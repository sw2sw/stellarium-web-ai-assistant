#!/usr/bin/env node
/* Installer safety tests — review items A1, A2, A3, A10.
 *
 * These are filesystem-only tests: no browser, no engine, no network. They
 * exist to prove that the installer refuses dangerous situations WITHOUT
 * leaving a side effect, which is the part a happy-path test cannot show.
 *
 * usage: node tests/installer/safety.mjs
 * exit:  0 = all checks passed
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const INSTALLER = path.join(ROOT, 'install', 'install.mjs')
const KNOWN = JSON.parse(fs.readFileSync(path.join(ROOT, 'install', 'known-hosts.json'), 'utf8'))
const PROFILE = KNOWN.hosts[0]

// Where the demo build lives, so we have a real verified host to copy.
const DEMO_DIST = path.resolve(ROOT, '..', 'packages', 'integrated-web', 'dist')

let failures = 0
function check (name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + JSON.stringify(detail) : ''))
  if (!ok) failures++
}

function sha256 (buf) { return crypto.createHash('sha256').update(buf).digest('hex') }
function fileHash (p) { return fs.existsSync(p) ? sha256(fs.readFileSync(p)) : null }

function run (args, opts) {
  try {
    const out = execFileSync(process.execPath, [INSTALLER].concat(args), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, (opts && opts.env) || {})
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: (e.stdout || '') + (e.stderr || '') }
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-installer-'))
function tmp (name) { return path.join(tmpRoot, name) }

function copyDemoHost (name) {
  const dst = tmp(name)
  fs.cpSync(DEMO_DIST, dst, {
    recursive: true,
    filter: (src) => {
      // Never carry an existing install into a fixture.
      const rel = path.relative(DEMO_DIST, src)
      if (rel.startsWith('ai-assistant')) return false
      if (rel.startsWith('.swe-backup')) return false
      if (rel.startsWith('.ai-assistant.')) return false
      return true
    }
  })
  // Copying may carry the patched index.html if the demo was installed; strip
  // the block so every fixture starts from the pristine host.
  const idx = path.join(dst, 'index.html')
  const html = fs.readFileSync(idx, 'utf8')
  const stripped = html.replace(/<!-- swe-assistant:begin -->[\s\S]*?<!-- swe-assistant:end -->\n?[ \t]*/g, '')
  if (stripped !== html) fs.writeFileSync(idx, stripped)
  return dst
}

// The entry file is written through a temp file whose name is random. These
// are the leftovers an interrupted run could leave, whatever it called them.
function indexTemps (dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.startsWith('index.html.') && n.endsWith('.swe-tmp'))
  } catch (e) {
    return []
  }
}

function snapshotTree (dir) {
  const out = {}
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const rel = path.relative(dir, p)
      if (e.isDirectory()) { out[rel + '/'] = 'dir'; walk(p) }
      else if (e.isFile()) out[rel] = sha256(fs.readFileSync(p))
    }
  }
  walk(dir)
  return out
}

function treeEqual (a, b) {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  if (ka.length !== kb.length) return false
  return ka.every((k, i) => k === kb[i] && a[k] === b[k])
}

console.log('# installer safety — ' + new Date().toISOString())
console.log('# temp root: ' + tmpRoot)
console.log('# known profile: ' + PROFILE.id)
console.log('')

/* ---- 1. unknown host is refused with no side effect ------------------ */
{
  const host = tmp('host-unknown')
  fs.mkdirSync(host, { recursive: true })
  fs.writeFileSync(path.join(host, 'index.html'),
    '<!DOCTYPE html><html><body><div id="app"></div><script src="/js/app.js"></script></body></html>')
  const before = snapshotTree(host)
  const r = run(['--host', host])
  const after = snapshotTree(host)
  check('unknown host refused', r.code !== 0 && /not a build we have verified/.test(r.out), { code: r.code })
  check('unknown host: no file was written', treeEqual(before, after))
}

/* ---- 2. plain Vue site (no engine) is refused ------------------------ */
{
  const host = tmp('host-plain-vue')
  fs.mkdirSync(path.join(host, 'js'), { recursive: true })
  fs.writeFileSync(path.join(host, 'index.html'),
    '<!DOCTYPE html><html><body><div id="app"></div>' +
    '<script src="/js/chunk-vendors.7a1cf844.js"></script>' +
    '<script src="/js/app.320979bc.js"></script></body></html>')
  fs.writeFileSync(path.join(host, 'js', 'chunk-vendors.7a1cf844.js'), '/* not the real bundle */')
  fs.writeFileSync(path.join(host, 'js', 'app.320979bc.js'), '/* not the real bundle */')
  const before = snapshotTree(host)
  const r = run(['--host', host])
  check('host without the pinned engine wasm is refused',
    r.code !== 0 && /not a build we have verified/.test(r.out), { code: r.code })
  check('plain Vue site: no file was written', treeEqual(before, snapshotTree(host)))
}

/* ---- 3. --check writes nothing on a real host ------------------------ */
{
  const host = copyDemoHost('host-check')
  const before = snapshotTree(host)
  const r = run(['--host', host, '--check'])
  check('--check succeeds on the pinned host', r.code === 0, { out: r.out.split('\n')[1] })
  check('--check reports the host as verified', /host identity: verified/.test(r.out))
  check('--check: no file was written', treeEqual(before, snapshotTree(host)))
}

