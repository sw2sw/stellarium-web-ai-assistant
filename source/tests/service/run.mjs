/* Service tests: no browser, no real model, no network beyond loopback.
 *
 * Everything the P0 slice promises is asserted here, because most of it is
 * invisible in a screenshot:
 *
 *   closed by default          no tokens / no admin tokens / no upstream
 *   origin                     exact scheme+host+port, cross-port refused
 *   trusted proxy headers      ignored unless the peer is named
 *   auth                       classroom vs admin, revocation, logout clears both
 *   config                     masking, SSRF allowlist, revision, atomic failure
 *   upstream                   Ollama no-key, Spark key, stall, timeout, no retry
 *   quota                      per identity, global, survives restart and cookie
 *   key hygiene                never in a response, a log line or config.json
 *
 * Run: node tests/service/run.mjs
 */

import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../..')
const mod = (rel) => pathToFileURL(path.join(SRC, rel)).href

const { createApp } = await import(mod('packages/ai-service/server.mjs'))
const { loadBootConfig, parseUpstream, hostAllowed } = await import(mod('packages/ai-service/lib/config.mjs'))
const { openStore, writeFileAtomic, syncDirectory } = await import(mod('packages/ai-service/lib/store.mjs'))

/* ------------------------------------------------------------- harness --- */

let pass = 0
let fail = 0
const failures = []

function check (name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS ' + name); return }
  fail += 1
  failures.push(name)
  console.log('FAIL ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra)))
}

function section (title) {
  console.log('\n# ' + title)
}

function quietLog () {
  const lines = []
  const mk = (lvl) => (msg, fields) => lines.push({ lvl, msg, fields: fields || null })
  return { lines, error: mk('error'), warn: mk('warn'), info: mk('info'), debug: mk('debug') }
}

function tmpDir (tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-' + tag + '-'))
  return d
}

function makeStatic (dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>hello-site\n')
  return dir
}

/* A fake OpenAI-compatible upstream. Injected as deps.fetch so no test ever
 * touches a real endpoint, and every call is counted so "no retry" is provable
 * rather than asserted by inspection. */
function makeUpstream (opts = {}) {
  const calls = []
  let mode = opts.mode || 'ok'
  let content = opts.content || 'OK'

  async function fakeFetch (url, init) {
    calls.push({
      url: String(url),
      method: init.method,
      headers: Object.assign({}, init.headers),
      body: init.body
    })
    const signal = init.signal

    if (mode === 'stall') {
      // Headers arrive, then the body never finishes. This is the case the old
      // client could not detect: fetch() resolved, so the timeout was cleared.
      const enc = new TextEncoder()
      const stream = new ReadableStream({
        start (c) {
          c.enqueue(enc.encode('{"choices":[{"message":{"cont'))
          if (signal) {
            signal.addEventListener('abort', () => {
              try { c.error(signal.reason || new Error('aborted')) } catch { /* ignore */ }
            }, { once: true })
          }
        }
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
    }

    if (mode === 'slow') {
      // Delays before the headers: exercises the connect timeout.
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 30000)
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(t)
            reject(signal.reason || new Error('aborted'))
          }, { once: true })
        }
      })
      return Response.json({ choices: [{ message: { content: 'late' } }] })
    }

    if (mode === 'trickle') {
      // Headers immediately, then one byte at a time forever. Never idle long
      // enough to trip the stall timer, so only the total deadline can stop it.
      const enc = new TextEncoder()
      let timer = null
      const stream = new ReadableStream({
        start (c) {
          c.enqueue(enc.encode('{"choices":'))
          timer = setInterval(() => {
            try { c.enqueue(enc.encode(' ')) } catch { clearInterval(timer) }
          }, 250)
          if (signal) {
            signal.addEventListener('abort', () => {
              clearInterval(timer)
              try { c.error(signal.reason || new Error('aborted')) } catch { /* ignore */ }
            }, { once: true })
          }
        },
        cancel () { clearInterval(timer) }
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
    }

    if (mode === 'late') {
      // R1: the shape of a real non-streaming generation. Nothing is written -
      // not even a header - until the whole answer exists, so the first byte
      // can easily arrive later than any sane "connect" budget. The old client
      // capped this wait with the connect timer and called a healthy answer
      // "unreachable"; the new one lets the total deadline decide.
      const wait = (opts && opts.ms) || 15000
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, wait)
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(t)
            reject(signal.reason || new Error('aborted'))
          }, { once: true })
        }
      })
      return Response.json({ choices: [{ message: { content } }] })
    }

    if (mode === 'throw') throw new TypeError('fetch failed')

    if (mode === 'status') {
      return new Response('{"error":"upstream"}', {
        status: opts.status || 500,
        headers: { 'content-type': 'application/json' }
      })
    }

    if (mode === 'models') {
      return Response.json({ data: [{ id: 'a' }, { id: 'b' }] })
    }

    return Response.json({ choices: [{ message: { content } }] })
  }

  return {
    fetch: fakeFetch,
    calls,
    setMode (m, o) {
      mode = m
      if (o && o.status) opts.status = o.status
      if (o && typeof o.ms === 'number') opts.ms = o.ms
    },
    setContent (c) { content = c },
    count () { return calls.length },
    last () { return calls[calls.length - 1] }
  }
}

/* --------------------------------------------------------------- client --- */

function request (port, method, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, opts.headers || {})
    if (opts.cookies && Object.keys(opts.cookies).length) {
      headers.Cookie = Object.keys(opts.cookies).map((k) => k + '=' + opts.cookies[k]).join('; ')
    }
    let body = null
    if (opts.body !== undefined) {
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
      headers['Content-Type'] = headers['Content-Type'] || 'application/json'
      headers['Content-Length'] = Buffer.byteLength(body)
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          setCookie: res.headers['set-cookie'] || [],
          text,
          json
        })
      })
    })
    req.on('error', reject)
    if (opts.abortAfterMs) {
      setTimeout(() => req.destroy(new Error('client abort')), opts.abortAfterMs)
    }
    if (body) req.write(body)
    req.end()
  })
}

function absorb (jar, setCookie) {
  for (const raw of setCookie) {
    const first = String(raw).split(';')[0]
    const i = first.indexOf('=')
    if (i < 0) continue
    const name = first.slice(0, i).trim()
    const value = first.slice(i + 1).trim()
    const expired = /max-age=0/i.test(String(raw))
    if (expired || !value) delete jar[name]
    else jar[name] = value
  }
}

/* ------------------------------------------------------------ app setup --- */

const ALLOW = '127.0.0.1:11434,api.example.test,*.example.test'

async function startApp (overrides = {}, deps = {}) {
  const root = overrides.root || tmpDir('svc')
  const staticDir = overrides.staticDir || makeStatic(path.join(root, 'static'))
  const dataDir = overrides.dataDir || path.join(root, 'data')
  fs.mkdirSync(dataDir, { recursive: true })

  const env = Object.assign({
    SWE_BIND: '127.0.0.1',
    // The validated port is irrelevant here: the test listens on 0 (ephemeral)
    // and reads the real port back from the socket.
    SWE_PORT: '8080',
    SWE_STATIC_DIR: staticDir,
    SWE_DATA_DIR: dataDir,
    SWE_ACCESS_TOKENS: 'class-one,class-two',
    SWE_ADMIN_TOKENS: 'admin-one',
    SWE_AI_ALLOWED_HOSTS: ALLOW,
    SWE_LOG_LEVEL: 'error',
    SWE_REQUIRE_AUTH: '1'
  }, overrides.env || {})

  // An env value of null means "unset", which is how the closed-by-default
  // cases are expressed.
  for (const k of Object.keys(env)) if (env[k] === null) delete env[k]

  const boot = loadBootConfig(env)
  const log = deps.log || quietLog()
  // The TCP probe is stubbed by default so that a test about, say, masking a
  // key does not depend on a DNS record for `ollama.local`. Tests that are
  // actually about the connect deadline pass `connect: null` and get the real
  // implementation against a loopback socket.
  const connect = 'connect' in deps ? deps.connect : async () => ({ ok: true })
  const app = await createApp(boot, { log, fetch: deps.fetch, connect, configWrite: deps.configWrite })
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const port = app.server.address().port

  return {
    app,
    port,
    boot,
    log,
    root,
    dataDir,
    staticDir,
    async close () {
      await new Promise((resolve) => app.server.close(resolve))
      try { app.store.close() } catch { /* ignore */ }
    }
  }
}

async function login (srv, token, jar) {
  const r = await request(srv.port, 'POST', '/api/auth/login', { body: { token }, cookies: jar })
  absorb(jar, r.setCookie)
  return r
}

// Every write to the config carries the revision the caller last saw; the
// service refuses a write without one. The helper reads it first so each test
// below still says only what it is actually testing. Passing
// `expectedRevision: null` deliberately sends none, which is how the
// "missing revision" case is exercised.
async function configure (srv, jar, patch) {
  const body = Object.assign({}, patch)
  if (!('expectedRevision' in body)) {
    const cur = await request(srv.port, 'GET', '/api/admin/config', { cookies: jar })
    body.expectedRevision = cur.json && cur.json.config ? cur.json.config.revision : 0
  }
  if (body.expectedRevision === null) delete body.expectedRevision
  return request(srv.port, 'PUT', '/api/admin/config', { body, cookies: jar })
}

async function keyOp (srv, jar, patch) {
  const body = Object.assign({}, patch)
  if (!('expectedRevision' in body)) {
    const cur = await request(srv.port, 'GET', '/api/admin/config', { cookies: jar })
    body.expectedRevision = cur.json && cur.json.config ? cur.json.config.revision : 0
  }
  if (body.expectedRevision === null) delete body.expectedRevision
  return request(srv.port, 'POST', '/api/admin/config/key', { body, cookies: jar })
}

function keyPath (dataDir, revision) {
  return path.join(dataDir, 'keys', 'rev-' + revision + '.key')
}

// A port nothing is listening on. Obtained by binding and releasing, so it is
// genuinely free at the moment the test uses it - a hardcoded port can be taken
// by something else on a shared machine and turn a real check into a coin flip.
async function freePort () {
  const srv = net.createServer()
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = srv.address().port
  await new Promise((resolve) => srv.close(resolve))
  return port
}

// A socket that accepts and then says nothing. Enough for the real TCP connect
// the upstream client now performs, without answering the request: the fetch
// layer is stubbed separately, so the two halves of the deadline can be
// exercised independently.
async function withTcpSink (fn) {
  const sockets = []
  const sink = net.createServer((s) => { sockets.push(s); s.on('error', () => {}) })
  await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve))
  const port = sink.address().port
  try {
    return await fn(port)
  } finally {
    for (const s of sockets) { try { s.destroy() } catch { /* ignore */ } }
    await new Promise((resolve) => sink.close(resolve))
  }
}

const KEY = 'sk-TESTKEY-abcdef1234567890'

/* ================================================================= tests === */

async function testClosedByDefault () {
  section('closed by default')

  {
    const srv = await startApp({ env: { SWE_ACCESS_TOKENS: null, SWE_ADMIN_TOKENS: null } })
    const r = await request(srv.port, 'POST', '/api/ai/chat', { body: { messages: [{ role: 'user', content: 'hi' }] } })
    check('no tokens: chat is 401', r.status === 401, r.status)
    const a = await request(srv.port, 'GET', '/api/admin/config')
    check('no tokens: admin is 401', a.status === 401, a.status)
    const c = await request(srv.port, 'GET', '/api/ai/config')
    check('no upstream: config reports unavailable', c.json && c.json.available === false, c.json)
    const h = await request(srv.port, 'GET', '/')
    check('site still serves when AI is closed', h.status === 200 && /hello-site/.test(h.text), h.status)
    await srv.close()
  }

  {
    // Classroom passphrase must not reach the admin surface.
    const srv = await startApp({ env: { SWE_ADMIN_TOKENS: null } })
    const jar = {}
    const lg = await login(srv, 'class-one', jar)
    check('classroom login succeeds without an admin token configured', lg.status === 200 && lg.json.role === 'classroom', lg.json)
    const a = await request(srv.port, 'GET', '/api/admin/config', { cookies: jar })
    check('classroom passphrase is refused by the admin surface', a.status === 403 && a.json.error === 'admin_required', a.json)
    await srv.close()
  }
}

async function testOrigin () {
  section('origin: exact scheme, host and port')

  const srv = await startApp()
  const jar = {}
  await login(srv, 'class-one', jar)
  const self = 'http://127.0.0.1:' + srv.port

  const good = await request(srv.port, 'POST', '/api/ai/chat', {
    body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar, headers: { Origin: self }
  })
  check('exact origin is accepted', good.status !== 403, good.status)

  const otherPort = await request(srv.port, 'POST', '/api/ai/chat', {
    body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar,
    headers: { Origin: 'http://127.0.0.1:8081' }
  })
  check('same host, different port is refused', otherPort.status === 403 && otherPort.json.error === 'cross_site', otherPort.json)

  const scheme = await request(srv.port, 'POST', '/api/ai/chat', {
    body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar,
    headers: { Origin: 'https://127.0.0.1:' + srv.port }
  })
  check('same host and port, different scheme is refused', scheme.status === 403, scheme.json)

  const evil = await request(srv.port, 'POST', '/api/ai/chat', {
    body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar,
    headers: { Origin: 'https://evil.test' }
  })
  check('cross-site origin is refused', evil.status === 403 && evil.json.error === 'cross_site', evil.json)

  const fetchSite = await request(srv.port, 'POST', '/api/ai/chat', {
    body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar,
    headers: { 'Sec-Fetch-Site': 'cross-site' }
  })
  check('sec-fetch-site cross-site is refused even with no Origin', fetchSite.status === 403, fetchSite.json)

  const noOrigin = await request(srv.port, 'POST', '/api/auth/login', { body: { token: 'class-one' } })
  check('scripted client without Origin still works (token is the gate)', noOrigin.status === 200, noOrigin.status)

  const loginCross = await request(srv.port, 'POST', '/api/auth/login', {
    body: { token: 'class-one' }, headers: { Origin: 'https://evil.test' }
  })
  check('cross-site login is refused', loginCross.status === 403, loginCross.json)

  await srv.close()
}

