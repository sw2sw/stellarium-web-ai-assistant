/* Access control: two kinds of passphrase, one cookie.
 *
 *   classroom  may use the paid route; cannot read or change the configuration
 *   admin      may do both
 *
 * Design notes that matter for the task book P0-1/P0-2:
 * - Tokens come from the environment or an operator-writable file. Never from
 *   the request, never from the built assets.
 * - Comparison is constant time over fixed-width digests, so a wrong token
 *   leaks neither its length nor a prefix match.
 * - The token files are re-read when their mtime changes, so revoking a
 *   passphrase is "edit the file", not "restart the container". Revocation also
 *   drops that passphrase's quota identity, because the identity is derived
 *   from the token itself.
 * - The quota subject is the *token*, not the session cookie. A session id is
 *   generated fresh on every login and can be re-rolled by clearing a cookie;
 *   using it as the budget key made the daily limit cosmetic.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'

const digest = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest()

function safeEqual (a, b) {
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function parseTokenFile (text) {
  const out = []
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    out.push(t)
  }
  return out
}

/* Environment tokens and a token file are merged: the env list is fixed for the
 * life of the process, the file is re-read when its mtime changes so a class
 * passphrase can be revoked without a restart.
 *
 * A token file that cannot be read is a REVOCATION, not a cache hit (R4). The
 * previous version returned the last good list when stat() failed, which meant
 * that deleting the file - the most obvious way to revoke a leaked passphrase -
 * left every passphrase in it working until the process restarted. Now an
 * unreadable file contributes nothing, and the failure is reported once on the
 * transition instead of on every request. */
function makeList (spec, onError) {
  const envTokens = spec.tokens || []
  const file = spec.file || ''
  const cache = { mtimeMs: -1, tokens: [], present: !file, lastError: null }

  function note (code) {
    if (cache.lastError === code) return
    cache.lastError = code
    if (!onError) return
    if (code === null) onError('token file readable again')
    else onError('token file unavailable (' + code + '); its passphrases are not accepted')
  }

  function current () {
    if (!file) return []
    let st
    try {
      st = fs.statSync(file)
    } catch (e) {
      cache.tokens = []
      cache.mtimeMs = -1
      cache.present = false
      note(e.code || 'unreadable')
      return []
    }
    cache.present = true
    if (st.mtimeMs !== cache.mtimeMs) {
      try {
        cache.tokens = parseTokenFile(fs.readFileSync(file, 'utf8'))
        cache.mtimeMs = st.mtimeMs
        note(null)
      } catch (e) {
        // Metadata readable but content not (permissions changed between the
        // two calls, I/O error). Drop the cache rather than keep honouring it,
        // and report the file as NOT readable: the previous version left
        // `present` true here, so /healthz called a revocation a healthy file.
        cache.tokens = []
        cache.mtimeMs = -1
        cache.present = false
        note(e.code || 'unreadable')
      }
    } else {
      // Same mtime is not "still readable" (review round 2, R4): taking the
      // read permission away changes no mtime, and the cached list would keep
      // accepting passphrases whose file can no longer be opened. One extra
      // probe buys the revocation; resetting mtime makes the recovery re-read
      // the content instead of trusting the old bytes.
      try {
        fs.accessSync(file, fs.constants.R_OK)
      } catch (e) {
        cache.tokens = []
        cache.mtimeMs = -1
        cache.present = false
        note(e.code || 'unreadable')
      }
    }
    return cache.tokens
  }

  return {
    configured: envTokens.length > 0 || !!file,
    file,
    all () { return envTokens.concat(current()) },
    fileOk () { current(); return !file || cache.present }
  }
}

export function createTokenStore (authCfg, opts = {}) {
  const onError = opts.onError
  const classroom = makeList({
    tokens: authCfg.classroom || [],
    file: authCfg.classroomFile || ''
  }, onError)
  const admin = makeList({
    tokens: authCfg.admin || [],
    file: authCfg.adminFile || ''
  }, onError)
  const secret = opts.identitySecret || crypto.randomBytes(32)

  /* Which role a presented token carries. Admin is checked first: a token that
   * appears in both lists is an admin, which is the safer reading of a
   * duplicated entry. */
  function roleOf (token) {
    if (!token) return null
    const probe = digest(token)
    for (const t of admin.all()) if (safeEqual(probe, digest(t))) return 'admin'
    for (const t of classroom.all()) if (safeEqual(probe, digest(t))) return 'classroom'
    return null
  }

  return {
    enabled: classroom.configured || admin.configured,
    adminEnabled: admin.configured,
    classroomEnabled: classroom.configured,

    count () { return classroom.all().length + admin.all().length },
    adminCount () { return admin.all().length },

    /* Whether each configured file is currently readable. A false here means the
     * passphrases in that file are no longer accepted, which /healthz reports so
     * the operator can tell "revoked on purpose" from "the mount went away". */
    files () {
      return { classroom: classroom.fileOk(), admin: admin.fileOk() }
    },

    roleOf,

    /* Opaque, stable per token, and not reversible without the secret. Used as
     * the quota subject and as the audit actor name. */
    identityOf (token) {
      if (!token) return null
      return crypto.createHmac('sha256', secret).update(String(token), 'utf8').digest('hex').slice(0, 32)
    },

    accepts (candidate) { return !!roleOf(candidate) }
  }
}

export function readCookie (req, name) {
  const raw = req.headers.cookie
  if (!raw) return ''
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(i + 1).trim())
    } catch {
      return ''
    }
  }
  return ''
}

/* Accepts either `Authorization: Bearer <token>` (scripted clients) or the
 * `swe_access` cookie the login form sets (browsers, where a fetch cannot read
 * the header back). */
export function bearerOf (req) {
  const h = req.headers.authorization || ''
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim())
  return m ? m[1].trim() : ''
}

export function presentedToken (req) {
  return bearerOf(req) || readCookie(req, ACCESS_COOKIE)
}

export function authenticate (req, store, opts = {}) {
  if (!store.enabled) {
    // With authentication switched off entirely the paid route still needs a
    // quota subject; everything shares one bucket and the admin surface stays
    // closed, because "no tokens configured" must not mean "anyone is admin".
    if (opts.allowAnonymous) {
      return { ok: true, role: 'classroom', identity: 'anon', anonymous: true }
    }
    return { ok: false, status: 401, reason: 'no_tokens_configured' }
  }
  const presented = presentedToken(req)
  if (!presented) return { ok: false, status: 401, reason: 'missing' }
  const role = store.roleOf(presented)
  if (!role) return { ok: false, status: 403, reason: 'invalid' }
  return { ok: true, role, identity: store.identityOf(presented) }
}

export const ACCESS_COOKIE = 'swe_access'
export const SESSION_COOKIE = 'swe_sid'

/* Every cookie this service may have set, with an expiry that also matches the
 * attributes it was created with. A logout that clears `swe_access` but leaves
 * the session cookie is a logout the next request can undo. */
export function clearCookieHeaders (secure) {
  const attrs = '; Path=/; Max-Age=0; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : '')
  return [
    ACCESS_COOKIE + '=' + attrs,
    SESSION_COOKIE + '=' + attrs
  ]
}
