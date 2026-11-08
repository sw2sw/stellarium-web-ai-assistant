/* Upstream client: the only code in the deployment that holds the model key.
 *
 * Hard rules (task book P0-1/P0-2):
 * - The destination, the model and the credential come from the private config
 *   store. A request cannot name a URL, a model, a header or a tool; only the
 *   message list crosses the boundary.
 * - The key never appears in a response, a log line or an error message.
 * - The browser receives `{content}` or a stable error code, never the raw
 *   upstream body: that body can contain a key echo, internal host names or a
 *   provider-specific trace.
 * - No automatic retry, ever. A retried paid call is a second bill for one
 *   click, and a retried timeout may be a second generation of the same answer.
 *
 * Timeouts, three of them, because they fail differently:
 *   connect  no TCP connection to host:port within N ms -> upstream_unreachable
 *   idle     bytes stopped flowing for N ms              -> upstream_stalled
 *   total    the whole exchange exceeds N ms             -> upstream_timeout
 *
 * The connect deadline is a real TCP connect, done before the request is sent.
 * It used to be a timer around `fetch`, which was wrong in a way that only
 * showed up with slow models: a non-streaming upstream generates the whole
 * answer before it writes the first header byte, so a timer waiting for headers
 * was really a cap on generation time, and a healthy 20-second answer was
 * reported as "unreachable". The wait for headers is now bounded by the total
 * deadline only, which is what the operator configured.
 *
 * The idle timer is the one the previous build lacked: an endpoint that answers
 * 200 and then stops writing kept a request open until the socket died.
 */

import net from 'node:net'
import { hostAllowed } from './config.mjs'

const MAX_BODY_BYTES = 1024 * 1024

function mkErr (code) {
  const e = new Error(code)
  e.code = code
  return e
}

function mapStatus (status) {
  if (status === 401 || status === 403) return 'upstream_auth'
  if (status === 404) return 'upstream_notfound'
  if (status === 429) return 'upstream_rate'
  if (status >= 500) return 'upstream_error'
  return 'upstream_rejected'
}

/* Codes for which the upstream provably produced no generation, so the reserved
 * quota slot may be returned. Everything else is `unknown` and is kept. */
const REFUNDABLE = new Set([
  'upstream_auth',
  'upstream_notfound',
  'upstream_rate',
  'upstream_rejected'
])

export function isRefundable (code) {
  return REFUNDABLE.has(code)
}

/* Some failures prove the upstream never generated, even though the code alone
 * does not say so. A TCP connect that never completed is the clearest case: no
 * request was written, so nothing can have been billed. Callers must use this
 * rather than isRefundable(code) alone, or the budget keeps paying for a
 * deployment whose upstream is simply down. */
export function refundableOutcome (out) {
  if (!out) return false
  if (out.refundable === true) return true
  return isRefundable(out.code)
}

/* A TCP connect with a deadline, used as the real "can we reach it" test.
 *
 * It deliberately stops at the socket: no TLS handshake, no request. That is
 * enough to tell "the host is not listening / does not resolve" (which is what
 * the operator needs to see immediately) from "the host accepted and is
 * thinking" (which only the total deadline may cut short). */
function tcpReachable (t, timeoutMs, signal) {
  return new Promise((resolve) => {
    let done = false
    let timer = null
    const sock = net.connect({ host: t.hostname, port: t.port })
    const finish = (r) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      if (signal) { try { signal.removeEventListener('abort', onAbort) } catch { /* ignore */ } }
      sock.destroy()
      resolve(r)
    }
    const onAbort = () => finish({ ok: false, code: 'client_aborted' })
    timer = setTimeout(() => finish({ ok: false, code: 'upstream_unreachable' }), timeoutMs)
    if (signal) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    sock.once('connect', () => finish({ ok: true }))
    sock.once('error', () => finish({ ok: false, code: 'upstream_unreachable' }))
  })
}

