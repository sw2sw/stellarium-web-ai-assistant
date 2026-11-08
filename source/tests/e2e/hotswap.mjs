/* Stage A: prove the assistant can be replaced without rebuilding the host,
 * and that a broken assistant cannot break the sky map.
 *
 * The pristine baseline comes from install/known-hosts.json, not from running
 * an uninstall first: a baseline produced by the code under test cannot prove
 * that the first uninstall did not delete something it should have kept
 * (review item A11).
 *
 * usage: node tests/e2e/hotswap.mjs
 * env:   DIST_DIR (source host to copy), SHOT_DIR, CHROME_PATH
 */
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Anchor every path to this file, not to the current directory: the test is
// shipped, and a build-machine absolute path or a cwd-relative one would point
// at the wrong tree on someone else's machine.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../..')                 // delivery/source
const DELIVERY = path.resolve(SRC, '..')                // delivery

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const DIST_SRC = process.env.DIST_DIR || path.join(DELIVERY, 'packages/integrated-web/dist')
const INSTALLER = path.join(SRC, 'install/install.mjs')
const FIXTURE = path.join(SRC, 'tests/fixtures/assistant-v2')
const SHOT = path.resolve(process.env.SHOT_DIR || path.join(DELIVERY, 'evidence/screenshots'))
fs.mkdirSync(SHOT, { recursive: true })

// This test installs, updates, corrupts and uninstalls. It must never do that
// to the delivery directory: a frozen package whose ai-assistant/ had been
// swapped for a fixture is exactly the kind of "the evidence cannot be
// reproduced" problem the review flagged. Work on a copy, served from its own
// loopback port.
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-hotswap-'))
const DIST = path.join(WORK, 'dist')
// fs.cpSync crashes silently (exit 127) on this Node/Windows when the SOURCE
// path contains non-ASCII characters, and this task directory is CJK. A plain
// walk copies the same tree without the native cp binding.
;(function copyTree (src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name)
    const to = path.join(dest, e.name)
    if (e.isDirectory()) copyTree(from, to)
    else if (e.isFile()) fs.copyFileSync(from, to)
  }
})(DIST_SRC, DIST)

function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

const PORT = await freePort()
const URL_ = 'http://127.0.0.1:' + PORT + '/'
const server = spawn(process.execPath, [path.join(SRC, 'tools/serve.mjs'), DIST, String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe']
})
server.stdout.on('data', () => {})
server.stderr.on('data', (d) => process.stderr.write('[serve] ' + d))

async function waitForServer () {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(URL_)
      if (r.ok) return true
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

function stopServer () {
  try { server.kill() } catch (e) {}
  try { fs.rmSync(WORK, { recursive: true, force: true }) } catch (e) {}
}

if (!await waitForServer()) {
  console.error('the static server for the copied host did not start on ' + URL_)
  stopServer()
  process.exit(1)
}

const KNOWN = JSON.parse(fs.readFileSync(path.join(SRC, 'install/known-hosts.json'), 'utf8'))
const PROFILE = KNOWN.hosts[0]
// The base version comes from the package that will be installed, not from a
// literal: bumping the assistant must not require editing this test.
const BASE = JSON.parse(fs.readFileSync(path.join(SRC, 'packages/assistant-web/manifest.json'), 'utf8'))
const FIXTURE_MANIFEST = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'manifest.json'), 'utf8'))

let failures = 0
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + JSON.stringify(detail) : ''))
  if (!ok) failures++
}

function hashDir (dir, re) {
  const out = {}
  for (const f of fs.readdirSync(dir)) {
    if (!re.test(f)) continue
    out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex').slice(0, 16)
  }
  return out
}

