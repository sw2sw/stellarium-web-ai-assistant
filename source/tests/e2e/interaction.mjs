/* End-to-end: explanation upgrade, multi-turn chat popup, current-time
 * recommendations and the external target file (task book 讲解与互动升级).
 *
 * Real Chrome against a real ai-service process (spawned, port 8901) and a
 * fake OpenAI-compatible upstream. No network beyond loopback, no real model.
 * The dist is a TEMP COPY with the curated-target fixture written in, so the
 * delivered tree stays frozen.
 *
 * Run: node tests/e2e/interaction.mjs
 */

import { chromium } from 'playwright-core'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../..')
const REPO_DIST = path.join(SRC, '../packages/integrated-web/dist')
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const FIXTURE = path.join(SRC, 'tests/fixtures/sky-targets/curated-targets.json')

const CLASS_TOKEN = 'class-ix-' + crypto.randomBytes(3).toString('hex')
const ADMIN_TOKEN = 'admin-ix-' + crypto.randomBytes(3).toString('hex')

let pass = 0
let fail = 0
const failures = []

function check (name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS ' + name); return }
  fail += 1
  failures.push(name)
  console.log('FAIL ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 400)))
}

/* ----------------------------------------------------------- fake model --- */

function startFakeUpstream () {
  const state = { calls: [], delayMs: 0, status: 200, override: null }
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization'
  }
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      return res.end()
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let user = ''
      let nMessages = 0
      try {
        const p = JSON.parse(body)
        nMessages = (p.messages || []).length
        for (const m of p.messages || []) if (m.role === 'user') user = String(m.content || '')
      } catch { user = String(body) }
      state.calls.push({ user, nMessages, body })

      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs))
      // A client abort (stop button) destroys the socket while we are still
      // waiting; writing afterwards would raise inside this server. Guarded -
      // the fake has to survive the panel's cancellations.
      if (res.writableEnded || res.destroyed) return
      if (state.status !== 200) {
        res.writeHead(state.status, Object.assign({ 'Content-Type': 'application/json' }, CORS))
        return res.end('{"error":"upstream says no"}')
      }
      if (res.writableEnded || res.destroyed) return
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, CORS))
      res.end(JSON.stringify({
        id: 'chatcmpl-fake',
        choices: [{ index: 0, message: { role: 'assistant', content: state.override || ('FAKE-REPLY[' + user.slice(0, 24) + ']') }, finish_reason: 'stop' }]
      }))
    })
    res.on('error', () => { /* client vanished - the panel cancelled */ })
  })
  server.on('error', () => { /* keep the fake alive */ })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server, state, port: server.address().port,
        reset () { state.calls.length = 0; state.delayMs = 0; state.status = 200; state.override = null },
        close () { return new Promise((r) => server.close(r)) }
      })
    })
  })
}

/* -------------------------------------------------------------- service --- */

async function waitFor (url, timeoutMs) {
  const started = Date.now()
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return true } catch { /* not up yet */ }
    if (Date.now() - started > timeoutMs) return false
    await new Promise((r) => setTimeout(r, 150))
  }
}

function apiJson (port, method, urlPath, body, cookie) {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
  return new Promise((resolve, reject) => {
    const headers = {}
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length }
    if (cookie) headers.Cookie = cookie
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

/* ------------------------------------------------------------------ run --- */

// A temp copy of the dist so the delivered tree stays frozen; the curated
// fixture is written into it to exercise the optional provider.
//
// NOTE: fs.cpSync is deliberately avoided here - on Node v24.4.1/Windows this
// environment it crashes the whole process (silent exit 127, no JS exception)
// whenever the SOURCE path contains non-ASCII characters, and this task's
// directory is 讲解与互动升级. A plain readdir/read/write walk handles the
// same tree without touching the native cp binding.
function copyTree (src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name)
    const to = path.join(dest, e.name)
    if (e.isDirectory()) copyTree(from, to)
    else if (e.isFile()) fs.copyFileSync(from, to)
  }
}

const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-ix-dist-'))
copyTree(REPO_DIST, dist)
fs.copyFileSync(FIXTURE, path.join(dist, 'ai-assistant/curated-targets.json'))

const fake = await startFakeUpstream()

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-ix-'))
const dataDir = path.join(root, 'data')
const logFd = fs.openSync(path.join(root, 'service.log'), 'w')
const env = Object.assign({}, process.env, {
  SWE_BIND: '127.0.0.1', SWE_PORT: '8901', SWE_STATIC_DIR: dist, SWE_DATA_DIR: dataDir,
  SWE_ACCESS_TOKENS: CLASS_TOKEN, SWE_ADMIN_TOKENS: ADMIN_TOKEN,
  SWE_AI_ALLOWED_HOSTS: '127.0.0.1:' + fake.port, SWE_LOG_LEVEL: 'error', SWE_REQUIRE_AUTH: '1'
})
const child = spawn(process.execPath, [path.join(SRC, 'packages/ai-service/server.mjs')], { env, stdio: ['ignore', logFd, logFd] })
const serviceUp = await waitFor('http://127.0.0.1:8901/healthz', 15000)
if (!serviceUp) { console.log('FAIL service did not start'); process.exit(1) }

const BASE = 'http://127.0.0.1:8901/'
console.log('# interaction e2e')
console.log('# site ' + BASE)
console.log('# upstream fake on 127.0.0.1:' + fake.port)

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
})
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() !== 'error') return
  const t = m.text()
  if (/status of (409|429|502|503)/.test(t)) return
  if (/net::ERR_(TIMED_OUT|EMPTY_RESPONSE|CONNECTION_RESET|ABORTED|CONNECTION_CLOSED)/.test(t)) return
  consoleErrors.push(t)
})

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('[data-swe-assistant="panel"]', { timeout: 30000 })
await page.waitForFunction(() => {
  const t = window.__SWE_ASSISTANT_TEST__
  return t && t.getServerAi && t.getServerAi().checked === true
}, null, { timeout: 20000 }).catch(() => {})

/* --- 1. versions and the read-only query capability ---------------------- */

const boot = await page.evaluate(() => {
  const t = window.__SWE_ASSISTANT_TEST__
  const b = window.__SWE_AI_BRIDGE__
  return { version: t.version, bridge: b.loaderVersion, caps: b.getCapabilities() }
})
check('assistant is 0.14.0', boot.version === '0.14.0', boot.version)
check('bridge is 0.11.0 on protocol 2', boot.bridge === '0.11.0' && boot.caps.protocolVersion === 2, boot.bridge)
check('the bridge advertises the bounded read-only body query',
  boot.caps.features.bodyQuery === true && boot.caps.features.bodyQueryMax > 0, boot.caps.features)

