#!/usr/bin/env node
// Build the Release assets from already-reviewed inputs, then write the release
// manifest and its SHA256SUMS. No network, no downloads, no rebuild: the
// runtime site and the assistant package are used exactly as delivered.
//
//   node release/package-assets.mjs \
//     --repo  ..                      # this checkout (the candidate source tree)
//     --dist  /path/to/integrated-web/dist \
//     --pkg   /path/to/assistant      # the standalone assistant package
//     --out   ../assets               # where the tarballs and manifests go
//     --version 0.14.0 --loader 0.11.0 --upstream 1162c9ef...
//     [--git-commit <40 hex>]         # optional; bound after the candidate commit exists
//     [--only source]                 # optional; comma list of runtime,assistant,source
//
// The source archive is built from an EXPLICIT allowlist, never by handing the
// working directory to tar. A checkout that happens to be clean today is not a
// guarantee: the moment the candidate is committed, `.git/` exists, and a
// resumed test setup leaves `packages/`, `node_modules/` or a real `.env`
// behind. Whatever is not named below is not archived, and anything the deny
// rules skip is reported in the manifest so the skip is visible rather than
// silent.
//
// Layout inside each archive is a single top-level directory, so extraction is
// predictable and never writes loose files into the current directory:
//   runtime .tar.gz  -> dist/...
//   assistant .tar.gz-> assistant/...
//   source .tar.gz   -> stellarium-web-ai-assistant-<version>-candidate/...
//
// Determinism: entries are sorted, mtime/owner are pinned, and gzip runs through
// zlib (no filename, no timestamp in the header). Same inputs -> same bytes.

import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import crypto from 'crypto'
import { spawnSync } from 'child_process'

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i]
  if (!k.startsWith('--')) throw new Error('bad argument: ' + k)
  args[k.slice(2)] = process.argv[i + 1]
}
const need = ['repo', 'dist', 'pkg', 'out', 'version', 'loader', 'upstream']
for (const k of need) if (!args[k]) throw new Error('missing --' + k)

const repo = path.resolve(args.repo)
const dist = path.resolve(args.dist)
const pkg = path.resolve(args.pkg)
const out = path.resolve(args.out)
const name = 'stellarium-web-ai-assistant-' + args.version + '-candidate'
fs.mkdirSync(out, { recursive: true })

// --- git commit binding ------------------------------------------------------
// Null is honest ("not in Git yet"); a value must be a real object id, so a
// placeholder like "HEAD" or a short SHA cannot end up in a release manifest.
const gitCommit = args['git-commit'] || null
if (gitCommit !== null && !/^[0-9a-f]{40}$/.test(gitCommit)) {
  throw new Error('--git-commit must be a full 40-character lowercase hex object id, got: ' + gitCommit)
}

// --- source archive scope ----------------------------------------------------
// Top-level entries that are allowed into the source archive. Everything else
// at the root (packages/, dist/, .git/, tmp/ ...) is out by default: the
// allowlist fails closed, so a new top-level directory has to be added here
// deliberately instead of slipping into a release by existing.
const ROOT_ALLOW = [
  'README.md',
  '.gitignore',
  'LICENSE',
  'NOTICE',
  'THIRD-PARTY.md',

  'source',
  'release'
]
// Skipped at any depth. These are build/test by-products or metadata that must
// never travel: `.git` carries history and remote config, `node_modules` is
// reproducible, `.env*` may hold credentials.
const DENY_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv',
  '.pytest_cache', '.mypy_cache', '.idea', '.vscode', '.cache', 'evidence', 'ai-service-data'])
const DENY_FILE_RE = /^(\.env(\..*)?|\.DS_Store|Thumbs\.db|\.desktop\.ini|.*\.pyc|.*\.swp|.*\.tmp|.*\.bak|.*\.orig|.*\.key|.*\.db(?:-wal|-shm)?|quota\.json|identity\.key)$/

function sourceEntries () {
  for (const top of ROOT_ALLOW) {
    if (!fs.existsSync(path.join(repo, top))) throw new Error('allowlisted entry is missing from the checkout: ' + top)
  }
  // Root entries that exist but are not named above. They are not even walked;
  // listing them keeps "we chose not to ship this" visible instead of silent.
  const notAllowlisted = fs.readdirSync(repo)
    .filter(n => !ROOT_ALLOW.includes(n))
    .sort()
    .map(n => ({ path: n + (fs.lstatSync(path.join(repo, n)).isDirectory() ? '/' : ''), reason: 'not on the allowlist' }))
  const files = []
  const dirs = []
  const skipped = []
  const walk = rel => {
    const abs = path.join(repo, rel)
    const st = fs.lstatSync(abs)
    if (st.isSymbolicLink()) {
      // A link would make the archive's contents depend on something outside the
      // tree, and extractors disagree on whether to follow it. Refuse loudly.
      throw new Error('symbolic link in the source tree, refusing to archive: ' + rel)
    }
    if (st.isDirectory()) {
      if (DENY_DIRS.has(path.basename(rel))) { skipped.push(rel + '/'); return }
      dirs.push(rel + '/')
      for (const child of fs.readdirSync(abs).sort()) walk(rel + '/' + child)
      return
    }
    if (DENY_FILE_RE.test(path.basename(rel))) { skipped.push(rel); return }
    files.push(rel)
  }
  for (const top of ROOT_ALLOW) walk(top)
  return { entries: [...dirs, ...files].sort(), files: files.length, dirs: dirs.length, skipped, notAllowlisted }
}