/* ---- 4. foreign ai-assistant/ is never touched ----------------------- */
{
  const host = copyDemoHost('host-foreign')
  const foreign = path.join(host, 'ai-assistant')
  fs.mkdirSync(foreign, { recursive: true })
  fs.writeFileSync(path.join(foreign, 'notes.txt'), 'someone else put this here')
  const before = snapshotTree(host)
  const r = run(['--host', host])
  check('foreign ai-assistant/ refused',
    r.code !== 0 && /was not installed by this tool/.test(r.out), { code: r.code })
  check('foreign ai-assistant/: nothing changed', treeEqual(before, snapshotTree(host)))
}

/* ---- 5. corrupt install state is refused ---------------------------- */
{
  const host = copyDemoHost('host-corrupt')
  const dir = path.join(host, 'ai-assistant')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.install.json'), '{ this is not json')
  fs.writeFileSync(path.join(dir, 'assistant.js'), '// leftover')
  const before = snapshotTree(host)
  const r = run(['--host', host])
  check('corrupt state refused', r.code !== 0 && /corrupt install state/.test(r.out), { code: r.code })
  check('corrupt state: nothing changed', treeEqual(before, snapshotTree(host)))

  const ru = run(['--host', host, '--uninstall'])
  check('uninstall with corrupt state refused', ru.code !== 0 && /corrupt/.test(ru.out), { code: ru.code })
  check('uninstall with corrupt state: nothing changed', treeEqual(before, snapshotTree(host)))
}

/* ---- 6. duplicate / modified marker blocks are refused -------------- */
{
  const host = copyDemoHost('host-dup')
  const idx = path.join(host, 'index.html')
  const html = fs.readFileSync(idx, 'utf8')
  const block = '<!-- swe-assistant:begin -->\n' +
    '  <script src="/ai-assistant/loader.js" defer data-swe-assistant="loader"></script>\n' +
    '<!-- swe-assistant:end -->\n'
  fs.writeFileSync(idx, html.replace('</body>', block + block + '</body>'))
  const before = snapshotTree(host)
  const r = run(['--host', host])
  check('duplicate marker blocks refused',
    r.code !== 0 && /markers/.test(r.out), { code: r.code })
  check('duplicate markers: nothing changed', treeEqual(before, snapshotTree(host)))
}
{
  const host = copyDemoHost('host-mod')
  const idx = path.join(host, 'index.html')
  const html = fs.readFileSync(idx, 'utf8')
  fs.writeFileSync(idx, html.replace('</body>',
    '<!-- swe-assistant:begin -->\n  <script src="/somewhere/else.js"></script>\n' +
    '<!-- swe-assistant:end -->\n</body>'))
  const before = snapshotTree(host)
  const r = run(['--host', host])
  check('hand-edited marker block refused without --force',
    r.code !== 0 && /does not match this installer/.test(r.out), { code: r.code })
  check('modified marker: nothing changed', treeEqual(before, snapshotTree(host)))
}

/* ---- 7. symlinked assistant directory is refused -------------------- */
{
  const host = copyDemoHost('host-symlink')
  const outside = tmp('outside-target')
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'must survive')
  let linked = true
  try {
    fs.symlinkSync(outside, path.join(host, 'ai-assistant'), 'junction')
  } catch (e) {
    linked = false
  }
  if (!linked) {
    console.log('SKIP symlink check (this machine/account cannot create junctions)')
  } else {
    const before = snapshotTree(host)
    const r = run(['--host', host])
    check('symlinked ai-assistant/ refused',
      r.code !== 0 && /symbolic link/.test(r.out), { code: r.code })
    check('symlink target untouched', fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8') === 'must survive')
    check('symlink: host unchanged', treeEqual(before, snapshotTree(host)))
  }
}

/* ---- 8. malicious file list cannot delete outside the assistant dir -- */
{
  const host = copyDemoHost('host-evil-state')
  const dir = path.join(host, 'ai-assistant')
  fs.mkdirSync(dir, { recursive: true })
  const idx = path.join(host, 'index.html')
  const html = fs.readFileSync(idx, 'utf8')
  const block = '<!-- swe-assistant:begin -->\n' +
    '  <script src="/ai-assistant/loader.js" defer data-swe-assistant="loader"></script>\n' +
    '<!-- swe-assistant:end -->\n'
  fs.writeFileSync(idx, html.replace('</body>', block + '</body>'))
  fs.writeFileSync(path.join(dir, '.install.json'), JSON.stringify({
    schema: 2,
    version: '9.9.9',
    protocolVersion: 2,
    assetQuery: 'deadbeef',
    files: { '../index.html': 'whatever', 'assistant.js': 'whatever' }
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'assistant.js'), '// ours')
  const before = snapshotTree(host)
  const r = run(['--host', host, '--uninstall'])
  const after = snapshotTree(host)
  check('state with a ../ entry is refused',
    r.code !== 0 && /suspicious file name/.test(r.out), { code: r.code })
  check('index.html not deleted by a ../ entry', after['index.html'] === before['index.html'])
  check('no file removed at all', treeEqual(before, after))
}

/* ---- 9. install, idempotent re-install, uninstall round trip --------- */
let installedHost = null
{
  const host = copyDemoHost('host-roundtrip')
  installedHost = host
  const pristineHash = fileHash(path.join(host, 'index.html'))
  check('fixture starts at the pinned pristine index.html',
    pristineHash === PROFILE.pristineIndexSha256, { got: pristineHash.slice(0, 12) })

  const r1 = run(['--host', host])
  check('install succeeds on the pinned host', r1.code === 0, { code: r1.code })
  const afterInstall = fileHash(path.join(host, 'index.html'))
  check('install patched index.html', afterInstall !== pristineHash)

  const st = JSON.parse(fs.readFileSync(path.join(host, 'ai-assistant', '.install.json'), 'utf8'))
  check('state records the pristine hash as before', st.indexSha256Before === pristineHash)
  check('state records the patched hash as after', st.indexSha256After === afterInstall)
  check('state is schema 2', st.schema === 2)
  check('state carries a content assetQuery', typeof st.assetQuery === 'string' && st.assetQuery.length === 16)
  // Derived from the package directory, not hard-coded: adding an asset must
  // not silently disagree with what the installer publishes.
  const pkgDir = path.join(ROOT, 'packages', 'assistant-web')
  const expectedFiles = fs.readdirSync(pkgDir)
    .filter((f) => !f.startsWith('.') && !/\.md$/i.test(f) && fs.statSync(path.join(pkgDir, f)).isFile())
    .concat('loader.js').sort()
  check('state lists every published file with its hash',
    Object.keys(st.files).sort().join(',') === expectedFiles.join(','),
    { files: Object.keys(st.files).sort(), expected: expectedFiles })
  check('state records the verified host profile', st.host.profileId === PROFILE.id)

  // Re-install must be idempotent down to the byte.
  const r2 = run(['--host', host])
  check('re-install is idempotent', r2.code === 0 && fileHash(path.join(host, 'index.html')) === afterInstall)

  // A user file dropped into our directory must survive uninstall.
  fs.writeFileSync(path.join(host, 'ai-assistant', 'user-notes.txt'), 'mine')
  // A user edit to one of our files must survive too (we do not delete what we
  // can no longer prove we wrote).
  fs.appendFileSync(path.join(host, 'ai-assistant', 'assistant.css'), '\n/* local tweak */\n')

  const r3 = run(['--host', host, '--uninstall'])
  check('uninstall succeeds', r3.code === 0, { code: r3.code })
  check('index.html restored to the pristine hash',
    fileHash(path.join(host, 'index.html')) === pristineHash)
  check('user file preserved', fs.existsSync(path.join(host, 'ai-assistant', 'user-notes.txt')))
  check('locally modified asset preserved',
    fs.existsSync(path.join(host, 'ai-assistant', 'assistant.css')))
  check('unmodified assets removed',
    !fs.existsSync(path.join(host, 'ai-assistant', 'assistant.js')) &&
    !fs.existsSync(path.join(host, 'ai-assistant', 'loader.js')))
}

/* ---- 10. bad update packages are refused before publishing ---------- */
{
  const host = installedHost
  // Test 9 left user-owned files behind on purpose (that is the point of the
  // preservation check), so the directory must be cleared before reinstalling.
  fs.rmSync(path.join(host, 'ai-assistant'), { recursive: true, force: true })
  const ri = run(['--host', host])
  check('reinstall after a full uninstall succeeds', ri.code === 0, { code: ri.code })
  const before = snapshotTree(host)

  const bad = tmp('pkg-missing-entry')
  fs.mkdirSync(bad, { recursive: true })
  fs.writeFileSync(path.join(bad, 'manifest.json'), JSON.stringify({
    protocolVersion: 2, version: '9.0.0', entry: 'nope.js', style: 'nope.css'
  }))
  const r = run(['--host', host, '--update', bad])
  check('update with a missing entry is refused', r.code !== 0 && /missing/.test(r.out), { code: r.code })
  check('refused update left the install untouched', treeEqual(before, snapshotTree(host)))

  const badProto = tmp('pkg-bad-protocol')
  fs.mkdirSync(badProto, { recursive: true })
  fs.writeFileSync(path.join(badProto, 'manifest.json'), JSON.stringify({
    protocolVersion: 99, version: '9.0.0', entry: 'a.js'
  }))
  fs.writeFileSync(path.join(badProto, 'a.js'), '// x')
  const rp = run(['--host', host, '--update', badProto])
  check('update with a mismatched protocol is refused',
    rp.code !== 0 && /protocol/.test(rp.out), { code: rp.code })
  check('protocol mismatch left the install untouched', treeEqual(before, snapshotTree(host)))

  const badJson = tmp('pkg-bad-json')
  fs.mkdirSync(badJson, { recursive: true })
  fs.writeFileSync(path.join(badJson, 'manifest.json'), '{ nope')
  const rj = run(['--host', host, '--update', badJson])
  check('update with an unparsable manifest is refused',
    rj.code !== 0 && /not valid JSON/.test(rj.out), { code: rj.code })
  check('bad manifest left the install untouched', treeEqual(before, snapshotTree(host)))

  // A manifest may promise references (files the loader injects before the
  // entry). The installer used to publish without checking them, so the panel
  // came up in the browser with no naming rules and no error until the model
  // asked for an object by name.
  const badRef = tmp('pkg-missing-reference')
  fs.mkdirSync(badRef, { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'packages', 'assistant-web', 'assistant.js'),
    path.join(badRef, 'assistant.js'))
  fs.writeFileSync(path.join(badRef, 'manifest.json'), JSON.stringify({
    protocolVersion: 2, version: '9.0.0', entry: 'assistant.js',
    references: ['naming-reference.js']
  }))
  const rr = run(['--host', host, '--update', badRef])
  check('update with a missing reference is refused',
    rr.code !== 0 && /missing reference/.test(rr.out), { code: rr.code, out: rr.out.split('\n')[0] })
  check('missing reference left the install untouched', treeEqual(before, snapshotTree(host)))

  const escRef = tmp('pkg-escaping-reference')
  fs.mkdirSync(escRef, { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'packages', 'assistant-web', 'assistant.js'),
    path.join(escRef, 'assistant.js'))
  fs.writeFileSync(path.join(escRef, 'manifest.json'), JSON.stringify({
    protocolVersion: 2, version: '9.0.0', entry: 'assistant.js',
    references: ['../evil.js']
  }))
  const re = run(['--host', host, '--update', escRef])
  check('a reference that leaves the package is refused',
    re.code !== 0 && /invalid reference name/.test(re.out), { code: re.code, out: re.out.split('\n')[0] })
  check('escaping reference left the install untouched', treeEqual(before, snapshotTree(host)))

  // A reference may exist on disk and still never be published: the installer
  // copies the top level without dot files and without .md notes. Accepting
  // such a name installs a package whose loader injects a 404, and the panel
  // comes up without its naming rules and without an error.
  const hiddenRef = tmp('pkg-unpublished-reference')
  fs.mkdirSync(hiddenRef, { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'packages', 'assistant-web', 'assistant.js'),
    path.join(hiddenRef, 'assistant.js'))
  fs.writeFileSync(path.join(hiddenRef, '.naming-reference.js'), '// hidden, never published')
  fs.writeFileSync(path.join(hiddenRef, 'manifest.json'), JSON.stringify({
    protocolVersion: 2, version: '9.0.0', entry: 'assistant.js',
    references: ['.naming-reference.js']
  }))
  const rh = run(['--host', host, '--update', hiddenRef])
  check('a reference that exists but would not be published is refused',
    rh.code !== 0 && /would not be published/.test(rh.out),
    { code: rh.code, out: rh.out.split('\n')[0] })
  check('unpublished reference left the install untouched', treeEqual(before, snapshotTree(host)))
}

/* ---- 11. same version, different content changes the assetQuery ----- */
{
  const host = installedHost
  const st1 = JSON.parse(fs.readFileSync(path.join(host, 'ai-assistant', '.install.json'), 'utf8'))

  const pkg = tmp('pkg-same-version')
  fs.mkdirSync(pkg, { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'packages', 'assistant-web', 'assistant.js'),
    path.join(pkg, 'assistant.js'))
  fs.copyFileSync(path.join(ROOT, 'packages', 'assistant-web', 'assistant.css'),
    path.join(pkg, 'assistant.css'))
  fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify({
    protocolVersion: 2, version: st1.version, entry: 'assistant.js', style: 'assistant.css'
  }, null, 2))
  // Same version number, one changed byte of content.
  fs.appendFileSync(path.join(pkg, 'assistant.js'), '\n/* one byte more */\n')

  const r = run(['--host', host, '--update', pkg])
  check('same-version update is accepted', r.code === 0, { code: r.code })
  const st2 = JSON.parse(fs.readFileSync(path.join(host, 'ai-assistant', '.install.json'), 'utf8'))
  check('version stayed the same', st2.version === st1.version)
  check('assetQuery changed despite the same version',
    st2.assetQuery !== st1.assetQuery, { before: st1.assetQuery, after: st2.assetQuery })
}

/* ---- 11b. update refuses a host that changed under it (review R4) ----- */
// An update writes to the same two places an install does: the asset directory
// and index.html. It used to be gated only by "there is a valid install state",
// so a host that had been rebuilt, re-templated or hand-edited since the
// install still accepted new assets. Each case below must be refused with no
// side effect, and the unmodified host must still update.
{
  const host = copyDemoHost('host-update-guard')
  const idx = path.join(host, 'index.html')

  const r0 = run(['--host', host])
  check('guard fixture installs', r0.code === 0, { code: r0.code })
  // Read AFTER installing: this is the patched host, and it is what the
  // "put it back exactly as it was" cases below restore.
  const installedHtml = fs.readFileSync(idx, 'utf8')

  const pkg = tmp('pkg-guard-update')
  fs.mkdirSync(pkg, { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'packages', 'assistant-web', 'assistant.js'),
    path.join(pkg, 'assistant.js'))
  fs.copyFileSync(path.join(ROOT, 'packages', 'assistant-web', 'assistant.css'),
    path.join(pkg, 'assistant.css'))
  fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify({
    protocolVersion: 2, version: '0.0.1-guard', entry: 'assistant.js', style: 'assistant.css'
  }, null, 2))

  // (a) the entry block was edited by hand after install
  fs.writeFileSync(idx, installedHtml.replace('/ai-assistant/loader.js', '/somewhere/else.js'))
  let before = snapshotTree(host)
  let r = run(['--host', host, '--update', pkg])
  check('update refuses a hand-edited entry block',
    r.code !== 0 && /does not match this installer/.test(r.out), { code: r.code, out: r.out.split('\n')[1] })
  check('hand-edited block: update wrote nothing', treeEqual(before, snapshotTree(host)))

  // (b) the host was rebuilt: index.html changed outside our block. Even with
  // --allow-variant (which an install accepts) the recorded host fingerprint
  // no longer matches, so the update is refused.
  fs.writeFileSync(idx, installedHtml.replace('</body>', '<!-- host rebuilt --></body>'))
  before = snapshotTree(host)
  r = run(['--host', host, '--update', pkg, '--allow-variant'])
  check('update refuses a host whose index.html was rebuilt',
    r.code !== 0 && /differs from the installed host/.test(r.out), { code: r.code, out: r.out.split('\n')[2] })
  check('rebuilt host: update wrote nothing', treeEqual(before, snapshotTree(host)))

  // (c) the entry block was removed while the install state remained: the host
  // no longer loads the assistant, so publishing assets would be a lie.
  fs.writeFileSync(idx, installedHtml.replace(/<!-- swe-assistant:begin -->[\s\S]*?<!-- swe-assistant:end -->\n?[ \t]*/g, ''))
  before = snapshotTree(host)
  r = run(['--host', host, '--update', pkg])
  check('update refuses a host that no longer carries the entry block',
    r.code !== 0 && /is missing from index\.html/.test(r.out), { code: r.code, out: r.out.split('\n')[1] })
  check('removed block: update wrote nothing', treeEqual(before, snapshotTree(host)))

  // (d) the engine binary was replaced (a different engine under the same UI)
  fs.writeFileSync(idx, installedHtml)
  const wasmDir = path.join(host, 'js')
  const wasm = fs.readdirSync(wasmDir).find((f) => f.endsWith('.wasm'))
  const wasmPath = path.join(wasmDir, wasm)
  const wasmBytes = fs.readFileSync(wasmPath)
  fs.appendFileSync(wasmPath, Buffer.from([0]))
  before = snapshotTree(host)
  r = run(['--host', host, '--update', pkg])
  check('update refuses a host with a different engine wasm',
    r.code !== 0 && /not a build we have verified/.test(r.out), { code: r.code, out: r.out.split('\n')[1] })
  check('different wasm: update wrote nothing', treeEqual(before, snapshotTree(host)))
  fs.writeFileSync(wasmPath, wasmBytes)

  // (e) once the host is put back exactly as it was, the same update succeeds
  fs.writeFileSync(idx, installedHtml)
  const ru = run(['--host', host, '--update', pkg])
  check('an unchanged host still accepts the update',
    ru.code === 0 && /assistant updated to v0.0.1-guard/.test(ru.out), { code: ru.code, out: ru.out.split('\n')[1] })
  const stG = JSON.parse(fs.readFileSync(path.join(host, 'ai-assistant', '.install.json'), 'utf8'))
  check('the update recorded the new version', stG.version === '0.0.1-guard', stG.version)
}

