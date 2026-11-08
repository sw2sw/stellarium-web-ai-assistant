#!/usr/bin/env node
/* Stellarium Web AI Teaching Assistant - installer
 * Copyright (c) 2026 - project contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Usage:
 *   node install/install.mjs --host <dist-dir>                  # install or repair
 *   node install/install.mjs --host <dist-dir> --check          # preflight only, no writes
 *   node install/install.mjs --host <dist-dir> --uninstall
 *   node install/install.mjs --host <dist-dir> --update <assistant-dir>
 *   node install/install.mjs --host <dist-dir> --status
 *
 * The host patch is a single <script> line inside dist/index.html. Everything
 * else lives in dist/ai-assistant/ and can be replaced without touching the
 * host build again.
 *
 * Safety rules enforced here (see docs/INSTALL.md and the A1/A2/A3/A10 review
 * items):
 *   - the host must be a recognised, verified build, not "any Vue site";
 *   - the marker block must be exactly one well-formed pair of our own;
 *   - an existing ai-assistant/ directory that we do not own is never touched;
 *   - publishing is stage-then-swap, so a failed copy cannot leave a mixed set;
 *   - uninstall only deletes files whose content still matches what we wrote;
 *   - symlinks anywhere on the managed path are refused, not followed.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const ASSISTANT_SRC = path.join(ROOT, 'packages', 'assistant-web')
const LOADER_SRC = path.join(ROOT, 'packages', 'host-adapter', 'loader.js')
const KNOWN_HOSTS_FILE = path.join(HERE, 'known-hosts.json')

const TARGET_DIR = 'ai-assistant'
const STAGE_PREFIX = '.ai-assistant.stage-'
const OLD_PREFIX = '.ai-assistant.old-'
const BACKUP_DIR = '.swe-backup'
const BEGIN = '<!-- swe-assistant:begin -->'
const END = '<!-- swe-assistant:end -->'
const STATE_FILE = '.install.json'
const STATE_SCHEMA = 2
const LOADER_FILE = 'loader.js'

/* ------------------------------------------------------------- helpers */

function die (msg, hint) {
  console.error('[install] ERROR: ' + msg)
  if (hint) console.error('[install] HINT: ' + hint)
  process.exit(1)
}

// Test hook: forces a failure at one named step so the tests can prove the
// rollback instead of trusting the comment above it. It can only make an
// install fail earlier; with it unset nothing here runs, and it cannot change
// what a successful install writes. Each name fires once, so the recovery path
// the failure is supposed to exercise is not sabotaged by the same fault.
//
// A comma-separated list arms several at once, which is what a "the main step
// failed AND the undo failed" case needs - that pair is exactly the case where
// the installer must stop claiming the host was put back.
const FAULT = (process.env.SWE_INSTALL_FAULT || '')
  .split(',').map((s) => s.trim()).filter(Boolean)
let faultArmed = FAULT.slice()
function armed (name) { return faultArmed.indexOf(name) >= 0 }
function fault (name) {
  const i = faultArmed.indexOf(name)
  if (i < 0) return
  faultArmed.splice(i, 1)
  throw new Error('injected fault: ' + name)
}

function info (msg) { console.log('[install] ' + msg) }
function warn (msg) { console.log('[install] WARNING: ' + msg) }

function sha256 (buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function sha256File (p) {
  return sha256(fs.readFileSync(p))
}

function lstatOrNull (p) {
  try { return fs.lstatSync(p) } catch { return null }
}

// A symlink on a managed path lets a write escape the host directory. Refuse
// rather than resolve: we cannot know where the link points.
function assertNotSymlink (p, label) {
  const st = lstatOrNull(p)
  if (st && st.isSymbolicLink()) {
    die(label + ' is a symbolic link; refusing to follow it: ' + p,
        'replace it with a real file/directory, or install into a clean host')
  }
  return st
}

// Only accept a bare file name that cannot climb out of the assistant dir.
function ownedFilePath (dir, name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name) ||
      name === '.' || name === '..') {
    die('refusing to touch a suspicious file name in the install state: ' + JSON.stringify(name),
        'the state file may be corrupted or tampered with; reinstall into a clean host')
  }
  const p = path.join(dir, name)
  if (path.relative(dir, p) !== name) {
    die('path escapes the assistant directory: ' + name)
  }
  return p
}

function parseArgs (argv) {
  const out = {
    host: null, uninstall: false, status: false, check: false,
    update: null, force: false, allowVariant: false, allowUnknownHost: false
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--host') out.host = argv[++i]
    else if (a === '--uninstall') out.uninstall = true
    else if (a === '--status') out.status = true
    else if (a === '--check') out.check = true
    else if (a === '--update') out.update = argv[++i]
    else if (a === '--force') out.force = true
    else if (a === '--allow-variant') out.allowVariant = true
    else if (a === '--allow-unknown-host') out.allowUnknownHost = true
    else if (a === '-h' || a === '--help') {
      console.log([
        'usage: node install/install.mjs --host <dist-dir> [mode] [options]',
        '',
        'modes:',
        '  (default)            install or repair',
        '  --check              run every preflight check, write nothing',
        '  --update <dir>       replace the assistant assets with another package',
        '  --uninstall          remove the assistant, restore index.html',
        '  --status             print the install state',
        '',
        'options:',
        '  --allow-variant      accept a host that matches a known build except for index.html',
        '  --allow-unknown-host accept a host that matches no known build (not recommended)',
        '  --force              accept a modified marker block (last resort)'
      ].join('\n'))
      process.exit(0)
    } else die('unknown argument: ' + a)
  }
  if (!out.host) die('--host <dist-dir> is required')
  out.host = path.resolve(out.host)
  return out
}