async function testTrustedProxy () {
  section('reverse proxy headers')

  {
    // Peer is not a trusted proxy, so X-Forwarded-Host must be ignored. If it
    // were believed, an attacker could make any Origin look same-origin.
    const srv = await startApp()
    const jar = {}
    await login(srv, 'class-one', jar)
    const r = await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar,
      headers: { Origin: 'https://evil.test', 'X-Forwarded-Host': 'evil.test' }
    })
    check('untrusted X-Forwarded-Host does not make a foreign Origin valid', r.status === 403, r.json)
    await srv.close()
  }

  {
    const srv = await startApp({ env: { SWE_TRUSTED_PROXY: '127.0.0.1' } })
    const jar = {}
    await login(srv, 'class-one', jar)
    const r = await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar,
      headers: { Origin: 'https://sky.example.test', 'X-Forwarded-Host': 'sky.example.test', 'X-Forwarded-Proto': 'https' }
    })
    check('trusted proxy: forwarded scheme+host are honoured', r.status !== 403, r.status)
    await srv.close()
  }

  {
    // Public origin wins over the socket-derived one, which is what a deployment
    // behind TLS termination needs.
    const srv = await startApp({ env: { SWE_PUBLIC_ORIGIN: 'https://sky.example.test' } })
    const jar = {}
    await login(srv, 'class-one', jar)
    const r = await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar,
      headers: { Origin: 'https://sky.example.test' }
    })
    check('SWE_PUBLIC_ORIGIN is accepted as the site origin', r.status !== 403, r.status)
    const bad = await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar,
      headers: { Origin: 'https://sky.example.test:8443' }
    })
    check('SWE_PUBLIC_ORIGIN with a different port is still refused', bad.status === 403, bad.json)
    await srv.close()
  }
}

async function testAuthAndLogout () {
  section('authentication, revocation, logout')

  const srv = await startApp()
  const jar = {}

  const bad = await login(srv, 'nope', jar)
  check('wrong passphrase is 403', bad.status === 403, bad.json)

  const lg = await login(srv, 'class-one', jar)
  check('classroom login sets both cookies', lg.status === 200 && jar.swe_access && jar.swe_sid, Object.keys(jar))
  check('login response never echoes the passphrase', !JSON.stringify(lg.json).includes('class-one'), lg.json)

  const st = await request(srv.port, 'GET', '/api/auth/status', { cookies: jar })
  check('status reports the classroom role', st.json.authenticated === true && st.json.role === 'classroom', st.json)

  const lo = await request(srv.port, 'POST', '/api/auth/logout', { cookies: jar })
  const cleared = lo.setCookie.map((c) => String(c).split(';')[0])
  check('logout expires swe_access', cleared.some((c) => c === 'swe_access='), cleared)
  check('logout expires the session cookie', cleared.some((c) => c === 'swe_sid='), cleared)
  check('logout sets Max-Age=0 on both', lo.setCookie.every((c) => /Max-Age=0/i.test(String(c))), lo.setCookie)

  absorb(jar, lo.setCookie)
  check('cookie jar is empty after logout', Object.keys(jar).length === 0, jar)
  const after = await request(srv.port, 'POST', '/api/ai/chat', {
    body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
  })
  check('paid route refuses after logout', after.status === 401, after.status)

  // Revocation: rewriting the token file must take effect without a restart.
  const tf = path.join(srv.root, 'tokens.txt')
  fs.writeFileSync(tf, 'class-two\n')
  const srv2 = await startApp({ dataDir: path.join(srv.root, 'data2'), env: { SWE_ACCESS_TOKENS: null, SWE_ACCESS_TOKENS_FILE: tf } })
  const jar2 = {}
  const ok1 = await login(srv2, 'class-two', jar2)
  check('token file is read at startup', ok1.status === 200, ok1.status)
  fs.writeFileSync(tf, 'class-three\n')
  // mtime granularity on some filesystems is coarse; force a different value.
  const now = new Date(Date.now() + 2000)
  fs.utimesSync(tf, now, now)
  const st2 = await request(srv2.port, 'GET', '/api/auth/status', { cookies: jar2 })
  check('removing a passphrase from the file revokes the live cookie', st2.json.authenticated === false, st2.json)
  await srv2.close()
  await srv.close()
}

async function testConfigSurface () {
  section('configuration: masking, validation, revision')

  const up = makeUpstream()
  const srv = await startApp({}, { fetch: up.fetch })
  const jar = {}
  await login(srv, 'admin-one', jar)

  const before = await request(srv.port, 'GET', '/api/admin/config', { cookies: jar })
  check('admin can read config', before.status === 200 && before.json.ok === true, before.status)
  check('config starts closed', before.json.config.enabled === false && before.json.live === false, before.json.live)
  check('key is reported as a boolean, never a value', before.json.config.upstream.hasKey === false, before.json.config.upstream)

  const rev0 = before.json.config.revision

  const ssrf = await configure(srv, jar, { baseUrl: 'http://evil.test/v1' })
  check('base URL outside the allowlist is refused', ssrf.status === 400 && ssrf.json.error === 'host_not_allowed', ssrf.json)

  const meta = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: '169.254.169.254,127.0.0.1:11434' } }, { fetch: up.fetch })
  const mjar = {}
  await login(meta, 'admin-one', mjar)
  const metaRes = await configure(meta, mjar, { baseUrl: 'http://169.254.169.254/latest' })
  check('cloud metadata address is refused even when allowlisted', metaRes.status === 400 && metaRes.json.error === 'host_not_allowed', metaRes.json)
  await meta.close()

  const creds = await configure(srv, jar, { baseUrl: 'http://user:pw@api.example.test/v1' })
  check('credentials inside the URL are refused', creds.status === 400 && creds.json.error === 'base_url_credentials', creds.json)

  const q = await configure(srv, jar, { baseUrl: 'http://api.example.test/v1?x=1' })
  check('a query string is refused', q.status === 400 && q.json.error === 'base_url_query', q.json)

  const scheme = await configure(srv, jar, { baseUrl: 'file:///etc/passwd' })
  check('non-http scheme is refused', scheme.status === 400 && scheme.json.error === 'base_url_scheme', scheme.json)

  const unknown = await configure(srv, jar, { baseUrl: 'http://api.example.test/v1', model: 'm', nope: 1 })
  check('unknown fields are refused', unknown.status === 400 && unknown.json.error === 'unexpected_fields', unknown.json)

  const enableNoKey = await configure(srv, jar, { baseUrl: 'http://api.example.test/v1', model: 'm', enabled: true })
  check('cannot enable without a key', enableNoKey.status === 400 && enableNoKey.json.error === 'enable_without_key', enableNoKey.json)

  const badLimits = await configure(srv, jar, { limits: { maxOutputTokens: 1 } })
  check('out-of-range limits are refused', badLimits.status === 400, badLimits.json)

  const inverted = await configure(srv, jar, { limits: { globalInflight: 2, perIdentityInflight: 4 } })
  check('per-identity concurrency above the global cap is refused', inverted.status === 400 && inverted.json.error === 'per_identity_above_global', inverted.json)

  // A failed patch must leave the previous snapshot intact.
  const afterFails = await request(srv.port, 'GET', '/api/admin/config', { cookies: jar })
  check('a rejected patch changes nothing', afterFails.json.config.revision === rev0, { rev0, now: afterFails.json.config.revision })

  const good = await configure(srv, jar, {
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    key: KEY,
    authMode: 'auto',
    enabled: true,
    note: 'local gemma'
  })
  check('valid config is accepted', good.status === 200 && good.json.live === true, good.json)
  check('revision increments on save', good.json.revision === rev0 + 1, { before: rev0, after: good.json.revision })
  check('save does not call the model', up.count() === 0, up.count())

  const shown = await request(srv.port, 'GET', '/api/admin/config', { cookies: jar })
  check('key is present after saving', shown.json.config.upstream.hasKey === true, shown.json.config.upstream)
  check('config response contains no key material', !shown.text.includes(KEY), 'leak')
  const cfgText = fs.readFileSync(path.join(srv.dataDir, 'config.json'), 'utf8')
  check('config.json on disk contains no key material', !cfgText.includes(KEY), 'leak')
  // R5: the key is a file per revision, and config.json only points at it, so
  // the pair is published by the one rename that publishes the config.
  const keyRef = JSON.parse(cfgText).upstream.keyRef
  check('config.json points at a per-revision key file',
    keyRef === 'rev-' + shown.json.config.revision, { keyRef, rev: shown.json.config.revision })
  check('key file exists and is not world readable',
    fs.existsSync(keyPath(srv.dataDir, shown.json.config.revision)) &&
    (process.platform === 'win32' ||
      (fs.statSync(keyPath(srv.dataDir, shown.json.config.revision)).mode & 0o077) === 0), 'mode')
  check('the key file holds the key, and only the key',
    fs.readFileSync(keyPath(srv.dataDir, shown.json.config.revision), 'utf8').trim() === KEY, 'value')
  check('a superseded key file is removed',
    fs.readdirSync(path.join(srv.dataDir, 'keys')).filter((f) => f.endsWith('.key')).length === 1,
    fs.readdirSync(path.join(srv.dataDir, 'keys')))

  // Empty key input must not clear the stored key.
  const emptyKey = await configure(srv, jar, { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', key: '' })
  check('an empty key field leaves the stored key alone', emptyKey.status === 200, emptyKey.json)
  const stillHas = await request(srv.port, 'GET', '/api/admin/config', { cookies: jar })
  check('key survives an empty key field', stillHas.json.config.upstream.hasKey === true, stillHas.json.config.upstream)

  const cleared = await keyOp(srv, jar, { clear: true })
  check('explicit clear removes the key', cleared.status === 200 && cleared.json.changed === true, cleared.json)
  check('clearing the key also switches the feature off', cleared.json.live === false, cleared.json)

  // Emergency stop.
  await configure(srv, jar, { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', key: KEY, enabled: true })
  const live = await request(srv.port, 'GET', '/api/ai/config')
  check('public config reports availability when live', live.json.available === true, live.json)
  const stop = await request(srv.port, 'POST', '/api/admin/emergency-stop', { cookies: jar })
  check('emergency stop succeeds', stop.status === 200 && stop.json.live === false, stop.json)
  const chatAfter = await request(srv.port, 'POST', '/api/ai/chat', {
    body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
  })
  check('emergency stop blocks the next request immediately', chatAfter.status === 503, chatAfter.status)
  check('emergency stop did not call the model', up.count() === 0, up.count())

  await srv.close()
}

async function testUpstreamAuth () {
  section('upstream credentials: Ollama without a key, Spark with one')

  {
    // authMode auto + no key = no Authorization header at all. A literal
    // "Bearer " with an empty value is rejected by some gateways.
    const up = makeUpstream()
    const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
    const jar = {}
    await login(srv, 'admin-one', jar)
    const cfg = await configure(srv, jar, {
      baseUrl: 'http://ollama.local:11434/v1', model: 'gemma:2b', authMode: 'none', enabled: true
    })
    check('authMode none can be enabled without a key', cfg.status === 200 && cfg.json.live === true, cfg.json)
    const r = await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
    })
    check('Ollama-style call succeeds', r.status === 200 && r.json.content === 'OK', r.json)
    check('no Authorization header is sent when there is no key',
      !('Authorization' in up.last().headers) && !('authorization' in up.last().headers), up.last().headers)
    await srv.close()
  }

  {
    const up = makeUpstream()
    const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: 'spark.local' } }, { fetch: up.fetch })
    const jar = {}
    await login(srv, 'admin-one', jar)
    await configure(srv, jar, {
      baseUrl: 'http://spark.local/v2', model: 'x2.6', key: KEY, authMode: 'auto', enabled: true
    })
    const r = await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
    })
    check('Spark-style call succeeds', r.status === 200, r.json)
    check('Authorization: Bearer is sent when a key is stored',
      up.last().headers.Authorization === 'Bearer ' + KEY, Object.keys(up.last().headers))
    check('the request body carries only model/messages/temperature/stream/max_tokens',
      Object.keys(JSON.parse(up.last().body)).sort().join(',') === 'max_tokens,messages,model,stream,temperature',
      Object.keys(JSON.parse(up.last().body)))
    await srv.close()
  }

  {
    // authMode none must win even when a key is stored: an operator may keep a
    // key for another purpose and still want an anonymous call.
    const up = makeUpstream()
    const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
    const jar = {}
    await login(srv, 'admin-one', jar)
    await configure(srv, jar, { baseUrl: 'http://ollama.local/v1', model: 'm', key: KEY, authMode: 'none', enabled: true })
    await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
    })
    check('authMode none suppresses the header even with a key stored',
      !('Authorization' in up.last().headers), up.last().headers)
    await srv.close()
  }
}