/* ---- 12. no staging directories and no leftover data ------------------ */
{
  const host = installedHost
  const st = JSON.parse(fs.readFileSync(path.join(host, 'ai-assistant', '.install.json'), 'utf8'))
  const leftovers = fs.readdirSync(host).filter(n => n.startsWith('.ai-assistant.'))
  check('no staging directory was left behind',
    !leftovers.some(n => n.startsWith('.ai-assistant.stage-')), { entries: leftovers })
  // An empty retire directory is harmless; a directory still holding files
  // would mean the old version leaked data.
  const withFiles = leftovers.filter(n => {
    try { return fs.readdirSync(path.join(host, n)).length > 0 } catch { return false }
  })
  check('no retired directory still holds files', withFiles.length === 0, { withFiles })
  if (leftovers.length) {
    console.log('NOTE empty retire director(ies) present: ' + leftovers.join(', ') +
                ' (filesystem refused the final unlink; harmless)')
  }
  check('install state is still readable after updates', st.schema === 2)
}

/* ---- 13. every failure window restores what it found (review v0.9.0) ---
 * The installer used to restore the *stripped* index.html when a publish
 * failed. On a first install that is right; on a repair it silently removed
 * the entry block of the version that was already working. These cases run a
 * repair (the assistant is already installed) and force one failure per step
 * through the installer's fault hook, then insist the host is byte-identical.
 */
{
  const host = copyDemoHost('host-fault')
  const idx = path.join(host, 'index.html')
  const r0 = run(['--host', host])
  check('fault fixture installs', r0.code === 0, { code: r0.code })
  const installedIndex = fs.readFileSync(idx, 'utf8')
  check('the installed page points at the loader',
    /\/ai-assistant\/loader\.js/.test(installedIndex))

  for (const step of ['stage', 'index-write', 'publish-rename', 'state-write']) {
    const before = snapshotTree(host)
    const r = run(['--host', host], { env: { SWE_INSTALL_FAULT: step } })
    const after = snapshotTree(host)
    check('repair fails when "' + step + '" fails', r.code !== 0, { code: r.code })
    check('"' + step + '": index.html keeps the entry block it found',
      /\/ai-assistant\/loader\.js/.test(fs.readFileSync(idx, 'utf8')))
    check('"' + step + '": index.html is byte-identical to before',
      after['index.html'] === before['index.html'],
      { before: String(before['index.html']).slice(0, 12), after: String(after['index.html']).slice(0, 12) })
    check('"' + step + '": nothing else in the host changed', treeEqual(before, after),
      { added: Object.keys(after).filter((k) => !(k in before)),
        removed: Object.keys(before).filter((k) => !(k in after)) })
    check('"' + step + '": the installed assistant still loads its files',
      fs.existsSync(path.join(host, 'ai-assistant', 'loader.js')) &&
      fs.existsSync(path.join(host, 'ai-assistant', 'assistant.js')))
    check('"' + step + '": no half-written index temp file is left behind',
      indexTemps(host).length === 0, indexTemps(host))
    check('"' + step + '": no staging directory is left behind',
      !fs.readdirSync(host).some((n) => n.startsWith('.ai-assistant.stage-')))
  }

  // The same fault on a FIRST install must leave a host that never had an
  // assistant looking exactly as it did (no entry block, no empty directory).
  const fresh = copyDemoHost('host-fault-first')
  const freshIdx = path.join(fresh, 'index.html')
  const pristine = fs.readFileSync(freshIdx, 'utf8')
  const rf = run(['--host', fresh], { env: { SWE_INSTALL_FAULT: 'index-write' } })
  check('a failed first install reports failure', rf.code !== 0, { code: rf.code })
  check('a failed first install leaves the page unpatched',
    fs.readFileSync(freshIdx, 'utf8') === pristine)
  check('a failed first install leaves no assistant directory',
    !fs.existsSync(path.join(fresh, 'ai-assistant')))
  check('a failed first install leaves no staging directory',
    !fs.readdirSync(fresh).some((n) => n.startsWith('.ai-assistant.stage-')))
  check('a failed first install leaves no index temp file', indexTemps(fresh).length === 0)
  // The backup is kept on purpose: it is the only copy of the page the user
  // had before the attempt, and deleting it to satisfy "nothing changed" would
  // trade a harmless directory for an unrecoverable file.
  check('a failed first install says the backup was kept',
    /copy of the original index\.html is kept/.test(rf.out), rf.out.split('\n').slice(-1)[0])
  check('the kept backup is the original page',
    fileHash(path.join(fresh, '.swe-backup',
      fs.readdirSync(path.join(fresh, '.swe-backup'))[0])) === sha256(Buffer.from(pristine)))
}