/* -------------------------------------------------------- host identity */

function loadKnownHosts () {
  if (!fs.existsSync(KNOWN_HOSTS_FILE)) return { hosts: [] }
  try {
    const j = JSON.parse(fs.readFileSync(KNOWN_HOSTS_FILE, 'utf8'))
    return { hosts: Array.isArray(j.hosts) ? j.hosts : [] }
  } catch (e) {
    die('cannot parse ' + KNOWN_HOSTS_FILE + ': ' + e.message)
  }
}

function findEngineWasm (hostDir) {
  const jsDir = path.join(hostDir, 'js')
  const dirs = fs.existsSync(jsDir) ? [jsDir, hostDir] : [hostDir]
  for (const d of dirs) {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isFile() && /^stellarium-web-engine\..*\.wasm$/.test(e.name)) {
        return path.join(d, e.name)
      }
    }
  }
  return null
}

// Which scripts the host loads. `<link rel="prefetch|preload" href="….js">`
// counts too: the pinned profile lists chunk-2d2253ec, which this host only
// references that way. Reading <script src> alone made every rebuilt host look
// "unknown" instead of "variant", so the documented --allow-variant path was
// unreachable for the one profile that ships here.
function referencedBundles (html) {
  const out = []
  const patterns = [/<script[^>]+src="([^"]+)"/gi, /<link[^>]+href="([^"]+\.js)"/gi]
  for (const re of patterns) {
    let m
    while ((m = re.exec(html))) out.push(m[1].replace(/^\//, ''))
  }
  return out
}

// Returns { status, profile, reasons } where status is
//   'verified' - pristine index.html hash matches a known build
//   'variant'  - engine wasm + bundle names match, but index.html differs
//   'unknown'  - nothing matches; the caller must refuse by default
function identifyHost (hostDir, cleanHtml, known) {
  const reasons = []
  const wasm = findEngineWasm(hostDir)
  const wasmHash = wasm ? sha256File(wasm) : null
  const indexHash = sha256(cleanHtml)
  const bundles = referencedBundles(cleanHtml)

  if (!wasm) reasons.push('engine wasm not found under js/')
  if (!bundles.length) reasons.push('index.html references no script bundle')

  for (const p of known.hosts) {
    if (p.pristineIndexSha256 === indexHash && (!p.engineWasmSha256 || p.engineWasmSha256 === wasmHash)) {
      return { status: 'verified', profile: p, reasons: [], wasmHash, indexHash, bundles }
    }
  }

  for (const p of known.hosts) {
    const bundleOk = (p.bundles || []).every(b => bundles.some(x => x.endsWith(b)))
    const wasmOk = !p.engineWasmSha256 || p.engineWasmSha256 === wasmHash
    if (bundleOk && wasmOk) {
      reasons.push('index.html hash differs from the known build (' + indexHash.slice(0, 12) + ')')
      return { status: 'variant', profile: p, reasons, wasmHash, indexHash, bundles }
    }
  }

  reasons.push('no known host profile matched (index ' + indexHash.slice(0, 12) +
               ', wasm ' + (wasmHash ? wasmHash.slice(0, 12) : 'none') + ')')
  return { status: 'unknown', profile: null, reasons, wasmHash, indexHash, bundles }
}

/* ------------------------------------------------------------- markers */

function countOccurrences (haystack, needle) {
  let n = 0
  let i = 0
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length }
  return n
}

function buildBlock () {
  return [
    BEGIN,
    '  <script src="/' + TARGET_DIR + '/loader.js" defer data-swe-assistant="loader"></script>',
    END,
    '  '
  ].join('\n')
}

function stripBlock (html) {
  // Exact inverse of buildBlock(): removes the marker pair and the indentation
  // that was added in front of </body>, so uninstall restores byte equality.
  const re = new RegExp(BEGIN + '[\\s\\S]*?' + END + '\\n?[ \\t]*', 'g')
  return html.replace(re, '')
}

// 'absent' | 'ours' | 'modified' | 'duplicate'
function inspectMarkers (html) {
  const b = countOccurrences(html, BEGIN)
  const e = countOccurrences(html, END)
  if (b === 0 && e === 0) return { state: 'absent', begins: 0, ends: 0 }
  if (b !== 1 || e !== 1) return { state: 'duplicate', begins: b, ends: e }
  const start = html.indexOf(BEGIN)
  const stop = html.indexOf(END)
  if (stop < start) return { state: 'duplicate', begins: b, ends: e }
  const body = html.slice(start, stop + END.length)
  const expected = buildBlock().slice(0, buildBlock().length - 3) // drop trailing indent
  return { state: body === expected ? 'ours' : 'modified', begins: b, ends: e }
}

/* --------------------------------------------------------- preflight */

function preflight (hostDir) {
  const st = assertNotSymlink(hostDir, 'host directory')
  if (!st) die('host directory not found: ' + hostDir)
  if (!st.isDirectory()) die('host path is not a directory: ' + hostDir)

  const index = path.join(hostDir, 'index.html')
  assertNotSymlink(index, 'index.html')
  if (!fs.existsSync(index)) {
    die('not a Stellarium Web build (missing index.html): ' + hostDir,
        'point --host at the built dist/ directory')
  }

  const html = fs.readFileSync(index, 'utf8')
  if (!/id="app"/i.test(html)) {
    die('index.html does not look like a Stellarium Web build (no #app mount point)')
  }
  return { index, html }
}

/* -------------------------------------------------------- install state */

function readStateRaw (hostDir) {
  const dir = path.join(hostDir, TARGET_DIR)
  assertNotSymlink(dir, TARGET_DIR + '/')
  const p = path.join(dir, STATE_FILE)
  assertNotSymlink(p, STATE_FILE)
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return { __corrupt: true } }
}