async function testUpstreamFailures () {
  section('upstream failures: stall, timeout, no retry')

  {
    // The headline fix: headers arrive, body stalls. Before, the panel said
    // "generating" until the socket died.
    const up = makeUpstream()
    const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
    const jar = {}
    await login(srv, 'admin-one', jar)
    await configure(srv, jar, {
      baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'none', enabled: true,
      limits: { idleTimeoutMs: 2000, timeoutMs: 20000, connectTimeoutMs: 5000 }
    })
    up.setMode('stall')
    const t0 = Date.now()
    const r = await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
    })
    const ms = Date.now() - t0
    check('a stalled response body is terminated', r.status === 504 && r.json.error === 'upstream_stalled', r.json)
    check('the stall is detected near the idle timeout, not the socket timeout', ms < 8000, ms)
    check('a stalled call is attempted exactly once', up.count() === 1, up.count())
    await srv.close()
  }

  {
    const up = makeUpstream()
    const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
    const jar = {}
    await login(srv, 'admin-one', jar)
    await configure(srv, jar, {
      baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'none', enabled: true,
      limits: { timeoutMs: 5000, idleTimeoutMs: 4000, connectTimeoutMs: 3000 }
    })
    up.setMode('trickle')
    const t0 = Date.now()
    const r = await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
    })
    const ms = Date.now() - t0
    check('a total-timeout overrun is reported as 504', r.status === 504 && r.json.error === 'upstream_timeout', r.json)
    check('the total deadline fires even while bytes keep arriving', ms >= 4500 && ms < 9000, ms)
    check('a timed-out call is attempted exactly once', up.count() === 1, up.count())
    await srv.close()
  }

  {
    // R1: the case that made the 180 s wait look broken. A non-streaming
    // upstream writes nothing at all - no header - until it has generated the
    // whole answer. Fifteen seconds is well past the old 10 s "connect" cap,
    // and the answer is perfectly healthy.
    await withTcpSink(async (port) => {
      const up = makeUpstream()
      const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: '127.0.0.1' } },
        { fetch: up.fetch, connect: null })
      const jar = {}
      await login(srv, 'admin-one', jar)
      await configure(srv, jar, {
        baseUrl: 'http://127.0.0.1:' + port + '/v1', model: 'm', authMode: 'none', enabled: true,
        limits: { timeoutMs: 40000, idleTimeoutMs: 20000, connectTimeoutMs: 1000 }
      })
      up.setMode('late', { ms: 15000 })
      const t0 = Date.now()
      const r = await request(srv.port, 'POST', '/api/ai/chat', {
        body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
      })
      const ms = Date.now() - t0
      check('a first byte later than the connect budget is still an answer',
        r.status === 200 && r.json.content === 'OK', r.json)
      check('a slow first byte is not reported as unreachable', ms >= 14000, ms)
      check('a slow answer is generated exactly once', up.count() === 1, up.count())
      await srv.close()
    })
  }

  {
    // The connect deadline still means something: it is now a real TCP connect,
    // so a refused socket fails in about a millisecond instead of waiting out
    // the total deadline.
    const deadPort = await freePort()
    const up = makeUpstream()
    const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: '127.0.0.1' } },
      { fetch: up.fetch, connect: null })
    const jar = {}
    await login(srv, 'admin-one', jar)
    await configure(srv, jar, {
      baseUrl: 'http://127.0.0.1:' + deadPort + '/v1', model: 'm', authMode: 'none', enabled: true,
      limits: { timeoutMs: 30000, idleTimeoutMs: 10000, connectTimeoutMs: 1000 }
    })
    const t0 = Date.now()
    const r = await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
    })
    const ms = Date.now() - t0
    check('a refused connection is reported as unreachable, not as a timeout',
      r.status === 502 && r.json.error === 'upstream_unreachable', r.json)
    check('the connect deadline is used, not the total one', ms < 5000, ms)
    check('a refused connection never reaches the request layer', up.count() === 0, up.count())
    await srv.close()
  }

  {
    const up = makeUpstream()
    const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
    const jar = {}
    await login(srv, 'admin-one', jar)
    await configure(srv, jar, { baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'none', enabled: true })

    for (const [status, want, code] of [[401, 502, 'upstream_auth'], [429, 429, 'upstream_rate'], [500, 502, 'upstream_error']]) {
      up.setMode('status', { status })
      const before = up.count()
      const r = await request(srv.port, 'POST', '/api/ai/chat', {
        body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
      })
      check('upstream ' + status + ' maps to ' + want + '/' + code,
        r.status === want && r.json.error === code, r.json)
      check('upstream ' + status + ' is not retried', up.count() - before === 1, up.count() - before)
    }

    up.setMode('throw')
    const thr = await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
    })
    check('a transport error is reported without a retry',
      thr.status === 502 && thr.json.error === 'upstream_unreachable', thr.json)
    await srv.close()
  }

  {
    // Client walks away mid-flight: the upstream connection is cut and the
    // outcome is recorded as unknown rather than refunded.
    const up = makeUpstream()
    const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
    const jar = {}
    await login(srv, 'admin-one', jar)
    await configure(srv, jar, {
      baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'none', enabled: true,
      limits: { timeoutMs: 20000, idleTimeoutMs: 15000 }
    })
    up.setMode('slow')
    await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar, abortAfterMs: 400
    }).catch(() => null)
    await new Promise((r) => setTimeout(r, 600))
    const usage = await request(srv.port, 'GET', '/api/admin/quota', { cookies: jar })
    check('a client abort leaves no in-flight slot behind', srv.app.limiter.stats().globalInflight === 0, srv.app.limiter.stats())
    check('a client abort is recorded as an unknown outcome, not refunded',
      usage.json.usage.global.unknown >= 1 && usage.json.usage.global.refunded === 0, usage.json.usage.global)
    const health = await request(srv.port, 'GET', '/healthz')
    check('the service is still healthy after a client abort', health.status === 200, health.status)
    await srv.close()
  }
}

async function testQuota () {
  section('quota: per identity, global, durable')

  {
    const up = makeUpstream()
    const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
    const jar = {}
    await login(srv, 'admin-one', jar)
    await configure(srv, jar, {
      baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'none', enabled: true,
      limits: { dailyGlobal: 10, dailyPerIdentity: 1 }
    })
    const a = await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
    })
    check('first call within the per-identity limit succeeds', a.status === 200, a.status)
    const b = await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
    })
    check('second call hits the per-identity limit', b.status === 429 && b.json.error === 'subject_quota', b.json)
    check('a rejected call never reaches the upstream', up.count() === 1, up.count())

    // Re-login gets a new session id and a new cookie, but the same passphrase:
    // the budget must not reset. This is the exact bypass the old build had.
    const jar2 = {}
    await login(srv, 'admin-one', jar2)
    const c = await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar2
    })
    check('clearing cookies and logging in again does not reset the budget',
      c.status === 429 && c.json.error === 'subject_quota', c.json)
    check('the new session really is a different session', jar2.swe_sid !== jar.swe_sid, 'sid')

    // A different passphrase has its own budget.
    const jar3 = {}
    await login(srv, 'class-two', jar3)
    const d = await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar3
    })
    check('a different passphrase has an independent budget', d.status === 200, d.status)

    const usage = await request(srv.port, 'GET', '/api/admin/quota', { cookies: jar })
    check('usage reports two completed calls and one limit hit',
      usage.json.usage.global.completed === 2 && usage.json.usage.global.used === 2, usage.json.usage.global)

    await srv.close()
  }

  {
    // Durable across a restart: new process, same data directory.
    const up = makeUpstream()
    const root = tmpDir('restart')
    const first = await startApp({ root, env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
    const jar = {}
    await login(first, 'admin-one', jar)
    await configure(first, jar, {
      baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'none', enabled: true,
      limits: { dailyGlobal: 10, dailyPerIdentity: 1 }
    })
    const a = await request(first.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
    })
    check('call before restart succeeds', a.status === 200, a.status)
    await first.close()

    const second = await startApp({ root, dataDir: path.join(root, 'data'), env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
    const jar2 = {}
    await login(second, 'admin-one', jar2)
    const b = await request(second.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar2
    })
    check('the daily limit survives a restart', b.status === 429 && b.json.error === 'subject_quota', b.json)
    const cfg = await request(second.port, 'GET', '/api/admin/config', { cookies: jar2 })
    check('the configuration survives a restart', cfg.json.config.upstream.model === 'm', cfg.json.config.upstream)
    await second.close()
  }

  {
    // Global ceiling, independent of identity.
    const up = makeUpstream()
    const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
    const jar = {}
    await login(srv, 'admin-one', jar)
    await configure(srv, jar, {
      baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'none', enabled: true,
      limits: { dailyGlobal: 2, dailyPerIdentity: 5 }
    })
    const r1 = await request(srv.port, 'POST', '/api/ai/chat', { body: { messages: [{ role: 'user', content: 'a' }] }, cookies: jar })
    const r2 = await request(srv.port, 'POST', '/api/ai/chat', { body: { messages: [{ role: 'user', content: 'b' }] }, cookies: jar })
    const r3 = await request(srv.port, 'POST', '/api/ai/chat', { body: { messages: [{ role: 'user', content: 'c' }] }, cookies: jar })
    check('the global daily ceiling stops the third call',
      r1.status === 200 && r2.status === 200 && r3.status === 429 && r3.json.error === 'global_quota', [r1.status, r2.status, r3.status])
    await srv.close()
  }

  {
    // The admin generate test is a real call and consumes a slot.
    const up = makeUpstream()
    const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
    const jar = {}
    await login(srv, 'admin-one', jar)
    await configure(srv, jar, {
      baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'none', enabled: true,
      limits: { dailyGlobal: 3, dailyPerIdentity: 3 }
    })
    const g = await request(srv.port, 'POST', '/api/admin/test-generate', { cookies: jar })
    check('generate test reports that it really generated', g.status === 200 && g.json.ok === true && g.json.generated === true, g.json)
    const usage = await request(srv.port, 'GET', '/api/admin/quota', { cookies: jar })
    check('generate test consumed one global slot', usage.json.usage.global.used === 1, usage.json.usage.global)
    check('generate test body is not echoed back in full', !('content' in g.json), Object.keys(g.json))
    await srv.close()
  }
}

async function testProbe () {
  section('non-generating connection check')

  const up = makeUpstream()
  const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
  const jar = {}
  await login(srv, 'admin-one', jar)
  await configure(srv, jar, { baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'none', enabled: true })

  up.setMode('models')
  const r = await request(srv.port, 'POST', '/api/admin/test-connection', { cookies: jar })
  check('probe reports reachability', r.status === 200 && r.json.ok === true && r.json.models === 2, r.json)
  check('probe declares it generated nothing', r.json.generated === false, r.json)
  check('probe hits /models, not /chat/completions', /\/models$/.test(up.last().url), up.last().url)
  check('probe does not consume quota', srv.app.store.usageFor(srv.app.store.dayKey(Date.now(), 'Asia/Shanghai'), 'global').used === 0, 'used')

  up.setMode('status', { status: 404 })
  const r404 = await request(srv.port, 'POST', '/api/admin/test-connection', { cookies: jar })
  check('a server without /models is still reported reachable',
    r404.json.ok === true && r404.json.note === 'models_unsupported', r404.json)

  up.setMode('status', { status: 401 })
  const r401 = await request(srv.port, 'POST', '/api/admin/test-connection', { cookies: jar })
  check('a 401 from the probe is reported as an auth problem', r401.json.ok === false && r401.json.code === 'upstream_auth', r401.json)
  await srv.close()
}

async function testRequestShape () {
  section('request shape: the browser cannot redirect the call')

  const up = makeUpstream()
  const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
  const jar = {}
  await login(srv, 'admin-one', jar)
  await configure(srv, jar, { baseUrl: 'http://ollama.local/v1', model: 'fixed-model', authMode: 'none', enabled: true })

  const smuggle = await request(srv.port, 'POST', '/api/ai/chat', {
    body: { messages: [{ role: 'user', content: 'hi' }], model: 'expensive-model' }, cookies: jar
  })
  check('a client-supplied model is refused, not silently dropped',
    smuggle.status === 400 && smuggle.json.error === 'unexpected_fields', smuggle.json)
  check('the smuggled request never reached the upstream', up.count() === 0, up.count())

  const urlField = await request(srv.port, 'POST', '/api/ai/chat', {
    body: { messages: [{ role: 'user', content: 'hi' }], url: 'http://evil.test' }, cookies: jar
  })
  check('a client-supplied URL is refused', urlField.status === 400, urlField.json)

  const tools = await request(srv.port, 'POST', '/api/ai/chat', {
    body: { messages: [{ role: 'user', content: 'hi', tool_calls: [] }] }, cookies: jar
  })
  check('a message with extra keys is refused', tools.status === 400 && tools.json.error === 'message_keys', tools.json)

  const role = await request(srv.port, 'POST', '/api/ai/chat', {
    body: { messages: [{ role: 'system', content: 'x' }, { role: 'tool', content: 'y' }] }, cookies: jar
  })
  check('an unknown role is refused', role.status === 400 && role.json.error === 'message_role', role.json)

  const ok = await request(srv.port, 'POST', '/api/ai/chat', {
    body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
  })
  check('the configured model is used, not the client one', JSON.parse(up.last().body).model === 'fixed-model', JSON.parse(up.last().body).model)
  check('the success response carries the config revision', Number(ok.headers['x-swe-config-revision']) >= 1, ok.headers['x-swe-config-revision'])
  await srv.close()
}

async function testKeyHygiene () {
  section('key hygiene across responses, logs and files')

  const log = quietLog()
  const up = makeUpstream()
  const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch, log })
  const jar = {}
  await login(srv, 'admin-one', jar)
  await configure(srv, jar, { baseUrl: 'http://ollama.local/v1', model: 'm', key: KEY, authMode: 'auto', enabled: true })

  const bodies = []
  const push = async (p, m, b) => {
    const r = await request(srv.port, m || 'GET', p, b ? { body: b, cookies: jar } : { cookies: jar })
    bodies.push(r.text)
    return r
  }
  await push('/api/admin/config')
  await push('/api/ai/config')
  await push('/api/auth/status')
  await push('/healthz')
  await push('/api/ai/chat', 'POST', { messages: [{ role: 'user', content: 'hi' }] })
  await push('/api/admin/test-connection', 'POST')
  await push('/api/admin/quota')

  check('no response body contains the key', bodies.every((t) => !t.includes(KEY)), 'leak')
  check('no log line contains the key',
    log.lines.every((l) => !JSON.stringify(l).includes(KEY)), 'leak')
  check('no log line contains a message body',
    log.lines.every((l) => !JSON.stringify(l).includes('"content":"hi"')), 'leak')

  // The key lives in keys/rev-<n>.key (R5). Walk the whole data directory, not
  // just its top level, and allow exactly that one shape to contain the secret -
  // otherwise "no other file contains the key" is satisfied by the key simply
  // having moved into a subdirectory.
  const found = []
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f)
      if (fs.statSync(p).isDirectory()) { walk(p); continue }
      let text = ''
      try { text = fs.readFileSync(p, 'utf8') } catch { continue }
      if (text.includes(KEY)) found.push(path.relative(srv.dataDir, p).split(path.sep).join('/'))
    }
  }
  walk(srv.dataDir)
  check('the key exists on disk in exactly one place',
    found.length === 1 && /^keys\/rev-\d+\.key$/.test(found[0]), found)
  check('no file other than the key file contains the key',
    found.every((f) => /^keys\/rev-\d+\.key$/.test(f)), found)
  await srv.close()
}