/* ---- 14. entry and style answer to the same rule as references --------
 * references were checked against the set of files that actually gets
 * published; entry and style were only checked with existsSync on the package
 * directory. A hidden file, a .md note or a name with a directory in it
 * therefore passed and produced an install whose page 404s.
 */
{
  const host = copyDemoHost('host-entry-style')
  const r0 = run(['--host', host])
  check('entry/style fixture installs', r0.code === 0, { code: r0.code })
  const before = snapshotTree(host)

  const mkPkg = (name, extra) => {
    const dir = tmp(name)
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'packages', 'assistant-web', 'assistant.js'),
      path.join(dir, 'assistant.js'))
    fs.copyFileSync(path.join(ROOT, 'packages', 'assistant-web', 'assistant.css'),
      path.join(dir, 'assistant.css'))
    if (extra) extra(dir)
    return dir
  }

  // (a) the entry exists on disk but is hidden, so it is never copied
  const hiddenEntry = mkPkg('pkg-hidden-entry', (dir) => {
    fs.copyFileSync(path.join(ROOT, 'packages', 'assistant-web', 'assistant.js'),
      path.join(dir, '.assistant.js'))
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      protocolVersion: 2, version: '9.0.0', entry: '.assistant.js'
    }))
  })
  let r = run(['--host', host, '--update', hiddenEntry])
  check('an entry that would not be published is refused',
    r.code !== 0 && /would not be published/.test(r.out),
    { code: r.code, out: r.out.split('\n')[0] })

  // (b) the style is a .md note that happens to sit in the package
  const mdStyle = mkPkg('pkg-md-style', (dir) => {
    fs.writeFileSync(path.join(dir, 'theme.md'), '# not a stylesheet')
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      protocolVersion: 2, version: '9.0.0', entry: 'assistant.js', style: 'theme.md'
    }))
  })
  r = run(['--host', host, '--update', mdStyle])
  check('a style sheet that would not be published is refused',
    r.code !== 0 && /would not be published/.test(r.out),
    { code: r.code, out: r.out.split('\n')[0] })

  // (c) and (d) neither entry nor style may name a path outside the root
  const nestedEntry = mkPkg('pkg-nested-entry', (dir) => {
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'packages', 'assistant-web', 'assistant.js'),
      path.join(dir, 'sub', 'assistant.js'))
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      protocolVersion: 2, version: '9.0.0', entry: 'sub/assistant.js'
    }))
  })
  r = run(['--host', host, '--update', nestedEntry])
  check('an entry inside a subdirectory is refused',
    r.code !== 0 && /invalid entry name/.test(r.out),
    { code: r.code, out: r.out.split('\n')[0] })

  const escapingStyle = mkPkg('pkg-escaping-style', (dir) => {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      protocolVersion: 2, version: '9.0.0', entry: 'assistant.js', style: '../assistant.css'
    }))
  })
  r = run(['--host', host, '--update', escapingStyle])
  check('a style sheet that leaves the package is refused',
    r.code !== 0 && /invalid style name/.test(r.out),
    { code: r.code, out: r.out.split('\n')[0] })

  check('none of the rejected manifests touched the install', treeEqual(before, snapshotTree(host)))
}

