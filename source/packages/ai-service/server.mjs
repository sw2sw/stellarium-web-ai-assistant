#!/usr/bin/env node
/* Deployment server: one process, three jobs.
 *
 *   1. serve the integrated Stellarium Web site (static, same origin)
 *   2. expose a small, authenticated AI endpoint that forwards to the one
 *      operator-configured OpenAI-compatible endpoint
 *   3. expose an administrator surface that edits that configuration
 *
 * It is deliberately not a framework app: no express, no Redis, no external
 * database server. The task book allows a single runtime image when the upgrade
 * boundary is clear, and the boundary here is "the site is a directory, the AI
 * is one POST route, the settings are one JSON file plus one key file".
 *
 * Security posture: closed by default.
 *   - no access tokens  -> every /api route answers 401 (unless SWE_REQUIRE_AUTH=0)
 *   - no admin tokens   -> /api/admin answers 403 even for a classroom passphrase
 *   - no upstream configured -> /api/ai/chat answers 503, the site still serves
 *
 * So a misconfigured deployment shows an unusable assistant, never an open one.
 */

import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadBootConfig, createConfigStore, loadIdentitySecret, ValidationError } from './lib/config.mjs'
import { createStatic } from './lib/static.mjs'
import { createTokenStore, authenticate, clearCookieHeaders, ACCESS_COOKIE } from './lib/auth.mjs'
import { createLimiter, readBody } from './lib/limits.mjs'
import { sessionIdOf, newSessionId, sessionTagOf, SESSION_COOKIE } from './lib/session.mjs'
import { createUpstream, validateMessages, isRefundable, refundableOutcome } from './lib/upstream.mjs'
import { openStore } from './lib/store.mjs'
import { createAdmin } from './lib/admin.mjs'
import { json, securityHeaders } from './lib/http.mjs'
import { originAllowed } from './lib/origin.mjs'

const VERSION = '0.2.0'
const HERE = path.dirname(fileURLToPath(import.meta.url))

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

function createLogger (level) {
  const min = LEVELS[level] === undefined ? LEVELS.info : LEVELS[level]
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] > min) return
    // Structured, one line, no message bodies and no credentials. A log is a
    // file someone will paste into a chat window.
    const line = { t: new Date().toISOString(), lvl, msg }
    if (fields) Object.assign(line, fields)
    process.stdout.write(JSON.stringify(line) + '\n')
  }
  return {
    error: (m, f) => emit('error', m, f),
    warn: (m, f) => emit('warn', m, f),
    info: (m, f) => emit('info', m, f),
    debug: (m, f) => emit('debug', m, f)
  }
}

function cookieAttrs (boot) {
  return '; Path=/; HttpOnly; SameSite=Strict' + (boot.publicOrigin.startsWith('https://') ? '; Secure' : '')
}

