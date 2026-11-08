/* End-to-end: the assistant panel talking to a real ai-service process.
 *
 * The service is spawned as a child process, not imported, because half of what
 * this file checks is that the *deployment* wiring works: static site + same
 * origin /api + cookie auth + a config file on disk. Importing createApp would
 * skip exactly the parts that break in production.
 *
 * The model is a local fake. No network beyond loopback, no real credentials,
 * no real generation.
 *
 * Run: node tests/e2e/server-ai.mjs http://127.0.0.1:8900/
 *   (or let it spawn the service itself: node tests/e2e/server-ai.mjs)
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
const DIST = process.env.DIST_DIR || path.resolve(SRC, '../packages/integrated-web/dist')
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SHOT = process.env.SHOT_DIR || path.join(SRC, '../evidence/screenshots')

const CLASS_TOKEN = 'class-e2e-' + crypto.randomBytes(3).toString('hex')
// A second passphrase, for the quota test. It is a different identity, so its
// daily counter starts at zero no matter how much the panel spent above - which
// is the point: the budget follows the passphrase, not the browser session.
const CLASS2_TOKEN = 'class2-e2e-' + crypto.randomBytes(3).toString('hex')
const ADMIN_TOKEN = 'admin-e2e-' + crypto.randomBytes(3).toString('hex')
const UPSTREAM_KEY = 'sk-e2e-' + crypto.randomBytes(6).toString('hex')

let pass = 0
let fail = 0
const failures = []

function check (name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS ' + name); return }
  fail += 1
  failures.push(name)
  console.log('FAIL ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra)))
}

/* ----------------------------------------------------------- fake model --- */

// The panel expects the model to answer with a JSON command proposal, so the
// fake has to answer like one. The reply is derived from the prompt so the two
// asks in this file exercise different commands: the layer toggle (whose effect
// is visible in the panel's own layer state) and a field-of-view change (whose
// effect is a number we can read off the engine).
function replyFor (body) {
  // The number comes from the teacher's sentence, not from the whole request:
  // the system prompt carries a worked example containing "视场", and matching
  // that first made every answer land on the example's value.
  let user = ''
  try {
    const parsed = JSON.parse(body)
    for (const m of (parsed.messages || [])) if (m && m.role === 'user') user = String(m.content || '')
  } catch { user = String(body) }
  const m = /视场[^0-9]*(\d+)\s*度/.exec(user) || /field of view[^0-9]*(\d+)/i.exec(user)
  if (m) {
    const deg = Number(m[1])
    return '{"commands":[{"type":"set_fov","deg":' + deg + '}],"say":"已把视场调到 ' + deg + ' 度"}'
  }
  return '{"commands":[{"type":"set_layer","layer":"atmosphere","visible":false}],"say":"已关闭大气层"}'
}

function startFakeUpstream () {
  const state = { calls: [], delayMs: 0, content: null, status: 200 }

  // Custom mode is the browser talking to the vendor endpoint directly, so this
  // fake has to behave like one: an Authorization header forces a preflight,
  // and a real endpoint answers it. Without this the failure under test is
  // CORS, not the assistant.
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Max-Age': '600'
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
      state.calls.push({ url: req.url, method: req.method, headers: req.headers, body })

      if (req.url === '/v1/models') {
        res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, CORS))
        return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
      }
      if (req.url !== '/v1/chat/completions') {
        res.writeHead(404, Object.assign({ 'Content-Type': 'application/json' }, CORS))
        return res.end('{"error":"not found"}')
      }

      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs))
      if (state.status !== 200) {
        res.writeHead(state.status, Object.assign({ 'Content-Type': 'application/json' }, CORS))
        return res.end('{"error":"upstream says no"}')
      }
      // A marker so the panel's text can be traced back to this exact call.
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, CORS))
      res.end(JSON.stringify({
        id: 'chatcmpl-fake',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: state.content === null ? replyFor(body) : state.content },
          finish_reason: 'stop'
        }]
      }))
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        state,
        port: server.address().port,
        reset () { state.calls.length = 0; state.delayMs = 0; state.content = null; state.status = 200 },
        close () { return new Promise((r) => server.close(r)) }
      })
    })
  })
}

/* -------------------------------------------------------------- service --- */

async function waitFor (url, timeoutMs) {
  const started = Date.now()
  for (;;) {
    try {
      const r = await fetch(url)
      if (r.ok) return true
    } catch { /* not up yet */ }
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
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

async function startService (fakePort) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-e2e-'))
  const dataDir = path.join(root, 'data')
  const logPath = path.join(root, 'service.log')
  const logFd = fs.openSync(logPath, 'w')

  const env = Object.assign({}, process.env, {
    SWE_BIND: '127.0.0.1',
    SWE_PORT: '8900',
    SWE_STATIC_DIR: DIST,
    SWE_DATA_DIR: dataDir,
    SWE_ACCESS_TOKENS: CLASS_TOKEN + ',' + CLASS2_TOKEN,
    SWE_ADMIN_TOKENS: ADMIN_TOKEN,
    SWE_AI_ALLOWED_HOSTS: '127.0.0.1:' + fakePort,
    SWE_LOG_LEVEL: 'info',
    SWE_REQUIRE_AUTH: '1'
  })

  const child = spawn(process.execPath, [path.join(SRC, 'packages/ai-service/server.mjs')], {
    env, stdio: ['ignore', logFd, logFd]
  })
  const ok = await waitFor('http://127.0.0.1:8900/healthz', 15000)
  if (!ok) throw new Error('ai-service did not start; log:\n' + fs.readFileSync(logPath, 'utf8'))
  return {
    child, root, dataDir, logPath,
    port: 8900,
    stop () {
      try { fs.closeSync(logFd) } catch { /* ignore */ }
      child.kill('SIGTERM')
    }
  }
}

/* ------------------------------------------------------------------ run --- */

const fake = await startFakeUpstream()
const svc = await startService(fake.port)
const BASE = 'http://127.0.0.1:8900/'

console.log('# server AI e2e')
console.log('# site      ' + BASE)
console.log('# assistant ' + fs.readFileSync(path.join(DIST, 'ai-assistant/assistant.js'), 'utf8').match(/var VERSION = '([^']+)'/)[1])
console.log('# service   ' + (await apiJson(8900, 'GET', '/healthz')).json.version)
console.log('# upstream  fake on 127.0.0.1:' + fake.port)

/* --- 1. admin configures the deployment ------------------------------- */

const login = await apiJson(8900, 'POST', '/api/auth/login', { token: ADMIN_TOKEN })
const adminCookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ')
check('admin can sign in', login.status === 200 && login.json.role === 'admin', login.json)

// Every admin write carries the revision it was rendered from, so a stale form
// cannot undo a newer one (R9). The helper reads it first: each call below still
// says only what it is actually testing.
async function saveConfig (patch, cookie) {
  const cur = await apiJson(8900, 'GET', '/api/admin/config', undefined, cookie)
  const body = Object.assign({ expectedRevision: cur.json.config.revision }, patch)
  return apiJson(8900, 'PUT', '/api/admin/config', body, cookie)
}

const closed = await apiJson(8900, 'GET', '/api/ai/config')
check('server AI starts closed', closed.json.available === false, closed.json)

const cfg = await saveConfig({
  baseUrl: 'http://127.0.0.1:' + fake.port + '/v1',
  model: 'fake-model',
  key: UPSTREAM_KEY,
  authMode: 'auto',
  enabled: true,
  note: 'e2e fake'
}, adminCookie)
check('admin can enable server AI', cfg.status === 200 && cfg.json.live === true, cfg.json)
check('enabling made no model call', fake.state.calls.length === 0, fake.state.calls.length)

const publicCfg = await apiJson(8900, 'GET', '/api/ai/config')
check('public config exposes the model name but no key',
  publicCfg.json.available === true && publicCfg.json.model === 'fake-model' &&
  !JSON.stringify(publicCfg.json).includes(UPSTREAM_KEY), publicCfg.json)

/* --- 2. browser: the panel sees a usable server option ----------------- */

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox']
})
try { fs.mkdirSync(SHOT, { recursive: true }) } catch { /* ignore */ }
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const pageErrors = []
const consoleErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('console', (m) => {
  if (m.type() !== 'error') return
  const t = m.text()
  if (/Satellite position error/.test(t)) return
  // Provoked on purpose. Section 8 saves a new configuration while an answer
  // is in flight (409 config_changed), section 11 spends the daily budget
  // (429 subject_quota), and section 8g breaks the status endpoint on purpose
  // (503). What those sections assert is that the *panel* says something a
  // teacher can read, and every one of them is provoked by the test itself.
  if (/status of (409|429|503)/.test(t)) return
  // This sandbox proxies loopback and occasionally drops an idle keep-alive
  // connection, which shows up as a network-level entry for a request the
  // service did serve. Every request the tests care about is asserted by its
  // effect elsewhere (the save's model is read back from the API), so this line
  // is noise about the transport, not about the panel.
  if (/net::ERR_(TIMED_OUT|EMPTY_RESPONSE|CONNECTION_RESET)/.test(t)) return
  consoleErrors.push(t)
})