/* ---- 15. clearing the old version happens after the commit ------------
 * The previous version's directory is cleared once the new one is installed
 * and described by the state file. If that housekeeping fails, the update did
 * happen - reporting "the installed version was left as it was" would send the
 * next run into a host that is not what the message claims.
 */
{
  const host = copyDemoHost('host-retire')
  const idx = path.join(host, 'index.html')
  const r0 = run(['--host', host])
  check('retire fixture installs', r0.code === 0, { code: r0.code })
  const stBefore = JSON.parse(fs.readFileSync(path.join(host, 'ai-assistant', '.install.json'), 'utf8'))

  const pkg = tmp('pkg-retire')
  fs.mkdirSync(pkg, { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'packages', 'assistant-web', 'assistant.js'), path.join(pkg, 'assistant.js'))
  fs.copyFileSync(path.join(ROOT, 'packages', 'assistant-web', 'assistant.css'), path.join(pkg, 'assistant.css'))
  fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify({
    protocolVersion: 2, version: '0.0.2-retire', entry: 'assistant.js', style: 'assistant.css'
  }, null, 2))

  const r = run(['--host', host, '--update', pkg], { env: { SWE_INSTALL_FAULT: 'retire' } })
  const stAfter = JSON.parse(fs.readFileSync(path.join(host, 'ai-assistant', '.install.json'), 'utf8'))
  check('an update whose old-directory cleanup fails still succeeds', r.code === 0,
    { code: r.code, out: r.out.split('\n').slice(-2) })
  check('the new version is what the state file describes',
    stAfter.version === '0.0.2-retire' && stAfter.assetQuery !== stBefore.assetQuery,
    { version: stAfter.version })
  check('the page still points at the loader',
    /\/ai-assistant\/loader\.js/.test(fs.readFileSync(idx, 'utf8')))
  check('the leftover directory is named in the warning',
    /previous version is still in \.ai-assistant\.old-/.test(r.out), r.out.split('\n').slice(-2))
  check('the leftover directory is not reported as a failed update',
    !/update failed/.test(r.out))
}

