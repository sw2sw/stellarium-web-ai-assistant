/* Static file distribution for the integrated site.
 *
 * Extracted from tools/serve.mjs so the deployment server and the local test
 * server cannot drift apart on the one thing that is security relevant: the
 * directory boundary check. tools/serve.mjs keeps its own copy on purpose -
 * it is a test tool that must stay runnable without the service package.
 */

import fs from 'node:fs'
import path from 'node:path'

export const MIME = {
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

export function createStatic (rootDir) {
  const root = fs.realpathSync(path.resolve(rootDir))

  function inside (p) {
    const rel = path.relative(root, p)
    if (rel === '') return p
    if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) return null
    return p
  }

  function realInside (p) {
    let real
    try { real = fs.realpathSync(p) } catch { return null }
    return inside(real)
  }

  return {
    root,
    /* Returns {status, headers, body} or null when nothing matches. Never
     * writes to the response itself, so the caller owns headers like
     * Cache-Control and the security headers. */
    resolve (urlPath) {
      const joined = inside(path.join(root, urlPath))
      if (joined === null) return { status: 403, body: 'forbidden' }

      let file = joined
      try {
        if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
      } catch { /* fall through to the SPA fallback */ }

      let real = realInside(file)
      if (real === null) {
        // SPA fallback: /skysource/<name> and friends are client routes.
        real = realInside(path.join(root, 'index.html'))
        if (real === null) return null
      }

      let buf
      try {
        buf = fs.readFileSync(real)
      } catch {
        return null
      }
      const ext = path.extname(real).toLowerCase()
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': buf.length
      }
      // The assistant bundle must never come from a stale cache during an
      // update; everything else may be cached normally.
      if (path.relative(root, real).split(path.sep)[0] === 'ai-assistant') {
        headers['Cache-Control'] = 'no-store'
      }
      return { status: 200, headers, body: buf }
    }
  }
}
