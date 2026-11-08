/* Same-origin enforcement for state-changing API calls.
 *
 * The earlier build compared only the *hostname*, so a page on
 * http://sky.example:8081 could POST to http://sky.example:8080 and be treated
 * as same-origin. Ports are origins. So are schemes. This module compares the
 * full (scheme, host, port) triple and refuses anything else.
 *
 * Reverse-proxy headers are attacker-controlled unless the socket peer is a
 * proxy we were told to trust, so `X-Forwarded-Host` / `X-Forwarded-Proto` are
 * only read when `SWE_TRUSTED_PROXY` names the peer address.
 */

function normaliseHost (h) {
  return String(h || '').trim().toLowerCase()
}

function peerIsTrusted (req, trustedProxies) {
  if (!trustedProxies || trustedProxies.length === 0) return false
  const peer = String(req.socket && req.socket.remoteAddress || '')
  // Node reports IPv4-mapped IPv6 for a v4 peer on a dual-stack socket.
  const plain = peer.startsWith('::ffff:') ? peer.slice(7) : peer
  return trustedProxies.some((t) => t === peer || t === plain)
}

/* What the browser believes it connected to. */
export function requestOrigin (req, boot) {
  const trusted = peerIsTrusted(req, boot.trustedProxies)
  const forwardedProto = trusted ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : ''
  const forwardedHost = trusted ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : ''

  const proto = forwardedProto || (req.socket && req.socket.encrypted ? 'https' : 'http')
  const host = normaliseHost(forwardedHost || req.headers.host || '')
  return { proto, host, origin: host ? proto + '://' + host : '' }
}

/* True when the request may change state.
 *
 * A browser always sends Origin on a cross-site POST, and on same-origin POSTs
 * of the form/fetch kind, so a mismatch is decisive. A missing Origin (curl, a
 * scripted client) is allowed to continue: the call still needs a valid access
 * token, which a third-party page cannot read.
 */
export function originAllowed (req, boot) {
  // Cheap corroborating signal. Not all browsers send it, so it can only deny.
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false

  const origin = req.headers.origin
  if (!origin) return true

  let got
  try { got = new URL(origin) } catch { return false }
  if (got.protocol !== 'http:' && got.protocol !== 'https:') return false

  if (boot.publicOrigin) {
    try {
      if (got.origin === new URL(boot.publicOrigin).origin) return true
    } catch { /* fall through to the socket-derived origin */ }
  }

  const self = requestOrigin(req, boot)
  if (!self.host) return false
  // Exact triple. `got.host` already carries the port when it is non-default,
  // and so does the Host header, so a string comparison is the whole check.
  return got.protocol === self.proto + ':' && normaliseHost(got.host) === self.host
}