function requireState (hostDir, action) {
  const st = readStateRaw(hostDir)
  if (!st) {
    die('no install state in ' + hostDir + '; refusing to ' + action,
        'run --status to inspect, or reinstall into a clean host')
  }
  if (st.__corrupt) {
    die('install state is corrupt; refusing to ' + action,
        'inspect ' + path.join(hostDir, TARGET_DIR, STATE_FILE) + ' manually')
  }
  if (st.schema !== STATE_SCHEMA) {
    die('install state schema ' + st.schema + ' is not supported by this installer; refusing to ' + action,
        'this build expects schema ' + STATE_SCHEMA)
  }
  if (!st.files || typeof st.files !== 'object') {
    die('install state has no file manifest; refusing to ' + action)
  }
  // Validate every recorded name BEFORE anything is written or deleted. A
  // tampered state file must not be able to reach outside the assistant
  // directory, and it must not get as far as stripping index.html (A10).
  for (const name of Object.keys(st.files)) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name) ||
        name === '.' || name === '..') {
      die('install state lists a suspicious file name: ' + JSON.stringify(name) +
          '; refusing to ' + action,
          'the state file may be corrupted or tampered with; inspect ' +
          path.join(hostDir, TARGET_DIR, STATE_FILE) + ' by hand')
    }
  }
  return st
}

function writeState (hostDir, state) {
  const dir = path.join(hostDir, TARGET_DIR)
  const p = path.join(dir, STATE_FILE)
  const tmp = p + '.tmp'
  fault('state-write')
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  fs.renameSync(tmp, p)
}

/* ------------------------------------------------------ package loading */

// Reads a candidate package and refuses anything incomplete before we touch
// the host. Returns { manifest, files: {name: buffer} }.
function readPackage (srcDir, protocolVersion) {
  const manifestPath = path.join(srcDir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) die('package has no manifest.json: ' + srcDir)
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch (e) {
    die('package manifest.json is not valid JSON: ' + e.message)
  }
  if (manifest.protocolVersion !== protocolVersion) {
    die('package protocol v' + manifest.protocolVersion + ' does not match loader protocol v' +
        protocolVersion, 'use a package built for this loader')
  }
  if (!manifest.entry) die('package manifest.json has no "entry"')
  // The loader injects every reference before the entry runs, and the page
  // needs the entry and the style to exist at all. A missing one does not fail
  // the install: it fails later, in the browser - and by then the previous
  // version has already been swapped out.
  //
  // Every one of the three is therefore checked against the set of files that
  // is actually published, not against the directory. A hidden file or a .md
  // note exists on disk but is never copied, and a value with a directory or
  // a ".." in it is not something this installer publishes at all; accepting
  // either would install a package that 404s in the browser.
  if (manifest.references !== undefined && !Array.isArray(manifest.references)) {
    die('package manifest.json "references" must be an array')
  }

  const files = {}
  for (const f of fs.readdirSync(srcDir)) {
    if (f.startsWith('.') || /\.md$/i.test(f)) continue
    const from = path.join(srcDir, f)
    const st = fs.lstatSync(from)
    if (st.isSymbolicLink()) die('package contains a symlink, refusing: ' + f)
    if (!st.isFile()) continue
    files[f] = fs.readFileSync(from)
  }
  // The loader is the host-adapter build, not an assistant asset: it always
  // wins over whatever the package happens to contain.
  files[LOADER_FILE] = fs.readFileSync(LOADER_SRC)

  const publishedName = function (field, value, what) {
    if (typeof value !== 'string' || !value.trim() || /[\\/]/.test(value) ||
        value === '.' || value === '..') {
      die('package manifest.json has an invalid ' + field + ' name: ' + JSON.stringify(value),
          what + ' must be a plain file name in the package root')
    }
    if (Object.prototype.hasOwnProperty.call(files, value)) return
    if (!fs.existsSync(path.join(srcDir, value))) {
      die('package manifest.json points at a missing ' + field + ' file: ' + value)
    }
    die('package manifest.json lists a ' + field + ' that would not be published: ' + value,
        'hidden files and .md notes stay out of the published set; rename the file ' +
        'without a leading dot and without a .md extension')
  }

  publishedName('entry', manifest.entry, 'the entry')
  if (manifest.style) publishedName('style', manifest.style, 'the style sheet')
  if (Array.isArray(manifest.references)) {
    for (const ref of manifest.references) publishedName('reference', ref, 'references')
  }
  return { manifest, files }
}