// Two different hops carry a chat request, and only one of them may contain a
// model name or a key. The browser -> service hop is recorded here; the
// service -> upstream hop is recorded by the fake itself. Asserting the shape
// of the wrong one is how "the browser sent only messages" silently passes.
const browserChatCalls = []
page.on('request', (req) => {
  if (req.method() !== 'POST') return
  if (!/\/api\/ai\/chat$/.test(req.url())) return
  browserChatCalls.push({ url: req.url(), postData: req.postData() })
})

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('[data-swe-assistant="panel"]', { timeout: 30000 })
await page.waitForFunction(() => {
  const t = window.__SWE_ASSISTANT_TEST__
  return t && t.getServerAi && t.getServerAi().checked === true
}, null, { timeout: 20000 }).catch(() => {})

const boot = await page.evaluate(() => {
  const t = window.__SWE_ASSISTANT_TEST__
  return { version: t.version, server: t.getServerAi(), timeouts: t.getTimeouts(), ai: t.getAiConfig() }
})
check('assistant is 0.13.0', boot.version === '0.13.0', boot.version)
check('the generation deadline is 180 s', boot.timeouts.gen === 180000, boot.timeouts)
check('the probe deadline stays short', boot.timeouts.probe === 15000, boot.timeouts)
check('the panel discovered server AI', boot.server.available === true && boot.server.model === 'fake-model', boot.server)
check('the panel knows a passphrase is required', boot.server.authRequired === true, boot.server)
check('the panel is not signed in yet', boot.server.authenticated === false, boot.server)

const radioState = await page.evaluate(() => {
  const r = document.querySelector('input[name="swe-ai-source"][value="server"]')
  return { exists: !!r, disabled: r ? r.disabled : null }
})
check('the server radio is enabled', radioState.exists === true && radioState.disabled === false, radioState)

/* --- 3. selecting the server source asks for a passphrase -------------- */

// The radio is enabled even before signing in: a teacher who has a passphrase
// should be able to select the option and be told what is missing, rather than
// find a dead control and guess why.
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.setSource('server'))
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.showTab('ai'))
await page.waitForSelector('[data-swe-action="ai-login"]', { state: 'visible', timeout: 10000 })

const needLogin = await page.evaluate(() => ({
  text: (document.querySelector('[data-swe-server-state]') || {}).textContent || '',
  server: window.__SWE_ASSISTANT_TEST__.getServerAi()
}))
check('server mode without a passphrase explains what is missing',
  /口令/.test(needLogin.text) && needLogin.server.authenticated === false, needLogin)

/* --- 4. classroom sign-in from the panel ------------------------------- */

await page.fill('.swe-ai-pass', CLASS_TOKEN)
await page.click('[data-swe-action="ai-login"]')
await page.waitForFunction(() => {
  const s = window.__SWE_ASSISTANT_TEST__.getServerAi()
  return s.authenticated === true
}, null, { timeout: 15000 }).catch(() => {})
const signed = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getServerAi())
check('the panel signs in with a class passphrase', signed.authenticated === true, signed)
check('the signed-in role is classroom, not admin', signed.role === 'classroom', signed)

/* --- 5. server mode: one call, messages only --------------------------- */

await page.waitForTimeout(200)
const modeUi = await page.evaluate(() => {
  const custom = document.querySelector('[data-swe-ai-custom]')
  const server = document.querySelector('[data-swe-ai-server]')
  const src = window.__SWE_ASSISTANT_TEST__.getAiConfig().source
  return {
    source: src,
    customHidden: custom ? getComputedStyle(custom).display === 'none' : null,
    serverShown: server ? getComputedStyle(server).display !== 'none' : null
  }
})
check('selecting server mode is remembered', modeUi.source === 'server', modeUi)
check('server mode hides the custom fields', modeUi.customHidden === true, modeUi)
check('server mode shows the server block', modeUi.serverShown === true, modeUi)

fake.reset()
browserChatCalls.length = 0
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.showTab('sky'))
await page.fill('.swe-ask', '关掉大气')
await page.click('[data-swe-action="ask"]')
await page.waitForFunction(() => {
  const p = window.__SWE_ASSISTANT_TEST__.getProposal()
  return !!p
}, null, { timeout: 30000 }).catch(() => {})

