/* Stage A smoke test for the installed assistant.
 * Drives a real Chrome against a running host and checks that
 *   - the host still boots with the loader injected,
 *   - the panel appears and reports engine-backed state,
 *   - every command is verified by reading the engine back,
 *   - a command that cannot reach its target reports `timeout`, never success,
 *   - time input without an explicit timezone is rejected,
 *   - a frozen snapshot stops tracking the sky and is marked stale.
 *
 * The first lines of output bind this run to the exact bytes the server
 * actually sent (review item A7): the log is only meaningful for that
 * candidate, not for "some version of the code".
 *
 * usage: node tests/e2e/smoke.mjs [url]
 */
import { chromium } from 'playwright-core'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const URL_ = process.argv[2] || 'http://127.0.0.1:8899/'
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

let failures = 0
function check (name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + JSON.stringify(detail) : ''))
  if (!ok) failures++
}

async function sha256Url (u) {
  const r = await fetch(u, { cache: 'no-store' })
  if (!r.ok) return 'HTTP_' + r.status
  const buf = Buffer.from(await r.arrayBuffer())
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/* ---- bind this run to the candidate bytes ---------------------------- */
console.log('# smoke — ' + new Date().toISOString())
console.log('# url: ' + URL_)
const served = {
  'index.html': await sha256Url(new URL('index.html', URL_).href),
  'ai-assistant/loader.js': await sha256Url(new URL('ai-assistant/loader.js', URL_).href),
  'ai-assistant/assistant.js': await sha256Url(new URL('ai-assistant/assistant.js', URL_).href)
}
for (const k of Object.keys(served)) console.log('# candidate ' + k + ' = ' + served[k])
const manifest = await (await fetch(new URL('ai-assistant/manifest.json', URL_).href, { cache: 'no-store' })).json()
console.log('# candidate manifest = v' + manifest.version + ' protocol v' + manifest.protocolVersion +
            ' assetQuery ' + manifest.assetQuery)
console.log('# test file = ' + crypto.createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'))
console.log('')

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

await page.goto(URL_, { waitUntil: 'load', timeout: 60000 })

// 1. host boots and the panel is injected
await page.waitForSelector('[data-swe-assistant="panel"]', { timeout: 60000 })
check('panel injected', true)

const engineReady = await page.evaluate(() => {
  const el = document.getElementById('app') || document.querySelector('.v-application')
  return !!(el && el.__vue__ && el.__vue__.$stel)
})
check('engine reachable via __vue__.$stel', engineReady)

const bridgeInfo = await page.evaluate(() => {
  const b = window.__SWE_AI_BRIDGE__
  return b ? { protocol: b.protocolVersion, loader: b.loaderVersion, caps: b.getCapabilities() } : null
})
check('bridge exposed with protocol 2', !!(bridgeInfo && bridgeInfo.protocol === 2),
  bridgeInfo && { loader: bridgeInfo.loader, protocol: bridgeInfo.protocol })
check('bridge advertises readback-verified async commands',
  !!(bridgeInfo && bridgeInfo.caps.commandResult.async &&
     bridgeInfo.caps.commandResult.verifiedByReadback))

const status = await page.textContent('.swe-status')
check('status shows connection', /已连接/.test(status || ''), status)

// 2. wait for catalogue, then select an object through the bridge
await page.waitForFunction(() => {
  const el = document.getElementById('app')
  const s = el && el.__vue__ && el.__vue__.$stel
  try { return !!(s && s.getObj('M 31')) } catch (e) { return false }
}, null, { timeout: 60000 })

const selResult = await page.evaluate(async () => {
  const b = window.__SWE_AI_BRIDGE__
  const before = b.readState()
  const res = await b.executeCommand({ type: 'select_object', name: 'M 31', lock: false })
  return { beforeRev: before.revision, res }
})
check('select_object accepted', selResult.res.ok, selResult.res.error)
check('select_object reports a verified status', selResult.res.status === 'applied', selResult.res.status)
const selState = selResult.res.state
check('selection read back from engine',
  !!(selState && selState.selection && selState.selection.designation),
  selState && selState.selection && selState.selection.designation)
check('selection carries real ra/dec/alt',
  !!(selState.selection.ra !== null && selState.selection.alt !== null),
  selState.selection && { ra: selState.selection.ra, dec: selState.selection.dec, alt: selState.selection.alt })
check('revision advanced', selState.revision > selResult.beforeRev,
  { before: selResult.beforeRev, after: selState.revision })

await page.waitForFunction(() => {
  const n = document.querySelector('.swe-obj-name')
  return n && /Andromeda|M 31/.test(n.textContent)
}, null, { timeout: 10000 }).catch(() => {})
const objName = await page.textContent('.swe-obj-name').catch(() => null)
check('panel shows selected object', /Andromeda|M 31/.test(objName || ''), objName)

// 3. layer toggles through the UI, verified against the engine
const atmBefore = await page.evaluate(() => document.getElementById('app').__vue__.$stel.core.atmosphere.visible)
// Layer toggles moved into the View pane in 0.7.0, when the sidebar was split
// into four tabs instead of one long column.
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.showTab('view'))
await page.click('.swe-toggle[data-layer="atmosphere"]')
await page.waitForTimeout(400)
const atmAfter = await page.evaluate(() => document.getElementById('app').__vue__.$stel.core.atmosphere.visible)
check('atmosphere toggle changed engine state', atmBefore !== atmAfter, { atmBefore, atmAfter })
const pressed = await page.getAttribute('.swe-toggle[data-layer="atmosphere"]', 'aria-pressed')
check('toggle aria-pressed matches engine', String(atmAfter) === pressed, { atmAfter, pressed })

const conBefore = await page.evaluate(() => document.getElementById('app').__vue__.$stel.core.constellations.lines_visible)
await page.click('.swe-toggle[data-layer="constellation_lines"]')
await page.waitForTimeout(300)
const conAfter = await page.evaluate(() => document.getElementById('app').__vue__.$stel.core.constellations.lines_visible)
check('constellation lines toggle works', conBefore !== conAfter, { conBefore, conAfter })

// 4. time: strict timezone handling (A6)
const timeRes = await page.evaluate(async () => {
  const b = window.__SWE_AI_BRIDGE__
  const res = await b.executeCommand({ type: 'set_time', utc: '2026-12-25T12:00:00.000Z' })
  const engineMjd = document.getElementById('app').__vue__.$stel.core.observer.utc
  return { res, engineMjd }
})
const expectMjd = Date.parse('2026-12-25T12:00:00.000Z') / 86400000 + 40587.0
check('set_time applied to engine', Math.abs(timeRes.engineMjd - expectMjd) < 1e-6,
  { engineMjd: timeRes.engineMjd, expectMjd })
check('set_time reports applied only after readback', timeRes.res.status === 'applied', timeRes.res.status)
check('set_time echoes the engine time',
  Math.abs(Date.parse(timeRes.res.readback.engineUtc) - Date.parse('2026-12-25T12:00:00.000Z')) < 1000,
  timeRes.res.readback.engineUtc)

const tzCases = await page.evaluate(async () => {
  const b = window.__SWE_AI_BRIDGE__
  const out = {}
  const naive = await b.executeCommand({ type: 'set_time', utc: '2026-12-25T12:00:00' })
  out.naive = naive.error ? naive.error.code : 'ACCEPTED'
  const offset = await b.executeCommand({ type: 'set_time', utc: '2026-12-25T20:00:00+08:00' })
  out.offsetOk = offset.ok
  out.offsetUtc = offset.ok ? offset.readback.engineUtc : null
  const bad = await b.executeCommand({ type: 'set_time', utc: '2026-13-45T99:99:99Z' })
  out.bad = bad.error ? bad.error.code : 'ACCEPTED'
  const dateOnly = await b.executeCommand({ type: 'set_time', utc: '2026-12-25' })
  out.dateOnly = dateOnly.error ? dateOnly.error.code : 'ACCEPTED'
  return out
})
check('naive datetime without timezone is rejected', tzCases.naive === 'invalid_value', tzCases)
check('explicit offset is accepted and normalised to UTC',
  tzCases.offsetOk === true && Math.abs(Date.parse(tzCases.offsetUtc) - Date.parse('2026-12-25T12:00:00Z')) < 1000,
  { offsetUtc: tzCases.offsetUtc })
check('impossible date is rejected', tzCases.bad === 'invalid_value', tzCases.bad)
check('date without time is rejected', tzCases.dateOnly === 'invalid_value', tzCases.dateOnly)

// Independent physical cross-check: in Beijing at 22:30 local the Sun must be
// well below the horizon. A self-consistent write+read test cannot catch an
// epoch/offset mistake; this can.
const sunCheck = await page.evaluate(async () => {
  const b = window.__SWE_AI_BRIDGE__
  await b.executeCommand({ type: 'set_location', lat: 39.9042, lng: 116.4074, elevation: 44 })
  await b.executeCommand({ type: 'set_time', utc: '2026-10-30T14:30:00.000Z' })
  const s = document.getElementById('app').__vue__.$stel
  const o = s.getObj('NAME Sun')
  const v = s.convertFrame(s.core.observer, 'ICRF', 'OBSERVED', o.getInfo('radec'))
  return { sunAlt: s.c2s(v)[1] * 180 / Math.PI }
})
check('22:30 Beijing really is night (sun below horizon)', sunCheck.sunAlt < -20, sunCheck)

// 5. invalid commands must be rejected
const rejects = await page.evaluate(async () => {
  const b = window.__SWE_AI_BRIDGE__
  const cases = [
    { type: 'set_layer', layer: 'atmosphere', visible: 'yes' },
    { type: 'set_layer', layer: 'nope', visible: true },
    { type: 'run_js', code: 'alert(1)' },
    { type: 'set_layer', layer: 'atmosphere', visible: true, extra: 1 },
    { type: 'set_time', utc: 'not-a-date' },
    { type: 'set_fov', deg: 500 },
    { type: 'set_location', lat: 200, lng: 0 },
    { type: 'select_object', name: '' }
  ]
  const out = []
  for (const c of cases) {
    const r = await b.executeCommand(c)
    out.push(r.error ? r.error.code : 'ACCEPTED')
  }
  return out
})
check('invalid commands rejected', rejects.every(c => c && c !== 'ACCEPTED'), rejects)

// 6. A4: a throwing engine setter must not be reported as success
// Faults injected below log on purpose, so remember where the log stood.
const errorsBeforeInjection = errors.length
const throwing = await page.evaluate(async () => {
  const b = window.__SWE_AI_BRIDGE__
  const stel = document.getElementById('app').__vue__.$stel
  const out = {}

  const realZoom = stel.zoomTo
  stel.zoomTo = function () { throw new Error('injected zoom failure') }
  const zoomRes = await b.executeCommand({ type: 'set_fov', deg: 20 })
  out.zoom = { ok: zoomRes.ok, code: zoomRes.error && zoomRes.error.code }
  stel.zoomTo = realZoom

  const realLock = stel.pointAndLock
  stel.pointAndLock = function () { throw new Error('injected lock failure') }
  const lockRes = await b.executeCommand({ type: 'select_object', name: 'M 31' })
  out.lock = { ok: lockRes.ok, code: lockRes.error && lockRes.error.code }
  stel.pointAndLock = realLock

  // Restore a sane view for the remaining checks.
  await b.executeCommand({ type: 'set_fov', deg: 30 })
  return out
})
check('throwing zoomTo is reported as failure, not success',
  throwing.zoom.ok === false && throwing.zoom.code === 'command_failed', throwing.zoom)
check('throwing pointAndLock is reported as failure, not success',
  throwing.lock.ok === false && throwing.lock.code === 'command_failed', throwing.lock)

// 7. A4: an animated command that cannot reach its target reports timeout
const timeoutCase = await page.evaluate(async () => {
  const b = window.__SWE_AI_BRIDGE__
  const stel = document.getElementById('app').__vue__.$stel
  const real = stel.zoomTo
  // Accept the call but never move: the classic "animation did not settle".
  stel.zoomTo = function () {}
  const res = await b.executeCommand({ type: 'set_fov', deg: 90 })
  stel.zoomTo = real
  return { ok: res.ok, status: res.status, waitedMs: res.waitedMs, fovDeg: res.readback && res.readback.fovDeg }
})
check('unsettled animation reports timeout, not applied',
  timeoutCase.ok === true && timeoutCase.status === 'timeout', timeoutCase)

// 8. A5: a frozen snapshot must stop tracking the sky
const freeze = await page.evaluate(async () => {
  const b = window.__SWE_AI_BRIDGE__
  await b.executeCommand({ type: 'select_object', name: 'M 31', lock: false })
  await b.executeCommand({ type: 'set_time', utc: '2026-10-30T14:30:00.000Z' })
  const snap = b.captureSnapshot()
  const freshBefore = b.isCurrentSnapshot(snap.snapshotId)

  // Simulate the user changing the time through the HOST's own UI: write the
  // engine directly, bypassing the bridge entirely.
  const stel = document.getElementById('app').__vue__.$stel
  stel.core.observer.utc = Date.parse('2026-10-30T18:30:00.000Z') / 86400000 + 40587.0
  await new Promise(r => setTimeout(r, 1200)) // let the watcher notice

  return {
    frozenUtc: snap.time.utc,
    frozenId: snap.snapshotId,
    freshBefore,
    staleAfterHostEdit: !b.isCurrentSnapshot(snap.snapshotId),
    liveUtc: b.readState().time.utc
  }
})
check('snapshot is current when taken', freeze.freshBefore === true, { id: freeze.frozenId })
check('a host-side change invalidates the snapshot id', freeze.staleAfterHostEdit === true,
  { frozen: freeze.frozenUtc, live: freeze.liveUtc })
check('the frozen snapshot payload did not change', freeze.frozenUtc === '2026-10-30T14:30:00.000Z',
  freeze.frozenUtc)

// The panel must expose the freeze control and mark the frozen payload stale.
// Freeze lives in the Sky pane; the layer toggles above moved the test to the
// View pane.
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.showTab('sky'))
await page.waitForSelector('[data-swe-action="freeze"]', { timeout: 5000 }).catch(() => {})
const hasFreezeBtn = await page.$('[data-swe-action="freeze"]')
check('panel offers a freeze control', !!hasFreezeBtn)
if (hasFreezeBtn) {
  await hasFreezeBtn.click()
  await page.waitForSelector('[data-swe-frozen]', { timeout: 5000 }).catch(() => {})
  const frozenText = await page.textContent('[data-swe-frozen]').catch(() => null)
  check('panel shows the frozen snapshot', /snapshotId=/.test(frozenText || ''),
    frozenText && frozenText.slice(0, 60))
  const staleBefore = await page.getAttribute('[data-swe-frozen-stale]', 'data-swe-frozen-stale')
  check('a freshly frozen snapshot is not marked stale', staleBefore === 'false', staleBefore)

  // Move the sky through the host engine again; the panel must mark the
  // frozen payload stale instead of quietly rewriting it.
  await page.evaluate(() => {
    const stel = document.getElementById('app').__vue__.$stel
    stel.core.observer.utc = Date.parse('2026-10-30T20:30:00.000Z') / 86400000 + 40587.0
  })
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-swe-frozen-stale]')
    return el && el.getAttribute('data-swe-frozen-stale') === 'true'
  }, null, { timeout: 8000 }).catch(() => {})
  const staleAfter = await page.getAttribute('[data-swe-frozen-stale]', 'data-swe-frozen-stale')
  check('panel marks the frozen snapshot stale after the sky moves', staleAfter === 'true', staleAfter)
}