async function testStoreBackends () {
  section('storage backends')

  for (const backend of ['json', 'sqlite']) {
    const up = makeUpstream()
    const srv = await startApp({ env: { SWE_STORE_BACKEND: backend, SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
    const jar = {}
    await login(srv, 'admin-one', jar)
    await configure(srv, jar, {
      baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'none', enabled: true,
      limits: { dailyGlobal: 5, dailyPerIdentity: 1 }
    })
    const a = await request(srv.port, 'POST', '/api/ai/chat', { body: { messages: [{ role: 'user', content: 'x' }] }, cookies: jar })
    const b = await request(srv.port, 'POST', '/api/ai/chat', { body: { messages: [{ role: 'user', content: 'x' }] }, cookies: jar })
    check(backend + ': one call allowed, the next refused', a.status === 200 && b.status === 429, [a.status, b.status])
    check(backend + ': the backend actually in use is ' + backend, srv.app.store.backend === backend, srv.app.store.backend)
    await srv.close()
  }
}

async function testAdminPage () {
  section('admin page')

  const srv = await startApp()
  const r = await request(srv.port, 'GET', '/admin')
  check('admin page is served', r.status === 200 && /text\/html/.test(r.headers['content-type']), r.status)
  check('admin page states that saving does not call the model', /保存不会调用模型/.test(r.text), 'copy')
  check('admin page has no key placeholder or default credential', !/sk-[A-Za-z0-9]{8}/.test(r.text), 'leak')
  check('admin page is not cacheable', /no-store/.test(r.headers['cache-control'] || ''), r.headers['cache-control'])
  check('admin page carries a restrictive CSP', /default-src 'none'/.test(r.headers['content-security-policy'] || ''), 'csp')
  await srv.close()
}

async function testParseUpstreamUnit () {
  section('base URL parsing (unit)')

  const allow = ['127.0.0.1:11434', 'api.example.test', '*.example.test']
  check('plain host is accepted', parseUpstream('http://api.example.test/v1', allow).base === 'http://api.example.test/v1', 'x')
  check('trailing slash is normalised', parseUpstream('http://api.example.test/v1/', allow).base === 'http://api.example.test/v1', 'x')
  check('a wildcard entry matches a subdomain', parseUpstream('https://sky.example.test/v1', allow).host === 'sky.example.test', 'x')
  check('a wildcard entry does not match the bare domain',
    (() => { try { parseUpstream('https://example.test/v1', allow); return false } catch { return true } })(), 'x')
  check('hostAllowed rejects metadata even when listed',
    hostAllowed(['169.254.169.254'], new URL('http://169.254.169.254/x')) === false, 'x')
  check('an empty allowlist refuses everything',
    (() => { try { parseUpstream('http://api.example.test/v1', []); return false } catch (e) { return e.code === 'allowlist_not_configured' } })(), 'x')
}

async function testStaticStillServes () {
  section('host site unaffected')

  const srv = await startApp()
  const r = await request(srv.port, 'GET', '/some/spa/route')
  check('unknown path falls back to index.html', r.status === 200 && /hello-site/.test(r.text), r.status)
  const m = await request(srv.port, 'POST', '/not-api')
  check('a non-API POST is 405, not a crash', m.status === 405, m.status)
  await srv.close()
}

/* --------------------------------------------------------- review fixes ---
 *
 * One section per finding of the static review, in its order, so a re-review
 * can read the evidence next to the item it answers. Everything here runs
 * against the same fake upstream: no real model, no network beyond loopback.
 */

// R2. A ledger that cannot be read is not an empty ledger. The site stays up
// (the teacher can still look at the sky), the paid route closes, and the file
// is left exactly where it is for the operator to repair.
async function testLedgerFaults () {
  section('R2: a broken ledger closes the paid route instead of starting over')

  const cases = [
    ['{ this is not json', 'ledger_corrupt'],
    ['{"schema":99,"days":{}}', 'ledger_schema'],
    ['[]', 'ledger_schema']
  ]

  for (const [body, code] of cases) {
    const root = tmpDir('svc')
    const dataDir = path.join(root, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    const file = path.join(dataDir, 'quota.json')
    fs.writeFileSync(file, body)
    // A data directory with a ledger in it is by definition not a first run
    // (B3): the fixture writes the identity key the previous run would have
    // left behind, so the fault under test is the ledger, not a missing key.
    fs.writeFileSync(path.join(dataDir, 'identity.key'),
      crypto.randomBytes(32).toString('hex'))

    const up = makeUpstream()
    const srv = await startApp({ root, dataDir, env: { SWE_STORE_BACKEND: 'json' } }, { fetch: up.fetch })
    const jar = {}
    await login(srv, 'class-one', jar)
    const chat = await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
    })
    check(code + ': the paid route is closed, not silently empty',
      chat.status === 503 && chat.json.error === 'storage_unavailable', chat.json)
    check(code + ': the refusal names the ledger as the fault',
      chat.json.area === 'ledger' && chat.json.code === code, chat.json)
    check(code + ': the model was never called', up.count() === 0, up.count())
    check(code + ': the ledger is left byte-for-byte as it was',
      fs.readFileSync(file, 'utf8') === body, 'rewritten')
    check(code + ': the ledger is not renamed out of the way',
      !fs.readdirSync(dataDir).some((f) => /^quota\.json\./.test(f)), fs.readdirSync(dataDir))

    const h = await request(srv.port, 'GET', '/healthz')
    check(code + ': healthz reports the ledger as unavailable',
      h.json.store === 'unavailable' && h.json.fault && h.json.fault.area === 'ledger', h.json)
    const pc = await request(srv.port, 'GET', '/api/ai/config')
    check(code + ': the public config blames the site, not the teacher',
      pc.json.available === false && pc.json.fault === 'ledger', pc.json)
    await srv.close()
  }

  // Two ledgers in one directory is a deployment nobody can reason about.
  {
    const dir = tmpDir('store')
    fs.writeFileSync(path.join(dir, 'quota.json'), '{"schema":1,"days":{}}')
    fs.writeFileSync(path.join(dir, 'quota.db'), '')
    let err = null
    try { await openStore({ dir, backend: 'auto', log: quietLog() }) } catch (e) { err = e }
    check('two ledgers in one directory are refused', err && err.code === 'ledger_ambiguous', err && err.code)
  }

  // A JSON transaction that cannot be written must roll memory back too, or the
  // next request prices itself against numbers the disk does not have.
  {
    const dir = tmpDir('store')
    const st = await openStore({ dir, backend: 'json', log: quietLog() })
    const day = st.dayKey(Date.now(), 'UTC')
    st.reserve({ day, subject: 'aaaaaaaa', dailyGlobal: 0, dailyPerSubject: 0 })
    const before = st.usageFor(day, 'global')

    // Make the commit impossible: the target name is now a directory.
    fs.unlinkSync(path.join(dir, 'quota.json'))
    fs.mkdirSync(path.join(dir, 'quota.json'))
    let err = null
    try { st.reserve({ day, subject: 'aaaaaaaa', dailyGlobal: 0, dailyPerSubject: 0 }) } catch (e) { err = e }
    check('a failed ledger write is reported, not swallowed', err && err.code === 'ledger_write_failed', err && err.code)
    check('a failed ledger write rolls the in-memory counts back',
      st.usageFor(day, 'global').used === before.used, { before: before.used, after: st.usageFor(day, 'global').used })

    // And the store is still usable afterwards: a stuck nesting depth would
    // make every later transaction run outside a transaction.
    fs.rmdirSync(path.join(dir, 'quota.json'))
    st.reserve({ day, subject: 'aaaaaaaa', dailyGlobal: 0, dailyPerSubject: 0 })
    check('a transaction after a failed one still commits',
      st.usageFor(day, 'global').used === before.used + 1,
      { want: before.used + 1, got: st.usageFor(day, 'global').used })
    st.close()
  }

  // R2 supplementary: an unusable identity key is a fault, not a new key. A
  // regenerated secret silently re-prices every teacher as a new subject.
  {
    const root = tmpDir('svc')
    const dataDir = path.join(root, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'identity.key'), 'not-a-key')
    const up = makeUpstream()
    const srv = await startApp({ root, dataDir }, { fetch: up.fetch })
    const jar = {}
    const lg = await login(srv, 'class-one', jar)
    check('a broken identity key still lets the teacher sign in', lg.status === 200, lg.status)
    const chat = await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
    })
    check('a broken identity key closes the paid route',
      chat.status === 503 && chat.json.area === 'identity', chat.json)
    check('a broken identity key is not replaced',
      fs.readFileSync(path.join(dataDir, 'identity.key'), 'utf8') === 'not-a-key', 'rewritten')
    check('a broken identity key never reaches the model', up.count() === 0, up.count())
    await srv.close()
  }
}

// R4. A token file that cannot be read is a revocation, not "carry on with the
// last good list". Otherwise deleting the file locks nobody out.
async function testTokenFileRevocation () {
  section('R4: an unreadable token file revokes instead of caching')

  const root = tmpDir('svc')
  const tf = path.join(root, 'tokens.txt')
  fs.writeFileSync(tf, 'class-two\n')
  const srv = await startApp({
    root,
    env: { SWE_ACCESS_TOKENS: null, SWE_ACCESS_TOKENS_FILE: tf }
  })
  const jar = {}
  const ok = await login(srv, 'class-two', jar)
  check('the file passphrase works while the file exists', ok.status === 200, ok.status)

  let h = await request(srv.port, 'GET', '/healthz')
  check('healthz lists the passphrase file as readable',
    h.json.authFiles && h.json.authFiles.classroom === true, h.json.authFiles)

  fs.unlinkSync(tf)
  const st = await request(srv.port, 'GET', '/api/auth/status', { cookies: jar })
  check('deleting the token file revokes the live session', st.json.authenticated === false, st.json)

  const again = await login(srv, 'class-two', {})
  check('deleting the token file refuses a new login', again.status === 403, again.status)

  h = await request(srv.port, 'GET', '/healthz')
  check('healthz says the passphrase file is gone',
    h.json.authFiles && h.json.authFiles.classroom === false, h.json.authFiles)
  check('the service is still up with no passphrases', h.status === 200 && h.json.ok === true, h.status)
  await srv.close()
}

