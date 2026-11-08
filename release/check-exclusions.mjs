#!/usr/bin/env node
// Prove that the source archive is built from an allowlist, not from "whatever
// happens to be in the working directory".
//
// The check copies this checkout to a temporary directory, plants the things a
// real candidate tree picks up after `git init` and a resumed test setup (.git
// with a remote that carries a credential, node_modules, a restored packages/,
// a dist/, a root .env), then runs the packaging script against that copy and
// asserts:
//
//   1. no planted path appears in the archive;
//   2. legitimate source under source/packages/ IS still archived (the deny rule
//      must not be a blunt "drop anything called packages");
//   3. the manifest reports what the rules skipped, so a skip is visible;
//   4. --git-commit rejects anything that is not a full 40-hex object id;
//   5. a valid --git-commit lands in the manifest and does not change the
//      archive bytes (the commit describes the source, it is not part of it);
//   6. no planted secret reaches the archive.
//
// Nothing here runs project tests, starts a server or touches the network.
//
//   node release/check-exclusions.mjs \
//     --repo . --dist /path/to/dist --pkg /path/to/assistant --out ../checks
//
// Writes <out>/exclusions.json and prints PASS/FAIL.

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawnSync } from 'child_process'

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i]
  if (!k.startsWith('--')) throw new Error('bad argument: ' + k)
  args[k.slice(2)] = process.argv[i + 1]
}
for (const k of ['repo', 'dist', 'pkg', 'out']) if (!args[k]) throw new Error('missing --' + k)

const repo = path.resolve(args.repo)
const dist = path.resolve(args.dist)
const pkg = path.resolve(args.pkg)
const outDir = path.resolve(args.out)
const script = path.join(repo, 'release', 'package-assets.mjs')
const version = JSON.parse(fs.readFileSync(path.join(repo, 'source/packages/assistant-web/manifest.json'), 'utf8')).version
const name = 'stellarium-web-ai-assistant-' + version + '-candidate'

const copyTree = (from, to) => {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name)
    const dst = path.join(to, e.name)
    if (e.isDirectory()) copyTree(src, dst)
    else if (e.isFile()) fs.copyFileSync(src, dst)
    // symlinks are not expected in this checkout; skip rather than follow
  }
}