// Sign in so the server route is usable for the chat half. The deployment is
// enabled through the admin API first (the panel only shows the passphrase
// row once /api/ai/config reports an available server route), then the panel
// is switched to the server source the way a teacher does.
const login = await apiJson(8901, 'POST', '/api/auth/login', { token: ADMIN_TOKEN })
const adminCookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ')
const cfg = await apiJson(8901, 'GET', '/api/admin/config', undefined, adminCookie)
const saved = await apiJson(8901, 'PUT', '/api/admin/config', Object.assign({
  baseUrl: 'http://127.0.0.1:' + fake.port + '/v1', model: 'fake-model',
  key: 'sk-ix-' + crypto.randomBytes(4).toString('hex'), authMode: 'auto', enabled: true
}, { expectedRevision: JSON.parse(cfg.text).config.revision }), adminCookie)
check('the deployment is enabled through the admin surface', saved.status === 200, saved.status)
// The panel loaded while the route was closed; make it re-read /api/ai/config
// before switching sources, exactly like the "test connection" button does.
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.refreshServerStatus())
await page.waitForTimeout(800)
await page.evaluate(() => {
  const t = window.__SWE_ASSISTANT_TEST__
  t.setSource('server')
  t.showTab('ai')
})
await page.waitForSelector('[data-swe-action="ai-login"]', { state: 'visible', timeout: 15000 })
await page.fill('.swe-ai-pass', ADMIN_TOKEN)
await page.click('[data-swe-action="ai-login"]')
await page.waitForFunction(() => window.__SWE_ASSISTANT_TEST__.getServerAi().authenticated === true,
  null, { timeout: 15000 }).catch(() => {})
check('the panel signs in', (await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getServerAi())).authenticated === true)

/* --- 2. night recommendation: physical sanity, rules, no side effects ---- */

// 21:00 Beijing on the fixture date: the Sun must be well below -8°.
await page.evaluate(async () => {
  await window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_time', utc: '2026-11-07T13:00:00.000Z' })
})
await page.waitForTimeout(600)

const beforeRec = await page.evaluate(() => {
  const st = window.__SWE_AI_BRIDGE__.readState()
  return {
    revision: st.revision,
    selection: (st.selection || {}).designation || null,
    fov: document.getElementById('app').__vue__.$stel.core.fov,
    utc: st.time.utc
  }
})
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.requestRecommendation())
await page.waitForTimeout(400)
const night = await page.evaluate(() => ({
  rec: window.__SWE_ASSISTANT_TEST__.getRecommendation(),
  timeScopeNote: (document.querySelector('[data-swe-rec-timescope]') || {}).textContent || '',
  groups: Array.from(document.querySelectorAll('[data-swe-rec-group]')).map((n) => n.getAttribute('data-swe-rec-group')),
  viewBtns: document.querySelectorAll('[data-swe-action="rec-view"]').length
}))
check('night recommendation: the Sun is physically below -8° at 21:00 Beijing',
  night.rec.result && night.rec.result.sunAltitudeDeg <= -8, night.rec.result && night.rec.result.sunAltitudeDeg)
check('night recommendation: the box says the scope is the current instant, not the whole night',
  /当前/.test(night.timeScopeNote) && /不覆盖整晚/.test(night.timeScopeNote), night.timeScopeNote)
check('night recommendation: both viewer groups render',
  night.groups.join(',') === 'eye,scope' && typeof night.viewBtns === 'number', night.groups)
check('night recommendation: read-only queries changed nothing on the sky',
  await page.evaluate((b) => {
    const st = window.__SWE_AI_BRIDGE__.readState()
    // The clock keeps running at speed 1, so utc advances on its own; what
    // the recommendation must never touch is revision, selection and view.
    return st.revision === b.revision &&
      ((st.selection || {}).designation || null) === b.selection &&
      Math.abs(document.getElementById('app').__vue__.$stel.core.fov - b.fov) < 1e-9 &&
      Math.abs(Date.parse(st.time.utc) - Date.parse(b.utc)) < 5000
  }, beforeRec), 'sky moved during recommendation')

/* --- 3. view in chart is a user click with a real readback --------------- */

await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.showTab('sky'))
await page.waitForTimeout(300)

const viewTarget = await page.evaluate(() => {
  const first = document.querySelector('[data-swe-action="rec-view"]')
  if (!first) return null
  return first.closest('[data-swe-rec-item]').getAttribute('data-swe-rec-item')
})
if (viewTarget) {
  await page.click('[data-swe-action="rec-view"]')
  await page.waitForFunction((want) => {
    const st = window.__SWE_AI_BRIDGE__.readState()
    return st.selection && st.selection.designation === want
  }, viewTarget, { timeout: 15000 }).catch(() => {})
  const selected = await page.evaluate(() => (window.__SWE_AI_BRIDGE__.readState().selection || {}).designation)
  check('view-in-chart selects exactly the recommended designation (readback)',
    selected === viewTarget, { want: viewTarget, got: selected })
} else {
  check('view-in-chart: skipped (no items at this instant)', true)
}

/* --- 4. daytime: inner planets are excluded, conservatively -------------- */

await page.evaluate(async () => {
  await window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_time', utc: '2026-11-07T06:00:00.000Z' })
})
await page.waitForTimeout(600)
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.requestRecommendation())
await page.waitForTimeout(400)
const day = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getRecommendation())
check('daytime recommendation: the Sun is physically high at 14:00 Beijing',
  day.result && day.result.sunAltitudeDeg >= 20, day.result && day.result.sunAltitudeDeg)
check('daytime recommendation: Mercury and Venus are refused outright',
  day.result.excluded.filter((e) => e.reason === 'daylight_inner_planet').map((e) => e.id).sort().join(',') === 'mercury,venus',
  day.result.excluded)
check('daytime recommendation: other planets are excluded too, conservatively',
  day.result.excluded.every((e) => e.id !== 'jupiter' || e.reason === 'daytime') &&
  day.result.groups.eye.items.every((i) => i.id === 'moon') === true ||
  day.result.groups.eye.items.length === 0,
  { eye: day.result.groups.eye.items.map((i) => i.id), excluded: day.result.excluded })