export async function createApp (boot, deps = {}) {
  const log = deps.log || createLogger(boot.logLevel)
  const staticSite = createStatic(boot.staticDir)

  /* Startup is the one place where a data-directory fault must not be papered
   * over. The previous build regenerated a missing identity key and started a
   * fresh quota ledger when the old one would not parse, which silently re-keyed
   * every passphrase and handed every class a new budget. Now a fault closes the
   * paid route and leaves the files alone; the site, the sky and the admin page
   * keep working so the operator can see what is wrong (R2). */
  let startupFault = null
  let identitySecret = deps.identitySecret || null
  if (!identitySecret) {
    try {
      identitySecret = loadIdentitySecret(boot.dataDir)
    } catch (e) {
      startupFault = { area: 'identity', code: e.code || 'identity_error', detail: e.detail || e.message }
      // An ephemeral secret keeps login working so an administrator can reach
      // /admin. Generation stays closed, so no quota subject is ever recorded
      // under a secret that will not exist after the next restart.
      identitySecret = crypto.randomBytes(32)
      log.error('identity key unusable; paid route closed', { code: startupFault.code })
    }
  }

  const tokens = createTokenStore(boot.auth, {
    onError: (m) => log.warn(m),
    identitySecret
  })
  // `configWrite` is the C1 evidence seam (same contract as writeFileAtomic):
  // a unit can inject a directory-sync fault after the rename without owning a
  // disk that lies on cue.
  const config = createConfigStore(boot, { log, write: deps.configWrite })

  let store = null
  if (!startupFault) {
    try {
      store = await openStore({ dir: boot.dataDir, backend: boot.storeBackend, log })
    } catch (e) {
      startupFault = { area: 'ledger', code: e.code || 'ledger_error', detail: e.detail || e.message }
      log.error('quota ledger unusable; paid route closed', { code: startupFault.code })
    }
  } else {
    // Still open it read-only-ish? No: with a broken identity the ledger cannot
    // be keyed correctly, so leaving it untouched is the safer choice.
    log.warn('quota ledger not opened because of an earlier startup fault')
  }

  const limiter = createLimiter(() => config.get().limits)
  const upstream = createUpstream({
    config, log, fetch: deps.fetch, connect: deps.connect, allowHosts: boot.allowHosts
  })
  const admin = createAdmin({ config, upstream, store, log, boot, limiter, startupFault })
  const startedAt = Date.now()

  if (!tokens.enabled) log.warn('no access tokens configured: /api returns 401 for everyone')
  if (!tokens.adminEnabled) log.warn('no admin tokens configured: /api/admin is closed to everyone')
  if (boot.allowHosts.length === 0) log.warn('SWE_AI_ALLOWED_HOSTS is empty: no upstream can be configured')

  function publicConfig () {
    const cfg = config.get()
    const live = config.live() && !startupFault
    const out = {
      available: live,
      authRequired: boot.requireAuth && tokens.enabled,
      revision: cfg.revision,
      limits: { maxOutputTokens: cfg.limits.maxOutputTokens, timeoutMs: cfg.limits.timeoutMs }
    }
    if (live) {
      out.model = cfg.upstream.model
      if (cfg.note) out.note = cfg.note
    }
    if (!live && cfg.enabled) out.missing = config.missing()
    // A data-directory fault is not something the teacher can fix, but saying
    // "closed because of a storage problem" is better than an unexplained
    // "not provided" that sends them to check their own network.
    if (startupFault) out.fault = startupFault.area
    else if (config.syncHealth().degraded) out.fault = 'config-sync'
    return out
  }

  async function handleApi (req, res, urlPath) {
    /* --- public capability endpoints ------------------------------------- */
    if (req.method === 'GET' && urlPath === '/api/ai/config') {
      return json(res, 200, publicConfig())
    }

    if (req.method === 'GET' && urlPath === '/api/auth/status') {
      const a = authenticate(req, tokens, { allowAnonymous: !boot.requireAuth })
      // A non-reversible tag of this browser's session cookie (R3 supplement).
      // The cookie jar is shared by every tab of the same browser, so when
      // another tab signs in, this tag changes here too - which is how an old
      // tab can tell "someone re-logged-in as the same role" without the
      // session id itself ever reaching the page.
      const sessionTag = sessionTagOf(req)
      return json(res, 200, {
        authenticated: a.ok,
        role: a.ok ? a.role : null,
        anonymous: !!a.anonymous,
        serverAi: config.live(),
        authRequired: boot.requireAuth && tokens.enabled,
        revision: config.get().revision,
        sessionTag
      })
    }

    /* --- login / logout --------------------------------------------------- */
    if (req.method === 'POST' && urlPath === '/api/auth/login') {
      if (!originAllowed(req, boot)) return json(res, 403, { error: 'cross_site' })
      if (!tokens.enabled) return json(res, 503, { error: 'auth_not_configured' })
      const body = await readBody(req, 4096)
      if (body.tooLarge) return json(res, 413, { error: 'body_too_large' })
      let parsed
      try { parsed = JSON.parse(body.text || '{}') } catch { return json(res, 400, { error: 'bad_json' }) }
      const presented = typeof parsed.token === 'string' ? parsed.token : ''
      if (!presented) return json(res, 401, { error: 'missing' })
      const role = tokens.roleOf(presented)
      if (!role) {
        log.warn('login rejected', { peer: req.socket && req.socket.remoteAddress })
        return json(res, 403, { error: 'invalid' })
      }
      const maxAge = 12 * 60 * 60
      const attrs = cookieAttrs(boot)
      log.info('login ok', { role })
      return json(res, 200, { ok: true, role }, {
        'Set-Cookie': [
          ACCESS_COOKIE + '=' + encodeURIComponent(presented) + '; Max-Age=' + maxAge + attrs,
          SESSION_COOKIE + '=' + newSessionId() + '; Max-Age=' + maxAge + attrs
        ]
      })
    }

    if (req.method === 'POST' && urlPath === '/api/auth/logout') {
      if (!originAllowed(req, boot)) return json(res, 403, { error: 'cross_site' })
      // Both cookies, every time. Clearing only the session cookie left the
      // access passphrase behind, so the very next request was authenticated
      // again and the "logout" had achieved nothing.
      const headers = clearCookieHeaders(boot.publicOrigin.startsWith('https://'))
      log.info('logout')
      return json(res, 200, { ok: true }, { 'Set-Cookie': headers })
    }

    /* --- administrator surface -------------------------------------------- */
    if (urlPath.startsWith('/api/admin/')) {
      if (!originAllowed(req, boot)) return json(res, 403, { error: 'cross_site' })
      const a = authenticate(req, tokens)
      if (!a.ok) return json(res, a.status, { error: a.status === 401 ? 'unauthorized' : 'forbidden' })
      if (a.role !== 'admin') return json(res, 403, { error: 'admin_required' })
      const actor = a.identity ? a.identity.slice(0, 8) : 'admin'
      return admin(req, res, urlPath, actor)
    }

    /* --- the one paid route ------------------------------------------------ */
    if (req.method === 'POST' && urlPath === '/api/ai/chat') {
      const t0 = Date.now()
      if (!originAllowed(req, boot)) return json(res, 403, { error: 'cross_site' })

      const auth = authenticate(req, tokens, { allowAnonymous: !boot.requireAuth })
      if (!auth.ok) {
        return json(res, auth.status, { error: auth.status === 401 ? 'unauthorized' : 'forbidden' })
      }
      // The ledger is what makes the limit real. Without a trustworthy one the
      // honest answer is "cannot serve", not "serve without counting".
      if (startupFault || !store) {
        return json(res, 503, {
          error: 'storage_unavailable',
          area: startupFault ? startupFault.area : 'ledger',
          code: startupFault ? startupFault.code : 'ledger_error'
        })
      }
      if (!config.live()) {
        return json(res, 503, {
          error: 'server_ai_unavailable',
          missing: config.missing()
        })
      }

      const cfg = config.get()
      const identity = auth.identity
      const sess = sessionIdOf(req)

      const slot = limiter.acquire(identity)
      if (!slot.ok) {
        return json(res, 429, { error: slot.code }, { 'Retry-After': '2' })
      }

      const day = store.dayKey(Date.now(), cfg.limits.dayTz)
      let reserved = false
      // The outcome is decided once and recorded once. Deciding it before the
      // write (rather than inferring it in `finally` from "did settle throw")
      // is what stops one call being counted as both completed and unknown
      // when the ledger refuses the second write (R2 supplement).
      let outcome = null
      const settleOnce = (o) => {
        if (outcome) return
        outcome = o
        try {
          store.settle({ day, subject: identity, outcome: o })
        } catch (e) {
          // The reservation stays on disk and still counts as used. That is the
          // conservative direction; a retry here could double count.
          log.error('quota settle failed', { code: e.code || e.message, outcome: o })
        }
      }
      try {
        const body = await readBody(req, 256 * 1024)
        if (body.tooLarge) return json(res, 413, { error: 'body_too_large' })
        let parsed
        try { parsed = JSON.parse(body.text || '{}') } catch { return json(res, 400, { error: 'bad_json' }) }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return json(res, 400, { error: 'bad_json' })
        }
        // Only `messages` is read. Anything else - model, url, headers, tools -
        // is refused rather than ignored, so an operator reading the logs can
        // see someone probing instead of seeing a normal 200.
        const extra = Object.keys(parsed).filter((k) => k !== 'messages')
        if (extra.length) return json(res, 400, { error: 'unexpected_fields', fields: extra.slice(0, 5) })

        const v = validateMessages(parsed.messages)
        if (v.error) return json(res, 400, { error: v.error })

        // Reserve before the upstream connection opens: a crash mid-flight
        // leaves a reservation behind, which is the conservative direction.
        const resv = store.reserve({
          day,
          subject: identity,
          dailyGlobal: cfg.limits.dailyGlobal,
          dailyPerSubject: cfg.limits.dailyPerIdentity
        })
        if (!resv.ok) {
          log.warn('quota exhausted', { id: identity.slice(0, 8), day, reason: resv.reason })
          return json(res, 429, {
            error: resv.reason,
            day,
            globalUsed: resv.globalUsed,
            globalLimit: cfg.limits.dailyGlobal
          }, { 'Retry-After': '60' })
        }
        reserved = true

        const ac = new AbortController()
        res.on('close', () => { if (!res.writableEnded) ac.abort() })

        const out = await upstream.chat(v.messages, ac.signal)
        const ms = Date.now() - t0

        if (!out.ok) {
          const refund = refundableOutcome(out)
          settleOnce(refund ? 'refunded' : 'unknown')
          log.warn('upstream failed', {
            id: identity.slice(0, 8), code: out.code, ms, refunded: refund
          })
          if (out.code === 'client_aborted') return // nobody is listening
          const status = out.code === 'upstream_timeout' || out.code === 'upstream_stalled' ? 504
            : out.code === 'upstream_rate' ? 429
              : out.code === 'upstream_unreachable' ? 502
                : 502
          return json(res, status, { error: out.code, revision: cfg.revision })
        }

        settleOnce('completed')
        log.info('chat ok', { id: identity.slice(0, 8), ms, chars: out.content.length })
        // The operator can save a new configuration while this request is in
        // flight. The answer was produced by the old model, under the old
        // limits, possibly with the feature switched off - so it is no longer
        // an answer to the question the panel is asking. Refusing it here is
        // the only place where both revisions are known; the quota stays spent
        // because the upstream call really happened and really cost money.
        const nowRev = config.get().revision
        if (nowRev !== cfg.revision) {
          log.warn('config changed mid-flight', {
            id: identity.slice(0, 8), was: cfg.revision, now: nowRev
          })
          return json(res, 409, { error: 'config_changed', revision: nowRev })
        }
        return json(res, 200, { content: out.content, revision: cfg.revision }, {
          'X-SWE-Session': sess.id,
          'X-SWE-Config-Revision': String(cfg.revision)
        })
      } finally {
        limiter.release(identity)
        // A throw after the reservation but before settlement must not refund
        // silently: the outcome is unknown, and unknown is what gets recorded.
        if (reserved && !outcome) settleOnce('unknown')
      }
    }

    return json(res, 404, { error: 'not_found' })
  }

  /* The admin page is served from this package, not from the host site, so an
   * assistant update cannot replace it and a host rebuild cannot lose it. */
  function serveAdminPage (res) {
    let buf
    try {
      buf = fs.readFileSync(path.join(HERE, 'public', 'admin.html'))
    } catch {
      return json(res, 500, { error: 'admin_page_missing' })
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
      // Self-contained page: no inline event handlers, no remote assets.
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'"
    })
    res.end(buf)
  }

  const server = http.createServer((req, res) => {
    securityHeaders(res)
    let urlPath
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    } catch {
      return json(res, 400, { error: 'bad_path' })
    }

    if (req.method === 'GET' && urlPath === '/healthz') {
      return json(res, 200, {
        ok: true,
        version: VERSION,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        ai: config.live() && !startupFault,
        auth: tokens.enabled,
        admin: tokens.adminEnabled,
        inflight: limiter.stats().globalInflight,
        store: store ? store.backend : 'unavailable',
        // Latched between "the ledger was published" and "the publish is proven
        // durable" (a directory fsync that failed after the rename). False on
        // platforms that cannot fsync a directory at all: there the write is
        // as durable as the platform ever makes it.
        storeSync: store ? store.syncHealth() : null,
        // Same question for the configuration document (C1). While this is
        // degraded the paid route is closed until a verified save or a restart.
        configSync: config.syncHealth(),
        // A passphrase file that has gone away is a revocation, and the operator
        // needs to see it here rather than infer it from "everyone is locked out".
        authFiles: tokens.files(),
        fault: startupFault ? startupFault : null,
        revision: config.get().revision
      })
    }

    if (req.method === 'GET' && (urlPath === '/admin' || urlPath === '/admin/')) {
      return serveAdminPage(res)
    }

    if (urlPath.startsWith('/api/')) {
      handleApi(req, res, urlPath).catch((e) => {
        // Never echo e.stack to the client: it names internal files.
        log.error('api handler threw', { name: e && e.name, code: e && e.code })
        if (!res.writableEnded) {
          if (e instanceof ValidationError) json(res, 400, { error: e.code })
          else json(res, 500, { error: 'internal' })
        }
      })
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'method_not_allowed' })
    }

    const hit = staticSite.resolve(urlPath)
    if (!hit) return json(res, 404, { error: 'not_found' })
    if (hit.status !== 200) {
      res.writeHead(hit.status, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end(hit.body || 'forbidden')
    }
    res.writeHead(200, hit.headers)
    if (req.method === 'HEAD') return res.end()
    res.end(hit.body)
  })

  server.requestTimeout = 60000
  server.headersTimeout = 20000
  return { server, boot, log, config, store, tokens, limiter, upstream, VERSION }
}