function assetQuery (manifest, files) {
  const h = crypto.createHash('sha256')
  h.update(String(manifest.protocolVersion))
  h.update('\0' + manifest.version)
  for (const name of Object.keys(files).sort()) {
    h.update('\0' + name + '\0')
    h.update(files[name])
  }
  return h.digest('hex').slice(0, 16)
}

// Writes the package into a staging directory next to the live one. Nothing
// is published until this returns successfully, and a failure half way
// through removes the half-written directory instead of leaving it for the
// next run to trip over.
function stagePackage (hostDir, manifest, files, query) {
  assertNotSymlink(hostDir, 'host directory')
  const stage = path.join(hostDir, STAGE_PREFIX + crypto.randomBytes(6).toString('hex'))
  fs.mkdirSync(stage, { recursive: false })
  try {
    fault('stage')
    const hashes = {}
    for (const name of Object.keys(files)) {
      const p = ownedFilePath(stage, name)
      fs.writeFileSync(p, files[name])
      hashes[name] = sha256(files[name])
    }
    const liveManifest = Object.assign({}, manifest, {
      assetQuery: query,
      stagedAt: new Date().toISOString()
    })
    const mp = ownedFilePath(stage, 'manifest.json')
    fs.writeFileSync(mp, JSON.stringify(liveManifest, null, 2) + '\n')
    hashes['manifest.json'] = sha256File(mp)
    return { stage, hashes }
  } catch (e) {
    try { fs.rmSync(stage, { recursive: true, force: true }) } catch (e2) {}
    throw e
  }
}

// Atomic-ish publish: rename the live dir out of the way, move the staged dir
// in, write the state file, then report where the previous version is.
//
// Every failure here throws instead of exiting, so the caller can undo the
// index.html write it did before publishing and remove its staging directory.
// Exiting from inside this function left a patched index pointing at nothing.
//
// The thrown error carries `publish.restored`: true when the previous version
// is back in place and the host is exactly as it was, false when that undo
// itself failed. The caller reports what actually happened instead of assuming
// the rollback worked - an error message that claims "nothing changed" over a
// half-swapped host is worse than no message at all.
function publish (hostDir, stageDir, state, previousFiles) {
  const live = path.join(hostDir, TARGET_DIR)
  const old = path.join(hostDir, OLD_PREFIX + crypto.randomBytes(6).toString('hex'))
  const liveStat = assertNotSymlink(live, TARGET_DIR + '/')
  let movedOld = false
  const notes = []

  const failed = function (what, cause, restored) {
    const err = new Error(what + ': ' + cause.message)
    err.publish = { committed: false, restored: restored, detail: notes.join('; ') }
    return err
  }

  if (liveStat) {
    try {
      fs.renameSync(live, old)
    } catch (e) {
      // Nothing moved: the host is untouched.
      throw failed('could not move the installed assistant aside', e, true)
    }
    movedOld = true
  }
  try {
    fault('publish-rename')
    fs.renameSync(stageDir, live)
  } catch (e) {
    let restored = true
    if (movedOld) {
      try { fault('restore'); fs.renameSync(old, live) } catch (e2) {
        restored = false
        notes.push('the previous version could not be moved back (' + e2.message + ')')
      }
    }
    throw failed('could not publish the staged assistant', e, restored)
  }
  // The state file describes the directory it sits in, so it is written last.
  // If it cannot be written the next run would see files it cannot account
  // for, so the publish is rolled back instead of left half-described.
  try {
    writeState(hostDir, state)
  } catch (e) {
    const bad = stageDir + '.failed'
    let movedAside = false
    try { fault('isolate'); fs.renameSync(live, bad); movedAside = true } catch (e2) {
      notes.push('the new files could not be moved out of the way (' + e2.message + ')')
    }
    // "Restored" means the host is what it was. On a first install that means
    // no assistant directory at all, so the new files have to be gone before
    // anything here can be called restored - `!movedOld` alone claimed the
    // host was clean while the new ai-assistant/ was still sitting there with
    // no state file describing it.
    let restored = false
    if (!movedAside) {
      notes.push('the new files are still in ' + TARGET_DIR + '/ and no install state describes them')
    } else if (movedOld) {
      try { fault('restore'); fs.renameSync(old, live); restored = true } catch (e2) {
        notes.push('the previous version could not be moved back (' + e2.message + ')')
      }
    } else {
      restored = true
    }
    if (movedAside) {
      try { fs.rmSync(bad, { recursive: true, force: true }) } catch (e2) {
        notes.push('the rejected copy is still at ' + path.basename(bad) + ' (' + e2.message + ')')
      }
    }
    const err = failed('could not write the install state', e, restored)
    err.publish.firstInstall = !movedOld
    throw err
  }
  // Clearing the old directory happens after the new one is in place and
  // described by the state file. It is housekeeping, not part of the commit:
  // see retireQuietly() - a failure here must not be reported as "the update
  // did not happen", because it did.
  return { oldDir: movedOld ? old : null, previousFiles: previousFiles || {} }
}