/* --- 5. external curated file: valid load, then corrupt handling --------- */

const ext = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getRecommendation().external)
check('the curated fixture loaded as a second provider', ext.loaded === 2 && ext.error === null, ext)
check('the fixture is not presented as builtin',
  ext.source && ext.source.name === '测试精选夹具', ext.source)

await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.requestRecommendation())
await page.waitForTimeout(300)
const withExternal = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-swe-rec-item]')).map((n) => n.getAttribute('data-swe-rec-item')))
check('external targets join the query set (fixture item rendered or honestly absent)',
  !withExternal.some((d) => d === 'XX 9999'), withExternal)
check('the bogus fixture designation produced no invented data',
  !withExternal.includes('XX 9999'), withExternal)

// C1 (review round 3): the alias 'M 45' RESOLVES in this engine, but its
// first resolved designation is 'NAME Pleiades'. Readings must be indexed by
// the query string actually asked - indexing by the resolved designation
// turned a successful alias query into a false not_found. At this daylight
// scene the deep-sky fixture entry is excluded for time-of-day (or horizon),
// never for an unresolved query. Red on the old indexing: the old map keyed
// 'NAME Pleiades' and the lookup for 'M 45' missed.
const c1Reasons = day.result.excluded.filter((e) => e.id === 'm45').map((e) => e.reason)
check('C1: the alias M 45 resolves to real readings (never a false not_found)',
  c1Reasons.length === 1 && c1Reasons[0] !== 'not_found', c1Reasons)

// Corrupt the file; a reload must keep the builtin provider alive and say so.
fs.writeFileSync(path.join(dist, 'ai-assistant/curated-targets.json'), '{ this is not json')
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-swe-assistant="panel"]', { timeout: 30000 })
await page.waitForTimeout(1200)
const corrupt = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getRecommendation().external)
check('a corrupt external file is ignored, not fatal', corrupt.loaded === 0 && !!corrupt.error, corrupt)

/* --- 6. the multi-turn chat popup ---------------------------------------- */

// The corrupt-file reload above reset the panel to custom source (source is
// not persisted; only remembered custom fields are). Re-select the server
// route the way a teacher does and wait for it to be usable again.
await page.evaluate(() => {
  const t = window.__SWE_ASSISTANT_TEST__
  t.setSource('server')
  t.showTab('sky')
})
await page.waitForFunction(() => {
  const s = window.__SWE_ASSISTANT_TEST__.getServerAi()
  return s.available === true && s.authenticated === true
}, null, { timeout: 15000 })
check('the server route is re-selected after the reload',
  (await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getAiConfig())).source === 'server')

// A clean night scene again, select a body, get the (fake) explanation. The
// state poll runs every 2 s, so wait until the selection is actually in the
// panel's state before asking for an explanation.
await page.evaluate(async () => {
  await window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_time', utc: '2026-11-07T13:00:00.000Z' })
  await window.__SWE_AI_BRIDGE__.executeCommand({ type: 'select_object', name: 'NAME Saturn', lock: false })
})
await page.waitForFunction(() => {
  const st = window.__SWE_AI_BRIDGE__.readState()
  return st.selection && st.selection.designation === 'NAME Saturn'
}, null, { timeout: 10000 })
await page.waitForTimeout(2200)
fake.reset()
await page.click('[data-swe-action="explain"]')
await page.waitForFunction(() => document.querySelector('[data-swe-ai-text]'), null, { timeout: 30000 }).catch(() => {})
check('the explanation rendered (fake model)', !!await page.$('[data-swe-ai-text]'))
const callsAfterExplain = fake.state.calls.length
check('the explanation was exactly one model call', callsAfterExplain === 1, callsAfterExplain)

// Opening the popup is free: no model request on open (task book §4).
await page.click('[data-swe-chat-continue]')
await page.waitForSelector('[data-swe-chat="panel"]', { state: 'visible', timeout: 5000 }).catch(() => {})
const chatOpen = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())
check('continue-chat opens with the explained body as topic and zero model calls',
  chatOpen.open === true && chatOpen.topic === 'Saturn' && chatOpen.hasOrigin === true &&
  fake.state.calls.length === callsAfterExplain,
  { chatOpen, calls: fake.state.calls.length })

await page.fill('[data-swe-chat="input"]', '土星的光环现在能看到吗？')
await page.click('[data-swe-action="chat-send"]')
await page.waitForFunction(() => document.querySelectorAll('[data-swe-msg-role="assistant"]').length === 1,
  null, { timeout: 30000 }).catch(() => {})
check('one send is exactly one model call and the reply lands',
  fake.state.calls.length === callsAfterExplain + 1 &&
  (await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())).assistantTurns === 1,
  { calls: fake.state.calls.length })

// The second turn carries the conversation, and the assistant's earlier reply
// travels as conversation, not as engine fact.
await page.fill('[data-swe-chat="input"]', '那木星呢？')
await page.click('[data-swe-action="chat-send"]')
await page.waitForFunction(() => document.querySelectorAll('[data-swe-msg-role="assistant"]').length === 2,
  null, { timeout: 30000 }).catch(() => {})
const lastBody = JSON.parse(fake.state.calls[fake.state.calls.length - 1].body)
check('the multi-turn history is sent with the system rules first',
  lastBody.messages[0].role === 'system' &&
  lastBody.messages.length === 4 &&
  lastBody.messages.map((m) => m.role).join(',') === 'system,user,assistant,user' &&
  /可信边界|TRUST BOUNDARIES/.test(lastBody.messages[0].content), lastBody.messages.map((m) => m.role))

/* --- 7. cancel, close and late replies ----------------------------------- */

fake.reset()
fake.state.delayMs = 4000
await page.fill('[data-swe-chat="input"]', '慢慢回答的问题')
await page.click('[data-swe-action="chat-send"]')
await page.waitForTimeout(400)
const busyState = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())
check('the stop button exists while generating', busyState.busy === true, busyState)
await page.click('[data-swe-action="chat-stop"]')
await page.waitForTimeout(300)
const stopped = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())
check('stop cancels locally and says the quota may already be spent',
  stopped.busy === false && stopped.noteCount >= 1, stopped)