// R5. The key and the config it belongs to are published together: a save that
// fails must not leave the new credential in effect for the old upstream.
async function testKeyPairing () {
  section('R5: the key travels with the revision it was saved for')

  const up = makeUpstream()
  const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
  const jar = {}
  await login(srv, 'admin-one', jar)

  const K1 = 'sk-KEY-ONE-1111111111'
  const K2 = 'sk-KEY-TWO-2222222222'
  const K3 = 'sk-KEY-THREE-3333333333'

  const first = await configure(srv, jar, {
    baseUrl: 'http://ollama.local/v1', model: 'm', key: K1, authMode: 'auto', enabled: true
  })
  check('the first key is accepted', first.status === 200 && first.json.live === true, first.json)
  const rev1 = first.json.revision
  check('the key file is named after its revision',
    fs.readFileSync(keyPath(srv.dataDir, rev1), 'utf8').trim() === K1, 'value')

  // A rejected save must not swap the credential: the next real request still
  // has to carry K1, and no third key file may appear.
  const bad = await configure(srv, jar, { baseUrl: 'http://evil.test/v1', key: K3 })
  check('a rejected save is still rejected', bad.status === 400, bad.json)
  check('a rejected save leaves the effective key alone',
    srv.app.config.key() === K1, 'key changed')
  check('a rejected save writes no key file',
    fs.readdirSync(path.join(srv.dataDir, 'keys')).filter((f) => f.endsWith('.key')).length === 1,
    fs.readdirSync(path.join(srv.dataDir, 'keys')))

  await request(srv.port, 'POST', '/api/ai/chat', {
    body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
  })
  check('the upstream still receives the key that belongs to the config',
    up.last().headers.Authorization === 'Bearer ' + K1, up.last().headers.Authorization)

  // A real rotation: one save, one revision, one key file.
  const second = await configure(srv, jar, { key: K2 })
  check('rotating the key is one revision', second.json.revision === rev1 + 1, second.json)
  check('the rotated key is in effect', srv.app.config.key() === K2, 'value')
  check('the superseded key file is gone',
    !fs.existsSync(keyPath(srv.dataDir, rev1)), fs.readdirSync(path.join(srv.dataDir, 'keys')))

  // The pair survives a restart: the config points at the key it was saved with.
  const dataDir = srv.dataDir
  const root = srv.root
  await srv.close()
  const again = await startApp({ root, dataDir, env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
  check('a restart restores the key/config pair', again.app.config.key() === K2, 'lost')
  check('a restart keeps the feature live', again.app.config.live() === true, again.app.config.missing())
  await again.close()
}

// R6. The admin "generate" button spends the same budget as a classroom, so it
// goes through the same concurrency gate.
async function testAdminGenerateGate () {
  section('R6: admin test generation goes through the concurrency gate')

  const up = makeUpstream()
  const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
  const jar = {}
  await login(srv, 'admin-one', jar)
  await configure(srv, jar, {
    baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'none', enabled: true,
    limits: { globalInflight: 1, perIdentityInflight: 1, timeoutMs: 20000 }
  })

  up.setMode('late', { ms: 1200 })
  const inFlight = request(srv.port, 'POST', '/api/ai/chat', {
    body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
  })
  await new Promise((r) => setTimeout(r, 300))
  const gen = await request(srv.port, 'POST', '/api/admin/test-generate', { cookies: jar })
  check('a second paid call is refused while one is in flight', gen.status === 429, gen.status)
  check('the refusal carries a retry hint', !!gen.headers['retry-after'], gen.headers['retry-after'])
  const first = await inFlight
  check('the call that held the slot still succeeds', first.status === 200, first.status)
  await srv.close()
}

// R8. An upstream saved while its host was allowed must stop being used when
// the allowlist shrinks, including across a restart.
async function testAllowlistAfterRestart () {
  section('R8: the saved upstream is re-checked against the allowlist')

  const up = makeUpstream()
  const root = tmpDir('svc')
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const env = { SWE_AI_ALLOWED_HOSTS: 'ollama.local' }
  const srv = await startApp({ root, dataDir, env }, { fetch: up.fetch })
  const jar = {}
  await login(srv, 'admin-one', jar)
  const saved = await configure(srv, jar, {
    baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'none', enabled: true
  })
  check('the upstream is saved and live', saved.json.live === true, saved.json)
  const cfgBefore = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')
  await srv.close()

  // The operator removes the host from the allowlist and restarts.
  const srv2 = await startApp({
    root, dataDir, env: { SWE_AI_ALLOWED_HOSTS: 'api.example.test' }
  }, { fetch: up.fetch })
  const before = up.count()
  const chat = await request(srv2.port, 'POST', '/api/ai/chat', {
    body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
  })
  check('a saved host that is no longer allowed is refused',
    chat.status === 503 && chat.json.error === 'server_ai_unavailable', chat.json)
  check('the refused host is never contacted', up.count() === before, up.count() - before)

  const jar2 = {}
  await login(srv2, 'admin-one', jar2)
  const gen = await request(srv2.port, 'POST', '/api/admin/test-generate', { cookies: jar2 })
  check('the admin generate button is refused too', gen.status === 503, gen.status)
  const probe = await request(srv2.port, 'POST', '/api/admin/test-connection', { cookies: jar2 })
  check('the connection check is refused too',
    probe.json && probe.json.ok === false && probe.json.code === 'server_ai_unavailable', probe.json)

  const cfg = await request(srv2.port, 'GET', '/api/admin/config', { cookies: jar2 })
  check('the admin page can say the host is no longer allowed',
    cfg.json.config.upstream.allowed === false, cfg.json.config.upstream)
  check('the operator sees the allowlist as the missing piece',
    (cfg.json.missing || []).includes('allowlist'), cfg.json.missing)
  check('the saved configuration is preserved, not rewritten',
    fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8') === cfgBefore, 'rewritten')
  await srv2.close()
}

// R9. A settings page left open in another tab must not write back the
// `enabled: true` it was rendered with and undo an emergency stop.
async function testRevisionCompareAndSet () {
  section('R9: a stale admin form cannot overwrite a newer config')

  const up = makeUpstream()
  const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
  const tabA = {}
  const tabB = {}
  await login(srv, 'admin-one', tabA)
  await login(srv, 'admin-one', tabB)

  const saved = await configure(srv, tabA, {
    baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'none', enabled: true
  })
  const rev = saved.json.revision
  check('the first save sets a revision', rev > 0, rev)

  // Tab B was rendered at `rev` and has not reloaded.
  const missing = await configure(srv, tabB, { model: 'other', expectedRevision: null })
  check('a save without a revision is refused',
    missing.status === 400 && missing.json.error === 'revision_required', missing.json)
  check('the refusal tells the caller which revision to use', missing.json.revision === rev, missing.json)

  // The operator saves in tab A. Tab B now holds a stale form.
  const newer = await configure(srv, tabA, { model: 'm2' })
  check('the second save moves the revision on', newer.json.revision === rev + 1, newer.json)

  const stale = await configure(srv, tabB, { model: 'stale', expectedRevision: rev })
  check('a stale form is refused with a conflict', stale.status === 409 && stale.json.error === 'revision_conflict', stale.json)
  check('the conflict reports the current revision', stale.json.revision === rev + 1, stale.json)
  const afterStale = await request(srv.port, 'GET', '/api/admin/config', { cookies: tabA })
  check('a stale form changed nothing', afterStale.json.config.upstream.model === 'm2', afterStale.json.config.upstream)

  // The dangerous case: an emergency stop, then a stale form that still says
  // `enabled: true`.
  const stop = await request(srv.port, 'POST', '/api/admin/emergency-stop', { cookies: tabA })
  check('emergency stop succeeds', stop.json.live === false, stop.json)
  const revStop = stop.json.revision
  const resurrect = await configure(srv, tabB, {
    baseUrl: 'http://ollama.local/v1', model: 'm2', authMode: 'none', enabled: true,
    expectedRevision: rev + 1
  })
  check('a stale form cannot re-enable a stopped service',
    resurrect.status === 409 && resurrect.json.error === 'revision_conflict', resurrect.json)
  const stillStopped = await request(srv.port, 'GET', '/api/ai/config')
  check('the service is still stopped after the attempt', stillStopped.json.available === false, stillStopped.json)
  const h = await request(srv.port, 'GET', '/healthz')
  check('healthz still reports the service as stopped', h.json.ai === false && h.json.revision === revStop, h.json)

  // A stop itself is never blocked by a stale form: refusing to stop is worse
  // than a conflict.
  const stopAgain = await request(srv.port, 'POST', '/api/admin/emergency-stop', { cookies: tabB })
  check('emergency stop does not require a revision', stopAgain.status === 200, stopAgain.status)

  const clearStale = await keyOp(srv, tabA, { clear: true, expectedRevision: rev })
  check('clearing the key from a stale form is refused too',
    clearStale.status === 409 && clearStale.json.error === 'revision_conflict', clearStale.json)
  await srv.close()
}

// R2 supplement (review round 2). A ledger the service cannot interpret is a
// fault; one it MISREADS is a reset. The old "is days an object?" check let a
// document like {"days":[]} through, and string keys on an array do not survive
// JSON.stringify - so the next save silently dropped every count and a restart
// handed every class a fresh budget.
async function testLedgerShape () {
  section('R2: a ledger with a bad shape closes instead of resetting')

  const cases = [
    ['{"schema":1,"days":[]}', 'days as an array is refused'],
    ['{"schema":1,"days":{"2026-13-99":{"global":{},"subjects":{}}}}', 'a malformed day key is refused'],
    ['{"schema":1,"days":{"2026-10-31":{"bogus":{},"subjects":{}}}}', 'an unexpected field in a day is refused'],
    ['{"schema":1,"days":{"2026-10-31":{"global":{"spent":3},"subjects":{}}}}', 'an unknown global state is refused'],
    ['{"schema":1,"days":{"2026-10-31":{"global":{"reserved":-1},"subjects":{}}}}', 'a negative count is refused'],
    ['{"schema":1,"days":{"2026-10-31":{"global":{},"subjects":{"bad subject!":{}}}}}', 'a malformed subject key is refused'],
    ['{"schema":1,"days":{"2026-10-31":{"global":{},"subjects":{"aaaaaaaa":{"done":1}}}}}', 'an unknown per-subject state is refused']
  ]
  for (const [body, name] of cases) {
    const dir = tmpDir('shape')
    const file = path.join(dir, 'quota.json')
    fs.writeFileSync(file, body)
    let err = null
    try { await openStore({ dir, backend: 'json', log: quietLog() }) } catch (e) { err = e }
    check(name, err && err.code === 'ledger_schema', err && err.code)
    check(name + ' - the file is left byte-for-byte in place',
      fs.readFileSync(file, 'utf8') === body, 'rewritten')
  }

  // The honest companion: a well-formed ledger with real counts still loads,
  // saves, and reloads.
  const dir = tmpDir('shape-ok')
  fs.writeFileSync(path.join(dir, 'quota.json'), JSON.stringify({
    schema: 1,
    days: { '2026-10-01': { global: { completed: 2 }, subjects: { aaaaaaaa: { completed: 2 } } } }
  }))
  const st = await openStore({ dir, backend: 'json', log: quietLog() })
  check('a well-formed ledger loads with its counts', st.usageFor('2026-10-01', 'global').used === 2, st.usageFor('2026-10-01', 'global'))
  st.reserve({ day: '2026-10-02', subject: 'aaaaaaaa', dailyGlobal: 0, dailyPerSubject: 0 })
  st.close()
  const again = await openStore({ dir, backend: 'json', log: quietLog() })
  check('a ledger saved under the strict rules reloads', again.usageFor('2026-10-02', 'aaaaaaaa').used === 1, again.usageFor('2026-10-02', 'aaaaaaaa'))
  again.close()
}

// R2 supplement (review round 2). The directory half of the atomic write used
// to be one unconditional silent catch: a real I/O error after the rename was
// reported as success. The semantics now: platform-cannot is accepted, a real
// fault throws, and a fault AFTER the rename keeps the published state in
// memory and on disk agreeing while healthz shows the durability is unproven.
async function testDirectorySyncSemantics () {
  section('R2: a directory fsync fault is reported, not swallowed')

  {
    const dir = tmpDir('dirsync')
    let out = null
    let err = null
    try { out = syncDirectory(dir) } catch (e) { err = e }
    check('syncDirectory on a normal directory does not report a fault',
      !err && (out === 'ok' || out === 'unsupported'), { out, err: err && err.code })
    err = null
    try { syncDirectory(path.join(dir, 'does-not-exist')) } catch (e) { err = e }
    check('a missing directory is a real fault, not platform noise',
      err && err.code === 'dir_sync_failed', err && err.code)
  }

  // A publish that renames but cannot fsync the directory: the counts are
  // live (memory AND disk), and the fault is visible until the next clean
  // write. Rolling memory back here would make the next transaction silently
  // overwrite numbers the disk already holds.
  {
    const dir = tmpDir('dirsync-tx')
    let injected = null
    const write = (file, data) => {
      if (injected) return injected(file, data)
      return writeFileAtomic(file, data)
    }
    const st = await openStore({ dir, backend: 'json', log: quietLog(), write })
    const day = st.dayKey(Date.now(), 'UTC')
    st.reserve({ day, subject: 'aaaaaaaa', dailyGlobal: 0, dailyPerSubject: 0 })
    const before = st.usageFor(day, 'global').used

    injected = (file, data) => {
      // Publish exactly like the real one, then fail the directory fsync.
      fs.writeFileSync(file, data)
      const e = new Error('injected directory fsync failure')
      e.code = 'dir_sync_failed'
      e.published = true
      e.detail = 'injected'
      throw e
    }
    let err = null
    try { st.reserve({ day, subject: 'aaaaaaaa', dailyGlobal: 0, dailyPerSubject: 0 }) } catch (e) { err = e }
    check('a publish that cannot prove durability is reported',
      err && err.code === 'ledger_sync_failed', err && err.code)
    check('the published counts stay in memory after a durability fault',
      st.usageFor(day, 'global').used === before + 1,
      { want: before + 1, got: st.usageFor(day, 'global').used })
    check('the published counts are on disk too',
      (JSON.parse(fs.readFileSync(path.join(dir, 'quota.json'), 'utf8')).days[day].global.reserved) === before + 1,
      'disk')
    check('healthz can see the degraded sync state',
      st.syncHealth().degraded === true && st.syncHealth().lastError === 'injected', st.syncHealth())

    injected = null
    st.reserve({ day, subject: 'aaaaaaaa', dailyGlobal: 0, dailyPerSubject: 0 })
    check('the next clean publish clears the degraded state',
      st.syncHealth().degraded === false && st.usageFor(day, 'global').used === before + 2,
      { sync: st.syncHealth(), used: st.usageFor(day, 'global').used })
    st.close()
  }
}

// B3 (review round 2). An identity key is generated only for a genuinely fresh
// data directory. A directory that already holds a ledger, a configuration or a
// versioned key is a previous deployment: regenerating the secret there re-keys
// every passphrase, and "restore a backup, forget identity.key" silently gives
// every class a new budget.
async function testIdentityProtection () {
  section('B3: an existing data directory never gets a new identity key')

  {
    const root = tmpDir('id-fresh')
    const dataDir = path.join(root, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    const srv = await startApp({ root, dataDir })
    check('a fresh data directory is initialized with an identity key',
      fs.existsSync(path.join(dataDir, 'identity.key')), fs.readdirSync(dataDir))
    await srv.close()
  }

  const markers = [
    ['quota.json', (d) => fs.writeFileSync(path.join(d, 'quota.json'), '{"schema":1,"days":{}}')],
    ['quota.db', (d) => fs.writeFileSync(path.join(d, 'quota.db'), '')],
    ['config.json', (d) => fs.writeFileSync(path.join(d, 'config.json'),
      JSON.stringify({ schema: 1, revision: 2, enabled: false, upstream: { keyRef: 'rev-2' } }))],
    ['keys/rev-1.key', (d) => {
      fs.mkdirSync(path.join(d, 'keys'))
      fs.writeFileSync(path.join(d, 'keys', 'rev-1.key'), 'sk-orphan')
    }]
  ]
  for (const [name, mark] of markers) {
    const root = tmpDir('id-kept')
    const dataDir = path.join(root, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    mark(dataDir)
    const up = makeUpstream()
    const srv = await startApp({ root, dataDir }, { fetch: up.fetch })
    const jar = {}
    const lg = await login(srv, 'class-one', jar)
    check('sign-in still works beside an existing ' + name, lg.status === 200, lg.status)
    const chat = await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
    })
    check('a lost identity key beside an existing ' + name + ' closes the paid route',
      chat.status === 503 && chat.json.area === 'identity' && chat.json.code === 'identity_missing', chat.json)
    check('no replacement identity key is generated beside an existing ' + name,
      !fs.existsSync(path.join(dataDir, 'identity.key')), fs.readdirSync(dataDir))
    check('the model was never called beside an existing ' + name, up.count() === 0, up.count())
    const h = await request(srv.port, 'GET', '/healthz')
    check('healthz names the identity fault beside an existing ' + name,
      h.json.fault && h.json.fault.area === 'identity' && h.json.fault.code === 'identity_missing', h.json.fault)
    await srv.close()
  }

  // The full round trip the review named: spend quota, lose the key, restart,
  // and the service must refuse - then restoring the original bytes restores
  // the same subjects and the earlier spend is still on the books.
  {
    const up = makeUpstream()
    const root = tmpDir('id-restart')
    const dataDir = path.join(root, 'data')
    const staticDir = makeStatic(path.join(root, 'static'))
    const env = { SWE_AI_ALLOWED_HOSTS: 'ollama.local' }
    const first = await startApp({ root, dataDir, staticDir, env }, { fetch: up.fetch })
    const admin = {}
    await login(first, 'admin-one', admin)
    await configure(first, admin, {
      baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'none', enabled: true
    })
    const jar = {}
    await login(first, 'class-one', jar)
    await request(first.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
    })
    const spent = first.app.store.usageFor(
      first.app.store.dayKey(Date.now(),
        first.app.config.get().limits.dayTz), 'global').used
    check('the first run actually spent quota', spent === 1, spent)
    const keyHex = fs.readFileSync(path.join(dataDir, 'identity.key'), 'utf8')
    await first.close()

    fs.unlinkSync(path.join(dataDir, 'identity.key'))
    const second = await startApp({ root, dataDir, staticDir, env }, { fetch: up.fetch })
    const jar2 = {}
    await login(second, 'class-one', jar2)
    const refused = await request(second.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar2
    })
    check('a restart without the identity key refuses to serve the paid route',
      refused.status === 503 && refused.json.code === 'identity_missing', refused.json)
    check('a restart without the identity key generates no replacement',
      !fs.existsSync(path.join(dataDir, 'identity.key')), fs.readdirSync(dataDir))
    check('the ledger file is left alone while the fault stands',
      fs.readdirSync(dataDir).some((f) => /^quota\.(json|db)$/.test(f)), fs.readdirSync(dataDir))
    await second.close()

    // The operator finds the backup. The same passphrase maps to the same
    // subject again and the earlier spend is still counted.
    fs.writeFileSync(path.join(dataDir, 'identity.key'), keyHex)
    const third = await startApp({ root, dataDir, staticDir, env }, { fetch: up.fetch })
    const jar3 = {}
    await login(third, 'class-one', jar3)
    const ok = await request(third.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar3
    })
    check('restoring the original key restores the paid route', ok.status === 200, ok.json)
    const after = third.app.store.usageFor(
      third.app.store.dayKey(Date.now(),
        third.app.config.get().limits.dayTz), 'global').used
    check('the restored identity still finds the earlier spend', after === spent + 1,
      { want: spent + 1, got: after })
    await third.close()
  }
}