const proposal = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getProposal())
check('server mode produced a proposal', !!proposal && proposal.items.length === 1, proposal)
check('the proposed command passed local validation',
  !!proposal && proposal.items.every((it) => !it.problem), proposal && proposal.items)
check('the server was called exactly once', fake.state.calls.length === 1, fake.state.calls.length)

// Hop 1: the browser -> /api/ai/chat. This is the one that must carry nothing
// but messages; a model name or a key here would mean the page still holds a
// credential and the operator's configuration is bypassable.
const fromBrowser = browserChatCalls[0] || {}
const browserBody = fromBrowser.postData ? JSON.parse(fromBrowser.postData) : {}
check('the browser sent only messages to the service',
  Object.keys(browserBody).sort().join(',') === 'messages', Object.keys(browserBody))

// Hop 2: the service -> upstream. Here the model, the sampling knobs and the
// stored key are expected, and they must come from the config file.
const serverCall = fake.state.calls[0] || {}
const serverBody = serverCall.body ? JSON.parse(serverCall.body) : {}
check('the service added the configured model',
  serverBody.model === 'fake-model', serverBody.model)
check('the service sent the stored key upstream',
  serverCall.headers && serverCall.headers.authorization === 'Bearer ' + UPSTREAM_KEY,
  serverCall.headers && Object.keys(serverCall.headers))
check('the service did not forward a vendor key from the page',
  !(fromBrowser.postData || '').includes('sk-'), 'leak')

// The browser must never have seen the key.
const bodyHtml = await page.content()
check('the key is not present in the page', !bodyHtml.includes(UPSTREAM_KEY), 'leak')
check('the panel never holds a vendor key in server mode',
  (await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getAiConfig())).hasKey === false, 'hasKey')

/* --- 5b. the plan still needs confirmation ----------------------------- */

const before = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getProposal())
check('the proposal is shown but not executed', !!before && before.items.length > 0, before && before.items.length)
try { await page.screenshot({ path: path.join(SHOT, 'panel-server-ai.png') }) } catch { /* evidence only */ }

// A command whose effect is a number, so "confirming changes the sky" is
// measured rather than inferred from the proposal being cleared.
await page.fill('.swe-ask', '把视场调到 10 度')
await page.click('[data-swe-action="ask"]')
await page.waitForFunction(() => {
  const p = window.__SWE_ASSISTANT_TEST__.getProposal()
  return !!p && p.items.some((it) => it.cmd && it.cmd.type === 'set_fov')
}, null, { timeout: 30000 }).catch(() => {})

const fovBefore = await page.evaluate(() => {
  const stel = document.getElementById('app').__vue__.$stel
  return stel.core.fov * 180 / Math.PI
})
await page.click('[data-swe-action="run-proposal"]')
await page.waitForTimeout(4000)
const afterRun = await page.evaluate(() => {
  const stel = document.getElementById('app').__vue__.$stel
  return {
    fov: stel.core.fov * 180 / Math.PI,
    proposal: window.__SWE_ASSISTANT_TEST__.getProposal(),
    status: (document.querySelector('[data-swe-ask-status]') || {}).textContent || ''
  }
})
check('the sky did not move before the click', Math.abs(fovBefore - 10) > 1, fovBefore)
check('confirming the plan actually changes the sky', Math.abs(afterRun.fov - 10) < 1,
  { fovBefore, afterRun: afterRun.fov })
check('the batch reports its own outcome', /执行完成：1 条成功/.test(afterRun.status), afterRun.status)

/* --- 6. custom mode still works, on its own path ----------------------- */

await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.setSource('custom'))
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.showTab('ai'))
await page.waitForSelector('[data-swe-ai-custom]', { state: 'visible', timeout: 10000 })
await page.fill('.swe-ai-url', 'http://127.0.0.1:' + fake.port + '/v1')
await page.fill('.swe-ai-model', 'custom-model')
await page.fill('.swe-ai-key', 'sk-custom-only')
fake.reset()
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.showTab('sky'))
await page.fill('.swe-ask', '关掉大气')
await page.click('[data-swe-action="ask"]')
await page.waitForFunction(() => !!window.__SWE_ASSISTANT_TEST__.getProposal(), null, { timeout: 30000 }).catch(() => {})

const customCall = fake.state.calls[0] || {}
const customBody = customCall.body ? JSON.parse(customCall.body) : {}
check('custom mode calls /chat/completions directly', /\/v1\/chat\/completions$/.test(customCall.url || ''), customCall.url)
check('custom mode sends its own model', customBody.model === 'custom-model', customBody.model)
check('custom mode sends its own key',
  customCall.headers && customCall.headers.authorization === 'Bearer sk-custom-only',
  customCall.headers && customCall.headers.authorization)

const switchedBack = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getAiConfig())
check('the custom endpoint survived the round trip through server mode',
  switchedBack.baseUrl === 'http://127.0.0.1:' + fake.port + '/v1', switchedBack)

/* --- 7. switching source cancels an in-flight request ------------------ */

fake.reset()
fake.state.delayMs = 3000
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.setSource('server'))
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.showTab('sky'))
await page.fill('.swe-ask', '把视场调到 10 度')
await page.click('[data-swe-action="ask"]')
await page.waitForTimeout(500)
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.setSource('custom'))
await page.waitForTimeout(4000)
const afterSwitch = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getProposal())
check('a late answer from the previous source is not shown as a proposal', afterSwitch === null, afterSwitch)
fake.state.delayMs = 0

/* --- 8. a config change invalidates an in-flight answer ---------------- */

fake.reset()
fake.state.delayMs = 2500
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.setSource('server'))
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.showTab('sky'))
await page.fill('.swe-ask', '把视场调到 10 度')
await page.click('[data-swe-action="ask"]')
await page.waitForTimeout(400)
const bump = await saveConfig({ note: 'changed mid-flight' }, adminCookie)
check('the operator can change the configuration mid-flight', bump.status === 200, bump.json)
await page.waitForTimeout(3500)
const afterBump = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getProposal())
check('an answer produced under the previous revision is discarded', afterBump === null, afterBump)
fake.state.delayMs = 0

/* --- 8b. R3: a plan that finished before the change is refused --------- */

// The case the review found: nothing is in flight. The plan is complete and on
// screen, the operator saves, and the confirm button is still clickable.
fake.reset()
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.showTab('sky'))
await page.fill('.swe-ask', '把视场调到 40 度')
await page.click('[data-swe-action="ask"]')
await page.waitForFunction(() => {
  const p = window.__SWE_ASSISTANT_TEST__.getProposal()
  return !!p && p.items.some((it) => it.cmd && it.cmd.type === 'set_fov')
}, null, { timeout: 30000 }).catch(() => {})