fake.state.delayMs = 0
const repliesAfterStop = await page.evaluate(() => document.querySelectorAll('[data-swe-msg-role="assistant"]').length)
await page.waitForTimeout(4500)
check('the stopped request never writes a reply when it returns',
  await page.evaluate(() => document.querySelectorAll('[data-swe-msg-role="assistant"]').length) === repliesAfterStop,
  'late reply landed after stop')

fake.state.delayMs = 4000
await page.fill('[data-swe-chat="input"]', '关窗前的问题')
await page.click('[data-swe-action="chat-send"]')
await page.waitForTimeout(400)
await page.click('[data-swe-action="chat-close"]')
await page.waitForTimeout(300)
const closedState = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())
check('closing aborts the in-flight request',
  closedState.busy === false && closedState.noteCount >= 1, closedState)
await page.waitForTimeout(4500)
const afterClose = await page.evaluate(() => {
  const t = window.__SWE_ASSISTANT_TEST__
  return { panelHidden: (document.querySelector('[data-swe-chat="panel"]') || {}).offsetParent === null, state: t.chatState() }
})
check('a late reply after close never lands in the session',
  afterClose.panelHidden && afterClose.state.assistantTurns === 2, afterClose)

/* --- 8. quick questions are wired to real behaviour ---------------------- */

fake.reset()
await page.click('[data-swe-chat-continue]') // reopen (closed in §7)
await page.waitForTimeout(300)
await page.evaluate(() => { window.__SWE_ASSISTANT_TEST__.openChat('ask') })
await page.waitForTimeout(200)
const callsBeforeQuick = fake.state.calls.length
await page.click('[data-swe-chat-quick="what"]')
// The preflight status read plus the fake round trip; under machine load this
// takes longer than a click, so wait for the TURN to start and the reply to
// land with a generous budget.
await page.waitForFunction(() => window.__SWE_ASSISTANT_TEST__.chatState().userTurns >= 1,
  null, { timeout: 20000 }).catch(() => {})
await page.waitForFunction(() => document.querySelectorAll('[data-swe-msg-role="assistant"]').length >= 1,
  null, { timeout: 45000 }).catch(() => {})
const seqAtTimeout = (await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())).seq
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatSend('探针消息'))
await page.waitForTimeout(2500)
const quickState = await page.evaluate(() => ({
  state: window.__SWE_ASSISTANT_TEST__.getRecommendation(),
  chat: window.__SWE_ASSISTANT_TEST__.chatState()
}))
console.log('# quick seq@timeout=' + seqAtTimeout + ' after-probe=' + quickState.chat.seq +
  ' hasAbort=' + quickState.chat.hasAbort + ' userTurns=' + quickState.chat.userTurns +
  ' assistantTurns=' + quickState.chat.assistantTurns)
quickState.body = fake.state.calls.length > callsBeforeQuick
  ? JSON.parse(fake.state.calls[fake.state.calls.length - 1].body)
  : null
check('the quick question computed the recommendation and attached the digest',
  quickChatHasDigest(quickState) && quickState.state.result !== null, quickState.chat)
check('the quick question was exactly one model call for this turn',
  quickState.chat.assistantTurns >= 1, quickState.chat)

function quickChatHasDigest (s) {
  if (!s.body) return false
  const sys = s.body.messages[0].content
  return /推荐结果|recommendation/i.test(sys) && /timeScope|"eye"/.test(sys)
}

/* --- 9. without a model: honest limitation, deterministic list still ----- */

// A proper PATCH body: the admin surface refuses unknown fields, so the
// enable/disable flips here send { enabled, expectedRevision } only.
async function setEnabled (enabled) {
  const cur = await apiJson(8901, 'GET', '/api/admin/config', undefined, adminCookie)
  return apiJson(8901, 'PUT', '/api/admin/config', {
    enabled,
    expectedRevision: JSON.parse(cur.text).config.revision
  }, adminCookie)
}

fake.reset()
await setEnabled(false)
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.refreshServerStatus())
await page.waitForFunction(() => window.__SWE_ASSISTANT_TEST__.getServerAi().available === false,
  null, { timeout: 15000 })
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.clearChat())
await page.evaluate(() => { window.__SWE_ASSISTANT_TEST__.openChat('ask') })
await page.waitForTimeout(200)
const callsBeforeNoModel = fake.state.calls.length
await page.click('[data-swe-chat-quick="eye"]')
await page.waitForTimeout(800)
const callsAfterNoModel = fake.state.calls.length
const noModel = await page.evaluate(() => ({
  chat: window.__SWE_ASSISTANT_TEST__.chatState(),
  notes: Array.from(document.querySelectorAll('[data-swe-chat-note]')).map((n) => n.textContent)
}))
check('with no model: no fake AI answer, an honest note, zero upstream calls',
  noModel.chat.assistantTurns === 0 && callsAfterNoModel === callsBeforeNoModel &&
  noModel.notes.some((n) => /尚未配置模型|No model configured/.test(n)),
  { chat: noModel.chat, notes: noModel.notes, calls: callsAfterNoModel - callsBeforeNoModel })

/* --- 10. config change cancels the in-flight request --------------------- */

// Re-enable, send with a delay, then stop the service under the request.
// The panel notices through its own status refresh (loud, revision moved),
// which runs the same invalidation path as any other configuration change.
await setEnabled(true)
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.refreshServerStatus())
await page.waitForFunction(() => window.__SWE_ASSISTANT_TEST__.getServerAi().available === true,
  null, { timeout: 15000 })
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.clearChat())
fake.reset()
fake.state.delayMs = 4000
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatSend('配置中途变化的提问'))
await page.waitForTimeout(400)
const busyBeforeCfg = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())
await apiJson(8901, 'POST', '/api/admin/emergency-stop', undefined, adminCookie)
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.refreshServerStatus())
await page.waitForTimeout(1000)
const afterCfg = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())
check('a configuration change cancels the in-flight chat and notes it',
  busyBeforeCfg.busy === true && afterCfg.busy === false && afterCfg.noteCount >= 1,
  { busyBeforeCfg, afterCfg })
fake.state.delayMs = 0

/* --- 11. history truncation is bounded and visible ----------------------- */

// The service is still emergency-stopped from section 10; bring it back so
// the truncation loop exercises real replies.
await setEnabled(true)
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.refreshServerStatus())
await page.waitForFunction(() => window.__SWE_ASSISTANT_TEST__.getServerAi().available === true,
  null, { timeout: 15000 })