function hostFingerprint () {
  return {
    js: hashDir(path.join(DIST, 'js'), /\.(js|wasm)$/),
    index: crypto.createHash('sha256').update(fs.readFileSync(path.join(DIST, 'index.html'))).digest('hex')
  }
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const pageErrors = []
page.on('pageerror', e => pageErrors.push('pageerror: ' + e.message))

// Real pixels, not "the element exists": a cleared buffer is uniform.
async function drawn () {
  return page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => {
      const c = document.getElementById('stel-canvas')
      if (!c || !c.width || !c.height) return resolve(null)
      const off = document.createElement('canvas')
      off.width = 80
      off.height = 80
      const ctx = off.getContext('2d')
      ctx.drawImage(c, 0, 0, 80, 80)
      const d = ctx.getImageData(0, 0, 80, 80).data
      let min = 255
      let max = 0
      for (let i = 0; i < d.length; i += 4) {
        const v = (d[i] + d[i + 1] + d[i + 2]) / 3
        if (v < min) min = v
        if (v > max) max = v
      }
      resolve({ min, max, spread: max - min })
    })
  }))
}

async function loadAndRead () {
  pageErrors.length = 0
  await page.goto(URL_ + '?t=' + Date.now(), { waitUntil: 'load', timeout: 60000 })
  const ok = await page.waitForSelector('[data-swe-assistant="panel"]', { timeout: 45000 })
    .then(() => true).catch(() => false)
  // Give the renderer a couple of frames before sampling pixels.
  await page.waitForTimeout(600)
  const info = await page.evaluate(() => {
    const vm = document.getElementById('app') && document.getElementById('app').__vue__
    const panel = document.querySelector('[data-swe-assistant="panel"]')
    // The locate box is the fixture-only feature. It is identified by its own
    // section, not by "any text input": the base panel has a text input too.
    const hasLocate = Array.from(document.querySelectorAll('.swe-sec h3'))
      .some((n) => /按名称定位|Locate by name/.test(n.textContent))
    return {
      panel: !!panel,
      version: (document.querySelector('.swe-ver') || {}).textContent || null,
      hasLocate: hasLocate,
      fixture: panel ? panel.getAttribute('data-swe-fixture') : null,
      engine: !!(vm && vm.$stel)
    }
  })
  info.pixels = await drawn()
  return { panelAppeared: ok, info }
}

/* ---- bind this run to the candidate bytes ---------------------------- */
console.log('# hotswap — ' + new Date().toISOString())
console.log('# url: ' + URL_)
console.log('# dist: ' + DIST)
console.log('# known pristine index.html = ' + PROFILE.pristineIndexSha256)
console.log('')

/* 1. baseline: v1 installed -------------------------------------------- */
// A host that is not installed yet is the expected starting point; if a
// previous run left one, remove it through the supported path.
const beforeInstall = hostFingerprint()
if (beforeInstall.index !== PROFILE.pristineIndexSha256) {
  execFileSync(process.execPath, [INSTALLER, '--host', DIST, '--uninstall'], { stdio: 'inherit' })
}
const fpPristine = hostFingerprint()
check('starting host matches the pinned pristine index.html',
  fpPristine.index === PROFILE.pristineIndexSha256, { got: fpPristine.index.slice(0, 16) })

execFileSync(process.execPath, [INSTALLER, '--host', DIST], { stdio: 'inherit' })
const fpBefore = hostFingerprint()
const v1 = await loadAndRead()
check('v1 panel present', v1.info.panel)
check('v1 version shown', v1.info.version === 'v' + BASE.version, { got: v1.info.version, want: BASE.version })
check('v1 has no locate box', v1.info.hasLocate === false)
check('v1 carries no fixture marker', v1.info.fixture === null, v1.info.fixture)
check('v1 host is really drawing the sky', !!(v1.info.pixels && v1.info.pixels.spread > 10), v1.info.pixels)

/* 2. hot update to v2 --------------------------------------------------- */
execFileSync(process.execPath,
  [INSTALLER, '--host', DIST, '--update', FIXTURE],
  { stdio: 'inherit' })

const fpAfter = hostFingerprint()
check('host bundles unchanged by update', JSON.stringify(fpBefore.js) === JSON.stringify(fpAfter.js),
  { files: Object.keys(fpBefore.js).length })