// Discards the directory the previous version lived in, after a successful
// publish. Any failure here is a leftover directory, not a failed install, so
// it warns and stops: routing it through the caller's rollback would restore
// an index.html that no longer matches the directory actually installed.
function retireQuietly (published, liveDir) {
  if (!published || !published.oldDir) return
  try {
    retireOldDir(published.oldDir, published.previousFiles, liveDir)
  } catch (e) {
    warn('the previous version is still in ' + path.basename(published.oldDir) + '/ (' +
         e.message + '); it is no longer used and can be deleted by hand')
  }
}

// Discards the directory a previous version lived in. Files we recorded are
// deleted only while their content still matches; anything else belongs to the
// user, so it is moved into the live directory instead of being left behind in
// a hidden one (or silently deleted).
function retireOldDir (oldDir, previousFiles, liveDir) {
  fault('retire')
  const kept = []
  for (const name of Object.keys(previousFiles)) {
    try {
      const p = ownedFilePath(oldDir, name)
      const st = lstatOrNull(p)
      if (!st || st.isSymbolicLink() || !st.isFile()) continue
      if (sha256File(p) !== previousFiles[name]) continue
      fs.rmSync(p, { force: true })
    } catch (e) {
      // A file we cannot read or delete is left for the operator; the install
      // itself already succeeded, so this is a note, not an error.
      kept.push(name + ' (could not be removed: ' + e.message + ')')
    }
  }
  // Our own state file, whatever it says.
  try {
    const sp = path.join(oldDir, STATE_FILE)
    const sst = lstatOrNull(sp)
    if (sst && sst.isFile() && !sst.isSymbolicLink()) fs.rmSync(sp, { force: true })
  } catch (e) {
    kept.push(STATE_FILE + ' (could not be removed: ' + e.message + ')')
  }

  let rest = []
  try { rest = fs.readdirSync(oldDir) } catch { rest = [] }
  for (const name of rest) {
    const from = path.join(oldDir, name)
    const to = path.join(liveDir, name)
    if (fs.existsSync(to)) {
      kept.push(name + ' (name already used by the new version)')
      continue
    }
    try {
      fs.renameSync(from, to)
      info('kept a file that was not part of the package: ' + name + ' -> ' + TARGET_DIR + '/')
    } catch (e) {
      kept.push(name + ' (could not be moved: ' + e.message + ')')
    }
  }

  let stillThere = []
  try { stillThere = fs.readdirSync(oldDir) } catch { stillThere = [] }
  if (stillThere.length === 0) {
    // The publish already succeeded; failing here would report a false error.
    // Some filesystems (and sandboxed delete shims) refuse to unlink an empty
    // directory immediately, so warn instead of aborting.
    try {
      fs.rmdirSync(oldDir)
    } catch (e) {
      warn('could not remove the empty ' + path.basename(oldDir) +
           '/ (' + e.message + '); it holds no files and can be deleted by hand')
    }
  } else {
    warn('could not clear ' + path.basename(oldDir) + '/: ' + stillThere.join(', ') +
         ' — remove it by hand')
  }
  if (kept.length) warn('left in place: ' + kept.join(', '))
}

// Deletes only files we recorded, and only while their content still matches.
// Used by uninstall, where user files must stay where they are.
function removeOwned (dir, fileMap) {
  const kept = []
  for (const name of Object.keys(fileMap)) {
    let p
    try { p = ownedFilePath(dir, name) } catch (e) { kept.push(name + ' (invalid name)'); continue }
    const st = lstatOrNull(p)
    if (!st) continue
    if (st.isSymbolicLink()) { kept.push(name + ' (symlink)'); continue }
    if (!st.isFile()) { kept.push(name + ' (not a regular file)'); continue }
    if (sha256File(p) !== fileMap[name]) { kept.push(name + ' (modified since install)'); continue }
    fs.rmSync(p, { force: true })
  }
  const sp = path.join(dir, STATE_FILE)
  const sst = lstatOrNull(sp)
  if (sst && sst.isFile() && !sst.isSymbolicLink()) fs.rmSync(sp, { force: true })

  let rest = []
  try { rest = fs.readdirSync(dir) } catch { rest = [] }
  if (rest.length === 0) {
    fs.rmdirSync(dir)
    info('removed ' + path.basename(dir) + '/')
  } else {
    warn('kept ' + rest.length + ' unrecognised entr' + (rest.length === 1 ? 'y' : 'ies') +
         ' in ' + path.basename(dir) + '/: ' + rest.join(', '))
  }
  if (kept.length) warn('kept ' + kept.length + ' file(s) not deleted: ' + kept.join(', '))
  return { kept, rest }
}

function backupIndex (indexPath, html) {
  const dir = path.join(path.dirname(indexPath), BACKUP_DIR)
  assertNotSymlink(dir, BACKUP_DIR + '/')
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, 'index.html.' + sha256(html).slice(0, 12) + '.orig')
  assertNotSymlink(target, 'backup file')
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, html)
    info('backed up index.html -> ' + path.relative(path.dirname(indexPath), target))
  }
}