fake.reset()
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.clearChat())
for (let i = 0; i < 13; i++) {
  // One turn at a time: wait for the previous reply (or error note) to land
  // before sending the next, exactly what a clicking teacher does.
  await page.waitForFunction((n) => {
    const c = window.__SWE_ASSISTANT_TEST__.chatState()
    return c.userTurns === n && c.busy === false
  }, i, { timeout: 20000 })
  await page.evaluate((n) => window.__SWE_ASSISTANT_TEST__.chatSend('第 ' + n + ' 轮'), i)
  await page.waitForFunction((n) => window.__SWE_ASSISTANT_TEST__.chatState().userTurns === n + 1,
    i, { timeout: 20000 })
}
const truncBody = fake.state.calls.length ? JSON.parse(fake.state.calls[fake.state.calls.length - 1].body) : null
const trunc = await page.evaluate(() => ({
  state: window.__SWE_ASSISTANT_TEST__.chatState(),
  note: (document.querySelector('[data-swe-chat="truncated"]') || {}).textContent || ''
}))
trunc.lastBody = truncBody
check('history is capped: the note names the omitted count',
  trunc.state.truncated > 0 && /省略/.test(trunc.note), trunc)
// 14 = system + the 12 kept history turns + the newest user turn, which is
// composed after the shed (R9, round 3) so the budget can never drop it.
check('the capped payload keeps the system rules plus the recent turns only',
  trunc.lastBody.messages.length === 14 && trunc.lastBody.messages[0].role === 'system' &&
  trunc.lastBody.messages[trunc.lastBody.messages.length - 1].role === 'user',
  trunc.lastBody.messages.length)

/* --- 12. no HTML execution from model text ------------------------------- */

fake.reset()
fake.state.override = 'FAKE<script>window.__SWE_PWNED__=1</script>'
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.clearChat())
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatSend('x'))
await page.waitForFunction(() => document.querySelectorAll('[data-swe-msg-role="assistant"]').length >= 1,
  null, { timeout: 20000 }).catch(() => {})
check('model text is rendered as text, never executed',
  await page.evaluate(() => !window.__SWE_PWNED__ &&
    (document.querySelector('[data-swe-msg-role="assistant"]') || {}).textContent.includes('<script>')),
  'script executed or not rendered as text')

/* --- 13. i18n and narrow screen ------------------------------------------ */

await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.closeChat())
await page.waitForTimeout(300)
await page.click('[data-swe-action="lang"]')
await page.waitForTimeout(400)
const i18n = await page.evaluate(() => ({
  title: (document.querySelector('[data-swe-chat="title"]') || {}).textContent || '',
  send: (document.querySelector('[data-swe-action="chat-send"]') || {}).textContent || ''
}))
check('the chat chrome follows the interface language', /Talk to the AI assistant/.test(i18n.title) && i18n.send === 'Send', i18n)

/* --- 14. R6: the origin is frozen from the explanation, not the selection - */

// Explain Saturn, then select Jupiter: 继续交流 must keep discussing SATURN
// with Saturn's own snapshot as the cited origin (R6), and 改聊当前天体 is the
// explicit switch.
fake.reset()
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.clearChat())
await page.evaluate(async () => {
  await window.__SWE_AI_BRIDGE__.executeCommand({ type: 'select_object', name: 'NAME Saturn', lock: false })
})
await page.waitForFunction(() => {
  const st = window.__SWE_AI_BRIDGE__.readState()
  return st.selection && st.selection.designation === 'NAME Saturn'
}, null, { timeout: 10000 })
await page.waitForTimeout(2200)
await page.click('[data-swe-action="explain"]')
await page.waitForFunction(() => document.querySelector('[data-swe-ai-text]'), null, { timeout: 30000 }).catch(() => {})
await page.evaluate(async () => {
  await window.__SWE_AI_BRIDGE__.executeCommand({ type: 'select_object', name: 'NAME Jupiter', lock: false })
})
await page.waitForFunction(() => {
  const st = window.__SWE_AI_BRIDGE__.readState()
  return st.selection && st.selection.designation === 'NAME Jupiter'
}, null, { timeout: 10000 })
await page.waitForTimeout(2200)
await page.click('[data-swe-chat-continue]')
await page.waitForTimeout(400)
const originCheck = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())
check('R6: continuing after selecting another body keeps the EXPLAINED object as topic',
  originCheck.topic === 'Saturn' && originCheck.originDesignation === 'Saturn',
  originCheck)
check('R6: the origin payload cites the explanation-time snapshot, not the current selection',
  originCheck.originDesignation === 'Saturn', originCheck.originDesignation)

await page.click('[data-swe-action="chat-retopic"]')
await page.waitForTimeout(300)
const retopicked = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())
check('R6: 改聊当前天体 switches the discussion to Jupiter and clears the old origin',
  retopicked.topic === 'Jupiter' && retopicked.originDesignation === null &&
  retopicked.noteCount >= 1, retopicked)

// R6: an in-flight OLD-topic request is cancelled by the topic switch; its
// late reply never lands under the new one.
fake.reset()
fake.state.delayMs = 4000
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatSend('木星的问题'))
await page.waitForTimeout(400)
const busyRetopic = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())
await page.evaluate(async () => {
  await window.__SWE_AI_BRIDGE__.executeCommand({ type: 'select_object', name: 'NAME Mars', lock: false })
})
await page.waitForFunction(() => {
  const st = window.__SWE_AI_BRIDGE__.readState()
  return st.selection && st.selection.designation === 'NAME Mars'
}, null, { timeout: 10000 })
await page.waitForTimeout(2200)
await page.click('[data-swe-action="chat-retopic"]')
await page.waitForTimeout(400)
const afterRetopic = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())
check('R6: switching topics cancels the in-flight old-topic request',
  busyRetopic.busy === true && afterRetopic.busy === false && afterRetopic.topic === 'Mars',
  { busyRetopic, afterRetopic })
const repliesAfterRetopic = await page.evaluate(() => document.querySelectorAll('[data-swe-msg-role="assistant"]').length)
await page.waitForTimeout(4500)
check('R6: the old-topic reply never lands after the switch',
  await page.evaluate(() => document.querySelectorAll('[data-swe-msg-role="assistant"]').length) === repliesAfterRetopic)
fake.state.delayMs = 0

/* --- 15. R8: quick taps during a generating reply change nothing ---------- */