check('index.html untouched by update', fpBefore.index === fpAfter.index)

const v2 = await loadAndRead()
check('v2 panel present after reload', v2.info.panel)
check('v2 version shown', v2.info.version === 'v' + FIXTURE_MANIFEST.version, v2.info.version)
check('v2 new feature present', v2.info.hasLocate === true)
check('v2 is the fixture build, not the old panel',
  v2.info.fixture === 'hotswap-' + FIXTURE_MANIFEST.version, v2.info.fixture)

// the new v2 control actually works against the engine
await page.waitForFunction(() => {
  const vm = document.getElementById('app') && document.getElementById('app').__vue__
  try { return !!(vm && vm.$stel && vm.$stel.getObj('* alf Ori')) } catch (e) { return false }
}, null, { timeout: 60000 })
await page.fill('.swe-input[type="text"]', '* alf Ori')
await page.click('button:has-text("定位")')
await page.waitForTimeout(2500)
const locate = await page.evaluate(() => {
  const vm = document.getElementById('app').__vue__
  const s = vm.$stel.core.selection
  return {
    engine: s ? s.designations()[0] : null,
    panel: (document.querySelector('.swe-obj-name') || {}).textContent || null
  }
})
check('v2 locate drove the engine', /Betelgeuse|alf Ori/.test(locate.engine || ''), locate)
check('panel followed the new selection', /Betelgeuse/.test(locate.panel || ''), locate.panel)
await page.screenshot({ path: path.join(SHOT, 'stage-a-v2-hotswap.png') })

/* 3. broken assistant must not break the host --------------------------- */
const manifestPath = path.join(DIST, 'ai-assistant', 'manifest.json')
const goodManifest = fs.readFileSync(manifestPath, 'utf8')

// 3a. corrupt manifest
fs.writeFileSync(manifestPath, '{ this is not json')
const broken = await loadAndRead()
check('corrupt manifest: host still reachable and drawing',
  broken.info.engine && broken.info.pixels && broken.info.pixels.spread > 10, broken.info.pixels)
check('corrupt manifest: no panel', broken.info.panel === false)
// The bridge lives in the loader, which is injected independently of the
// assistant bundle. A broken assistant must not take the bridge down with it,
// otherwise the host loses its only remote control surface.
const brokenBridge = await page.evaluate(async () => {
  const b = window.__SWE_AI_BRIDGE__
  if (!b) return { bridge: false }
  const r = await b.executeCommand({ type: 'set_fov', deg: 70 })
  return { bridge: true, ok: r.ok, status: r.status, fovDeg: r.readback && r.readback.fovDeg }
})
check('corrupt manifest: the control bridge still drives the engine',
  brokenBridge.bridge && brokenBridge.ok && brokenBridge.status === 'applied', brokenBridge)
await page.screenshot({ path: path.join(SHOT, 'stage-a-broken-manifest.png') })

// 3b. manifest points at files that do not exist
fs.writeFileSync(manifestPath, JSON.stringify({
  protocolVersion: 2, version: 'boom', entry: 'missing.js', style: 'missing.css'
}))
const missing = await loadAndRead()
check('missing bundle: host still reachable and drawing',
  missing.info.engine && missing.info.pixels && missing.info.pixels.spread > 10, missing.info.pixels)
check('missing bundle: no panel', missing.info.panel === false)

// 3c. the assistant bundle itself throws on load
fs.writeFileSync(path.join(DIST, 'ai-assistant', 'boom.js'),
  'throw new Error("injected assistant failure")\n')
fs.writeFileSync(manifestPath, JSON.stringify({
  protocolVersion: 2, version: 'boom2', entry: 'boom.js', style: 'assistant.css', assetQuery: 'boom'
}))
const throwing = await loadAndRead()
check('throwing assistant: host still reachable and drawing',
  throwing.info.engine && throwing.info.pixels && throwing.info.pixels.spread > 10, throwing.info.pixels)