/* ---- 16. a rollback that fails is not reported as a rollback ----------
 * The main step fails and the undo fails with it. The installer used to print
 * "the installed version and index.html were left as they were" over a host
 * with no assistant directory at all, because every undo failure was swallowed
 * by an empty catch.
 */
{
  const host = copyDemoHost('host-restore')
  const idx = path.join(host, 'index.html')
  const r0 = run(['--host', host])
  check('restore fixture installs', r0.code === 0, { code: r0.code })

  // (a) repair: publish fails, and moving the old directory back fails too
  let r = run(['--host', host], { env: { SWE_INSTALL_FAULT: 'publish-rename,restore' } })
  check('repair with a failed undo reports failure', r.code !== 0, { code: r.code })
  check('repair with a failed undo says the previous version could not be put back',
    /could NOT be put back/.test(r.out), r.out.split('\n').slice(-2))
  check('repair with a failed undo does not claim the host is as it was',
    !/back to their previous state/.test(r.out))
  check('repair with a failed undo points at the directory to inspect',
    /check ai-assistant\/ and \.ai-assistant\.old-/.test(r.out))
  check('the previous version is still on disk under its retired name',
    fs.readdirSync(host).some((n) => n.startsWith('.ai-assistant.old-') &&
      fs.existsSync(path.join(host, n, 'assistant.js'))))

  // (b) update: same pair of failures, same requirement. A fresh host, because
  // the repair above deliberately left one that cannot be updated any more.
  const host2 = copyDemoHost('host-restore-update')
  const r2 = run(['--host', host2])
  check('restore fixture for the update installs', r2.code === 0, { code: r2.code })
  const pkg = tmp('pkg-restore')
  fs.mkdirSync(pkg, { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'packages', 'assistant-web', 'assistant.js'), path.join(pkg, 'assistant.js'))
  fs.copyFileSync(path.join(ROOT, 'packages', 'assistant-web', 'assistant.css'), path.join(pkg, 'assistant.css'))
  fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify({
    protocolVersion: 2, version: '0.0.3-restore', entry: 'assistant.js', style: 'assistant.css'
  }, null, 2))
  r = run(['--host', host2, '--update', pkg], { env: { SWE_INSTALL_FAULT: 'publish-rename,restore' } })
  check('update with a failed undo reports failure', r.code !== 0, { code: r.code })
  check('update with a failed undo says the previous version could not be put back',
    /could NOT be put back/.test(r.out), r.out.split('\n').slice(-2))
  check('update with a failed undo does not claim the old version is still installed',
    !/left as they were/.test(r.out))
}