fake.reset()
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.clearChat())
await page.evaluate(() => { window.__SWE_ASSISTANT_TEST__.openChat('ask') })
fake.state.delayMs = 4000
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatSend('慢慢答的问题'))
await page.waitForFunction(() => {
  const c = window.__SWE_ASSISTANT_TEST__.chatState()
  return c.userTurns === 1 && c.busy === true
}, null, { timeout: 20000 })
await page.waitForTimeout(400) // let the upstream call actually leave
const callsBeforeR8 = fake.state.calls.length
await page.click('[data-swe-chat-quick="eye"]')
await page.waitForTimeout(400)
const r8 = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())
const r8Calls = fake.state.calls.length - callsBeforeR8
check('R8: a quick tap while busy is refused with a note and changes nothing',
  r8.busy === true && r8.noteCount >= 1 && r8Calls === 0 && r8.userTurns === 1,
  { r8, calls: r8Calls })
await page.click('[data-swe-action="chat-stop"]')
await page.waitForTimeout(300)
fake.state.delayMs = 0

/* --- 16. R4: the chat send re-verifies the deployment before spending ----- */

// Config healthy, auth/status failing: the old path still sent (verified was
// stale). The send must refuse with no upstream call.
fake.reset()
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.clearChat())
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.refreshServerStatus())
await page.waitForTimeout(600)
await page.route('**/api/auth/status', (route) =>
  route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }))
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.expireServerStatusCache())
const callsBeforeR4 = fake.state.calls.length
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatSend('状态未核实的提问'))
await page.waitForTimeout(1500)
const r4 = await page.evaluate(() => ({
  chat: window.__SWE_ASSISTANT_TEST__.chatState(),
  notes: Array.from(document.querySelectorAll('[data-swe-chat-note]')).map((n) => n.textContent)
}))
check('R4: a send with an unverifiable server state is refused, nothing spent',
  r4.chat.assistantTurns === 0 && fake.state.calls.length === callsBeforeR4 &&
  r4.notes.some((n) => /无法核实|could not be verified/.test(n)),
  { r4, calls: fake.state.calls.length - callsBeforeR4 })

// Status endpoint hanging: the same deadline applies to the preflight.
await page.unroute('**/api/auth/status')
await page.route('**/api/auth/status', () => new Promise(() => { /* stall */ }))
await page.evaluate(() => { window.__SWE_AI_STATUS_TIMEOUT_MS__ = 800 })
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.expireServerStatusCache())
const tR4 = Date.now()
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatSend('状态挂起的提问'))
await page.waitForTimeout(2000)
const r4b = await page.evaluate(() => ({
  chat: window.__SWE_ASSISTANT_TEST__.chatState(),
  notes: Array.from(document.querySelectorAll('[data-swe-chat-note]')).map((n) => n.textContent)
}))
check('R4: a stalled status preflight gives up and refuses',
  r4b.chat.busy === false && r4b.chat.assistantTurns === 0 &&
  r4b.notes.some((n) => /无法核实|could not be verified/.test(n)) &&
  Date.now() - tR4 < 10000, r4b)
await page.unroute('**/api/auth/status')
await page.evaluate(() => { delete window.__SWE_AI_STATUS_TIMEOUT_MS__ })

// A re-login in another tab replaces the session; the preflight re-reads it
// and the send proceeds under the CURRENT session, not a stale verdict.
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.refreshServerStatus())
await page.waitForTimeout(600)
const relogin = await context.request.post(BASE + 'api/auth/login', { data: { token: CLASS_TOKEN } })
check('R4 setup: another tab signed in as classroom', relogin.status() === 200, relogin.status())
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.expireServerStatusCache())
fake.reset()
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatSend('会话更换后的提问'))
await page.waitForFunction(() => document.querySelectorAll('[data-swe-msg-role="assistant"]').length >= 1,
  null, { timeout: 30000 }).catch(() => {})
check('R4: a send after a cross-tab re-login verifies the CURRENT session and works',
  (await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())).assistantTurns >= 1)

/* --- 17. R1: free-typed recommendation questions share the data path ----- */

fake.reset()
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.clearChat())
await page.fill('[data-swe-chat="input"]', '今天适合看什么？')
await page.click('[data-swe-action="chat-send"]')
await page.waitForFunction(() => document.querySelectorAll('[data-swe-msg-role="assistant"]').length >= 1,
  null, { timeout: 30000 }).catch(() => {})
const r1aBody = fake.state.calls.length ? JSON.parse(fake.state.calls[fake.state.calls.length - 1].body) : null
const r1a = await page.evaluate(() => ({
  chat: window.__SWE_ASSISTANT_TEST__.chatState(),
  rec: window.__SWE_ASSISTANT_TEST__.getRecommendation()
}))
r1a.body = r1aBody
check('R1: a manually typed recommendation question gets program candidates, not memory',
  !!r1a.body && /推荐结果|recommendation/i.test(r1a.body.messages[0].content) &&
  /timeScope|"eye"|computedForUtc/.test(r1a.body.messages[0].content) &&
  r1a.rec.result !== null, { digest: !!r1a.body && r1a.body.messages[0].content.slice(0, 80) })

// A follow-up keeps the historical basis (the digest is retained, labelled).
await page.fill('[data-swe-chat="input"]', '那木星呢？')
await page.click('[data-swe-action="chat-send"]')
await page.waitForFunction(() => document.querySelectorAll('[data-swe-msg-role="assistant"]').length >= 2,
  null, { timeout: 30000 }).catch(() => {})
const r1bBody = fake.state.calls.length ? JSON.parse(fake.state.calls[fake.state.calls.length - 1].body) : null
const r1b = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())
r1b.body = r1bBody
check('R1: follow-up questions keep the retained recommendation basis',
  !!r1b.body && /推荐结果|recommendation/i.test(r1b.body.messages[0].content) &&
  /computedForUtc/.test(r1b.body.messages[0].content), 'digest lost')

// A changed chart time makes the next "now" question recompute explicitly.
// The assertion pins the NEW instant: the old OR with hasPendingDigest let a
// stale digest pass and proved nothing (review round 3). Red on the old code:
// "现在呢？" matched no recommendation keyword, so the stale digest stayed.
await page.evaluate(async () => {
  await window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_time', utc: '2026-11-07T06:00:00.000Z' })
})
await page.waitForTimeout(600)
await page.fill('[data-swe-chat="input"]', '现在呢？')
await page.click('[data-swe-action="chat-send"]')
await page.waitForFunction(() => document.querySelectorAll('[data-swe-msg-role="assistant"]').length >= 3,
  null, { timeout: 30000 }).catch(() => {})