check('throwing assistant: no panel', throwing.info.panel === false)
// The throw is expected — it is the fault being injected. What matters is that
// it stays confined to the assistant: the bridge still answers and the engine
// keeps rendering.
check('throwing assistant: the injected error is the only page error',
  pageErrors.length === 1 && /injected assistant failure/.test(pageErrors[0]), pageErrors.slice(0, 2))
const bridgeAlive = await page.evaluate(async () => {
  const b = window.__SWE_AI_BRIDGE__
  if (!b) return 'no bridge'
  const st = b.readState()
  const res = await b.executeCommand({ type: 'set_layer', layer: 'atmosphere', visible: true })
  return { state: !!st, command: res.ok, status: res.status }
})
check('throwing assistant: the bridge still drives the engine',
  bridgeAlive.state === true && bridgeAlive.command === true, bridgeAlive)
fs.rmSync(path.join(DIST, 'ai-assistant', 'boom.js'), { force: true })

// 3d. protocol mismatch between manifest and loader
fs.writeFileSync(manifestPath, JSON.stringify({
  protocolVersion: 99, version: 'future', entry: 'assistant.js', style: 'assistant.css'
}))
const mismatch = await loadAndRead()
check('protocol mismatch: no panel', mismatch.info.panel === false)
check('protocol mismatch: host still drawing',
  !!(mismatch.info.pixels && mismatch.info.pixels.spread > 10), mismatch.info.pixels)

fs.writeFileSync(manifestPath, goodManifest)
const restored = await loadAndRead()
check('restored after fixing the manifest',
  restored.info.panel && restored.info.version === 'v' + FIXTURE_MANIFEST.version, restored.info.version)

/* 4. engine never becomes available ------------------------------------ */
// Isolated from the real host: a bare page that only loads the loader, with a
// short timeout. This exercises the give-up path without breaking the host.
{
  const fake = new URL('__test/no-engine.html', URL_).href
  await page.route(fake, route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><body><div id="app"></div>' +
          '<script>window.__SWE_AI_ENGINE_TIMEOUT_MS__ = 800</script>' +
          '<script src="/ai-assistant/loader.js"></script></body></html>'
  }))
  pageErrors.length = 0
  await page.goto(fake, { waitUntil: 'load', timeout: 30000 })
  const gaveUp = await page.evaluate(() =>
    window.__SWE_AI_BRIDGE__.ready.then(v => v === null), { timeout: 20000 }).catch(() => 'threw')
  check('loader gives up cleanly when the engine never appears', gaveUp === true, gaveUp)
  check('no panel is built without an engine',
    await page.evaluate(() => !document.querySelector('[data-swe-assistant="panel"]')))
  check('giving up did not throw into the page', pageErrors.length === 0, pageErrors.slice(0, 2))
  await page.unroute(fake)
}

/* 5. uninstall restores the host ---------------------------------------- */
execFileSync(process.execPath, [INSTALLER, '--host', DIST, '--uninstall'], { stdio: 'inherit' })
const removed = await loadAndRead()
check('host still drawing after uninstall',
  !!(removed.info.pixels && removed.info.pixels.spread > 10), removed.info.pixels)
check('panel gone after uninstall', removed.info.panel === false)
const fpUninstalled = hostFingerprint()
check('index.html restored to the pinned pristine hash',
  fpUninstalled.index === PROFILE.pristineIndexSha256,
  { pristine: PROFILE.pristineIndexSha256.slice(0, 16), afterUninstall: fpUninstalled.index.slice(0, 16) })
check('host bundles untouched across the whole run',
  JSON.stringify(fpBefore.js) === JSON.stringify(fpUninstalled.js))

// Reinstall once more to prove the uninstall left the host installable again.
// The directory is a throwaway copy, so there is nothing to preserve.
execFileSync(process.execPath, [INSTALLER, '--host', DIST], { stdio: 'inherit' })

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
console.log('# frozen delivery untouched: ' + DIST_SRC + ' (ran against ' + WORK + ')')
await browser.close()
stopServer()
process.exit(failures === 0 ? 0 : 1)