/* ---- 17. the entry temp file is not a name somebody can plant a link at
 * writeIndexAtomic used a fixed name, so a symlink placed there was followed:
 * writeFileSync truncated the file it pointed at outside the host, and the
 * rename that followed did not undo that. The name is random and the file is
 * created exclusively now, so there is nothing to follow.
 */
{
  const host = copyDemoHost('host-index-tmp')
  const idx = path.join(host, 'index.html')
  const outside = tmp('outside-target.txt')
  const secret = 'do-not-touch-' + crypto.randomBytes(4).toString('hex')
  fs.writeFileSync(outside, secret)
  // A symlink is the exact shape of the bug, but Windows only creates file
  // symlinks with extra privileges. A hard link is the same test from the
  // other side: writing through the planted name changes the same bytes, so
  // "the outside file still says what it said" is the assertion either way.
  let kind = 'none'
  try {
    fs.symlinkSync(outside, idx + '.swe-tmp')
    kind = 'symlink'
  } catch (e) {
    try { fs.linkSync(outside, idx + '.swe-tmp'); kind = 'hardlink' } catch (e2) { kind = 'none' }
  }
  if (kind === 'none') {
    console.log('SKIP the planted-link case (this filesystem allows neither a symlink nor a hard link)')
  } else {
    const r = run(['--host', host])
    check('an install succeeds with a link planted at the old temp name (' + kind + ')',
      r.code === 0, { code: r.code })
    check('the file the planted name pointed at is byte-for-byte untouched',
      fs.readFileSync(outside, 'utf8') === secret)
    check('the install still patched the page',
      /\/ai-assistant\/loader\.js/.test(fs.readFileSync(idx, 'utf8')))
    check('the planted name is neither followed nor adopted as the temp file',
      fs.readFileSync(idx + '.swe-tmp', 'utf8') === secret)
    check('no temp file of this installer is left behind',
      indexTemps(host).filter((n) => n !== 'index.html.swe-tmp').length === 0, indexTemps(host))
  }
}

