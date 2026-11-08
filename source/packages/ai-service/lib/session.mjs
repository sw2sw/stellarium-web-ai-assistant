/* Session identity: correlation only.
 *
 * This id is NOT the quota subject. It used to be, and that was the bug: a
 * student could clear the cookie, log in again, and receive a fresh budget.
 * The budget now follows the access passphrase (see auth.mjs identityOf).
 *
 * What is left here is a random id used for log correlation and for the
 * X-SWE-Session response header, plus in-flight concurrency bookkeeping. There
 * is still no per-session object table and no "current selection": the star map
 * state lives in each browser and nowhere else.
 */

import crypto from 'node:crypto'
import { readCookie, SESSION_COOKIE } from './auth.mjs'

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/

export function newSessionId () {
  return crypto.randomBytes(18).toString('base64url')
}

/* Reuse the client's id only when it looks like one we issued, so a caller
 * cannot poison a map with arbitrary keys (or a huge string). */
export function sessionIdOf (req) {
  const fromHeader = String(req.headers['x-swe-session'] || '').trim()
  if (ID_RE.test(fromHeader)) return { id: fromHeader, fresh: false }
  const fromCookie = readCookie(req, SESSION_COOKIE)
  if (ID_RE.test(fromCookie)) return { id: fromCookie, fresh: false }
  return { id: newSessionId(), fresh: true }
}

/* A non-reversible tag of the session the browser is holding, for clients that
 * need to tell "same session" from "replaced session" without being handed the
 * id itself (R3). The cookie jar is shared across a browser's tabs, so a
 * re-login in ANY tab changes the tag everywhere. Empty when the request
 * carries no session of ours - which is exactly the "no session" case a tag
 * comparison must see, not a fresh id nobody knows about. */
export function sessionTagOf (req) {
  const cookie = readCookie(req, SESSION_COOKIE)
  if (!ID_RE.test(cookie)) return ''
  return crypto.createHash('sha256').update(cookie).digest('hex').slice(0, 12)
}

export { SESSION_COOKIE }