const MTIME = '2026-10-31 00:00:00 UTC'
const tarCommon = ['--sort=name', '--mtime=' + MTIME, '--owner=0', '--group=0', '--numeric-owner', '--format=gnu']

function tarGz (dest, cwd, entries, transform, opts = {}) {
  const tarPath = dest.replace(/\.gz$/, '')
  // --force-local: on Windows an archive path like C:\tmp\x.tar contains a
  // colon, which GNU tar otherwise reads as "remote host C". The flag makes tar
  // treat it as a local path. Harmless on POSIX.
  const argv = ['--force-local', '-cf', tarPath, ...tarCommon]
  let listFile = null
  if (opts.explicit) {
    // Archive exactly the listed paths, directory entries included and NOT
    // descended into. Used for the source tree, where the list is the allowlist.
    listFile = tarPath + '.list'
    fs.writeFileSync(listFile, entries.join('\n') + '\n')
    argv.push('--no-recursion', '-T', listFile)
  } else {
    // A single directory, archived recursively (runtime site, assistant package).
    argv.push(...entries)
  }
  if (transform) argv.push('--transform', transform)
  try {
    const r = spawnSync('tar', argv, { cwd, encoding: 'utf8' })
    if (r.status !== 0) throw new Error('tar failed: ' + (r.stderr || r.error))
  } finally {
    if (listFile) fs.rmSync(listFile, { force: true })
  }
  const raw = fs.readFileSync(tarPath)
  fs.writeFileSync(dest, zlib.gzipSync(raw, { level: 9 }))
  fs.rmSync(tarPath, { force: true })
  const sha = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex')
  return { file: path.basename(dest), bytes: fs.statSync(dest).size, sha256: sha }
}

// Which assets to build. `--only` exists so a reviewer can rebuild just the
// source archive (the one with the allowlist rules) without repacking 9.6 MB of
// runtime that did not change.
const ALL = ['runtime', 'assistant', 'source']
const only = args.only ? args.only.split(',').map(s => s.trim()).filter(Boolean) : ALL
for (const o of only) if (!ALL.includes(o)) throw new Error('unknown asset in --only: ' + o)

const built = {}
if (only.includes('runtime')) {
  // runtime site: everything under dist/, top-level directory kept as "dist"
  built.runtime = tarGz(path.join(out, name + '-runtime.tar.gz'), path.dirname(dist), [path.basename(dist)])
}
if (only.includes('assistant')) {
  built.assistant = tarGz(path.join(out, name + '-assistant.tar.gz'), path.dirname(pkg), [path.basename(pkg)])
}
let sourceScope = null
if (only.includes('source')) {
  // project source: an allowlisted subset of this checkout, renamed to a stable
  // top-level directory. It is NOT the complete corresponding source - see
  // source_scope in the manifest.
  sourceScope = sourceEntries()
  built.source = tarGz(
    path.join(out, name + '-project-source.tar.gz'),
    repo,
    sourceScope.entries,
    's,^,' + name + '/,',
    { explicit: true }
  )
}

const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const publishedManifest = JSON.parse(fs.readFileSync(path.join(repo, 'source/packages/assistant-web/manifest.json'), 'utf8'))
const core = [...new Set([publishedManifest.entry, publishedManifest.style,
  ...(publishedManifest.references || []), 'manifest.json', 'loader.js'])]
  .map(file => [file, file === 'loader.js'
    ? 'source/packages/host-adapter/loader.js' : 'source/packages/assistant-web/' + file])
const coreHashes = {}
for (const [file, rel] of core) {
  coreHashes[file] = { source: hash(path.join(repo, rel)), package: hash(path.join(pkg, file)) }
  if (coreHashes[file].source !== coreHashes[file].package) throw new Error('source/package mismatch: ' + file)
  if (file !== 'manifest.json' && hash(path.join(dist, 'ai-assistant', file)) !== coreHashes[file].source) throw new Error('source/runtime mismatch: ' + file)
}

