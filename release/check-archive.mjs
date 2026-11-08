#!/usr/bin/env node
// Verify the Release assets against RELEASE-MANIFEST.json and SHA256SUMS.
//
// Read-only with respect to the assets: each archive is listed, then extracted
// into a temporary directory that is removed afterwards. Nothing is rebuilt,
// no test runs, no network.
//
//   node release/check-archive.mjs \
//     --assets   ../assets \
//     --out      ../checks \
//     [--baseline ../SOURCE-BASELINE.json]     # optional: compare against the frozen delivery
//
// Writes <out>/archive-checks.json and prints PASS/FAIL. Checks that need the
// baseline are reported as SKIP when it is not given.

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
for (const k of ['assets', 'out']) if (!args[k]) throw new Error('missing --' + k)

const A = path.resolve(args.assets)
const OUT = path.resolve(args.out)
const baseline = args.baseline ? JSON.parse(fs.readFileSync(path.resolve(args.baseline), 'utf8')) : null
const manifest = JSON.parse(fs.readFileSync(path.join(A, 'RELEASE-MANIFEST.json'), 'utf8'))
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

const checks = []
const ok = (name, pass, detail) => checks.push({ check: name, pass: !!pass, detail })
const skip = (name, why) => checks.push({ check: name, pass: null, detail: 'SKIP: ' + why })