const r1c = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())
// The simulated clock keeps flowing after set_time, so the fresh digest is
// stamped within seconds of the new instant, not to the millisecond. What
// must hold is the REFRESH: ~06:00, not the earlier scene's digest.
check('R1: a new-time query refreshes the recommendation context',
  r1c.digestUtc !== null &&
  Math.abs(Date.parse(r1c.digestUtc) - Date.parse('2026-11-07T06:00:00.000Z')) < 10000, r1c)

// A follow-up ABOUT the earlier recommendation keeps that historical basis:
// the chart moves again, and the digest must STILL be the 06:00 one. Red on
// the old code, where the bare keyword "望远镜" recomputed at the new time.
await page.evaluate(async () => {
  await window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_time', utc: '2026-11-07T08:00:00.000Z' })
})
await page.waitForTimeout(600)
await page.fill('[data-swe-chat="input"]', '刚才推荐的为什么适合望远镜？')
await page.click('[data-swe-action="chat-send"]')
await page.waitForFunction(() => document.querySelectorAll('[data-swe-msg-role="assistant"]').length >= 4,
  null, { timeout: 30000 }).catch(() => {})
const r1d = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())
// Same flow tolerance: the retained basis is still the ~06:00 digest. Red on
// the old code, which recomputed at ~08:00 (a 2h jump) on the bare keyword.
check('R1: a historical follow-up keeps the retained basis (no silent recompute)',
  r1d.digestUtc !== null &&
  Math.abs(Date.parse(r1d.digestUtc) - Date.parse('2026-11-07T06:00:00.000Z')) < 10000, r1d)

/* --- 18. R9: budgets and recovery ---------------------------------------- */

fake.reset()
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.clearChat())
const longText = '长'.repeat(9001)
await page.fill('[data-swe-chat="input"]', longText)
await page.click('[data-swe-action="chat-send"]')
await page.waitForTimeout(600)
const r9a = await page.evaluate(() => ({
  chat: window.__SWE_ASSISTANT_TEST__.chatState(),
  notes: Array.from(document.querySelectorAll('[data-swe-chat-note]')).map((n) => n.textContent),
  input: document.querySelector('[data-swe-chat="input"]').value.length
}))
check('R9: an oversized single message is refused locally, text recoverable',
  r9a.chat.userTurns === 0 && r9a.input === 9001 &&
  r9a.notes.some((n) => /太长|too long/.test(n)), { turns: r9a.chat.userTurns, input: r9a.input, notes: r9a.notes })

// A server-rejected turn does not poison the history: the failed user text
// comes back to the input and the session stays clean for the retry.
await page.fill('[data-swe-chat="input"]', '会被拒绝的一轮')
fake.state.status = 500
await page.click('[data-swe-action="chat-send"]')
await page.waitForTimeout(1200)
fake.state.status = 200
const r9b = await page.evaluate(() => ({
  chat: window.__SWE_ASSISTANT_TEST__.chatState(),
  input: document.querySelector('[data-swe-chat="input"]').value
}))
check('R9: a failed turn leaves no poisoned history; the text is recoverable',
  r9b.chat.userTurns === 0 && r9b.chat.assistantTurns === 0 && r9b.input === '会被拒绝的一轮',
  r9b)
await page.click('[data-swe-action="chat-send"]')
await page.waitForFunction(() => document.querySelectorAll('[data-swe-msg-role="assistant"]').length >= 1,
  null, { timeout: 30000 }).catch(() => {})
check('R9: the recovered retry succeeds on the healthy path',
  (await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())).assistantTurns >= 1)

// Accumulated long turns shed the OLDEST history and say so.
fake.reset()
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.clearChat())
for (let i = 0; i < 3; i++) {
  await page.waitForFunction((n) => {
    const c = window.__SWE_ASSISTANT_TEST__.chatState()
    return c.userTurns === n && c.busy === false
  }, i, { timeout: 20000 })
  await page.evaluate((n) => window.__SWE_ASSISTANT_TEST__.chatSend(new Array(200).join('x') + ' 第' + n + '轮'), i)
  await page.waitForFunction((n) => window.__SWE_ASSISTANT_TEST__.chatState().userTurns === n + 1,
    i, { timeout: 20000 })
}
const r9cBody = fake.state.calls.length ? JSON.parse(fake.state.calls[fake.state.calls.length - 1].body) : null
const r9c = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())
r9c.body = r9cBody
check('R9: long multi-turn payload sheds its oldest turns and stays under budget',
  !!r9c.body &&
  r9c.body.messages.reduce((n, m) => n + m.content.length, 0) < 24000,
  { total: r9c.body && r9c.body.messages.reduce((n, m) => n + m.content.length, 0), truncated: r9c.truncated })

/* --- 19. R9/R6 (review round 3): per-message cap, id-bound recovery, A/B --- */

// R9: an oversized ASSISTANT reply in the history can never be sent (the
// server refuses any single message over 12000 chars, whatever the total).
// The payload sheds it visibly and keeps working. Red on the old total-only
// budget: the 13000-char reply rode along and the server refused the whole
// conversation.
fake.reset()
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.clearChat())
fake.state.override = '巨'.repeat(13000)
await page.fill('[data-swe-chat="input"]', '造一条超长回复')
await page.click('[data-swe-action="chat-send"]')
await page.waitForFunction(() => document.querySelectorAll('[data-swe-msg-role="assistant"]').length >= 1,
  null, { timeout: 30000 }).catch(() => {})
fake.state.override = null
await page.fill('[data-swe-chat="input"]', '继续短问题')
await page.click('[data-swe-action="chat-send"]')
await page.waitForFunction(() => document.querySelectorAll('[data-swe-msg-role="assistant"]').length >= 2,
  null, { timeout: 30000 }).catch(() => {})
const r9dBody = JSON.parse(fake.state.calls[fake.state.calls.length - 1].body)
const r9d = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())
const r9dNotes = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-swe-chat-note]')).map((n) => n.textContent))
check('R9: an oversized history reply is shed from the payload, visibly',
  r9dBody.messages.every((m) => m.content.length <= 12000) && r9d.truncated >= 1 &&
  r9dNotes.some((t) => /移出|Removed/.test(t)),
  { lens: r9dBody.messages.map((m) => m.content.length), truncated: r9d.truncated })