// 9. no uncaught errors before the injected faults; the canvas is not just
// present but actually drawn
check('no unexpected console errors', errorsBeforeInjection === 0,
  errors.slice(0, errorsBeforeInjection))

const canvasSize = await page.evaluate(() => {
  const c = document.getElementById('stel-canvas')
  return c ? { w: c.width, h: c.height } : null
})
check('canvas element exists with non-zero size', !!(canvasSize && canvasSize.w > 0 && canvasSize.h > 0), canvasSize)

// "Has non-zero size" is not "is drawing". Sample real pixels: a blank or
// cleared buffer is uniform, a rendered sky is not.
const pixels = await page.evaluate(() => new Promise(resolve => {
  requestAnimationFrame(() => {
    const c = document.getElementById('stel-canvas')
    if (!c) return resolve(null)
    const off = document.createElement('canvas')
    off.width = 80
    off.height = 80
    const ctx = off.getContext('2d')
    ctx.drawImage(c, 0, 0, 80, 80)
    const d = ctx.getImageData(0, 0, 80, 80).data
    let min = 255
    let max = 0
    let sum = 0
    let n = 0
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] + d[i + 1] + d[i + 2]) / 3
      if (v < min) min = v
      if (v > max) max = v
      sum += v
      n++
    }
    resolve({ min, max, mean: Math.round(sum / n * 10) / 10, spread: max - min })
  })
}))
check('canvas pixels are not uniform (the sky is actually drawn)',
  !!(pixels && pixels.spread > 10), pixels)

// No screenshot here on purpose: visual evidence is composed by hand in
// evidence/screenshots (night sky, named objects, frozen payload). A shot taken
// at whatever the default state happens to be would overwrite a better one.
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
await browser.close()
process.exit(failures === 0 ? 0 : 1)