const run = (cwd, extra) => {
  const argv = [script,
    '--repo', cwd,
    '--dist', dist,
    '--pkg', pkg,
    '--out', path.join(cwd, 'assets'),
    '--version', version, '--loader', '0.10.0',
    '--upstream', '1162c9ef73cc94f4762dfbfd24c637190119ea93',
    ...extra]
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

const listArchive = file => {
  const r = spawnSync('tar', ['--force-local', '-tzf', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error('tar -t failed: ' + r.stderr)
  return r.stdout.split('\n').filter(Boolean)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-excl-'))
const checks = []
const ok = (name, pass, detail) => checks.push({ check: name, pass: !!pass, detail })
// Random per run: a literal would be shipped inside release/check-exclusions.mjs
// itself (that file is part of the source archive), and the scan would then
// always hit its own text.
const SECRET = 'sk-' + crypto.randomBytes(16).toString('hex')
const TOKEN = 'tok-' + crypto.randomBytes(12).toString('hex')
const REMOTE = 'https://candidate:' + TOKEN + '@gitea.invalid/owner/repo.git'

try {
  const tree = path.join(work, 'repo')
  copyTree(repo, tree)

  // --- planted decoys, exactly what a committed/resumed tree collects ---------
  const plant = (rel, body) => {
    const p = path.join(tree, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  plant('.git/config', '[remote "origin"]\n\turl = ' + REMOTE + '\n')
  plant('.git/objects/pack/pack-deadbeef.pack', 'binary-ish\n')
  plant('.git/HEAD', 'ref: refs/heads/main\n')
  plant('node_modules/left-pad/index.js', 'module.exports = 1\n')
  plant('packages/integrated-web/dist/leak.txt', 'restored runtime, should not ship\n')
  plant('dist/leak.txt', 'root build output, should not ship\n')
  plant('.env', 'OPENAI_API_KEY=' + SECRET + '\n')
  plant('.env.local', 'MODEL_KEY=' + SECRET + '\n')
  plant('source/node_modules/x/index.js', 'nested dependency\n')
  plant('source/packages/__pycache__/x.pyc', 'bytecode\n')
  plant('tmp/scratch.txt', 'local scratch\n')
  plant('evidence/logs/private.txt', SECRET)
  plant('RESULT.md', 'Internal operation report: ' + SECRET)
  plant('HANDOVER.md', 'Internal handover: ' + SECRET)
  plant('source/ai-service-data/quota.json', SECRET)
  plant('source/private.key', SECRET)
  plant('source/.env', 'NESTED=' + SECRET + '\n')
  // Legitimate file that the deny rule must NOT swallow.
  plant('source/packages/assistant-web/ALLOWLIST-PROBE.txt', 'legitimate source file\n')

  // --- 1/2/3: build the source archive from the polluted tree ----------------
  const first = run(tree, ['--only', 'source'])
  ok('packaging exits 0 on a polluted tree', first.status === 0, first.stderr.trim() || first.stdout.trim())
  const srcArchive = path.join(tree, 'assets', name + '-project-source.tar.gz')
  ok('source archive exists', fs.existsSync(srcArchive), srcArchive)
  const entries = listArchive(srcArchive)
  const members = new Set(entries.map(e => e.replace(new RegExp('^' + name + '/'), '').replace(/\/$/, '')))

  const forbidden = [
    '.git', '.git/config', '.git/HEAD', '.git/objects/pack/pack-deadbeef.pack',
    'node_modules', 'node_modules/left-pad/index.js',
    'packages/integrated-web/dist/leak.txt',
    'dist/leak.txt',
    '.env', '.env.local', 'RESULT.md', 'HANDOVER.md',
    'source/node_modules', 'source/node_modules/x/index.js',
    'source/packages/__pycache__/x.pyc',
    'tmp', 'tmp/scratch.txt',
    'source/.env', 'evidence/logs/private.txt', 'source/ai-service-data/quota.json', 'source/private.key'
  ]
  const leaked = forbidden.filter(f => members.has(f))
  ok('no planted path is archived', leaked.length === 0, leaked.join(', ') || 'none of the planted paths appear')

  const anyGit = entries.filter(e => e.includes('/.git/') || e.endsWith('/.git'))
  const anyModules = entries.filter(e => e.includes('node_modules/'))
  ok('no .git anywhere in the archive', anyGit.length === 0, anyGit.slice(0, 3).join(', ') || 'clean')
  ok('no node_modules anywhere in the archive', anyModules.length === 0, anyModules.slice(0, 3).join(', ') || 'clean')

  ok('legitimate source/packages/ is still archived',
    members.has('source/packages/assistant-web/ALLOWLIST-PROBE.txt') && members.has('source/packages/host-adapter/loader.js'),
    'probe + loader.js present')
  ok('top-level project files are archived',
    ['README.md', 'LICENSE', 'NOTICE', 'THIRD-PARTY.md', '.gitignore']
      .every(f => members.has(f)),
    'README, LICENSE, NOTICE, THIRD-PARTY, .gitignore')
  ok('internal operation reports are not archived',
    !members.has('RESULT.md') && !members.has('HANDOVER.md'), 'RESULT and HANDOVER excluded')

  const manifest1 = JSON.parse(fs.readFileSync(path.join(tree, 'assets', 'RELEASE-MANIFEST.json'), 'utf8'))
  const scope = manifest1.source_archive || {}
  // Directory entries are reported with a trailing slash; compare on the bare path.
  const norm = set => new Set([...set].map(s => s.replace(/\/+$/, '')))
  const skipped = norm(scope.skipped_by_rules || [])
  const notListed = norm((scope.not_allowlisted || []).map(x => x.path))
  const reported = new Set([...skipped, ...notListed])
  // Inside the walked allowlist these are dropped by the deny rules...
  const expectedSkipped = ['.git', 'node_modules', 'packages', 'dist', '.env', '.env.local', 'tmp',
    'source/node_modules', 'source/packages/__pycache__', 'source/.env']
  // ...and at the root they never even get walked, so they must appear in the
  // "not on the allowlist" list. Either way the skip has to be reported.
  const notReported = expectedSkipped.filter(s => !reported.has(s))
  ok('manifest reports every skipped path', notReported.length === 0,
    notReported.length ? 'unreported: ' + notReported.join(', ') : [...reported].sort().join(', '))
  ok('root decoys are reported as not allowlisted',
    ['.git', 'node_modules', 'packages', 'dist', '.env', '.env.local', 'tmp'].every(s => notListed.has(s)),
    ['.git', 'node_modules', 'packages', 'dist', '.env', '.env.local', 'tmp']
      .map(s => s + (notListed.has(s) ? ' ok' : ' MISSING')).join(', '))
  ok('nested decoys are reported as skipped by rule',
    ['source/node_modules', 'source/packages/__pycache__', 'source/.env'].every(s => skipped.has(s)),
    [ 'source/node_modules', 'source/packages/__pycache__', 'source/.env']
      .map(s => s + (skipped.has(s) ? ' ok' : ' MISSING')).join(', '))
  ok('manifest says the source is not complete', manifest1.source_scope && manifest1.source_scope.complete === false,
    manifest1.source_scope ? 'complete=' + manifest1.source_scope.complete + ', missing=' + manifest1.source_scope.missing_components.map(m => m.component).join(',') : 'no source_scope')
  ok('manifest uses the project-source role', (manifest1.assets || []).every(a => a.role === 'project-source'),
    (manifest1.assets || []).map(a => a.role).join(','))

  // --- 4: a bad --git-commit must be refused --------------------------------
  for (const badValue of ['HEAD', '1162c9ef', '1162C9EF73CC94F4762DFBFD24C637190119EA93', 'z'.repeat(40)]) {
    const bad = run(tree, ['--only', 'source', '--git-commit', badValue])
    ok('--git-commit rejects "' + badValue + '"', bad.status !== 0 && /git-commit must be/.test(bad.stderr + bad.stdout),
      (bad.stderr || bad.stdout).trim().split('\n').slice(-1)[0])
  }

  // --- 5: a valid commit lands in the manifest, archive bytes unchanged ------
  const commit = 'a1b2c3d4e5f60718293a94b5c6d7e8f901234567'
  const before = crypto.createHash('sha256').update(fs.readFileSync(srcArchive)).digest('hex')
  const bound = run(tree, ['--only', 'source', '--git-commit', commit])
  ok('packaging accepts a full 40-hex commit', bound.status === 0, bound.stdout.trim().split('\n').slice(-1)[0])
  const manifest2 = JSON.parse(fs.readFileSync(path.join(tree, 'assets', 'RELEASE-MANIFEST.json'), 'utf8'))
  ok('manifest records the commit', manifest2.git_commit === commit, 'git_commit=' + manifest2.git_commit)
  const after = crypto.createHash('sha256').update(fs.readFileSync(srcArchive)).digest('hex')
  ok('binding a commit does not change the archive bytes', before === after, before.slice(0, 16) + ' -> ' + after.slice(0, 16))
  ok('unbound run leaves git_commit null', manifest1.git_commit === null, String(manifest1.git_commit))

  // --- 6: no planted secret in the archive ---------------------------------
  const raw = spawnSync('tar', ['--force-local', '-xzOf', srcArchive], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 })
  const text = raw.stdout ? raw.stdout.toString('latin1') : ''
  ok('planted secret does not reach the archive', text.indexOf(SECRET) < 0 && text.indexOf(TOKEN) < 0,
    'scanned ' + text.length + ' bytes of archive payload')

  // --- SUMS covers the manifest, manifest does not cite SUMS ----------------
  const sums = fs.readFileSync(path.join(tree, 'assets', 'SHA256SUMS'), 'utf8').trim().split('\n')
  const sumsNames = sums.map(l => l.replace(/^\w+ \*/, ''))
  ok('SHA256SUMS covers the manifest', sumsNames.includes('RELEASE-MANIFEST.json'), sumsNames.join(', '))
  ok('SHA256SUMS does not hash itself', !sumsNames.includes('SHA256SUMS'), sumsNames.join(', '))
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}

const failures = checks.filter(c => !c.pass)
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'exclusions.json'), JSON.stringify({
  checked_at: new Date().toISOString(),
  subject: 'source archive scope: allowlist, deny rules, commit binding, secret exclusion',
  method: 'copy the checkout to a temporary directory, plant .git/node_modules/packages/dist/.env decoys, run release/package-assets.mjs --only source against the copy, inspect the archive and the manifest; the temporary directory is removed afterwards',
  planted: {
    git_remote: 'https://candidate:<redacted>@gitea.invalid/owner/repo.git',
    env_secret: 'sk-<redacted sentinel>',
    legitimate_probe: 'source/packages/assistant-web/ALLOWLIST-PROBE.txt'
  },
  checks, failures: failures.length,
  verdict: failures.length === 0 ? 'PASS' : 'FAIL'
}, null, 2) + '\n')

for (const c of checks) console.log((c.pass ? 'PASS ' : 'FAIL ') + c.check + (c.pass ? '' : '  <-- ' + c.detail))
console.log('')
console.log(failures.length === 0 ? 'PASS all ' + checks.length + ' exclusion checks' : 'FAIL ' + failures.length + ' of ' + checks.length)
process.exit(failures.length === 0 ? 0 : 1)