// R9: recovery is bound to the message id. Send -> busy-time quick note ->
// failure: the failed question must still be recovered. Red on the old
// "last element is the user message" recovery - the note sits after it.
fake.reset()
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.clearChat())
await page.fill('[data-swe-chat="input"]', '忙时失败组合')
fake.state.status = 500
fake.state.delayMs = 800
await page.click('[data-swe-action="chat-send"]')
await page.waitForFunction(() => window.__SWE_ASSISTANT_TEST__.chatState().busy === true,
  null, { timeout: 5000 }).catch(() => {})
await page.click('[data-swe-chat-quick="what"]')
await page.waitForTimeout(200)
const r9eMid = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.chatState())
await page.waitForFunction(() => window.__SWE_ASSISTANT_TEST__.chatState().busy === false,
  null, { timeout: 15000 })
const r9e = await page.evaluate(() => ({
  chat: window.__SWE_ASSISTANT_TEST__.chatState(),
  input: document.querySelector('[data-swe-chat="input"]').value
}))
check('R9: a busy-time quick note does not block recovery of the failed turn',
  r9eMid.noteCount >= 1 &&
  r9e.chat.userTurns === 0 && r9e.chat.assistantTurns === 0 &&
  r9e.chat.noteCount >= 2 && r9e.input === '忙时失败组合',
  { mid: r9eMid, end: r9e })
fake.state.status = 200
fake.state.delayMs = 0

// R9: an unsendable composed system sheds the digest VISIBLY instead of
// shipping a payload the server must refuse; the digest itself is kept for
// later turns.
fake.reset()
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.clearChat())
await page.evaluate(() => {
  window.__SWE_ASSISTANT_TEST__.setPendingDigest({
    note: 'x'.repeat(13000),
    computedForUtc: '2026-11-07T00:00:00.000Z',
    computedForSite: { lat: 31.2, lng: 121.5 }
  })
})
await page.fill('[data-swe-chat="input"]', '带巨大摘要的问题')
await page.click('[data-swe-action="chat-send"]')
await page.waitForFunction(() => document.querySelectorAll('[data-swe-msg-role="assistant"]').length >= 1,
  null, { timeout: 30000 }).catch(() => {})
const r9fBody = JSON.parse(fake.state.calls[fake.state.calls.length - 1].body)
const r9f = await page.evaluate(() => ({
  chat: window.__SWE_ASSISTANT_TEST__.chatState(),
  notes: Array.from(document.querySelectorAll('[data-swe-chat-note]')).map((n) => n.textContent)
}))
check('R9: an oversized digest is shed from the system message, visibly',
  r9fBody.messages.every((m) => m.content.length <= 12000) &&
  !/程序筛选的推荐结果|Program-selected recommendation/.test(r9fBody.messages[0].content) &&
  r9f.notes.some((t) => /推荐摘要过长|digest was too long/.test(t)) &&
  r9f.chat.hasPendingDigest === true,
  { lens: r9fBody.messages.map((m) => m.content.length), notes: r9f.notes })

// R6: an explanation of A with B currently selected - the send-time snapshot
// goes out labelled as B's reading, explicitly NOT as an update for A. Red on
// the old unconditional "以此为准" label, which handed the model a fresh
// Jupiter snapshot as the state of the discussed Saturn.
fake.reset()
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.clearChat())
// The popup from the previous section is still open; its backdrop would
// swallow the explain click below.
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.closeChat())
await page.evaluate(async () => {
  await window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_time', utc: '2026-11-07T13:00:00.000Z' })
  await window.__SWE_AI_BRIDGE__.executeCommand({ type: 'select_object', name: 'NAME Saturn', lock: false })
})
await page.waitForFunction(() => {
  const st = window.__SWE_AI_BRIDGE__.readState()
  return st.selection && st.selection.designation === 'NAME Saturn'
}, null, { timeout: 10000 })
await page.waitForTimeout(2200)
await page.click('[data-swe-action="explain"]')
await page.waitForFunction(() => !!document.querySelector('[data-swe-ai-text]'), null, { timeout: 30000 }).catch(() => {})
await page.evaluate(async () => {
  await window.__SWE_AI_BRIDGE__.executeCommand({ type: 'select_object', name: 'NAME Jupiter', lock: false })
})
await page.waitForFunction(() => {
  const st = window.__SWE_AI_BRIDGE__.readState()
  return st.selection && st.selection.designation === 'NAME Jupiter'
}, null, { timeout: 10000 })
await page.click('[data-swe-chat-continue]')
await page.waitForSelector('[data-swe-chat="panel"]', { state: 'visible', timeout: 5000 }).catch(() => {})
await page.fill('[data-swe-chat="input"]', '土星的光环还能看到吗？')
await page.click('[data-swe-action="chat-send"]')
await page.waitForFunction(() => document.querySelectorAll('[data-swe-msg-role="assistant"]').length >= 1,
  null, { timeout: 30000 }).catch(() => {})
const r6Body = JSON.parse(fake.state.calls[fake.state.calls.length - 1].body)
const r6Sys = r6Body.messages[0].content
// The panel is in ENGLISH from section 9's language switch onward; assert
// both wordings so the check follows the guard, not the UI language.
check('R6: an A-explained/B-selected send labels the snapshot as the OTHER object',
  (/当前讨论对象：Saturn|Current discussion object: Saturn/).test(r6Sys) &&
  (/发送时快照——当前星图选中对象：|Snapshot at send time of the CURRENTLY SELECTED object \(/).test(r6Sys) &&
  (/不得用来更新或推断讨论对象|do NOT use them to update or infer the discussion object/).test(r6Sys) &&
  !(/以此为准，与讲解时快照区分|fresher than the one above when the sky moved/).test(r6Sys),
  { sys: r6Sys.slice(0, 200) })

/* --- hygiene -------------------------------------------------------------- */

check('no unexpected console errors', consoleErrors.length === 0, consoleErrors.slice(0, 4))

console.log('\n' + pass + ' PASS / ' + fail + ' FAIL')
if (fail) {
  console.log('failed:')
  for (const f of failures) console.log('  - ' + f)
}

await browser.close()
child.kill('SIGTERM')
await fake.close()
try { fs.rmSync(dist, { recursive: true, force: true }) } catch { /* temp */ }
try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* temp */ }
if (fail) process.exit(1)