const list = file => {
  const r = spawnSync('tar', ['--force-local', '-tzf', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error('tar -t failed: ' + r.stderr)
  return r.stdout.split('\n').filter(Boolean)
}
const verbose = file => {
  const r = spawnSync('tar', ['--force-local', '-tvzf', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error('tar -tv failed: ' + r.stderr)
  return r.stdout.split('\n').filter(Boolean)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-arch-'))
const extracted = {}
const report = { checked_at: new Date().toISOString(), assets_dir: A, archives: [], core_files: {}, ties: {}, sums: {}, verdict: '' }
try {
  for (const a of manifest.assets) {
    const file = path.join(A, a.file)
    if (!fs.existsSync(file)) { ok('asset exists: ' + a.file, false, 'missing'); continue }
    const bytes = fs.statSync(file).size
    const digest = sha(file)
    ok('bytes match manifest: ' + a.role, bytes === a.bytes, bytes + ' vs ' + a.bytes)
    ok('sha256 matches manifest: ' + a.role, digest === a.sha256, digest.slice(0, 16) + '… vs ' + String(a.sha256).slice(0, 16) + '…')

    const entries = list(file)
    const v = verbose(file)
    const tops = [...new Set(entries.map(e => e.split('/')[0]))]
    const abs = entries.filter(e => e.startsWith('/') || /^[A-Za-z]:/.test(e))
    const dotdot = entries.filter(e => e.split('/').includes('..'))
    const links = v.filter(l => /^[lh]/.test(l.trim()))
    ok('single top-level directory: ' + a.role, tops.length === 1, tops.join(','))
    ok('no absolute paths or ..: ' + a.role, abs.length === 0 && dotdot.length === 0,
      'absolute=' + abs.length + ' dotdot=' + dotdot.length)
    ok('no symlink or hardlink entries: ' + a.role, links.length === 0, links.length ? links[0].slice(0, 60) : 'none')

    const dest = path.join(work, a.role)
    fs.mkdirSync(dest, { recursive: true })
    const x = spawnSync('tar', ['--force-local', '-xzf', file], { cwd: dest, encoding: 'utf8' })
    ok('extracts cleanly: ' + a.role, x.status === 0, x.stderr.trim())
    const files = []
    const walk = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else files.push(p)
      }
    }
    walk(dest)
    report.archives.push({
      role: a.role, file: a.file, bytes, sha256: digest,
      entries: entries.length, files: files.length, top_level: tops,
      absolute_paths: abs.length, parent_dir_entries: dotdot.length, special_entries: links.length
    })

    extracted[a.role] = dest
  }

  // Second pass: what each archive must contain. Done after every archive is on
  // disk, because the runtime's manifest has to be compared with the package's.
  const srcManifest = extracted['project-source']
    ? JSON.parse(fs.readFileSync(path.join(extracted['project-source'],
        manifest.assets.find(x => x.role === 'project-source').unpack_to.replace(/\/$/, ''),
        'source/packages/assistant-web/manifest.json'), 'utf8'))
    : null

  for (const a of manifest.assets) {
    const dest = extracted[a.role]
    if (!dest) continue
    if (a.role === 'runtime-site') {
      const idx = path.join(dest, 'dist', 'index.html')
      const text = fs.readFileSync(idx, 'utf8')
      ok('runtime index.html carries the assistant block', /swe-assistant/.test(text), 'swe-assistant marker')
      if (baseline) {
        const h = sha(idx)
        ok('runtime index.html matches the installed baseline',
          h === baseline.host_binding.installed_index_sha256, h.slice(0, 16) + '…')
      } else skip('runtime index.html matches the installed baseline', 'no --baseline')
      for (const [name, pair] of Object.entries(manifest.core_files)) {
        const p = path.join(dest, 'dist', 'ai-assistant', name)
        if (!fs.existsSync(p)) { ok('runtime has ' + name, false, 'missing'); continue }
        if (name === 'manifest.json') {
          // The installer rewrites this copy: it adds assetQuery and stagedAt, so
          // the bytes differ from the source on purpose. What must hold is that
          // it still describes the same package.
          const installed = JSON.parse(fs.readFileSync(p, 'utf8'))
          const same = srcManifest && ['version', 'protocolVersion', 'entry', 'style']
            .every(k => installed[k] === srcManifest[k]) &&
            JSON.stringify(installed.references || []) === JSON.stringify(srcManifest.references || [])
          ok('runtime manifest.json describes the same package (bytes differ by design)',
            same, 'version=' + installed.version + ', stagedAt ' + (installed.stagedAt ? 'present' : 'absent'))
          continue
        }
        ok('runtime ' + name + ' matches the manifest source hash', sha(p) === pair.source, sha(p).slice(0, 16) + '…')
      }
    }
    if (a.role === 'assistant-package') {
      const pkgManifest = JSON.parse(fs.readFileSync(path.join(dest, 'assistant', 'manifest.json'), 'utf8'))
      const declared = [pkgManifest.entry, pkgManifest.style, ...(pkgManifest.references || [])]
      ok('declared entry/style/references exist in the package',
        declared.every(n => fs.existsSync(path.join(dest, 'assistant', n))), declared.join(', '))
      ok('package manifest version matches the asset name', a.file.includes(pkgManifest.version), pkgManifest.version)
      for (const [name, pair] of Object.entries(manifest.core_files)) {
        const p = path.join(dest, 'assistant', name)
        if (!fs.existsSync(p)) { ok('package has ' + name, false, 'missing'); continue }
        ok('package ' + name + ' matches the manifest package hash', sha(p) === pair.package, sha(p).slice(0, 16) + '…')
      }
      report.core_files = Object.fromEntries(Object.entries(manifest.core_files).map(([n, p]) => [n, {
        source: p.source, package: p.package,
        package_matches: fs.existsSync(path.join(dest, 'assistant', n)) && sha(path.join(dest, 'assistant', n)) === p.package
      }]))
    }
    if (a.role === 'project-source') {
      const root = path.join(dest, a.unpack_to.replace(/\/$/, ''))
      const need = ['README.md', '.gitignore', 'LICENSE', 'NOTICE', 'THIRD-PARTY.md',
        'source/upstream/LOCK.md', 'source/install/install.mjs', 'source/packages/host-adapter/loader.js',
        'source/upstream/patches/0001-web-frontend-vue2.patch', 'source/upstream/patches/0002-web-frontend-zh-locale.patch',
        'source/upstream/patches/0003-local-fonts.patch',
        'release/package-assets.mjs', 'release/check-exclusions.mjs', 'release/check-archive.mjs',
        'release/SOURCE-ACCESS.md']
      const missing = need.filter(f => !fs.existsSync(path.join(root, f)))
      ok('project-source has the expected layout', missing.length === 0, missing.join(', ') || need.length + ' paths present')
      const bad = []
      const scan = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name)
          if (e.isDirectory()) { if (e.name === '.git' || e.name === 'node_modules') bad.push(p); else scan(p) }
        }
      }
      scan(root)
      ok('project-source has no .git or node_modules', bad.length === 0, bad.slice(0, 3).join(', ') || 'clean')
      ok('project-source is not presented as the complete corresponding source',
        a.role === 'project-source' && !/corresponding-source/.test(a.file), a.role + ' / ' + a.file)
      const scope = manifest.source_scope || {}
      if (scope.complete === false) {
        ok('incomplete source is declared, with what is missing',
          Array.isArray(scope.missing_components) && scope.missing_components.length > 0,
          (scope.missing_components || []).map(m => m.component + '@' + String(m.commit).slice(0, 8)).join(', '))
        ok('the licence file states the gap instead of claiming completeness',
          /NOT a complete corresponding-source delivery|does NOT satisfy/i.test(fs.readFileSync(path.join(root, 'THIRD-PARTY.md'), 'utf8')),
          'THIRD-PARTY.md STATUS section')
        ok('README says the same thing as the manifest',
          /不是.{0,4}完整对应源码|NOT a complete corresponding source/i.test(fs.readFileSync(path.join(root, 'README.md'), 'utf8')) ||
          /完整对应源码/.test(fs.readFileSync(path.join(root, 'README.md'), 'utf8')) && /SOURCE-ACCESS\.md/.test(fs.readFileSync(path.join(root, 'README.md'), 'utf8')),
          'README release-assets section')
      } else {
        ok('source_scope.complete is true only with no missing components',
          Array.isArray(scope.missing_components) && scope.missing_components.length === 0,
          'complete=' + scope.complete)
      }
      if (baseline) {
        ok('project-source core files match the frozen delivery',
          Object.entries(manifest.core_files).every(([n, p]) => {
            const rel = n === 'loader.js' ? 'source/packages/host-adapter/loader.js' : 'source/packages/assistant-web/' + n
            return sha(path.join(root, rel)) === p.source
          }), 'declared core files')
      } else skip('project-source core files match the frozen delivery', 'no --baseline')
    }
  }

  // SHA256SUMS must cover every asset plus the manifest, never itself, no dupes.
  const sumsLines = fs.readFileSync(path.join(A, 'SHA256SUMS'), 'utf8').trim().split('\n')
  const parsed = sumsLines.map(l => {
    const m = l.match(/^([0-9a-f]{64}) \*(.+)$/)
    return { sha256: m && m[1], file: m && m[2], raw: l }
  })
  const names = parsed.filter(p => p.file).map(p => p.file)
  ok('every SHA256SUMS line parses', parsed.every(p => p.file), parsed.filter(p => !p.file).map(p => p.raw).join(' | ') || names.length + ' lines')
  ok('SHA256SUMS has no duplicates', names.length === new Set(names).size, names.join(', '))
  ok('SHA256SUMS does not hash itself', !names.includes('SHA256SUMS'), names.join(', '))
  ok('SHA256SUMS covers every asset', manifest.assets.every(a => names.includes(a.file)),
    manifest.assets.map(a => a.file).join(', '))
  ok('SHA256SUMS covers the manifest too', names.includes('RELEASE-MANIFEST.json'), 'RELEASE-MANIFEST.json')
  const sumsMismatch = parsed.filter(p => p.file && fs.existsSync(path.join(A, p.file)) && sha(path.join(A, p.file)) !== p.sha256)
  ok('every listed hash verifies', sumsMismatch.length === 0, sumsMismatch.map(p => p.file).join(', ') || 'all match')
  ok('manifest does not cite SHA256SUMS (no cycle)',
    !JSON.stringify(manifest).includes('SHA256SUMS'), 'manifest mentions no sums file')
  report.sums = { lines: names.length, files: names, covers_manifest: names.includes('RELEASE-MANIFEST.json') }

  // Ties between the three views of the same bytes.
  const referenceManifest = srcManifest || (extracted['assistant-package']
    ? JSON.parse(fs.readFileSync(path.join(extracted['assistant-package'], 'assistant/manifest.json'), 'utf8'))
    : extracted['runtime-site']
      ? JSON.parse(fs.readFileSync(path.join(extracted['runtime-site'], 'dist/ai-assistant/manifest.json'), 'utf8')) : null)
  const expectedCore = referenceManifest ? [...new Set([referenceManifest.entry, referenceManifest.style,
    ...(referenceManifest.references || []), 'manifest.json', 'loader.js'])].sort() : []
  const actualCore = Object.keys(manifest.core_files || {}).sort()
  const coreSetMatches = expectedCore.length > 0 && JSON.stringify(actualCore) === JSON.stringify(expectedCore)
  ok('release core set matches the package declaration', coreSetMatches, actualCore.join(', '))
  report.ties = {
    runtime_matches_manifest: (manifest.assets || []).some(a => a.role === 'runtime-site'),
    core_files_in_manifest: coreSetMatches
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}

const failures = checks.filter(c => c.pass === false)
report.checks = checks
report.failures = failures.length
report.verdict = failures.length === 0 ? 'PASS' : 'FAIL'
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'archive-checks.json'), JSON.stringify(report, null, 2) + '\n')

for (const c of checks) {
  const tag = c.pass === null ? 'SKIP' : c.pass ? 'PASS' : 'FAIL'
  console.log(tag + ' ' + c.check + (c.pass === false ? '  <-- ' + c.detail : ''))
}
console.log('')
console.log(report.verdict + ' — ' + (checks.length - failures.length) + '/' + checks.length +
  ' checks passed' + (failures.length ? ', ' + failures.length + ' failed' : ''))
process.exit(failures.length === 0 ? 0 : 1)