// index.html is written through a temp file and renamed into place, so a full
// disk or a killed process cannot leave a half-written entry behind: the page
// either still points at the old assistant or at the complete new one.
//
// The temp name is random and the file is created exclusively ("wx"), because a
// fixed name is one somebody else can plant a symlink at: writeFileSync would
// follow the link, truncate whatever it points at outside the host, and the
// rename would not undo that. With an unpredictable name and O_EXCL there is
// nothing to follow - an existing path, link or not, makes the create fail -
// and the bytes only ever go to the file we opened ourselves.
//
// The file is created private (0600) so a half-written copy is nobody's
// business, then given the mode the page already had before it replaces it. The
// rename carries the temp file's mode over, so without that step an update
// would quietly turn a world-readable 0644 index.html into a 0600 one and a
// static server running as another user would start answering 403.
const INDEX_TMP_SUFFIX = '.swe-tmp'
const INDEX_DEFAULT_MODE = 0o644
function indexTmpName (indexPath) {
  return indexPath + '.' + crypto.randomBytes(6).toString('hex') + INDEX_TMP_SUFFIX
}
function indexMode (indexPath) {
  try {
    const st = fs.statSync(indexPath)
    if (st.isFile() && (st.mode & 0o777)) return st.mode & 0o7777
  } catch (e) {}
  return INDEX_DEFAULT_MODE
}
function writeIndexAtomic (indexPath, bytes) {
  const tmp = indexTmpName(indexPath)
  const mode = indexMode(indexPath)
  let fd = -1
  try {
    fd = fs.openSync(tmp, 'wx', 0o600)
    if (armed('index-write')) {
      // A truncated temp file, exactly what a full disk leaves behind. The
      // rename below never happens, so index.html keeps its previous bytes.
      fs.writeSync(fd, bytes.slice(0, Math.floor(bytes.length / 2)))
      fs.closeSync(fd)
      fd = -1
      fault('index-write')
    }
    fs.writeSync(fd, bytes)
    // Filesystems without POSIX modes (FAT, and Windows' own) either ignore
    // this or flip the read-only bit, which is not a failure to report.
    try { fs.fchmodSync(fd, mode) } catch (e) {}
    fs.closeSync(fd)
    fd = -1
    fs.renameSync(tmp, indexPath)
  } catch (e) {
    if (fd >= 0) { try { fs.closeSync(fd) } catch (e2) {} }
    try { fs.rmSync(tmp, { force: true }) } catch (e2) {}
    throw e
  }
}

/* ------------------------------------------------------------- commands */

// Host acceptance, shared by install and update. It used to live inline in the
// install branch, which meant --update published new assets into a host it
// would have refused to install into: a different variant, an edited marker
// block, an unknown build. An update writes to the same places as an install,
// so it answers to the same rules (review item R4).
function assertHostAcceptable (args, identity, markers) {
  if (identity.status === 'unknown' && !args.allowUnknownHost) {
    die('this host is not a build we have verified; refusing to patch it',
        'build the host from the pinned upstream commit (docs/UPSTREAM-BUILD.md), ' +
        'or pass --allow-unknown-host if you accept the risk')
  }
  if (identity.status === 'variant' && !args.allowVariant && !args.allowUnknownHost) {
    die('this host matches a known build except for index.html; refusing to patch it',
        'if the difference is cosmetic, pass --allow-variant')
  }
  if (markers.state === 'duplicate') {
    die('index.html contains ' + markers.begins + ' begin and ' + markers.ends +
        ' end markers; refusing to guess which one is ours',
        'remove the extra marker blocks by hand, then retry')
  }
  if (markers.state === 'modified' && !args.force) {
    die('an assistant block exists in index.html but does not match this installer; refusing to overwrite it',
        'diff it against the block in docs/INSTALL.md, then pass --force if it is safe to replace')
  }
}

// The engine wasm and the pristine index.html are the two things an update
// must never silently accept a change in. They are recorded at install time,
// so comparing them answers "is this still the host I was installed into?"
function assertSameHost (st, identity) {
  const wasmWas = st.host && st.host.engineWasmSha256
  const indexWas = st.host && st.host.pristineIndexSha256
  const problems = []
  if (wasmWas && identity.wasmHash !== wasmWas) {
    problems.push('engine wasm ' + String(identity.wasmHash || 'none').slice(0, 12) +
                  ' differs from the installed host ' + String(wasmWas).slice(0, 12))
  }
  if (indexWas && identity.indexHash !== indexWas) {
    problems.push('index.html ' + String(identity.indexHash).slice(0, 12) +
                  ' differs from the installed host ' + String(indexWas).slice(0, 12))
  }
  if (problems.length) {
    die('the host was replaced or rebuilt after this assistant was installed (' +
        problems.join('; ') + '); refusing to update into it',
        'run --uninstall on this host and install again, so the records match the bytes')
  }
  return true
}