async function readBody (res, bumpIdle) {
  if (!res.body) {
    const text = await res.text()
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw Object.assign(new Error('too large'), { code: 'body_too_large' })
    return text
  }
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bumpIdle()
    size += value.length
    if (size > MAX_BODY_BYTES) {
      try { await reader.cancel() } catch { /* ignore */ }
      throw Object.assign(new Error('too large'), { code: 'body_too_large' })
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createUpstream (deps) {
  const config = deps.config
  const fetchImpl = deps.fetch || globalThis.fetch
  // Same seam as `fetch`, and for the same reason: a test that only wants to
  // check what the service does with an answer should not need a DNS record for
  // a made-up host. The two tests that are about the connect deadline itself
  // leave this unset and use a real loopback socket.
  const connectImpl = deps.connect || tcpReachable
  // Empty means "nothing is allowed", which is the fail-closed default.
  const allowHosts = deps.allowHosts || []

  function target () {
    const c = config.get()
    const base = c.upstream.baseUrl
    if (!base) return null
    let u
    try { u = new URL(base) } catch { return null }
    // Re-checked on every call, not only when the URL is saved. An operator who
    // removes a host from SWE_AI_ALLOWED_HOSTS expects the running deployment
    // to stop talking to it - including a configuration that was saved and
    // enabled while the host was still allowed.
    if (!hostAllowed(allowHosts, u)) return null
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
    return {
      endpoint: base + '/chat/completions',
      models: base + '/models',
      model: c.upstream.model,
      limits: c.limits,
      authMode: c.upstream.authMode,
      key: config.key(),
      connect: { hostname: u.hostname, port }
    }
  }

  function authHeader (t) {
    // Ollama needs no credential; Spark does. Sending `Bearer ` with an empty
    // value is worse than sending nothing: some gateways treat it as a failed
    // authentication rather than as an anonymous request.
    if (t.authMode === 'none') return null
    if (!t.key) return null
    return 'Bearer ' + t.key
  }

  async function chat (messages, signal) {
    const t = target()
    if (!t || !t.model) return { ok: false, code: 'server_ai_unavailable' }

    const ctrl = new AbortController()
    let settled = false
    const fail = (code) => { if (!settled) { settled = true; ctrl.abort(mkErr(code)) } }

    // The total deadline covers the connect attempt as well: it is the only
    // bound on "how long may this click cost an inflight slot".
    const totalTimer = setTimeout(() => fail('upstream_timeout'), t.limits.timeoutMs)
    let idleTimer = null
    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => fail('upstream_stalled'), t.limits.idleTimeoutMs)
    }

    const onClientAbort = () => fail('client_aborted')
    if (signal) {
      if (signal.aborted) onClientAbort()
      else signal.addEventListener('abort', onClientAbort, { once: true })
    }

    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
    const auth = authHeader(t)
    if (auth) headers.Authorization = auth

    function cleanup () {
      settled = true
      clearTimeout(totalTimer)
      if (idleTimer) clearTimeout(idleTimer)
      if (signal) {
        try { signal.removeEventListener('abort', onClientAbort) } catch { /* ignore */ }
      }
    }

    // Step 1: can we open a socket at all? Bounded by connectTimeoutMs, and
    // the only place where "unreachable" is decided - after this the request is
    // committed and a slow answer is a slow answer, not a connection failure.
    const reach = await connectImpl(t.connect, t.limits.connectTimeoutMs, ctrl.signal)
    if (!reach.ok) {
      cleanup()
      const aborted = ctrl.signal.aborted && ctrl.signal.reason && ctrl.signal.reason.code
      if (aborted) return { ok: false, code: aborted }
      // Nothing was sent, so nothing can have been billed: this is the one
      // transport failure that may return the reserved slot.
      return { ok: false, code: 'upstream_unreachable', refundable: true }
    }

    let res
    try {
      res = await fetchImpl(t.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: t.model,
          messages,
          temperature: 0,
          stream: false,
          max_tokens: t.limits.maxOutputTokens
        }),
        signal: ctrl.signal,
        // A 302 to another host would defeat the fixed destination rule.
        redirect: 'error'
      })
    } catch (e) {
      cleanup()
      const code = ctrl.signal.aborted && ctrl.signal.reason && ctrl.signal.reason.code
      return { ok: false, code: code || 'upstream_unreachable' }
    }

    // Headers are in: the body timers take over. The wait for them was bounded
    // by the total deadline, which is the point of R1.
    bumpIdle()

    if (!res.ok) {
      const code = mapStatus(res.status)
      // Read a bounded amount so the socket can be reused, but never wait
      // without a deadline for an error body that may never end: the same idle
      // budget applies here. If it stalls, the status is still what matters.
      try { await readBody(res, bumpIdle) } catch { /* discard */ }
      cleanup()
      const abortedCode = ctrl.signal.aborted && ctrl.signal.reason && ctrl.signal.reason.code
      if (abortedCode === 'client_aborted') return { ok: false, code: 'client_aborted' }
      return { ok: false, code, status: res.status, refundable: isRefundable(code) }
    }

    let text
    try {
      text = await readBody(res, bumpIdle)
    } catch (e) {
      cleanup()
      const code = ctrl.signal.aborted && ctrl.signal.reason && ctrl.signal.reason.code
      if (code) return { ok: false, code }
      if (e && e.code === 'body_too_large') return { ok: false, code: 'upstream_too_large' }
      return { ok: false, code: 'upstream_unreachable' }
    }
    cleanup()

    let data
    try {
      data = JSON.parse(text)
    } catch {
      return { ok: false, code: 'upstream_bad_json' }
    }
    const choice = data && data.choices && data.choices[0]
    const content = choice && choice.message && choice.message.content
    if (typeof content !== 'string') return { ok: false, code: 'upstream_shape' }
    if (!content.trim()) return { ok: false, code: 'upstream_empty' }
    return { ok: true, content }
  }

  /* Non-generating reachability probe for the admin "check connection" button.
   * GET /models costs nothing on every OpenAI-compatible server we target, and
   * a 404 there is reported as "reachable, list unsupported" rather than as a
   * failure: plenty of compatible servers do not implement /models. */
  async function probe (signal) {
    const t = target()
    if (!t) return { ok: false, code: 'server_ai_unavailable' }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(mkErr('upstream_timeout')),
      Math.min(t.limits.connectTimeoutMs + 5000, 20000))
    const onAbort = () => ctrl.abort(mkErr('client_aborted'))
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const headers = { Accept: 'application/json' }
    const auth = authHeader(t)
    if (auth) headers.Authorization = auth
    try {
      const res = await fetchImpl(t.models, { method: 'GET', headers, signal: ctrl.signal, redirect: 'error' })
      const body = await res.text().catch(() => '')
      if (res.status === 404) return { ok: true, reachable: true, models: null, note: 'models_unsupported', status: 404 }
      if (!res.ok) return { ok: false, code: mapStatus(res.status), status: res.status }
      let n = null
      try {
        const d = JSON.parse(body)
        if (d && Array.isArray(d.data)) n = d.data.length
      } catch { /* reachable but not JSON: still reachable */ }
      return { ok: true, reachable: true, models: n, status: res.status }
    } catch (e) {
      const code = ctrl.signal.aborted && ctrl.signal.reason && ctrl.signal.reason.code
      return { ok: false, code: code || 'upstream_unreachable' }
    } finally {
      clearTimeout(timer)
      if (signal) { try { signal.removeEventListener('abort', onAbort) } catch { /* ignore */ } }
    }
  }

  return { chat, probe, target }
}

/* ------------------------------------------------------------ validation --- */

const ROLES = new Set(['system', 'user', 'assistant'])
const MAX_MESSAGE_CHARS = 12000
const MAX_MESSAGES = 24

export function validateMessages (value) {
  if (!Array.isArray(value) || value.length === 0) return { error: 'messages_required' }
  if (value.length > MAX_MESSAGES) return { error: 'too_many_messages' }
  let total = 0
  const clean = []
  for (const m of value) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { error: 'message_shape' }
    const keys = Object.keys(m)
    // Extra fields are how a caller would try to smuggle `tool_calls`, a `name`
    // that selects another model, or provider-specific switches.
    if (keys.some((k) => k !== 'role' && k !== 'content')) return { error: 'message_keys' }
    if (!ROLES.has(m.role)) return { error: 'message_role' }
    if (typeof m.content !== 'string') return { error: 'message_content' }
    if (m.content.length > MAX_MESSAGE_CHARS) return { error: 'message_too_long' }
    total += m.content.length
    clean.push({ role: m.role, content: m.content })
  }
  if (total > MAX_MESSAGE_CHARS * 2) return { error: 'conversation_too_long' }
  return { messages: clean }
}