const fovBeforeChange = await page.evaluate(() => {
  const stel = document.getElementById('app').__vue__.$stel
  return stel.core.fov * 180 / Math.PI
})
const planBeforeChange = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getProposal())
check('R3: the plan is on screen before the operator saves', !!planBeforeChange, planBeforeChange)

const lateSave = await saveConfig({ note: 'saved after the plan was shown' }, adminCookie)
check('R3: the operator saves while the plan is on screen', lateSave.status === 200, lateSave.json)

await page.click('[data-swe-action="run-proposal"]')
await page.waitForTimeout(3000)
const afterLateSave = await page.evaluate(() => {
  const stel = document.getElementById('app').__vue__.$stel
  return {
    fov: stel.core.fov * 180 / Math.PI,
    proposal: window.__SWE_ASSISTANT_TEST__.getProposal(),
    status: (document.querySelector('[data-swe-ask-status]') || {}).textContent || ''
  }
})
check('R3: a plan generated under the previous revision is not executed',
  Math.abs(afterLateSave.fov - fovBeforeChange) < 0.5,
  { before: fovBeforeChange, after: afterLateSave.fov })
check('R3: the panel says why the confirm did nothing',
  /变了|没有执行/.test(afterLateSave.status), afterLateSave.status)
check('R3: the discarded plan is cleared, not left clickable',
  afterLateSave.proposal === null, afterLateSave.proposal)

/* --- 8c. R3: signing out drops a plan that is already on screen -------- */

fake.reset()
await page.fill('.swe-ask', '把视场调到 25 度')
await page.click('[data-swe-action="ask"]')
await page.waitForFunction(() => {
  const p = window.__SWE_ASSISTANT_TEST__.getProposal()
  return !!p && p.items.some((it) => it.cmd && it.cmd.type === 'set_fov')
}, null, { timeout: 30000 }).catch(() => {})
const fovBeforeLogout = await page.evaluate(() => {
  const stel = document.getElementById('app').__vue__.$stel
  return stel.core.fov * 180 / Math.PI
})
check('R3: a second plan is on screen before signing out',
  (await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getProposal())) !== null, 'none')

await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.showTab('ai'))
await page.waitForSelector('[data-swe-action="ai-logout"]', { state: 'visible', timeout: 10000 })
await page.click('[data-swe-action="ai-logout"]')
await page.waitForTimeout(1200)
const afterSignOut = await page.evaluate(() => ({
  proposal: window.__SWE_ASSISTANT_TEST__.getProposal(),
  session: window.__SWE_ASSISTANT_TEST__.getServerAi()
}))
check('R3: signing out drops the plan immediately', afterSignOut.proposal === null, afterSignOut.proposal)
check('R3: signing out is reflected in the panel', afterSignOut.session.authenticated === false, afterSignOut.session)

// Even the path a disabled button cannot take must refuse.
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.forceRunProposal())
await page.waitForTimeout(1500)
const fovAfterLogout = await page.evaluate(() => {
  const stel = document.getElementById('app').__vue__.$stel
  return stel.core.fov * 180 / Math.PI
})
check('R3: a plan cannot be run after signing out',
  Math.abs(fovAfterLogout - fovBeforeLogout) < 0.5, { before: fovBeforeLogout, after: fovAfterLogout })

// Back in, through the same form a teacher uses.
await page.fill('.swe-ai-pass', CLASS_TOKEN)
await page.click('[data-swe-action="ai-login"]')
await page.waitForTimeout(1500)
check('the panel signs back in',
  (await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getServerAi())).authenticated === true, 'not signed in')
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.showTab('sky'))

/* --- 8d. R7: an answer after an operator save is not thrown away ------- */

// The other order: the operator saves while the panel is idle, then the teacher
// asks. The answer arrives stamped with a revision the panel has not seen yet,
// and it is a valid answer - treating it as superseded is how a class paid for
// the same question twice.
fake.reset()
const staleRev = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getServerAi().revision)
const freshSave = await saveConfig({ note: 'saved while the panel was idle' }, adminCookie)
check('R7: the operator saves while the panel is idle', freshSave.status === 200, freshSave.json)
check('R7: the panel is still holding the previous revision',
  staleRev < freshSave.json.revision, { staleRev, saved: freshSave.json.revision })

await page.fill('.swe-ask', '把视场调到 55 度')
await page.click('[data-swe-action="ask"]')
await page.waitForFunction(() => {
  const p = window.__SWE_ASSISTANT_TEST__.getProposal()
  return !!p && p.items.some((it) => it.cmd && it.cmd.type === 'set_fov')
}, null, { timeout: 30000 }).catch(() => {})
const afterStaleAsk = await page.evaluate(() => ({
  proposal: window.__SWE_ASSISTANT_TEST__.getProposal(),
  status: (document.querySelector('[data-swe-ask-status]') || {}).textContent || '',
  server: window.__SWE_ASSISTANT_TEST__.getServerAi()
}))
check('R7: the answer is shown instead of being discarded',
  !!afterStaleAsk.proposal, { status: afterStaleAsk.status })
check('R7: the panel caught up to the revision it was answered under',
  afterStaleAsk.server.revision === freshSave.json.revision,
  { cached: afterStaleAsk.server.revision, saved: freshSave.json.revision })

// B2: the plan bought under the newer revision must be CONFIRMABLE. Showing it
// was half the fix; a confirm that then refuses a paid, valid answer was the
// leftover. This is the first-proposal confirm and engine readback the review
// asked for.
check('R7: the plan is bound to the revision it was answered under',
  !!afterStaleAsk.proposal && !!afterStaleAsk.proposal.bind &&
  afterStaleAsk.proposal.bind.revision === freshSave.json.revision,
  { bind: afterStaleAsk.proposal && afterStaleAsk.proposal.bind, saved: freshSave.json.revision })
const fovR7Before = await page.evaluate(() => document.getElementById('app').__vue__.$stel.core.fov * 180 / Math.PI)
await page.click('[data-swe-action="run-proposal"]')
await page.waitForFunction(() => window.__SWE_ASSISTANT_TEST__.getProposal() === null,
  null, { timeout: 30000 }).catch(() => {})
const fovR7After = await page.evaluate(() => document.getElementById('app').__vue__.$stel.core.fov * 180 / Math.PI)
check('R7: the first proposal of the stale-cache path is executed',
  Math.abs(fovR7After - 55) < 0.5, { before: fovR7Before, after: fovR7After })
check('R7: the executed plan is cleared, not left clickable',
  (await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getProposal())) === null)

// And the next ask still works, which is the part a classroom notices.
await page.fill('.swe-ask', '把视场调到 65 度')
await page.click('[data-swe-action="ask"]')
await page.waitForFunction(() => {
  const p = window.__SWE_ASSISTANT_TEST__.getProposal()
  return !!p && p.items.some((it) => it.cmd && it.cmd.type === 'set_fov' && it.cmd.deg === 65)
}, null, { timeout: 30000 }).catch(() => {})
const secondAsk = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getProposal())
check('R7: the following ask is answered too', !!secondAsk &&
  secondAsk.items.some((it) => it.cmd && it.cmd.deg === 65), secondAsk)