const roleOf = { runtime: 'runtime-site', assistant: 'assistant-package', source: 'project-source' }
const unpackOf = { runtime: 'dist/', assistant: 'assistant/', source: name + '/' }

const manifest = {
  schema: 2,
  component: 'stellarium-web-ai-assistant',
  version: args.version,
  bridge: { loader: args.loader, protocolVersion: 2 },
  upstream: {
    repository: 'https://github.com/Stellarium/stellarium-web-engine',
    commit: args.upstream,
    licence: 'AGPL-3.0'
  },
  built_from: 'reviewed delivery snapshot; no rebuild, no network',
  generated_at: new Date().toISOString(),
  git_commit: gitCommit,
  git_commit_note: gitCommit
    ? 'Full object id of the candidate commit this source archive was cut from.'
    : 'Source is not in Git yet. Pass --git-commit <40 hex> after the candidate commit exists; until then this is null on purpose, not a released commit.',
  assets: only.map(k => ({
    role: roleOf[k],
    file: built[k].file,
    bytes: built[k].bytes,
    sha256: built[k].sha256,
    unpack_to: unpackOf[k]
  })),
  // The runtime asset contains a build of an AGPL-3.0 work, so distribution
  // requires the complete corresponding source. This package is not that: it
  // carries the project source, the pinned commit, the patches and the build
  // recipe, but not the upstream tree itself. Saying so in the machine-readable
  // manifest is the point - a name alone must not imply completeness.
  source_scope: {
    complete: false,
    archive_role: 'project-source',
    contains: [
      'this project\'s source, tests, tools and docs (source/)',
      'the three host patches and Dockerfile.engine (source/upstream/patches/)',
      'upstream lock: repository, commit, licence, change list (source/upstream/LOCK.md)',
      'build recipe (source/docs/UPSTREAM-BUILD.md)',
      'licence texts (LICENSE, NOTICE, THIRD-PARTY.md)'
    ],
    missing_components: [{
      component: 'stellarium-web-engine',
      repository: 'https://github.com/Stellarium/stellarium-web-engine',
      commit: args.upstream,
      paths: ['apps/web-frontend', 'src', 'apps/test-skydata'],
      reason: 'The upstream checkout is not present on the packaging host and downloading it is outside this task. The archive is therefore project-source, not the complete corresponding source for the runtime asset.'
    }],
    acquisition: 'See release/SOURCE-ACCESS.md: exact pinned Git/tree/archive routes plus this project source and three patches.',
    how_to_complete: 'Verify the matching source and build materials are actually accessible to website users; the pinned upstream tree is not bundled and the project source route for users is unresolved. Do not flip complete on the strength of a URL alone.'
  },
  source_archive: sourceScope
    ? {
        built_from_allowlist: true,
        allowlist: ROOT_ALLOW,
        files: sourceScope.files,
        directories: sourceScope.dirs,
        skipped_by_rules: sourceScope.skipped,
        not_allowlisted: sourceScope.notAllowlisted
      }
    : null,
  core_files: coreHashes,
  evidence_scope: {
    prior_acceptance: 'Functional verification is documented separately; raw internal evidence is not distributed.',
    current_run: 'Local archive integrity and exclusion checks only; no model calls, rebuild or deployment by these tools.',
    model_limits: 'Generated content may be inaccurate, incomplete or empty; transport success is not scientific validation.'
  }
}
const manifestPath = path.join(out, 'RELEASE-MANIFEST.json')
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

// The sums file covers every asset AND the manifest. That is not circular: the
// manifest records the archives' hashes, the sums file records the manifest's
// hash, and the manifest never records the sums file. Only the sums file would
// be circular by hashing itself, so it does not.
const sumsFiles = only.map(k => built[k])
sumsFiles.push({ file: 'RELEASE-MANIFEST.json', sha256: hash(manifestPath) })
const sums = sumsFiles.map(a => a.sha256 + ' *' + a.file).join('\n') + '\n'
fs.writeFileSync(path.join(out, 'SHA256SUMS'), sums)

for (const k of only) {
  const a = built[k]
  console.log(roleOf[k] + '  ' + a.file + '  ' + a.bytes + ' B  ' + a.sha256.slice(0, 16) + '…')
}
if (sourceScope) {
  console.log('source archive: ' + sourceScope.files + ' files, ' + sourceScope.dirs + ' dirs, ' +
    sourceScope.skipped.length + ' path(s) skipped by rule, ' +
    sourceScope.notAllowlisted.length + ' root path(s) not on the allowlist, complete=false')
}
console.log('git_commit: ' + (gitCommit || 'null (not bound yet)'))
console.log('RELEASE-MANIFEST.json + SHA256SUMS written to ' + out)
