#!/usr/bin/env node
/* Minimal static server for LOCAL VERIFICATION ONLY.
 *
 * This is a test tool, not a deployment server: it has no authentication, no
 * rate limiting and no TLS. It binds loopback on purpose. Stage D must use a
 * reviewed static server instead of pointing this one at a public interface
 * (see docs/INSTALL.md and review item A9).
 *
 * Adds the MIME types the Stellarium Web host needs and an SPA fallback so
 * /skysource/<name> routes work like they do behind the real deployment.
 *
 * usage: node tools/serve.mjs <dir> [port]
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const root = fs.realpathSync(path.resolve(process.argv[2] || '.'))
const port = Number(process.argv[3] || 8899)

// Resolve a request path inside `root`, or return null when it escapes.
// Comparing strings is not enough: `/srv/site-evil` starts with `/srv/site`,
// and a symlink can point anywhere. Resolve the real path and then check the
// directory boundary segment by segment.
function resolveInside (urlPath) {
  const candidate = path.join(root, urlPath)
  const rel = path.relative(root, candidate)
  if (rel === '') return root
  if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) return null
  return candidate
}

function realInside (p) {
  let real
  try { real = fs.realpathSync(p) } catch { return null }
  const rel = path.relative(root, real)
  if (rel === '') return real
  if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) return null
  return real
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.dat': 'application/octet-stream',
  '.gz': 'application/gzip'
}

http.createServer((req, res) => {
  let urlPath
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  } catch {
    res.writeHead(400).end('bad request')
    return
  }
  const target = resolveInside(urlPath)
  if (target === null) {
    res.writeHead(403).end('forbidden')
    return
  }
  let file = target
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
  if (!fs.existsSync(file)) file = path.join(root, 'index.html') // SPA fallback

  // Follow the real path and re-check the boundary: a symlink inside the tree
  // must not become a way to read files outside it.
  const real = realInside(file)
  if (real === null) {
    res.writeHead(403).end('forbidden')
    return
  }
  file = real

  const ext = path.extname(file).toLowerCase()
  const type = MIME[ext] || 'application/octet-stream'
  const headers = { 'Content-Type': type }
  // The assistant must never be served from a stale cache during updates.
  if (path.relative(root, file).split(path.sep)[0] === 'ai-assistant') {
    headers['Cache-Control'] = 'no-store'
  }
  try {
    const buf = fs.readFileSync(file)
    headers['Content-Length'] = buf.length
    res.writeHead(200, headers).end(buf)
  } catch (e) {
    res.writeHead(500).end('read error')
  }
}).listen(port, '127.0.0.1', () => {
  console.log('serving ' + root + ' on http://127.0.0.1:' + port + '/')
  console.log('NOTE: local verification only — loopback, no auth, no TLS.')
})