await page.click('[data-swe-action="discard-proposal"]').catch(() => {})

/* --- 8f. R3 supplement: another tab re-logging-in kills the plan ------- */

// A second tab of the SAME browser signs in again. The cookie jar is shared,
// so the session behind this tab's plan is replaced even though this page
// never signed out. A plan bought under the old session must not survive a
// confirm, and this tab must be able to SEE that the session moved.
fake.reset()
await page.fill('.swe-ask', '把视场调到 70 度')
await page.click('[data-swe-action="ask"]')
await page.waitForFunction(() => {
  const p = window.__SWE_ASSISTANT_TEST__.getProposal()
  return !!p && p.items.some((it) => it.cmd && it.cmd.type === 'set_fov' && it.cmd.deg === 70)
}, null, { timeout: 30000 }).catch(() => {})
const preRelogin = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getServerAi())
check('R3: the plan is on screen before the other tab signs in',
  !!(await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getProposal())))

// context.request shares the cookie jar with every page of the context -
// exactly what a second tab's login does to this one.
const relogin = await context.request.post(BASE + 'api/auth/login', { data: { token: CLASS_TOKEN } })
check('R3: the other tab signs in as the same role', relogin.status() === 200, relogin.status())

const fovCrossBefore = await page.evaluate(() => document.getElementById('app').__vue__.$stel.core.fov * 180 / Math.PI)
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.forceRunProposal())
await page.waitForTimeout(2500)
const postCross = await page.evaluate(() => ({
  proposal: window.__SWE_ASSISTANT_TEST__.getProposal(),
  fov: document.getElementById('app').__vue__.$stel.core.fov * 180 / Math.PI,
  server: window.__SWE_ASSISTANT_TEST__.getServerAi()
}))
check('R3: a plan does not survive a re-login from another tab',
  postCross.proposal === null, postCross.proposal)
check('R3: the cross-tab plan moved nothing',
  Math.abs(postCross.fov - fovCrossBefore) < 0.5, { before: fovCrossBefore, after: postCross.fov })
check('R3: the tab can see the new session tag',
  !!postCross.server.sessionTag && postCross.server.sessionTag !== preRelogin.sessionTag,
  { before: preRelogin.sessionTag, after: postCross.server.sessionTag })

/* --- 8g. R3 supplement: a status read that fails stops the confirm ----- */

// The deployment answers, but the status endpoint is broken. The panel keeps
// its last known display, but a confirm must not run a plan on the strength
// of a re-verification that never happened.
fake.reset()
await page.fill('.swe-ask', '把视场调到 75 度')
await page.click('[data-swe-action="ask"]')
await page.waitForFunction(() => {
  const p = window.__SWE_ASSISTANT_TEST__.getProposal()
  return !!p && p.items.some((it) => it.cmd && it.cmd.type === 'set_fov' && it.cmd.deg === 75)
}, null, { timeout: 30000 }).catch(() => {})
const fovFailBefore = await page.evaluate(() => document.getElementById('app').__vue__.$stel.core.fov * 180 / Math.PI)
await page.route('**/api/auth/status', (route) =>
  route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }))
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.forceRunProposal())
await page.waitForTimeout(2000)
const postFail = await page.evaluate(() => ({
  proposal: window.__SWE_ASSISTANT_TEST__.getProposal(),
  fov: document.getElementById('app').__vue__.$stel.core.fov * 180 / Math.PI,
  server: window.__SWE_ASSISTANT_TEST__.getServerAi()
}))
check('R3: a confirm during a status outage refuses and clears the plan',
  postFail.proposal === null, postFail.proposal)
check('R3: the status-outage plan moved nothing',
  Math.abs(postFail.fov - fovFailBefore) < 0.5, { before: fovFailBefore, after: postFail.fov })
check('R3: the panel says the session verdict is no longer verified',
  postFail.server.verified === false, postFail.server)
await page.unroute('**/api/auth/status')
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.refreshServerStatus())
await page.waitForTimeout(1000)
check('R3: the panel recovers once the status endpoint answers again',
  (await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getServerAi())).verified === true)

/* --- 8h. C2-a: a failed quiet pre-ask read cannot ride an old verified -- */

// The exact shape the review named: the panel holds a still-fresh status
// cache, the config endpoint starts failing while /api/ai/chat keeps
// answering, and the quiet pre-ask read fails. The paid ask must not go out
// against a deployment this tab cannot currently see.
fake.reset()
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.refreshServerStatus())
const healthy8h = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getServerAi())
check('C2-a: the panel is verified before the outage',
  healthy8h.verified === true && healthy8h.available === true, healthy8h)

const upstreamCalls8h = fake.state.calls.length
await page.route('**/api/ai/config', (route) =>
  route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }))
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.expireServerStatusCache())
await page.fill('.swe-ask', '把视场调到 80 度')
await page.click('[data-swe-action="ask"]')
await page.waitForTimeout(1500)
const c2a = await page.evaluate(() => ({
  proposal: window.__SWE_ASSISTANT_TEST__.getProposal(),
  server: window.__SWE_ASSISTANT_TEST__.getServerAi(),
  status: (document.querySelector('[data-swe-ask-status]') || {}).textContent || ''
}))
check('C2-a: the ask is refused while the status cannot be verified',
  c2a.proposal === null && c2a.server.verified === false, c2a)
check('C2-a: no generation was paid for behind the failed pre-read',
  fake.state.calls.length === upstreamCalls8h,
  { before: upstreamCalls8h, after: fake.state.calls.length })
check('C2-a: the refusal says so in teacher words', /核实/.test(c2a.status), c2a.status)

// The deployment itself kept answering chats the whole time - which is exactly
// why the panel-side gate is the thing that has to hold: the money path was
// open, only the panel's view of it was gone.
const directChatC2a = await apiJson(8900, 'POST', '/api/ai/chat',
  { messages: [{ role: 'user', content: 'hi' }] }, 'swe_access=' + encodeURIComponent(CLASS_TOKEN))
check('C2-a: the chat route itself still answered during the outage',
  directChatC2a.status === 200, directChatC2a.status)