/* ---------------------------------------------------------------- boot --- */

function isMain () {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (isMain()) {
  let boot
  try {
    boot = loadBootConfig()
  } catch (e) {
    process.stderr.write('configuration error: ' + e.message + '\n')
    process.exit(2)
  }
  if (!fs.existsSync(boot.staticDir)) {
    process.stderr.write('static directory not found: ' + boot.staticDir + '\n')
    process.stderr.write('set SWE_STATIC_DIR, or run install.mjs against the host first\n')
    process.exit(2)
  }

  const app = await createApp(boot)
  const { server, log, config, store } = app
  server.listen(boot.port, boot.host, () => {
    log.info('listening', {
      addr: boot.host + ':' + boot.port,
      static: boot.staticDir,
      data: boot.dataDir,
      ai: config.live(),
      auth: app.tokens.enabled,
      admin: app.tokens.adminEnabled,
      // The real CLI entry reaches this callback even when the data directory
      // failed to open (B4): `store` is then null and dereferencing it used to
      // throw out of the listen callback, killing the process that was
      // supposed to keep the site and /healthz alive through the fault.
      store: store ? store.backend : 'unavailable'
    })
  })

  // Containers get SIGTERM; stop accepting, let in-flight finish, then exit.
  // A hard exit would drop a model call the student already paid for.
  const shutdown = (sig) => {
    log.info('shutting down', { sig })
    const closeStore = () => { try { if (store) store.close() } catch { /* ignore */ } }
    server.close(() => { closeStore(); process.exit(0) })
    setTimeout(() => { closeStore(); process.exit(0) }, 10000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

export { VERSION }
