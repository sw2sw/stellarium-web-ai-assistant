/* Small response helpers shared by the route handlers.
 *
 * Keeping JSON writing in one place is not tidiness: every response this service
 * produces must carry no-store, and none of them may echo an upstream body.
 */

import { readBody } from './limits.mjs'

export function json (res, status, obj, extra) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  }, extra || {}))
  res.end(body)
}

export async function readJson (req, maxBytes) {
  const body = await readBody(req, maxBytes)
  if (body.tooLarge) return { error: 'body_too_large', status: 413 }
  let parsed
  try { parsed = JSON.parse(body.text || '{}') } catch { return { error: 'bad_json', status: 400 } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'bad_json', status: 400 }
  }
  return { value: parsed }
}

export function securityHeaders (res) {
  // No CORS headers on purpose: same-origin only. Adding
  // Access-Control-Allow-Origin here would let any site spend the budget.
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
}