// A plan that was already on screen when the outage began must not ride the
// old verdict either: the confirm re-verifies, fails, refuses.
await page.unroute('**/api/ai/config')
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.refreshServerStatus())
await page.waitForTimeout(800)
await page.fill('.swe-ask', '把视场调到 85 度')
await page.click('[data-swe-action="ask"]')
await page.waitForFunction(() => {
  const p = window.__SWE_ASSISTANT_TEST__.getProposal()
  return !!p && p.items.some((it) => it.cmd && it.cmd.type === 'set_fov' && it.cmd.deg === 85)
}, null, { timeout: 30000 }).catch(() => {})
const fovC2a = await page.evaluate(() => document.getElementById('app').__vue__.$stel.core.fov * 180 / Math.PI)
await page.route('**/api/ai/config', (route) =>
  route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }))
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.expireServerStatusCache())
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.forceRunProposal())
await page.waitForTimeout(2000)
const c2aConfirm = await page.evaluate(() => ({
  proposal: window.__SWE_ASSISTANT_TEST__.getProposal(),
  fov: document.getElementById('app').__vue__.$stel.core.fov * 180 / Math.PI,
  server: window.__SWE_ASSISTANT_TEST__.getServerAi()
}))
check('C2-a: a confirm during the outage refuses and clears the plan',
  c2aConfirm.proposal === null, c2aConfirm.proposal)
check('C2-a: the outage-era plan moved nothing',
  Math.abs(c2aConfirm.fov - fovC2a) < 0.5, { before: fovC2a, after: c2aConfirm.fov })
await page.unroute('**/api/ai/config')
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.refreshServerStatus())
await page.waitForTimeout(800)
check('C2-a: the panel recovers after the outage',
  (await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getServerAi())).verified === true)

/* --- 8i. C2-b: a status endpoint that never answers cannot wedge ask ---- */

// Not a 503 - the request never completes at all. The status read has its own
// deadline (shortened here through the documented seam), the ask is refused,
// the busy state is released, and the panel stays usable.
fake.reset()
await page.evaluate(() => { window.__SWE_AI_STATUS_TIMEOUT_MS__ = 800 })
await page.route('**/api/ai/config', () => new Promise(() => { /* never answers */ }))
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.expireServerStatusCache())
const tHang = Date.now()
await page.fill('.swe-ask', '把视场调到 90 度')
await page.click('[data-swe-action="ask"]')
await page.waitForTimeout(2500)
const c2b = await page.evaluate(() => ({
  proposal: window.__SWE_ASSISTANT_TEST__.getProposal(),
  server: window.__SWE_ASSISTANT_TEST__.getServerAi(),
  status: (document.querySelector('[data-swe-ask-status]') || {}).textContent || '',
  askBtnDisabled: (document.querySelector('[data-swe-action="ask"]') || {}).disabled
}))
check('C2-b: the hanging status read times out and the ask is refused',
  c2b.proposal === null && c2b.server.verified === false, c2b)
check('C2-b: the ask gave up close to the shortened deadline, not forever',
  Date.now() - tHang < 5000, { elapsedMs: Date.now() - tHang, deadlineMs: 800 })
check('C2-b: no generation happened behind the hang',
  fake.state.calls.length === 0, fake.state.calls.length)
check('C2-b: the ask button is usable again after the refusal',
  c2b.askBtnDisabled === false, c2b.askBtnDisabled)
check('C2-b: the refusal says so in teacher words', /核实/.test(c2b.status), c2b.status)

await page.unroute('**/api/ai/config')
await page.evaluate(() => { delete window.__SWE_AI_STATUS_TIMEOUT_MS__ })
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.refreshServerStatus())
await page.waitForTimeout(800)
check('C2-b: the panel recovers once the status endpoint answers again',
  (await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getServerAi())).verified === true)

/* --- 8j. C2-b supplement: the auth/status endpoint is the one hanging --- */

// The config endpoint answers fine; auth/status never does. The same deadline
// applies, the same failure mark lands, and the ask is refused without a
// generation - the second status GET is under the same contract as the first.
fake.reset()
await page.evaluate(() => { window.__SWE_AI_STATUS_TIMEOUT_MS__ = 800 })
await page.route('**/api/auth/status', () => new Promise(() => { /* never answers */ }))
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.expireServerStatusCache())
const tAuthHang = Date.now()
await page.fill('.swe-ask', '把视场调到 95 度')
await page.click('[data-swe-action="ask"]')
await page.waitForTimeout(2500)
const c2bAuth = await page.evaluate(() => ({
  proposal: window.__SWE_ASSISTANT_TEST__.getProposal(),
  server: window.__SWE_ASSISTANT_TEST__.getServerAi(),
  status: (document.querySelector('[data-swe-ask-status]') || {}).textContent || ''
}))
check('C2-b: a hanging auth/status read also times out and refuses the ask',
  c2bAuth.proposal === null && c2bAuth.server.verified === false, c2bAuth)
check('C2-b: the auth/status hang gave up close to the shortened deadline',
  Date.now() - tAuthHang < 5000, { elapsedMs: Date.now() - tAuthHang, deadlineMs: 800 })
check('C2-b: no generation happened behind the auth/status hang',
  fake.state.calls.length === 0, fake.state.calls.length)
check('C2-b: the auth/status refusal says so in teacher words',
  /核实/.test(c2bAuth.status), c2bAuth.status)
await page.unroute('**/api/auth/status')
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.refreshServerStatus())
await page.waitForTimeout(800)
check('C2-b: the panel recovers after the auth/status hang',
  (await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getServerAi())).verified === true)

/* --- 8k. C2-b supplement: the confirm path waits on the same deadline --- */

// A plan is already on screen when the status endpoints stop answering. The
// confirm's forced re-verification hits the same deadline, the plan is
// refused and cleared, the sky does not move, and the button state recovers.
fake.reset()
await page.evaluate(() => { window.__SWE_AI_STATUS_TIMEOUT_MS__ = 800 })
await page.fill('.swe-ask', '把视场调到 98 度')
await page.click('[data-swe-action="ask"]')
await page.waitForFunction(() => {
  const p = window.__SWE_ASSISTANT_TEST__.getProposal()
  return !!p && p.items.some((it) => it.cmd && it.cmd.type === 'set_fov' && it.cmd.deg === 98)
}, null, { timeout: 30000 }).catch(() => {})
const fovC2bConfirm = await page.evaluate(() => document.getElementById('app').__vue__.$stel.core.fov * 180 / Math.PI)
// The ask above legitimately spent one upstream call; the hung confirm must
// not spend another one.
const upstreamBeforeConfirmHang = fake.state.calls.length
await page.route('**/api/ai/config', () => new Promise(() => { /* never answers */ }))
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.expireServerStatusCache())
const tConfirmHang = Date.now()
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.forceRunProposal())
await page.waitForTimeout(2500)
const c2bConfirm = await page.evaluate(() => ({
  proposal: window.__SWE_ASSISTANT_TEST__.getProposal(),
  fov: document.getElementById('app').__vue__.$stel.core.fov * 180 / Math.PI,
  server: window.__SWE_ASSISTANT_TEST__.getServerAi(),
  askBtnDisabled: (document.querySelector('[data-swe-action="ask"]') || {}).disabled
}))
check('C2-b: a confirm whose re-verification hangs is refused and clears the plan',
  c2bConfirm.proposal === null && c2bConfirm.server.verified === false, c2bConfirm)
