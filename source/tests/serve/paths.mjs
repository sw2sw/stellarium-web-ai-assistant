#!/usr/bin/env node
/* Static-server path boundary tests — review item A9.
 *
 * The tool in tools/serve.mjs is a local verification server, not a
 * deployment server. These checks pin down the one thing it must get right:
 * a request can never read a file outside the served root, whether the path
 * climbs out with dot segments or through a symlink.
 *
 * usage: node tests/serve/paths.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SERVE = path.join(ROOT, 'tools', 'serve.mjs')

let failures = 0
function check (name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + JSON.stringify(detail) : ''))
  if (!ok) failures++
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-serve-'))
const root = path.join(tmp, 'site')
fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>root index</title>ROOT-INDEX')
fs.writeFileSync(path.join(root, 'sub', 'ok.txt'), 'INSIDE-OK')

// A sibling directory whose name shares the root's prefix: the classic
// string-startsWith() bypass.
const sibling = path.join(tmp, 'site-evil')
fs.mkdirSync(sibling, { recursive: true })
fs.writeFileSync(path.join(sibling, 'secret.txt'), 'SIBLING-SECRET')

// A file outside the root, and a symlink inside the root pointing at it.
// On Windows, file symlinks need elevation but directory junctions do not, so
// the two are attempted independently.
const outside = path.join(tmp, 'outside-secret.txt')
fs.writeFileSync(outside, 'OUTSIDE-SECRET')
let linkFile = false
let linkDir = false
try {
  fs.symlinkSync(outside, path.join(root, 'link.txt'), 'file')
  linkFile = true
} catch (e) { /* needs privileges on Windows */ }
try {
  fs.symlinkSync(sibling, path.join(root, 'linkdir'), 'junction')
  linkDir = true
} catch (e) { /* ditto */ }

const port = 8912
const child = spawn(process.execPath, [SERVE, root, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
let ready = false
child.stdout.on('data', d => { if (/serving /.test(String(d))) ready = true })

function get (p) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: 'GET'
    }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }))
    })
    req.on('error', e => resolve({ status: 0, body: 'ERR ' + e.message }))
    req.end()
  })
}

for (let i = 0; i < 100 && !ready; i++) await new Promise(r => setTimeout(r, 50))

if (!ready) {
  console.log('FAIL server did not start')
  child.kill()
  process.exit(1)
}

const inside = await get('/sub/ok.txt')
check('serves a file inside the root', inside.status === 200 && inside.body === 'INSIDE-OK', inside.status)

const dotdot = await get('/../../outside-secret.txt')
check('dot-dot traversal does not leak the outside file',
  !String(dotdot.body).includes('OUTSIDE-SECRET'), { status: dotdot.status })

const encoded = await get('/%2e%2e/%2e%2e/outside-secret.txt')
check('percent-encoded traversal does not leak the outside file',
  !String(encoded.body).includes('OUTSIDE-SECRET'), { status: encoded.status })

const siblingTry = await get('/../site-evil/secret.txt')
check('sibling directory with a shared prefix is not reachable',
  !String(siblingTry.body).includes('SIBLING-SECRET'), { status: siblingTry.status })

if (linkFile) {
  const viaLink = await get('/link.txt')
  check('symlink to a file outside the root is refused',
    !String(viaLink.body).includes('OUTSIDE-SECRET'), { status: viaLink.status })
} else {
  console.log('SKIP file-symlink check (cannot create file symlinks here)')
}

if (linkDir) {
  const viaLinkDir = await get('/linkdir/secret.txt')
  check('symlinked directory outside the root is refused',
    !String(viaLinkDir.body).includes('SIBLING-SECRET'), { status: viaLinkDir.status })
} else {
  console.log('SKIP directory-junction check (cannot create junctions here)')
}

const spa = await get('/some/deep/route')
check('unknown routes fall back to index.html (SPA)', spa.status === 200 && spa.body.includes('ROOT-INDEX'), spa.status)

child.kill()
fs.rmSync(tmp, { recursive: true, force: true })

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