/* ---- 18. the entry keeps the mode it had ------------------------------
 * The entry is written as a private temp file (0600) and renamed over
 * index.html, so the public page inherited the private mode: an update turned a
 * world-readable 0644 page into one only the installing user could read, and a
 * static server running as another user started answering 403. The mode is
 * carried over now, on the rewrite that follows a failure as well.
 */
{
  if (process.platform === 'win32') {
    console.log('SKIP the entry-mode case (this platform does not carry POSIX mode bits)')
  } else {
    const host = copyDemoHost('host-index-mode')
    const idx = path.join(host, 'index.html')
    fs.chmodSync(idx, 0o644)
    const r = run(['--host', host])
    const after = fs.statSync(idx).mode & 0o777
    check('mode fixture installs', r.code === 0, { code: r.code })
    check('a 0644 entry stays 0644 after an install', after === 0o644, after.toString(8))
    check('the page is still readable by other users', (after & 0o444) === 0o444, after.toString(8))

    fs.chmodSync(idx, 0o640)
    const r2 = run(['--host', host], { env: { SWE_INSTALL_FAULT: 'publish-rename' } })
    const after2 = fs.statSync(idx).mode & 0o777
    check('a failed install puts the entry back with its own mode',
      r2.code !== 0 && after2 === 0o640, { code: r2.code, mode: after2.toString(8) })
  }
}

/* ---- 19. a first install that cannot describe itself is not "restored" --
 * The state file failed to write AND the new directory could not be moved out
 * of the way. There was no previous version, so `restored = !movedOld` said the
 * host was as it was found - while ai-assistant/ sat there with no state file
 * describing it. "Restored" now requires the new files to be gone.
 */
{
  const host = copyDemoHost('host-first-fail')
  const idx = path.join(host, 'index.html')
  const pristine = fileHash(idx)
  const r = run(['--host', host], { env: { SWE_INSTALL_FAULT: 'state-write,isolate' } })
  check('a first install that cannot write its state fails', r.code !== 0, { code: r.code })
  check('it does not claim the host is back to its previous state',
    !/nothing was installed/.test(r.out) && !/back to their previous state/.test(r.out),
    r.out.split('\n').slice(-2))
  check('it says the new files could not be removed rather than put back',
    /could NOT be removed from ai-assistant\//.test(r.out), r.out.split('\n').slice(-2))
  check('it points at the directory to inspect',
    /check ai-assistant\//.test(r.out), r.out.split('\n').slice(-2))
  check('the files it reports as left behind really are there',
    fs.existsSync(path.join(host, 'ai-assistant', 'assistant.js')))
  check('no state file describes them',
    !fs.existsSync(path.join(host, 'ai-assistant', '.install.json')))
  check('index.html was restored to its previous bytes', fileHash(idx) === pristine)
}

/* ---- 20. a failed install deletes only its own temp file ---------------
 * A directory-wide sweep of index.html.*.swe-tmp ran on every failure, so an
 * install that failed deleted files it had never created: a user's own file,
 * or another run's temp. Nothing outside this run's random path is touched now.
 */
{
  const host = copyDemoHost('host-foreign-tmp')
  const idx = path.join(host, 'index.html')
  const fixed = idx + '.swe-tmp'
  const randomish = idx + '.' + crypto.randomBytes(6).toString('hex') + '.swe-tmp'
  fs.writeFileSync(fixed, 'belongs-to-the-user')
  fs.writeFileSync(randomish, 'belongs-to-another-run')
  const r = run(['--host', host], { env: { SWE_INSTALL_FAULT: 'state-write' } })
  check('the failing install still fails', r.code !== 0, { code: r.code })
  check('a file at the old fixed temp name keeps its bytes',
    fs.readFileSync(fixed, 'utf8') === 'belongs-to-the-user')
  check('a file at a random temp name keeps its bytes',
    fs.readFileSync(randomish, 'utf8') === 'belongs-to-another-run')
  check('no temp file of this run is left behind',
    indexTemps(host).length === 2, indexTemps(host))
}

console.log('')
if (failures === 0) {
  console.log('ALL CHECKS PASSED')
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  process.exit(0)
} else {
  console.log(failures + ' CHECK(S) FAILED')
  console.log('fixtures kept for inspection: ' + tmpRoot)
  process.exit(1)
}