check('C2-b: the confirm gave up close to the shortened deadline',
  Date.now() - tConfirmHang < 5000, { elapsedMs: Date.now() - tConfirmHang, deadlineMs: 800 })
check('C2-b: the hung-confirm plan moved nothing',
  Math.abs(c2bConfirm.fov - fovC2bConfirm) < 0.5, { before: fovC2bConfirm, after: c2bConfirm.fov })
check('C2-b: no generation happened behind the confirm hang',
  fake.state.calls.length === upstreamBeforeConfirmHang,
  { before: upstreamBeforeConfirmHang, after: fake.state.calls.length })
check('C2-b: the busy state is released after the confirm hang',
  c2bConfirm.askBtnDisabled === false, c2bConfirm.askBtnDisabled)
await page.unroute('**/api/ai/config')
await page.evaluate(() => { delete window.__SWE_AI_STATUS_TIMEOUT_MS__ })
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.refreshServerStatus())
await page.waitForTimeout(800)
check('C2-b: the panel recovers after the confirm hang',
  (await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getServerAi())).verified === true)

/* --- 9. a cross-site page cannot spend the budget --------------------- */

const cross = await apiJson(8900, 'POST', '/api/ai/chat',
  { messages: [{ role: 'user', content: 'hi' }] }, 'swe_access=' + encodeURIComponent(CLASS_TOKEN))
check('a request with no Origin is allowed only because it carries a token', cross.status === 200, cross.status)

const crossOrigin = await new Promise((resolve) => {
  const data = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }))
  const req = http.request({
    host: '127.0.0.1', port: 8900, method: 'POST', path: '/api/ai/chat',
    headers: {
      'Content-Type': 'application/json', 'Content-Length': data.length,
      Origin: 'http://127.0.0.1:9999',
      Cookie: 'swe_access=' + encodeURIComponent(CLASS_TOKEN)
    }
  }, (res) => { res.resume(); resolve(res.statusCode) })
  req.on('error', () => resolve(0))
  req.write(data); req.end()
})
check('a different port is a different origin', crossOrigin === 403, crossOrigin)

/* --- 10. logout takes the paid route away ------------------------------ */