// B4 (review round 2). The real CLI entry used to dereference a null store in
// its listen callback when the data directory had failed to open: an uncaught
// TypeError killed exactly the process that was supposed to keep the site and
// /healthz alive through the fault. Both variants below spawn server.mjs the
// way a deployment does - no createApp shortcut.
async function waitHealthy (port, timeoutMs) {
  const started = Date.now()
  for (;;) {
    try {
      const r = await request(port, 'GET', '/healthz')
      if (r.status === 200) return r
    } catch { /* not up yet */ }
    if (Date.now() - started > timeoutMs) return null
    await new Promise((r) => setTimeout(r, 200))
  }
}

async function withRealService (dataDir, fn) {
  const root = tmpDir('cli')
  const staticDir = makeStatic(path.join(root, 'static'))
  const port = await freePort()
  const env = Object.assign({}, process.env, {
    SWE_BIND: '127.0.0.1',
    SWE_PORT: String(port),
    SWE_STATIC_DIR: staticDir,
    SWE_DATA_DIR: dataDir,
    SWE_ACCESS_TOKENS: 'class-one',
    SWE_ADMIN_TOKENS: 'admin-one',
    SWE_AI_ALLOWED_HOSTS: 'ollama.local',
    SWE_LOG_LEVEL: 'error',
    SWE_REQUIRE_AUTH: '1'
  })
  const child = spawn(process.execPath, [path.join(SRC, 'packages/ai-service/server.mjs')], {
    env, stdio: ['ignore', 'pipe', 'pipe']
  })
  const stderr = []
  child.stderr.on('data', (c) => stderr.push(String(c)))
  try {
    return await fn({ child, port, stderr })
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 3000)
      child.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
}

async function testRealEntrypointSurvivesStorageFault () {
  section('B4: the real CLI entry keeps the site up through a storage fault')

  // A corrupt ledger.
  {
    const dataDir = tmpDir('cli-badledger')
    fs.writeFileSync(path.join(dataDir, 'identity.key'), crypto.randomBytes(32).toString('hex'))
    fs.writeFileSync(path.join(dataDir, 'quota.json'), '{ this is not json')
    const out = await withRealService(dataDir, async ({ child, port, stderr }) => {
      const h = await waitHealthy(port, 15000)
      check('the entry process survives a corrupt ledger and answers healthz',
        !!h && child.exitCode === null, { healthy: !!h, stderr: stderr.join('').slice(0, 300) })
      if (!h) return
      check('healthz names the ledger as the fault',
        h.json.fault && h.json.fault.area === 'ledger' && h.json.fault.code === 'ledger_corrupt', h.json.fault)
      const site = await request(port, 'GET', '/')
      check('the static site still serves with a corrupt ledger',
        site.status === 200 && /hello-site/.test(site.text), site.status)
      const jar = {}
      await login({ port }, 'class-one', jar)
      const chat = await request(port, 'POST', '/api/ai/chat', {
        body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
      })
      check('generation stays closed with a corrupt ledger',
        chat.status === 503 && chat.json.error === 'storage_unavailable', chat.json)
    })
    void out
  }

  // An unusable identity key.
  {
    const dataDir = tmpDir('cli-badidentity')
    fs.writeFileSync(path.join(dataDir, 'identity.key'), 'not-a-key')
    const out = await withRealService(dataDir, async ({ child, port }) => {
      const h = await waitHealthy(port, 15000)
      check('the entry process survives a broken identity key',
        !!h && child.exitCode === null, { healthy: !!h })
      if (!h) return
      check('healthz names the identity as the fault',
        h.json.fault && h.json.fault.area === 'identity', h.json.fault)
      const site = await request(port, 'GET', '/')
      check('the static site still serves with a broken identity key',
        site.status === 200 && /hello-site/.test(site.text), site.status)
      const jar = {}
      await login({ port }, 'class-one', jar)
      const chat = await request(port, 'POST', '/api/ai/chat', {
        body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
      })
      check('generation stays closed with a broken identity key',
        chat.status === 503 && chat.json.area === 'identity', chat.json)
    })
    void out
  }
}

// R4 supplement (review round 2). stat() succeeding says nothing about the
// CONTENT being readable: a file swapped for a directory keeps answering stat
// and fails the read; a chmod that removes the read bit changes no mtime at
// all. Both must revoke instead of riding the cache, and both must recover.
async function testTokenFileReadFailures () {
  section('R4: an unreadable token file revokes even when stat still works')

  const root = tmpDir('svc')
  const tf = path.join(root, 'tokens.txt')
  fs.writeFileSync(tf, 'class-two\n')
  const srv = await startApp({
    root,
    env: { SWE_ACCESS_TOKENS: null, SWE_ACCESS_TOKENS_FILE: tf }
  })
  const jar = {}
  const ok = await login(srv, 'class-two', jar)
  check('the file passphrase works before the failure', ok.status === 200, ok.status)

  // stat succeeds, read does not: the path became a directory.
  fs.unlinkSync(tf)
  fs.mkdirSync(tf)
  const st = await request(srv.port, 'GET', '/api/auth/status', { cookies: jar })
  check('a stat-able but unreadable token file revokes the session',
    st.json.authenticated === false, st.json)
  let h = await request(srv.port, 'GET', '/healthz')
  check('healthz reports the unreadable token file as not readable',
    h.json.authFiles && h.json.authFiles.classroom === false, h.json.authFiles)
  const again = await login(srv, 'class-two', {})
  check('an unreadable token file refuses a new login', again.status === 403, again.status)

  // Recovery: a real file again, and the passphrases come back without a
  // restart.
  fs.rmdirSync(tf)
  fs.writeFileSync(tf, 'class-two\n# restored\n')
  const back = await request(srv.port, 'GET', '/api/auth/status', { cookies: jar })
  check('a restored token file ends the revocation', back.json.authenticated === true, back.json)
  h = await request(srv.port, 'GET', '/healthz')
  check('healthz shows the token file as readable again',
    h.json.authFiles && h.json.authFiles.classroom === true, h.json.authFiles)
  await srv.close()

  if (process.platform === 'win32') {
    console.log('SKIP chmod revocation probe (Windows chmod cannot take the read bit away)')
  } else {
    const root2 = tmpDir('svc')
    const tf2 = path.join(root2, 'tokens.txt')
    fs.writeFileSync(tf2, 'class-three\n')
    const srv2 = await startApp({
      root: root2,
      env: { SWE_ACCESS_TOKENS: null, SWE_ACCESS_TOKENS_FILE: tf2 }
    })
    const jar2 = {}
    const ok2 = await login(srv2, 'class-three', jar2)
    check('the chmod probe: the passphrase works before the chmod', ok2.status === 200, ok2.status)

    // No mtime change - only the permission bit moves.
    fs.chmodSync(tf2, 0o000)
    const revoked = await request(srv2.port, 'GET', '/api/auth/status', { cookies: jar2 })
    check('a chmod with no mtime change still revokes the cached tokens',
      revoked.json.authenticated === false, revoked.json)
    const fresh = await login(srv2, 'class-three', {})
    check('a chmod with no mtime change refuses a new login', fresh.status === 403, fresh.status)

    fs.chmodSync(tf2, 0o644)
    const restored = await request(srv2.port, 'GET', '/api/auth/status', { cookies: jar2 })
    check('restoring the read permission ends the revocation',
      restored.json.authenticated === true, restored.json)
    await srv2.close()
  }
}