function main () {
  const args = parseArgs(process.argv)

  if (args.status) {
    const st = readStateRaw(args.host)
    if (!st) { console.log('not installed'); return }
    console.log(JSON.stringify(st, null, 2))
    return
  }

  const { index, html } = preflight(args.host)
  const markers = inspectMarkers(html)
  const clean = stripBlock(html)
  const known = loadKnownHosts()
  const identity = identifyHost(args.host, clean, known)

  const identityLine = 'host identity: ' + identity.status +
    (identity.profile ? ' (' + identity.profile.id + ')' : '') +
    (identity.reasons.length ? ' — ' + identity.reasons.join('; ') : '')
  info(identityLine)

  /* ---- uninstall ---- */
  if (args.uninstall) {
    const st = requireState(args.host, 'uninstall')
    if (markers.state === 'duplicate') {
      die('index.html contains ' + markers.begins + ' begin and ' + markers.ends +
          ' end markers; refusing to guess which one is ours',
          'remove the extra marker blocks by hand, then retry')
    }
    if (markers.state === 'modified' && !args.force) {
      die('the assistant block in index.html was edited after install; refusing to remove it',
          'restore the block or pass --force after checking the diff')
    }
    if (args.check) { info('check-only: would remove the block and ' +
      Object.keys(st.files).length + ' recorded file(s)'); return }

    if (markers.state !== 'absent') {
      backupIndex(index, clean)
      writeIndexAtomic(index, clean)
      info('removed loader tag from index.html')
    } else {
      info('no loader tag found in index.html')
    }
    const dir = path.join(args.host, TARGET_DIR)
    if (lstatOrNull(dir)) removeOwned(dir, st.files)
    info('uninstalled assistant v' + st.version + '; host build untouched')
    return
  }

  /* ---- update ---- */
  if (args.update) {
    const st = requireState(args.host, 'update')
    const srcDir = path.resolve(args.update)
    if (!fs.existsSync(srcDir)) die('update source not found: ' + srcDir)

    // Everything an install would refuse, an update refuses too.
    assertHostAcceptable(args, identity, markers)
    const liveDir = path.join(args.host, TARGET_DIR)
    const liveStat = assertNotSymlink(liveDir, TARGET_DIR + '/')
    if (!liveStat) {
      die(TARGET_DIR + '/ is missing although the install state lists ' +
          Object.keys(st.files).length + ' file(s); refusing to update',
          'run --uninstall, then install again')
    }
    if (!liveStat.isDirectory()) die(TARGET_DIR + ' is not a directory; refusing to update')
    // A vanished or edited marker block means index.html no longer points at
    // this assistant; publishing assets would leave the host loading nothing.
    if (markers.state === 'absent') {
      die('the assistant block is missing from index.html although the assistant is installed',
          'run install (no --update) to re-patch the host, or --uninstall to clean up')
    }
    assertSameHost(st, identity)

    const loader = fs.readFileSync(LOADER_SRC, 'utf8')
    const protocol = Number((loader.match(/PROTOCOL_VERSION\s*=\s*(\d+)/) || [])[1])
    if (!protocol) die('cannot read PROTOCOL_VERSION from ' + LOADER_SRC)
    if (st.protocolVersion !== protocol && !args.force) {
      die('installed bridge protocol v' + st.protocolVersion +
          ' differs from this package v' + protocol,
          'uninstall first, then install the matching version')
    }

    const { manifest, files } = readPackage(srcDir, protocol)
    const query = assetQuery(manifest, files)

    if (args.check) {
      info('check-only: package v' + manifest.version + ' is complete (' +
           Object.keys(files).length + ' files, assetQuery ' + query + ')')
      info('check-only: current install is v' + st.version + ' (assetQuery ' + st.assetQuery + ')')
      return
    }

    let stage = null
    let hashes = null
    let published = null
    // An update leaves index.html alone, so undoing it only has to drop the
    // staging directory: publish has already put the old assets back.
    try {
      const staged = stagePackage(args.host, manifest, files, query)
      stage = staged.stage
      hashes = staged.hashes
      published = publish(args.host, stage, {
        schema: STATE_SCHEMA,
        version: manifest.version,
        protocolVersion: manifest.protocolVersion,
        assetQuery: query,
        installedAt: st.installedAt,
        updatedAt: new Date().toISOString(),
        host: st.host,
        indexSha256Before: st.indexSha256Before,
        indexSha256After: st.indexSha256After,
        files: hashes,
        ownedPaths: st.ownedPaths
      }, st.files)
    } catch (e) {
      if (stage) { try { fs.rmSync(stage, { recursive: true, force: true }) } catch (e2) {} }
      const rollback = e.publish
      if (rollback && rollback.restored === false) {
        die('update failed: ' + e.message,
            'the new version did not go in and the previous one could NOT be put back' +
            (rollback.detail ? ' (' + rollback.detail + ')' : '') +
            ' - inspect ' + TARGET_DIR + '/ and ' + OLD_PREFIX + '*/ before using this host')
      }
      die('update failed: ' + e.message,
          'the installed version and index.html were left as they were')
    }
    retireQuietly(published, liveDir)
    info('assistant updated to v' + manifest.version + ' (' + Object.keys(hashes).length +
         ' files, assetQuery ' + query + ')')
    info('Reload the page (F5) — the host bundle and WASM were not rebuilt.')
    return
  }

  /* ---- install / repair ---- */
  assertHostAcceptable(args, identity, markers)

  const existing = readStateRaw(args.host)
  const liveDir = path.join(args.host, TARGET_DIR)
  const liveStat = assertNotSymlink(liveDir, TARGET_DIR + '/')

  if (liveStat && !existing) {
    die(TARGET_DIR + '/ already exists but was not installed by this tool; refusing to touch it',
        'move or rename that directory first — this installer never overwrites foreign files')
  }
  if (liveStat && existing && existing.__corrupt) {
    die(TARGET_DIR + '/ exists with a corrupt install state; refusing to repair it',
        'inspect ' + path.join(liveDir, STATE_FILE) + ', then remove the directory manually')
  }

  const loader = fs.readFileSync(LOADER_SRC, 'utf8')
  const protocol = Number((loader.match(/PROTOCOL_VERSION\s*=\s*(\d+)/) || [])[1])
  if (!protocol) die('cannot read PROTOCOL_VERSION from ' + LOADER_SRC)
  if (existing && existing.schema === STATE_SCHEMA &&
      existing.protocolVersion !== protocol && !args.force) {
    die('installed bridge protocol v' + existing.protocolVersion +
        ' differs from this package v' + protocol,
        'uninstall first, then install the matching version')
  }

  const { manifest, files } = readPackage(ASSISTANT_SRC, protocol)
  const query = assetQuery(manifest, files)
  const patched = clean.replace(/<\/body>/i, () => buildBlock() + '</body>')
  if (patched === clean) die('could not find </body> in index.html')

  if (args.check) {
    info('check-only: would patch index.html (+' + (patched.length - clean.length) + ' bytes)')
    info('check-only: would publish ' + Object.keys(files).length +
         ' file(s) for v' + manifest.version + ' (assetQuery ' + query + ')')
    if (markers.state === 'ours') info('check-only: re-installing over our own block (idempotent)')
    return
  }

  // One transaction from here on: the backup, the staging directory, the
  // index.html write and the swap all succeed, or the host is put back the way
  // it was found. What "the way it was found" means matters: a repair runs on
  // a host that already carries our entry block, so restoring `clean` (the
  // block stripped) would publish the old assets into a page that no longer
  // loads any assistant. The pre-image is the bytes read at the start.
  const preImage = html
  let stage = null
  let published = null
  const putIndexBack = function () {
    try {
      writeIndexAtomic(index, preImage)
      return true
    } catch (e) {
      return false
    }
  }
  try {
    backupIndex(index, clean)
    const staged = stagePackage(args.host, manifest, files, query)
    stage = staged.stage
    writeIndexAtomic(index, patched)
    published = publish(args.host, stage, {
      schema: STATE_SCHEMA,
      version: manifest.version,
      protocolVersion: manifest.protocolVersion,
      assetQuery: query,
      installedAt: new Date().toISOString(),
      updatedAt: null,
      host: {
        profileId: identity.profile ? identity.profile.id : null,
        identity: identity.status,
        upstreamCommit: identity.profile ? identity.profile.upstreamCommit : null,
        pristineIndexSha256: identity.indexHash,
        engineWasmSha256: identity.wasmHash
      },
      indexSha256Before: sha256(clean),
      indexSha256After: sha256(patched),
      files: staged.hashes,
      ownedPaths: [TARGET_DIR + '/', 'index.html (only the swe-assistant block)']
    }, existing ? existing.files : null)
    retireQuietly(published, liveDir)
    info('installed assistant v' + manifest.version + ' into ' + liveDir)
    info('host patch: 1 script tag in index.html (+' + (patched.length - clean.length) + ' bytes)')
    info('serve the host directory over HTTP and open it in Chrome.')
    return
  } catch (e) {
    if (stage) { try { fs.rmSync(stage, { recursive: true, force: true }) } catch (e2) {} }
    // Nothing else is swept here. writeIndexAtomic() removes the one temp file
    // it created; anything else matching index.html.*.swe-tmp in this directory
    // may be somebody's file or another run's, and a failed install is not
    // permission to delete it.
    // Two things can be half-done here and they are reported separately: the
    // assets (publish says whether it got the previous version back) and the
    // entry file. Claiming "nothing was installed" over a host that has the
    // new directory but the old state file would send the next run the wrong
    // way, so anything that did not come back is named.
    const rb = e.publish
    const assetsBack = !rb || rb.restored !== false
    const indexBack = putIndexBack()
    if (!assetsBack || !indexBack) {
      const broken = []
      if (!assetsBack) {
        const what = rb.firstInstall
          ? 'the new assistant files could NOT be removed from ' + TARGET_DIR + '/'
          : 'the previous assistant files could NOT be put back'
        broken.push(what + (rb.detail ? ' (' + rb.detail + ')' : ''))
      }
      if (!indexBack) broken.push('index.html could NOT be restored to its previous bytes')
      die('install failed: ' + e.message + '; ' + broken.join('; '),
          'the host is not in the state it was found in - check ' + TARGET_DIR + '/ and ' +
          OLD_PREFIX + '*/ and restore index.html from ' + path.join(args.host, BACKUP_DIR) +
          ' before using it')
    }
    die('install failed: ' + e.message,
        'nothing was installed; index.html and ' + TARGET_DIR + '/ are back to their previous state' +
        ' (a copy of the original index.html is kept in ' + BACKUP_DIR + '/)')
  }
}

main()