const classLogin = await apiJson(8900, 'POST', '/api/auth/login', { token: CLASS_TOKEN })
const classCookie = (classLogin.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ')
const lo = await apiJson(8900, 'POST', '/api/auth/logout', undefined, classCookie)
const cleared = (lo.headers['set-cookie'] || []).map((c) => c.split(';')[0])
check('logout clears swe_access and swe_sid',
  cleared.includes('swe_access=') && cleared.includes('swe_sid='), cleared)
const afterLogout = await apiJson(8900, 'POST', '/api/ai/chat', { messages: [{ role: 'user', content: 'hi' }] })
check('the paid route is closed after logout', afterLogout.status === 401, afterLogout.status)

/* --- 11. quota refusal is phrased for a teacher ------------------------ */

// The panel has already spent several calls, so its own identity is over a
// limit of 1. A second passphrase is used for the "first one is allowed"
// half, so the check does not depend on how much earlier sections spent.
await saveConfig({ limits: { dailyPerIdentity: 1, dailyGlobal: 100 } }, adminCookie)

const c2 = await apiJson(8900, 'POST', '/api/auth/login', { token: CLASS2_TOKEN })
const c2Cookie = (c2.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ')
const q1 = await apiJson(8900, 'POST', '/api/ai/chat',
  { messages: [{ role: 'user', content: 'hi' }] }, c2Cookie)
const q2 = await apiJson(8900, 'POST', '/api/ai/chat',
  { messages: [{ role: 'user', content: 'hi' }] }, c2Cookie)
check('a fresh passphrase gets its own first call',
  q1.status === 200, [q1.status, q1.json && q1.json.error])
check('the second call is refused by the daily limit',
  q2.status === 429 && q2.json.error === 'subject_quota', [q2.status, q2.json && q2.json.error])

await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.showTab('sky'))
await page.fill('.swe-ask', '关掉大气')
await page.click('[data-swe-action="ask"]')
await page.waitForTimeout(2500)
const quotaMsg = await page.textContent('[data-swe-ask-status]').catch(() => '')
check('the panel explains the quota in words, not a status code',
  /额度/.test(quotaMsg || ''), quotaMsg)

await saveConfig({ limits: { dailyPerIdentity: 60, dailyGlobal: 400 } }, adminCookie)

/* --- 12. admin page ---------------------------------------------------- */

const adminPage = await apiJson(8900, 'GET', '/admin')
check('the admin page is served', adminPage.status === 200 && /保存不会调用模型/.test(adminPage.text), adminPage.status)
check('the admin page contains no key', !adminPage.text.includes(UPSTREAM_KEY), 'leak')

// Serving the file proves nothing about what it shows, so drive it: an operator
// who cannot see the masked state, the revision and the last-modified stamp is
// being asked to change a paid configuration blind.
const adminTab = await context.newPage()
await adminTab.goto('http://127.0.0.1:8900/admin', { waitUntil: 'domcontentloaded' })
await adminTab.fill('#token', ADMIN_TOKEN)
await adminTab.click('#loginBtn')
await adminTab.waitForSelector('#configCard:not(.hide)', { timeout: 10000 }).catch(() => {})
const adminUi = await adminTab.evaluate(() => ({
  shown: !document.getElementById('configCard').classList.contains('hide'),
  baseUrl: document.getElementById('baseUrl').value,
  model: document.getElementById('model').value,
  keyField: document.getElementById('key').value,
  status: document.getElementById('statusKv').textContent || '',
  html: document.body.innerHTML
}))
check('the admin page opens after a passphrase', adminUi.shown === true, adminUi.shown)
check('it shows the configured base URL and model',
  adminUi.baseUrl === 'http://127.0.0.1:' + fake.port + '/v1' && adminUi.model === 'fake-model',
  { baseUrl: adminUi.baseUrl, model: adminUi.model })
check('the key field is empty, never pre-filled', adminUi.keyField === '', adminUi.keyField)
check('the key is reported as set without being echoed', /已设置（不回显）/.test(adminUi.status), adminUi.status.slice(0, 160))
check('the revision and the last-modified stamp are visible',
  /rev \d+/.test(adminUi.status) && /最后修改/.test(adminUi.status), adminUi.status.slice(0, 160))
check('the admin page never contains the key value', !adminUi.html.includes(UPSTREAM_KEY), 'leak')
try { await adminTab.screenshot({ path: path.join(SHOT, 'admin-config.png') }) } catch { /* evidence only */ }

/* --- 12b. R9: a second admin tab cannot overwrite the first ------------ */

// Two operators (or one operator in two tabs) with the same page open. The one
// that saves second is working from a form that no longer describes the
// deployment; writing it back would undo the other save silently.
const adminTab2 = await context.newPage()
await adminTab2.goto('http://127.0.0.1:8900/admin', { waitUntil: 'domcontentloaded' })
// The two tabs share the browser context, so the session cookie is already
// there; only fill the form when the page actually asks for it.
await adminTab2.waitForTimeout(800)
const tab2NeedsLogin = await adminTab2.evaluate(() =>
  !document.getElementById('loginCard').classList.contains('hide'))
if (tab2NeedsLogin) {
  await adminTab2.fill('#token', ADMIN_TOKEN)
  await adminTab2.click('#loginBtn')
}
await adminTab2.waitForSelector('#configCard:not(.hide)', { timeout: 10000 }).catch(() => {})

const revBefore = await adminTab2.evaluate(() => {
  const m = /rev (\d+)/.exec(document.getElementById('statusKv').textContent || '')
  return m ? Number(m[1]) : 0
})
check('R9: the second tab rendered a revision', revBefore > 0, revBefore)

// A save is a round-trip plus a disk write; on a loaded machine it can take a
// moment, so wait for the page to leave "saving" rather than for a fixed delay.
async function saveAndWait (tab) {
  await tab.click('#saveBtn')
  await tab.waitForFunction(() => {
    const t = document.getElementById('cfgOut').textContent || ''
    return !!t && !/保存中/.test(t)
  }, null, { timeout: 30000 }).catch(() => {})
  return tab.textContent('#cfgOut').catch(() => '')
}

// Tab 2 saves first. The effect is read back from the API rather than from the
// page's own confirmation text: this sandbox proxies loopback and occasionally
// drops an idle keep-alive connection, which loses the *response* of a save that
// was in fact applied.
await adminTab2.fill('#model', 'model-from-tab-2')
await adminTab2.fill('#note', 'saved in tab 2')
await saveAndWait(adminTab2)
const firstSave = await apiJson(8900, 'GET', '/api/admin/config', undefined, adminCookie)
check('R9: the first tab to save succeeds',
  firstSave.json.config.upstream.model === 'model-from-tab-2', firstSave.json.config.upstream.model)

// Tab 1 is now stale: it still shows the old model and the old revision.
const staleForm = await adminTab.evaluate(() => ({
  model: document.getElementById('model').value,
  status: document.getElementById('statusKv').textContent || ''
}))
check('R9: the older tab is still showing its own revision',
  staleForm.model === 'fake-model' && new RegExp('rev ' + revBefore + '\\b').test(staleForm.status),
  { model: staleForm.model, status: staleForm.status.slice(0, 120) })

await adminTab.fill('#model', 'model-from-tab-1')
const staleOut = await saveAndWait(adminTab)
check('R9: the stale save is refused, not applied', /未保存/.test(staleOut), staleOut)
check('R9: the stale save explains that someone else changed it',
  /其他人|另一个标签页/.test(staleOut), staleOut)

const afterConflict = await apiJson(8900, 'GET', '/api/admin/config', undefined, adminCookie)
check('R9: the newer configuration survived the stale save',
  afterConflict.json.config.upstream.model === 'model-from-tab-2', afterConflict.json.config.upstream.model)
// The page reloads its form after a conflict; wait for that rather than reading
// the field the instant the message appears.
await adminTab.waitForFunction(() => document.getElementById('model').value === 'model-from-tab-2',
  null, { timeout: 10000 }).catch(() => {})
const refreshedModel = await adminTab.inputValue('#model')
check('R9: the stale form was refreshed to the newer values',
  refreshedModel === 'model-from-tab-2', refreshedModel)

// Put the model back so the sections after this one see what they expect.
await adminTab2.fill('#model', 'fake-model')
await adminTab2.fill('#note', 'e2e fake')
await saveAndWait(adminTab2)
let restored = await apiJson(8900, 'GET', '/api/admin/config', undefined, adminCookie)
if (restored.json.config.upstream.model !== 'fake-model') {
  // One retry: a lost response is not a refused save, and an operator would
  // simply click again.
  await saveAndWait(adminTab2)
  restored = await apiJson(8900, 'GET', '/api/admin/config', undefined, adminCookie)
}
check('R9: the model is restored for the later sections',
  restored.json.config.upstream.model === 'fake-model', restored.json.config.upstream.model)
await adminTab2.close()
await adminTab.close()

/* --- 13. fault isolation: AI off, sky still works ---------------------- */

await apiJson(8900, 'POST', '/api/admin/emergency-stop', undefined, adminCookie)
const off = await apiJson(8900, 'GET', '/api/ai/config')
check('emergency stop is visible to the panel', off.json.available === false, off.json)

await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-swe-assistant="panel"]', { timeout: 30000 })
await page.waitForTimeout(1500)
const afterStop = await page.evaluate(() => {
  const t = window.__SWE_ASSISTANT_TEST__
  const stel = document.getElementById('app').__vue__.$stel
  const o = stel.getObj('NAME Sun')
  const v = stel.convertFrame(stel.core.observer, 'ICRF', 'OBSERVED', o.getInfo('radec'))
  return {
    server: t.getServerAi(),
    sunAlt: stel.c2s(v)[1] * 180 / Math.PI,
    canvas: !!document.querySelector('canvas')
  }
})
check('with server AI off the panel still loads', afterStop.canvas === true, afterStop.canvas)
check('the panel reports the option as unavailable', afterStop.server.available === false, afterStop.server)
check('the sky still renders', Number.isFinite(afterStop.sunAlt), afterStop.sunAlt)

/* --- 14. hygiene ------------------------------------------------------- */

check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3))
check('no unexpected console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3))

const serviceLog = fs.readFileSync(svc.logPath, 'utf8')
check('the key never reached the service log', !serviceLog.includes(UPSTREAM_KEY), 'leak')
check('the config file on disk has no key',
  !fs.readFileSync(path.join(svc.dataDir, 'config.json'), 'utf8').includes(UPSTREAM_KEY), 'leak')

/* --- screenshots ------------------------------------------------------- */

try {
  fs.mkdirSync(SHOT, { recursive: true })
} catch { /* ignore */ }

console.log('\n' + pass + ' PASS / ' + fail + ' FAIL')
if (fail) {
  console.log('failed:')
  for (const f of failures) console.log('  - ' + f)
}

await browser.close()
await svc.stop()
await fake.close()
if (fail) process.exit(1)