// R5 supplement (review round 2). Three states must be distinguishable and
// each must behave: a legacy key honoured for upgrade, a legacy file retired by
// the first versioned key, and an explicitly cleared key that a leftover legacy
// file cannot resurrect.
async function testLegacyKeyLifecycle () {
  section('R5: the legacy key is honoured, then retired, then forgotten')

  const K0 = 'sk-LEGACY-0000000000000000'
  const K1 = 'sk-KEY-ONE-1111111111'
  const K2 = 'sk-KEY-TWO-2222222222'
  const legacyPath = (dataDir) => path.join(dataDir, 'upstream.key')

  {
    // A pre-R5 deployment: config.json has no keyRef field at all, the key
    // lives in upstream.key.
    const up = makeUpstream()
    const root = tmpDir('svc')
    const dataDir = path.join(root, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      schema: 1,
      revision: 4,
      updatedAt: '2026-10-01T00:00:00.000Z',
      updatedBy: 'before',
      enabled: true,
      note: '',
      upstream: { baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'auto' },
      limits: {}
    }, null, 2) + '\n')
    fs.writeFileSync(legacyPath(dataDir), K0)
    // A pre-R5 directory is a previous deployment (B3): it carries the
    // identity key that run left behind.
    fs.writeFileSync(path.join(dataDir, 'identity.key'), crypto.randomBytes(32).toString('hex'))
    const srv = await startApp({ root, dataDir, env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
    const admin = {}
    await login(srv, 'admin-one', admin)

    check('a pre-R5 key is still honoured for upgrade', srv.app.config.key() === K0, 'lost')
    check('the legacy deployment is live', srv.app.config.live() === true, srv.app.config.missing())
    const cfg = await request(srv.port, 'GET', '/api/admin/config', { cookies: admin })
    check('the admin page says the key source is the legacy file',
      cfg.json.config.upstream.keySource === 'legacy' && cfg.json.config.upstream.legacyPending === true,
      cfg.json.config.upstream)

    // Saving a key writes the versioned file AND retires the legacy bytes.
    const saved = await configure(srv, admin, { key: K1 })
    check('saving a key on a legacy config moves one revision', saved.status === 200, saved.json)
    check('the first versioned key retires the legacy file',
      !fs.existsSync(legacyPath(dataDir)), fs.readdirSync(dataDir))
    const after = await request(srv.port, 'GET', '/api/admin/config', { cookies: admin })
    check('the key source becomes the revision file',
      after.json.config.upstream.keySource === 'revision' && after.json.config.upstream.legacyPending === false,
      after.json.config.upstream)
    await srv.close()
  }

  {
    // A save that leaves the key box alone must not drop the working legacy
    // credential: it migrates into the versioned store as part of that save.
    const up = makeUpstream()
    const root = tmpDir('svc')
    const dataDir = path.join(root, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      schema: 1,
      revision: 4,
      updatedAt: '2026-10-01T00:00:00.000Z',
      updatedBy: 'before',
      enabled: true,
      note: '',
      upstream: { baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'auto' },
      limits: {}
    }, null, 2) + '\n')
    fs.writeFileSync(legacyPath(dataDir), K0)
    // A pre-R5 directory is a previous deployment (B3): it carries the
    // identity key that run left behind.
    fs.writeFileSync(path.join(dataDir, 'identity.key'), crypto.randomBytes(32).toString('hex'))
    const srv = await startApp({ root, dataDir, env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
    const admin = {}
    await login(srv, 'admin-one', admin)

    const migrated = await configure(srv, admin, { note: 'first save after the upgrade' })
    check('a save that leaves the key box alone keeps the feature live',
      migrated.status === 200 && migrated.json.live === true, migrated.json)
    check('the untouched key box migrates the legacy key into the revision store',
      srv.app.config.key() === K0 && srv.app.config.get().upstream.keySource === 'revision',
      { key: srv.app.config.key(), src: srv.app.config.get().upstream.keySource })
    check('the migration retires the legacy file', !fs.existsSync(legacyPath(dataDir)))
    await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: admin
    })
    check('the upstream receives the migrated credential',
      up.last().headers.Authorization === 'Bearer ' + K0, up.last().headers.Authorization)
    await srv.close()

    const again = await startApp({ root, dataDir, env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
    check('the migrated pair survives a restart', again.app.config.key() === K0, again.app.config.key())
    await again.close()
  }

  {
    // Explicit clear, then the resurrection attempt the review named: a
    // legacy file that could not be deleted must not become the key again.
    const root = tmpDir('svc')
    const dataDir = path.join(root, 'data')
    const srv = await startApp({ root, dataDir, env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } })
    const admin = {}
    await login(srv, 'admin-one', admin)
    await configure(srv, admin, {
      baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'auto', key: K1, enabled: true
    })
    const cleared = await keyOp(srv, admin, { clear: true })
    check('an explicit clear removes the key', cleared.status === 200 && cleared.json.changed === true, cleared.json)
    check('the effective key is empty after the clear', srv.app.config.key() === '', 'not empty')

    // The bytes come back (a botched restore, a stray copy) - they must stay
    // dead bytes, because the document now carries a keyRef field.
    fs.writeFileSync(legacyPath(dataDir), K0)
    check('a leftover legacy file is reported as pending retirement',
      srv.app.config.get().upstream.legacyPending === true &&
      srv.app.config.get().upstream.keySource === 'none', srv.app.config.get().upstream)
    const reenable = await configure(srv, admin, { enabled: true })
    check('a cleared key is not resurrected from leftover legacy bytes',
      reenable.status === 400 && reenable.json.error === 'enable_without_key', reenable.json)
    check('the resurrect-attempt left the key empty', srv.app.config.key() === '', 'resurrected')
    await srv.close()

    // The same refusal must survive a restart: the state is on disk (the
    // document has a keyRef), not in this process's memory.
    const again = await startApp({ root, dataDir, env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } })
    check('a restart does not re-adopt leftover legacy bytes',
      again.app.config.key() === '' && again.app.config.live() === false, again.app.config.key())
    await again.close()
  }

  {
    // A legacy file that cannot be unlinked is reported, not hidden.
    const root = tmpDir('svc')
    const dataDir = path.join(root, 'data')
    const srv = await startApp({ root, dataDir, env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } })
    const admin = {}
    await login(srv, 'admin-one', admin)
    await configure(srv, admin, {
      baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'auto', key: K2, enabled: true
    })
    // An old copy comes back and then cannot be removed: it becomes a
    // directory, which answers unlink with EPERM/EISDIR everywhere.
    fs.writeFileSync(legacyPath(dataDir), K0)
    fs.unlinkSync(legacyPath(dataDir))
    fs.mkdirSync(legacyPath(dataDir))
    const rotated = await configure(srv, admin, { key: K1 })
    check('a rotation whose legacy prune cannot delete still succeeds',
      rotated.status === 200 && srv.app.config.key() === K1, rotated.json)
    const cleared = await keyOp(srv, admin, { clear: true })
    check('a clear that cannot delete the legacy file says so',
      cleared.status === 200 && typeof cleared.json.leftover === 'string' && cleared.json.leftover, cleared.json)
    check('the un-deletable legacy file is still not a key',
      srv.app.config.key() === '' && srv.app.config.get().upstream.keySource === 'none',
      srv.app.config.get().upstream)
    await srv.close()
  }
}

// R5 supplement (review round 2): the fault window the original item named.
// The key is written first, the config is published second; a publish that
// fails must leave the OLD pair in effect - and the orphaned key file must
// never be adopted, including after a restart.
async function testKeyConfigFaultWindow () {
  section('R5: a config publish that fails keeps the old key in effect')

  const up = makeUpstream()
  const root = tmpDir('svc')
  const dataDir = path.join(root, 'data')
  const srv = await startApp({ root, dataDir, env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
  const jar = {}
  await login(srv, 'admin-one', jar)
  const K1 = 'sk-KEY-ONE-1111111111'
  const K2 = 'sk-KEY-TWO-2222222222'

  const first = await configure(srv, jar, {
    baseUrl: 'http://ollama.local/v1', model: 'm', key: K1, authMode: 'auto', enabled: true
  })
  const rev1 = first.json.revision
  check('the first pair is live', first.status === 200 && first.json.live === true, first.json)

  // The publish target becomes impossible while reads keep working.
  const cfgBefore = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')
  fs.unlinkSync(path.join(dataDir, 'config.json'))
  fs.mkdirSync(path.join(dataDir, 'config.json'))
  const broken = await configure(srv, jar, { key: K2 })
  check('a save that cannot publish is reported as a server fault', broken.status === 500, broken.status)
  check('the effective key is still the old one', srv.app.config.key() === K1, 'changed')
  await request(srv.port, 'POST', '/api/ai/chat', {
    body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
  })
  check('the upstream still receives the old key after the failed publish',
    up.last().headers.Authorization === 'Bearer ' + K1, up.last().headers.Authorization)
  const orphan = path.join(dataDir, 'keys', 'rev-' + (rev1 + 1) + '.key')
  check('the new key file was written before the publish failed',
    fs.existsSync(orphan) && fs.readFileSync(orphan, 'utf8').trim() === K2, fs.existsSync(orphan))
  check('a publish that failed BEFORE the rename prunes nothing: the old key file stays',
    fs.existsSync(keyPath(dataDir, rev1)) && fs.readFileSync(keyPath(dataDir, rev1), 'utf8').trim() === K1,
    fs.existsSync(keyPath(dataDir, rev1)))
  await srv.close()

  // Restart: the orphan must stay unreferenced. The operator restores the last
  // good config.json (that is the runbook for a publish failure).
  fs.rmdirSync(path.join(dataDir, 'config.json'))
  fs.writeFileSync(path.join(dataDir, 'config.json'), cfgBefore)
  const again = await startApp({ root, dataDir, env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
  check('a restart restores the previous key/config pair', again.app.config.key() === K1, again.app.config.key())
  check('a restart does not adopt the orphan key file',
    again.app.config.get().revision === rev1 && again.app.config.get().upstream.keyRef === 'rev-' + rev1,
    again.app.config.get().upstream)
  check('the feature is still live after the round trip', again.app.config.live() === true, again.app.config.missing())
  await again.close()
}

// R9 supplement (review round 2). The standalone key endpoint used to accept a
// missing or null revision - a direct API call could write or clear a
// credential outside the compare-and-set every other write obeys.
async function testStandaloneKeyCAS () {
  section('R9: the standalone key endpoint is compare-and-set too')

  const up = makeUpstream()
  const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
  const jar = {}
  await login(srv, 'admin-one', jar)
  await configure(srv, jar, {
    baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'auto', key: 'sk-KEY-ONE-1111111111', enabled: true
  })
  const cur = await request(srv.port, 'GET', '/api/admin/config', { cookies: jar })
  const rev = cur.json.config.revision

  const missing = await request(srv.port, 'POST', '/api/admin/config/key', {
    body: { key: 'sk-UNVERSIONED-000000' }, cookies: jar
  })
  check('a key write without a revision is refused',
    missing.status === 400 && missing.json.error === 'revision_required', missing.json)
  check('the refusal names the current revision', missing.json.revision === rev, missing.json)

  const nulled = await request(srv.port, 'POST', '/api/admin/config/key', {
    body: { key: 'sk-UNVERSIONED-000000', expectedRevision: null }, cookies: jar
  })
  check('a key write with a null revision is refused too',
    nulled.status === 400 && nulled.json.error === 'revision_required', nulled.json)

  const clearMissing = await request(srv.port, 'POST', '/api/admin/config/key', {
    body: { clear: true }, cookies: jar
  })
  check('a clear without a revision is refused',
    clearMissing.status === 400 && clearMissing.json.error === 'revision_required', clearMissing.json)

  const stale = await request(srv.port, 'POST', '/api/admin/config/key', {
    body: { clear: true, expectedRevision: rev - 1 }, cookies: jar
  })
  check('a clear from a stale revision is a conflict',
    stale.status === 409 && stale.json.error === 'revision_conflict', stale.json)

  // Defense in depth: the config layer refuses the same call even when it is
  // reached directly, not through the HTTP surface.
  let err = null
  try { srv.app.config.setKey('sk-DIRECT-000000', 'tester') } catch (e) { err = e }
  check('the config layer refuses an unconditional key write too',
    err && err.code === 'revision_required', err && err.code)
  let err2 = null
  try { srv.app.config.clearKey('tester') } catch (e) { err2 = e }
  check('the config layer refuses an unconditional clear too',
    err2 && err2.code === 'revision_required', err2 && err2.code)

  const after = await request(srv.port, 'GET', '/api/admin/config', { cookies: jar })
  check('none of the refused calls moved the revision or the key',
    after.json.config.revision === rev && srv.app.config.key() === 'sk-KEY-ONE-1111111111',
    { rev: after.json.config.revision, key: srv.app.config.key() })
  await srv.close()
}

// R3 supplement (review round 2): the server-side half of the session tag the
// panel now binds plans to.
async function testSessionTag () {
  section('R3: auth status carries a non-reversible session tag')

  const srv = await startApp()
  const before = await request(srv.port, 'GET', '/api/auth/status')
  check('no session yet: the tag is empty',
    before.json.sessionTag === '', before.json.sessionTag)

  const jar = {}
  await login(srv, 'class-one', jar)
  const first = await request(srv.port, 'GET', '/api/auth/status', { cookies: jar })
  check('a session gets a 12-hex tag',
    typeof first.json.sessionTag === 'string' && /^[0-9a-f]{12}$/.test(first.json.sessionTag),
    first.json.sessionTag)

  const jar2 = {}
  await login(srv, 'class-two', jar2)
  const second = await request(srv.port, 'GET', '/api/auth/status', { cookies: jar2 })
  check('a re-login produces a different tag',
    second.json.sessionTag !== first.json.sessionTag,
    { first: first.json.sessionTag, second: second.json.sessionTag })

  const lo = await request(srv.port, 'POST', '/api/auth/logout', { cookies: jar2 })
  absorb(jar2, lo.setCookie)
  const out = await request(srv.port, 'GET', '/api/auth/status', { cookies: jar2 })
  check('a logout empties the tag again', out.json.sessionTag === '', out.json.sessionTag)
  await srv.close()
}

// C1 (review round 3). The fault is injected AFTER config.json's rename: the
// new document IS the file on disk, only its directory entry is unproven. The
// old behaviour kept the previous snapshot in memory there - the process went
// on generating under a configuration the next restart would not see, and the
// next save could reuse an already-published revision number and key file
// name. Now the published snapshot is adopted, the fault is latched, the paid
// route is closed until a verified save or a restart, and the response still
// says the save did not come back clean.
async function testConfigPublishFault () {
  section('C1: a config publish that cannot prove durability is adopted, not hidden')

  const K1 = 'sk-KEY-ONE-1111111111'
  const K2 = 'sk-KEY-TWO-2222222222'

  const mkApp = async (fetchImpl) => {
    const up = makeUpstream()
    let failConfigSync = false
    const configWrite = (file, data) => {
      if (failConfigSync && /config\.json$/.test(file)) {
        // Publish like the real one - the content lands at the final path -
        // then fail the directory fsync.
        fs.writeFileSync(file, data)
        const e = new Error('injected directory fsync failure')
        e.code = 'dir_sync_failed'
        e.published = true
        e.detail = 'injected'
        throw e
      }
      return writeFileAtomic(file, data)
    }
    const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } },
      { fetch: fetchImpl || up.fetch, configWrite })
    return { up, srv, setFault: (v) => { failConfigSync = v } }
  }
  const diskConfig = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'))

  {
    // apply: the save reports a fault, but memory and disk agree on the NEW
    // revision, and the paid route is closed while durability is unproven.
    const { up, srv, setFault } = await mkApp()
    const jar = {}
    await login(srv, 'admin-one', jar)
    const first = await configure(srv, jar, {
      baseUrl: 'http://ollama.local/v1', model: 'm', key: K1, authMode: 'auto', enabled: true
    })
    const rev1 = first.json.revision
    check('the first save is clean', first.status === 200 && first.json.live === true, first.json)

    setFault(true)
    const broken = await configure(srv, jar, { key: K2, model: 'm2', note: 'switched under fault' })
    check('a publish that renamed but cannot fsync is reported',
      broken.status === 503 && broken.json.error === 'config_sync_unverified', broken.json)
    check('the refusal names the revision that is now on disk',
      broken.json.revision === rev1 + 1, broken.json)
    const disk = diskConfig(srv.dataDir)
    check('the new document is really on disk',
      disk.revision === rev1 + 1 && disk.upstream.keyRef === 'rev-' + (rev1 + 1) &&
      disk.upstream.model === 'm2' && disk.note === 'switched under fault', disk)
    check('memory adopts the published snapshot, not the old one',
      srv.app.config.get().revision === rev1 + 1 && srv.app.config.key() === K2,
      { rev: srv.app.config.get().revision, key: srv.app.config.key() })
    check('the adopted target and note match the disk too',
      srv.app.config.get().upstream.model === 'm2' && srv.app.config.get().note === 'switched under fault',
      srv.app.config.get())
    check('the superseded key file did not survive the adoption',
      fs.readdirSync(path.join(srv.dataDir, 'keys')).join(',') === 'rev-' + (rev1 + 1) + '.key',
      fs.readdirSync(path.join(srv.dataDir, 'keys')))
    check('the paid route is closed while durability is unproven',
      srv.app.config.live() === false, srv.app.config.live())
    const chat = await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
    })
    check('no generation happens against an unverified configuration',
      chat.status === 503 && chat.json.error === 'server_ai_unavailable' && up.count() === 0,
      { status: chat.status, upstream: up.count() })
    const h = await request(srv.port, 'GET', '/healthz')
    check('healthz shows the unverified config sync',
      h.json.configSync && h.json.configSync.degraded === true, h.json.configSync)

    // Recovery: a verified save clears the latch and never reuses the
    // published revision.
    setFault(false)
    const recovered = await configure(srv, jar, { note: 'verified again' })
    check('the next save after a verified publish clears the latch',
      recovered.status === 200 && recovered.json.revision === rev1 + 2 && recovered.json.live === true,
      recovered.json)
    check('the recovered document is at a new revision, not a rewrite of the published one',
      diskConfig(srv.dataDir).revision === rev1 + 2, diskConfig(srv.dataDir).revision)
    const h2 = await request(srv.port, 'GET', '/healthz')
    check('healthz shows the config sync as proven again',
      h2.json.configSync && h2.json.configSync.degraded === false, h2.json.configSync)

    // The pair the disk kept is the one a restart loads - no key crossing.
    // (This restart happens after the recovery save above; the direct
    // restart - no recovery in between - has its own block below.)
    const root = srv.root
    const dataDir = srv.dataDir
    await srv.close()
    const again = await startApp({ root, dataDir, env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
    check('a restart after the recovery save reads the disk as it is and does not cross keys',
      again.app.config.key() === K2 && again.app.config.live() === true,
      { key: again.app.config.key(), live: again.app.config.live() })
    await again.close()
  }

  {
    // The restart evidence the review asked to sharpen: no recovery save in
    // between - the process dies right after the adopted fault, and the next
    // process reads whatever the disk actually kept.
    const up = makeUpstream()
    const { srv, setFault } = await mkApp(up.fetch)
    const jar = {}
    await login(srv, 'admin-one', jar)
    const first = await configure(srv, jar, {
      baseUrl: 'http://ollama.local/v1', model: 'm', key: K1, authMode: 'auto', enabled: true
    })
    const rev1 = first.json.revision
    setFault(true)
    await configure(srv, jar, { key: K2 })
    const root = srv.root
    const dataDir = srv.dataDir
    await srv.close()

    const again = await startApp({ root, dataDir, env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch })
    check('a restart directly after the adopted fault loads the published revision',
      again.app.config.get().revision === rev1 + 1, again.app.config.get().revision)
    check('a restart directly after the adopted fault restores the published key, not the old one',
      again.app.config.key() === K2 && again.app.config.live() === true,
      { key: again.app.config.key(), live: again.app.config.live() })
    const h = await request(again.port, 'GET', '/healthz')
    check('a restart is itself the durability proof: the sync latch is process-local',
      h.json.configSync && h.json.configSync.degraded === false, h.json.configSync)
    const jar2 = {}
    await login(again, 'class-one', jar2)
    await request(again.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar2
    })
    check('the restarted deployment sends the key the published document names',
      up.last().headers.Authorization === 'Bearer ' + K2, up.last().headers.Authorization)
    const admin2 = {}
    await login(again, 'admin-one', admin2)
    const next = await configure(again, admin2, { note: 'after direct restart' })
    check('the next save after the direct restart continues from the published revision',
      next.status === 200 && next.json.revision === rev1 + 2, next.json)
    await again.close()
  }

  {
    // The round-4 scenario, verbatim: rotate the key under a published sync
    // fault, then clear the key - every version file left behind must go, not
    // just the one that was current at the clear.
    const { srv, setFault } = await mkApp()
    const jar = {}
    await login(srv, 'admin-one', jar)
    const first = await configure(srv, jar, {
      baseUrl: 'http://ollama.local/v1', model: 'm', key: K1, authMode: 'auto', enabled: true
    })
    const rev1 = first.json.revision
    setFault(true)
    const rotated = await configure(srv, jar, { key: K2 })
    check('the rotation under a sync fault is adopted and reported',
      rotated.status === 503 && rotated.json.error === 'config_sync_unverified', rotated.json)
    check('the superseded K1 file is gone at adoption time',
      fs.readdirSync(path.join(srv.dataDir, 'keys')).join(',') === 'rev-' + (rev1 + 1) + '.key',
      fs.readdirSync(path.join(srv.dataDir, 'keys')))

    // Clear while the fault is still in place: the sweep runs even though the
    // publish reports unproven durability.
    const cleared = await keyOp(srv, jar, { clear: true })
    check('a clear under the same fault is reported and adopted',
      cleared.status === 503 && cleared.json.error === 'config_sync_unverified', cleared.json)
    check('the sweep took every version file with it',
      fs.readdirSync(path.join(srv.dataDir, 'keys')).length === 0,
      fs.readdirSync(path.join(srv.dataDir, 'keys')))
    check('no key is in effect in memory or on disk after the sweep',
      srv.app.config.key() === '' && diskConfig(srv.dataDir).upstream.keyRef === '',
      { key: srv.app.config.key(), disk: diskConfig(srv.dataDir).upstream })

    // And the ordinary path: a clean clear leaves an empty keys directory.
    // Re-keying also re-enables: clearKey switched the feature off and a bare
    // key save does not turn it back on.
    setFault(false)
    await configure(srv, jar, { note: 'verified again' })
    const saved = await configure(srv, jar, { key: K1, enabled: true })
    check('the deployment can be re-keyed after the round trip',
      saved.status === 200 && saved.json.live === true, saved.json)
    const clean = await keyOp(srv, jar, { clear: true })
    check('a clean clear still reports success and sweeps the keys directory',
      clean.status === 200 && fs.readdirSync(path.join(srv.dataDir, 'keys')).length === 0,
      { res: clean.json, keys: fs.readdirSync(path.join(srv.dataDir, 'keys')) })
    await srv.close()
  }

  {
    // emergencyStop: a stop that renamed but cannot fsync IS in effect on
    // disk and in memory; the caller still hears the durability question.
    const { srv, setFault } = await mkApp()
    const jar = {}
    await login(srv, 'admin-one', jar)
    await configure(srv, jar, {
      baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'none', enabled: true
    })
    setFault(true)
    const stop = await request(srv.port, 'POST', '/api/admin/emergency-stop', { cookies: jar })
    check('an emergency stop with an unproven publish is reported',
      stop.status === 503 && stop.json.error === 'config_sync_unverified', stop.json)
    check('the stop is nevertheless in effect in memory and on disk',
      srv.app.config.get().enabled === false &&
      diskConfig(srv.dataDir).enabled === false, srv.app.config.get())
    check('the stopped service does not accept generations',
      srv.app.config.live() === false, srv.app.config.live())
    const stoppedChat = await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
    })
    check('a chat against the stopped service is refused, not served',
      stoppedChat.status === 503, { status: stoppedChat.status, body: stoppedChat.json })
    setFault(false)
    const again = await request(srv.port, 'POST', '/api/admin/emergency-stop', { cookies: jar })
    check('a verified stop clears the latch', again.status === 200 && srv.app.config.syncHealth().degraded === false,
      srv.app.config.syncHealth())
    await srv.close()
  }

  {
    // setKey / clearKey through the standalone endpoint.
    const { srv, setFault } = await mkApp()
    const jar = {}
    await login(srv, 'admin-one', jar)
    await configure(srv, jar, {
      baseUrl: 'http://ollama.local/v1', model: 'm', authMode: 'auto', key: K1, enabled: true
    })
    const cur = await request(srv.port, 'GET', '/api/admin/config', { cookies: jar })
    const rev = cur.json.config.revision

    setFault(true)
    const set = await keyOp(srv, jar, { key: K2 })
    check('a key set with an unproven publish is reported',
      set.status === 503 && set.json.error === 'config_sync_unverified', set.json)
    check('the set key is adopted in memory and on disk',
      srv.app.config.key() === K2 && diskConfig(srv.dataDir).upstream.keyRef === 'rev-' + (rev + 1),
      { key: srv.app.config.key(), disk: diskConfig(srv.dataDir).upstream })
    check('the route stays closed after the unproven key set', srv.app.config.live() === false, srv.app.config.live())

    const clear = await keyOp(srv, jar, { clear: true })
    check('a clear with an unproven publish is reported too',
      clear.status === 503 && clear.json.error === 'config_sync_unverified', clear.json)
    check('the cleared state is adopted in memory and on disk',
      srv.app.config.key() === '' && diskConfig(srv.dataDir).upstream.keyRef === '',
      { key: srv.app.config.key(), disk: diskConfig(srv.dataDir).upstream })
    setFault(false)
    await configure(srv, jar, { note: 'verified again' })
    check('a later verified save clears the latch after key operations',
      srv.app.config.syncHealth().degraded === false, srv.app.config.syncHealth())
    await srv.close()
  }

  {
    // The key FILE's own publish fault is a different, smaller question (C1
    // policy): its content is on disk, and the config publish below is the
    // atomic gate. If that gate succeeds the pair is in effect; if a crash
    // later loses the key file's entry, the config references a missing key
    // and readKey() fails closed.
    const up = makeUpstream()
    let failKeySync = false
    const configWrite = (file, data) => {
      if (failKeySync && /keys[/\\]rev-\d+\.key$/.test(file)) {
        fs.writeFileSync(file, data)
        const e = new Error('injected directory fsync failure')
        e.code = 'dir_sync_failed'
        e.published = true
        e.detail = 'injected'
        throw e
      }
      return writeFileAtomic(file, data)
    }
    const srv = await startApp({ env: { SWE_AI_ALLOWED_HOSTS: 'ollama.local' } }, { fetch: up.fetch, configWrite })
    const jar = {}
    await login(srv, 'admin-one', jar)
    failKeySync = true
    const saved = await configure(srv, jar, {
      baseUrl: 'http://ollama.local/v1', model: 'm', key: K2, authMode: 'auto', enabled: true
    })
    check('a key-file durability warning does not fail the save whose gate held',
      saved.status === 200 && saved.json.live === true, saved.json)
    check('the gate-held pair is in effect', srv.app.config.key() === K2, srv.app.config.key())
    await request(srv.port, 'POST', '/api/ai/chat', {
      body: { messages: [{ role: 'user', content: 'hi' }] }, cookies: jar
    })
    check('the upstream receives the key the config references',
      up.last().headers.Authorization === 'Bearer ' + K2, up.last().headers.Authorization)
    check('the config document itself was proven, so nothing is latched',
      srv.app.config.syncHealth().degraded === false, srv.app.config.syncHealth())
    await srv.close()
  }
}

/* ---------------------------------------------------------------- run --- */

console.log('# service tests')
console.log('# node ' + process.version + '  backend auto (sqlite if available)')

const t0 = Date.now()
await testParseUpstreamUnit()
await testClosedByDefault()
await testOrigin()
await testTrustedProxy()
await testAuthAndLogout()
await testConfigSurface()
await testUpstreamAuth()
await testUpstreamFailures()
await testQuota()
await testProbe()
await testRequestShape()
await testKeyHygiene()
await testStoreBackends()
await testAdminPage()
await testStaticStillServes()
await testLedgerFaults()
await testLedgerShape()
await testDirectorySyncSemantics()
await testIdentityProtection()
await testRealEntrypointSurvivesStorageFault()
await testTokenFileRevocation()
await testTokenFileReadFailures()
await testKeyPairing()
await testLegacyKeyLifecycle()
await testKeyConfigFaultWindow()
await testAdminGenerateGate()
await testAllowlistAfterRestart()
await testRevisionCompareAndSet()
await testStandaloneKeyCAS()
await testSessionTag()
await testConfigPublishFault()

console.log('\n' + pass + ' PASS / ' + fail + ' FAIL  (' + Math.round((Date.now() - t0) / 1000) + 's)')
if (fail) {
  console.log('failed:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
