/* Client-side acceptance for the teaching assistant panel.
 *
 * Everything here runs against an isolated fake OpenAI-compatible server
 * (tests/fake-openai/server.mjs). No real model is called, no credentials are
 * used, and the fake binds loopback only. Passing this file proves the client
 * path works; it does NOT prove any real endpoint works (task book 10).
 *
 * usage: node tests/e2e/client.mjs [url]
 * env:   FAKE_PORT, CHROME_PATH
 */
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../..')
const DELIVERY = path.resolve(SRC, '..')

const URL_ = process.argv[2] || 'http://127.0.0.1:8899/'
const FAKE_PORT = Number(process.env.FAKE_PORT || 8951)
const FAKE = 'http://127.0.0.1:' + FAKE_PORT
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

let failures = 0
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''))
  if (!ok) failures++
}

/* ---------------------------------------------------- fake model server */

const fake = spawn(process.execPath, [path.join(HERE, '../fake-openai/server.mjs'), String(FAKE_PORT)], {
  stdio: ['ignore', 'pipe', 'pipe']
})
fake.stdout.on('data', () => {})
fake.stderr.on('data', (d) => process.stderr.write('[fake] ' + d))

async function waitForFake () {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(FAKE + '/v1/models')
      if (r.ok) return true
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

const control = (patch) => fetch(FAKE + '/__control', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
}).then((r) => r.json())

const stats = () => fetch(FAKE + '/__stats').then((r) => r.json())
const resetFake = () => fetch(FAKE + '/__reset', { method: 'POST' }).then((r) => r.json())

if (!await waitForFake()) {
  console.error('fake server did not start on ' + FAKE)
  process.exit(1)
}

/* ------------------------------------------------------------- browser */

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
})
// locale is pinned to en-US on purpose: the host and the panel must come up in
// Chinese whatever the browser/OS says (task book 5.1), so the machine's own
// language must not leak into the result.
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() !== 'error') return
  const text = m.text()
  // The engine logs satellite-ephemeris misses on every run; they are not ours.
  if (/Satellite position error/.test(text)) return
  // Deliberately injected faults (401, aborted request) surface here as failed
  // resource loads. The user-facing behaviour for each is asserted below.
  if (/Failed to load resource/.test(text)) return
  consoleErrors.push(text)
})
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))
await page.addInitScript(() => { try { localStorage.clear() } catch (_) {} })

// The host asks Google Fonts for Roboto. That is the only request in this page
// that leaves the machine, and it makes every run depend on the public
// internet and on whatever proxy the operator has configured - a font
// timeout was holding the load event open for 30 s. Abort it: the panel ships
// a local font stack, and a test must not need the internet to pass.
await page.route('**://fonts.googleapis.com/**', (r) => r.abort())
await page.route('**://fonts.gstatic.com/**', (r) => r.abort())

await page.goto(URL_, { waitUntil: 'load' })
await page.waitForSelector('[data-swe-assistant="panel"]', { timeout: 60000 })
await page.waitForFunction(() => {
  const e = document.getElementById('app')
  const s = e && e.__vue__ && e.__vue__.$stel
  try { return !!(s && s.getObj('M 31')) } catch (_) { return false }
}, null, { timeout: 90000 })
await page.waitForTimeout(2500)

/* ---- bind the run to the bytes that were actually served ---- */
const served = await page.evaluate(async () => {
  const grab = async (u) => {
    const r = await fetch(u, { cache: 'no-store' })
    const buf = await r.arrayBuffer()
    const h = await crypto.subtle.digest('SHA-256', buf)
    return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  const m = await (await fetch('ai-assistant/manifest.json?t=' + Date.now(), { cache: 'no-store' })).json()
  return {
    index: await grab('index.html'),
    loader: await grab('ai-assistant/loader.js'),
    assistant: await grab('ai-assistant/assistant.js'),
    version: m.version,
    protocol: m.protocolVersion,
    assetQuery: m.assetQuery
  }
})
console.log('# client — ' + new Date().toISOString())
console.log('# url: ' + URL_)
console.log('# candidate index.html = ' + served.index)
console.log('# candidate ai-assistant/loader.js = ' + served.loader)
console.log('# candidate ai-assistant/assistant.js = ' + served.assistant)
console.log('# candidate manifest = v' + served.version + ' protocol v' + served.protocol + ' assetQuery ' + served.assetQuery)
console.log('# fake model = ' + FAKE + ' (test only, loopback, no credentials)')
console.log('# test file = ' + crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'))
console.log('')

const engine = () => page.evaluate(() => {
  const stel = document.getElementById('app').__vue__.$stel
  return {
    atm: stel.core.atmosphere.visible,
    fov: stel.core.fov * 180 / Math.PI,
    utc: new Date((stel.core.observer.utc - 40587) * 86400000).toISOString(),
    lat: stel.core.observer.latitude * 180 / Math.PI,
    lng: stel.core.observer.longitude * 180 / Math.PI,
    sel: stel.core.selection ? stel.core.selection.designations()[0] : null
  }
})

const select = (name) => page.evaluate((n) => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'select_object', name: n }), name)
const showTab = (k) => page.evaluate((name) => window.__SWE_ASSISTANT_TEST__.showTab(name), k)

async function configureAi (opts) {
  // The AI form is its own pane since 0.7.0; the sidebar had grown to eight
  // stacked sections. Everything below still drives the same DOM nodes.
  await showTab('ai')
  await page.fill('.swe-ai-url', (opts && opts.baseUrl) || (FAKE + '/v1'))
  await page.fill('.swe-ai-model', (opts && opts.model) || 'fake-teacher')
  await page.fill('.swe-ai-key', (opts && opts.apiKey) || '')
}

async function ask (text) {
  await showTab('sky')
  await page.fill('.swe-ask', text)
  await page.click('[data-swe-action="ask"]')
  await page.waitForSelector('[data-swe-proposal] .swe-cmd, [data-swe-ask-status]', { timeout: 20000 }).catch(() => {})
  await page.waitForFunction(() => {
    const n = document.querySelector('[data-swe-ask-status]')
    const p = document.querySelector('[data-swe-proposal] .swe-cmd')
    return !!p || (n && n.textContent && !/正在解析/.test(n.textContent))
  }, null, { timeout: 20000 }).catch(() => {})
}

async function explain () {
  await showTab('sky')
  await page.click('[data-swe-action="explain"]')
}

/* 1. panel basics ------------------------------------------------------ */
check('panel injected', true)
// Baseline version comes from the installed manifest, never hardcoded: bumping
// the assistant must not silently turn this suite red (or green).
const BASE_MANIFEST = JSON.parse(fs.readFileSync(
  path.join(DELIVERY, 'packages/integrated-web/dist/ai-assistant/manifest.json'), 'utf8'))
check('assistant version matches the installed manifest',
  (await page.textContent('.swe-ver')) === 'v' + BASE_MANIFEST.version,
  { got: await page.textContent('.swe-ver'), want: 'v' + BASE_MANIFEST.version })

const langDefault = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getLanguage())
check('UI defaults to Chinese', langDefault === 'zh', langDefault)

/* 2. Shanghai default site --------------------------------------------- */
const site0 = await engine()
check('first use applies the Shanghai default site',
  Math.abs(site0.lat - 31.2304) < 0.01 && Math.abs(site0.lng - 121.4737) < 0.01,
  { lat: site0.lat, lng: site0.lng })
const locText = await page.evaluate(() => {
  const secs = Array.from(document.querySelectorAll('.swe-sec'))
  const s = secs.find((x) => /观测地点|Observing site/.test(x.textContent))
  return s ? s.textContent : ''
})
check('the default site is labelled as simulated, not the real position',
  /模拟位置|simulated/.test(locText), locText.slice(0, 60))
check('time zone defaults to Asia/Shanghai',
  (await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getPrefs().tz)) === 'Asia/Shanghai')

/* 3. endpoint resolution ---------------------------------------------- */
const eps = await page.evaluate(() => {
  const r = window.__SWE_ASSISTANT_TEST__.resolveEndpoint
  return {
    bare: r('http://h:1', 'chat'),
    v1: r('http://h:1/v1', 'chat'),
    slash: r('http://h:1/v1/', 'chat'),
    full: r('http://h:1/v1/chat/completions', 'chat'),
    models: r('http://h:1/v1', 'models')
  }
})
check('a bare host gets exactly one /v1', eps.bare === 'http://h:1/v1/chat/completions', eps.bare)
check('an existing /v1 is not doubled', eps.v1 === 'http://h:1/v1/chat/completions', eps.v1)
check('a trailing slash is normalised', eps.slash === 'http://h:1/v1/chat/completions', eps.slash)
check('a full endpoint path is kept as given', eps.full === 'http://h:1/v1/chat/completions', eps.full)
check('the models probe shares the same prefix', eps.models === 'http://h:1/v1/models', eps.models)

/* 4. server AI is announced as unavailable ---------------------------- */
const serverOpt = await page.evaluate(() => {
  const radio = document.querySelector('input[value="server"]')
  const hint = document.querySelector('.swe-ai-server-hint')
  return { disabled: !!radio.disabled, hint: hint ? hint.textContent : '' }
})
check('server AI option is disabled', serverOpt.disabled === true)
check('server AI says it is not provided, not that the user failed',
  /尚未提供|not provided/i.test(serverOpt.hint), serverOpt.hint)

/* 5. connection test --------------------------------------------------- */
await resetFake()
await configureAi()
await page.click('[data-swe-action="ai-test"]')
await page.waitForFunction(() => {
  const n = document.querySelector('.swe-ai-test')
  return n && n.textContent && !/测试中|Testing/.test(n.textContent)
}, null, { timeout: 15000 }).catch(() => {})
const testOut = await page.textContent('.swe-ai-test')
check('connection test reports the endpoint reachable', /可达|reachable/i.test(testOut), testOut)
check('connection test warns that it does not prove generation',
  /不代表生成|not mean generation/i.test(testOut), testOut)
let s = await stats()
check('an empty API key sends no Authorization header', s.lastAuth === null, s.lastAuth)

await page.fill('.swe-ai-key', 'sk-fake-123')
await page.click('[data-swe-action="ai-test"]')
await page.waitForTimeout(1200)
s = await stats()
check('a filled API key is sent as a Bearer token', s.lastAuth === 'Bearer sk-fake-123', s.lastAuth)
await page.fill('.swe-ai-key', '')

await control({ mode: '401' })
await page.click('[data-swe-action="ai-test"]')
await page.waitForTimeout(1200)
check('401 is reported as an authentication problem',
  /认证失败|Authentication failed/i.test(await page.textContent('.swe-ai-test')),
  await page.textContent('.swe-ai-test'))
await control({ mode: 'ok' })

/* 6. selection alone makes no model request ---------------------------- */
await resetFake()
await select('M 31')
await page.waitForTimeout(700)
await select('* alf Ori')
await page.waitForTimeout(1800)
s = await stats()
check('selecting objects does not call the model', s.chat === 0, { chat: s.chat })
check('selection is reflected in the panel',
  /Betelgeuse|alf Ori/.test(await page.textContent('.swe-obj-name').catch(() => '')),
  await page.textContent('.swe-obj-name').catch(() => ''))

/* 7. proposal: preview, confirm, read-back ----------------------------- */
await control({ mode: 'ok', delayMs: 0, text: null, commands: null })
await resetFake()
await select('M 31')
const beforeProposal = await engine()
await ask('关掉大气，视场调到 20 度')
const propText = await page.textContent('[data-swe-proposal]')
check('the proposal is shown as a preview', /确认后才会执行|nothing runs until you confirm/i.test(propText), propText.slice(0, 60))
check('the proposal lists the commands',
  (await page.$$('[data-swe-proposal] .swe-cmd')).length === 2)
const beforeConfirm = await engine()
check('nothing is executed before confirmation',
  beforeConfirm.atm === beforeProposal.atm && Math.abs(beforeConfirm.fov - beforeProposal.fov) < 0.5,
  { atm: beforeConfirm.atm, fov: beforeConfirm.fov })

await page.click('[data-swe-action="run-proposal"]')
await page.waitForFunction(() => {
  const n = document.querySelector('[data-swe-ask-status]')
  return n && /完成|Done/.test(n.textContent)
}, null, { timeout: 20000 }).catch(() => {})
const afterConfirm = await engine()
check('confirming applies the atmosphere change', afterConfirm.atm === false, afterConfirm.atm)
check('confirming applies the field of view, read back from the engine',
  Math.abs(afterConfirm.fov - 20) < 0.5, afterConfirm.fov)
check('the result line reports success only after read-back',
  /2 条成功|2 succeeded/.test(await page.textContent('[data-swe-ask-status]')),
  await page.textContent('[data-swe-ask-status]'))

/* 8. discard leaves the engine alone ----------------------------------- */
const beforeDiscard = await engine()
await ask('关掉大气')
await page.click('[data-swe-action="discard-proposal"]')
await page.waitForTimeout(600)
const afterDiscard = await engine()
check('discarding a proposal changes nothing',
  afterDiscard.atm === beforeDiscard.atm && Math.abs(afterDiscard.fov - beforeDiscard.fov) < 0.5,
  { atm: afterDiscard.atm, fov: afterDiscard.fov })

/* 9. a proposal made for another selection is refused ------------------ */
// The plan is written while M 31 is selected, then the teacher moves on. The
// panel now latches the verdict: the confirm button is disabled and the guard
// also holds if something reaches runProposal anyway.
await ask('关掉大气')
await select('* alf Ori')
await page.waitForTimeout(1200)
const beforeStale = await engine()
check('a proposal is marked void once the selection changed',
  await page.getAttribute('[data-swe-action="run-proposal"]', 'disabled') !== null)
check('the void proposal says why it cannot run',
  /作废|void/i.test(await page.textContent('[data-swe-proposal]')))

// A -> B -> A used to put the values back where they were and revive the plan.
await select('M 31')
await page.waitForTimeout(1200)
check('returning to the original selection does not revive the void proposal',
  await page.getAttribute('[data-swe-action="run-proposal"]', 'disabled') !== null)
check('the void banner survives the return to the original selection',
  /作废|void/i.test(await page.textContent('[data-swe-proposal]')))

// And the guard is in the code, not just in the disabled attribute.
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.forceRunProposal())
await page.waitForTimeout(800)
const afterStale = await engine()
check('forcing a void proposal runs nothing',
  afterStale.atm === beforeStale.atm && Math.abs(afterStale.fov - beforeStale.fov) < 0.5,
  { atm: afterStale.atm, fov: afterStale.fov })
check('the refusal is explained to the user',
  /作废|void/i.test(await page.textContent('.swe-status')), await page.textContent('.swe-status'))
check('the void proposal is gone after the refusal',
  (await page.$$('[data-swe-proposal] .swe-cmd')).length === 0)

/* 10. explanation ------------------------------------------------------ */
await control({ mode: 'ok', delayMs: 0, text: 'FAKE-ANSWER-A' })
await select('M 31')
await page.waitForTimeout(700)
const chatBeforeExplain = (await stats()).chat
await explain()
await page.waitForSelector('[data-swe-ai-text]', { timeout: 20000 }).catch(() => {})
const explainText = await page.textContent('[data-swe-ai-text]').catch(() => '')
check('the explanation is rendered', /FAKE-ANSWER-A/.test(explainText), explainText.slice(0, 40))
check('exactly one model request was made for it', (await stats()).chat - chatBeforeExplain === 1)
check('the AI text is labelled as generated and possibly wrong',
  /可能有误|may be wrong/i.test(await page.textContent('.swe-ai-label')))
check('engine data and AI text live in separate blocks',
  (await page.$('.swe-sel')) !== null && (await page.$('.swe-ai-text')) !== null)

/* 11. A -> B -> A must not show the first answer again ----------------- */
await control({ delayMs: 2500, text: 'ANSWER-SLOW-A' })
await select('M 31')
await explain()
await page.waitForTimeout(200)
await control({ delayMs: 0, text: 'ANSWER-FAST-B' })
await select('* alf Ori')
await explain()
await page.waitForTimeout(4000)
const aba = await page.textContent('[data-swe-ai-text]').catch(() => '')
check('the newest answer wins and the late one is dropped',
  /ANSWER-FAST-B/.test(aba) && !/ANSWER-SLOW-A/.test(aba), aba.slice(0, 40))

/* 12. explanation marked stale when the sky moves ---------------------- */
await control({ delayMs: 0, text: 'ANSWER-C' })
await select('M 31')
await explain()
await page.waitForSelector('[data-swe-ai-text]', { timeout: 20000 }).catch(() => {})
const staleBefore = await page.getAttribute('[data-swe-ai-text]', 'data-swe-explanation-stale')
await page.evaluate(() => {
  const stel = document.getElementById('app').__vue__.$stel
  stel.core.observer.utc = Date.parse('2026-10-30T18:00:00.000Z') / 86400000 + 40587.0
})
await page.waitForFunction(() => {
  const n = document.querySelector('[data-swe-ai-text]')
  return n && n.getAttribute('data-swe-explanation-stale') === 'true'
}, null, { timeout: 10000 }).catch(() => {})
const staleAfter = await page.getAttribute('[data-swe-ai-text]', 'data-swe-explanation-stale')
check('a fresh explanation is not marked stale', staleBefore === 'false', staleBefore)
check('an explanation is marked stale after the sky moves', staleAfter === 'true', staleAfter)
check('the stale answer is not silently rewritten',
  /ANSWER-C/.test(await page.textContent('[data-swe-ai-text]').catch(() => '')))

/* 13. error surfaces --------------------------------------------------- */
await control({ mode: 'malformed' })
await ask('关掉大气')
check('a non-JSON model reply is reported, not swallowed',
  /不是合法 JSON|not valid JSON/i.test(await page.textContent('[data-swe-ask-status]')),
  await page.textContent('[data-swe-ask-status]'))
await control({ mode: 'ok', delayMs: 0 })

await page.evaluate(() => { window.__SWE_AI_TIMEOUT_MS__ = 800 })
await control({ delayMs: 3000 })
await explain()
await page.waitForFunction(() => {
  const n = document.querySelector('.swe-status')
  return n && /超时|timed out/i.test(n.textContent)
}, null, { timeout: 10000 }).catch(() => {})
check('a timeout is reported to the user',
  /超时|timed out/i.test(await page.textContent('.swe-status')), await page.textContent('.swe-status'))
await control({ delayMs: 0 })
await page.evaluate(() => { delete window.__SWE_AI_TIMEOUT_MS__ })

/* 14. language switch preserves state ---------------------------------- */
await control({ delayMs: 0, text: 'ANSWER-D' })
await select('M 31')
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_fov', deg: 45 }))
await page.waitForTimeout(1200)
await explain()
await page.waitForFunction(() => {
  const n = document.querySelector('[data-swe-ai-text]')
  return n && /ANSWER-D/.test(n.textContent)
}, null, { timeout: 20000 }).catch(() => {})
const beforeLang = await engine()
const aiBefore = await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.getAiConfig())
await page.click('[data-swe-action="lang"]')
await page.waitForTimeout(900)
const afterLang = await engine()
const uiEn = await page.evaluate(() => ({
  lang: window.__SWE_ASSISTANT_TEST__.getLanguage(),
  title: document.querySelector('.swe-title').textContent,
  sections: Array.from(document.querySelectorAll('.swe-sec h3')).map((n) => n.textContent),
  ai: window.__SWE_ASSISTANT_TEST__.getAiConfig()
}))
check('the UI switches to English', uiEn.lang === 'en' && uiEn.title === 'Teaching Assistant', uiEn.title)
check('section headings switch too', uiEn.sections.includes('Current object'), uiEn.sections)
check('switching language keeps the selection', afterLang.sel === beforeLang.sel, { before: beforeLang.sel, after: afterLang.sel })
check('switching language keeps the site',
  Math.abs(afterLang.lat - beforeLang.lat) < 0.01 && Math.abs(afterLang.lng - beforeLang.lng) < 0.01,
  { before: beforeLang.lat, after: afterLang.lat })
check('switching language keeps the field of view', Math.abs(afterLang.fov - beforeLang.fov) < 0.5,
  { before: beforeLang.fov, after: afterLang.fov })
check('switching language keeps the observing time',
  Math.abs(Date.parse(afterLang.utc) - Date.parse(beforeLang.utc)) < 120000,
  { before: beforeLang.utc, after: afterLang.utc })
check('switching language keeps the AI settings',
  JSON.stringify(uiEn.ai) === JSON.stringify(aiBefore), { before: aiBefore, after: uiEn.ai })
check('an existing answer is not passed off as translated',
  /ANSWER-D/.test(await page.textContent('[data-swe-ai-text]').catch(() => '')),
  (await page.textContent('[data-swe-ai-text]').catch(() => '')).slice(0, 30))

// In English UI, a Chinese request must still be sent verbatim, while the
// instruction (and therefore the answer language) follows the UI choice.
await resetFake()
await showTab('sky')
await page.fill('.swe-ask', '关掉大气')
await page.click('[data-swe-action="ask"]')
await page.waitForFunction(() => {
  const n = document.querySelector('[data-swe-proposal] .swe-cmd')
  const s = document.querySelector('[data-swe-ask-status]')
  return !!n || (s && s.textContent && !/Parsing|正在解析/.test(s.textContent))
}, null, { timeout: 20000 }).catch(() => {})
const sent = (await stats()).lastBody
check('the user request is sent verbatim, not translated',
  !!(sent && sent.messages && sent.messages[1] && sent.messages[1].content === '关掉大气'),
  sent && sent.messages && sent.messages[1] && sent.messages[1].content)
check('the instruction follows the UI language',
  !!(sent && sent.messages && sent.messages[0] && /You convert a teacher request/.test(sent.messages[0].content)))
await page.click('[data-swe-action="discard-proposal"]').catch(() => {})

await page.click('[data-swe-action="lang"]')
await page.waitForTimeout(600)
const backZh = await page.evaluate(() => ({
  lang: window.__SWE_ASSISTANT_TEST__.getLanguage(),
  title: document.querySelector('.swe-title').textContent
}))
check('switching back restores Chinese', backZh.lang === 'zh' && backZh.title === '教学助手', backZh)

/* 14b. the host UI follows the panel language --------------------------- */
// The host has its own locale bundle (locales/zh.json) and a hook that the
// panel drives. "FOV"/"Stellarium Web" and object names are data or brand, so
// only the translated chrome is asserted here.
const hostChrome = async () => page.evaluate(() => {
  const bar = document.getElementById('app')
  const text = (bar ? bar.innerText : '').replace(/\s+/g, ' ')
  return { text, stored: localStorage.getItem('swe.uiLang') }
})
const hostZh = await hostChrome()
check('with the panel in Chinese the host chrome is Chinese too',
  /搜索|观测/.test(hostZh.text) && hostZh.stored === 'zh', hostZh.text.slice(0, 60))
await page.click('[data-swe-action="lang"]')
await page.waitForTimeout(700)
const hostEn = await hostChrome()
check('switching to English also switches the host UI',
  /Search|OBSERVE/.test(hostEn.text) && hostEn.stored === 'en', hostEn.text.slice(0, 60))
await page.click('[data-swe-action="lang"]')
await page.waitForTimeout(700)
const hostZh2 = await hostChrome()
check('switching back restores the host UI',
  /搜索|观测/.test(hostZh2.text) && hostZh2.stored === 'zh', hostZh2.text.slice(0, 60))

/* 14c. object naming: the measured grammar and the bridge fallback -------- */
// The engine's search is an exact, case-insensitive comparison against each
// object's designation. It has no fuzzy match, no Chinese table and no
// tolerance for a dropped space, so the bridge rewrites what the model (or a
// teacher) writes. Each case is [what is sent, the designation read back].
const namingCases = [
  ['NAME Jupiter', 'NAME Jupiter', 'the NAME form the prompt teaches for planets'],
  ['CON western Ori', 'NAME Ori', 'the CON western form the prompt teaches for constellations'],
  ['M 42', 'NAME Great Orion Nebula', 'a catalogue number with the space the engine requires'],
  ['木星', 'NAME Jupiter', 'a Chinese planet name the engine does not know'],
  ['猎户座', 'NAME Ori', 'a Chinese constellation name the engine does not know'],
  ['Jupiter', 'NAME Jupiter', 'a bare planet name, which the engine itself rejects'],
  ['M42', 'NAME Great Orion Nebula', 'a catalogue number with the space missing'],
  ['Orion', 'NAME Ori', 'an English constellation name, which the engine itself rejects']
]
for (const [sent, want, why] of namingCases) {
  await control({ mode: 'ok', delayMs: 0, text: null, commands: [{ type: 'select_object', name: sent, lock: false }] })
  await ask(sent)
  const proposed = await page.evaluate(() => {
    const p = window.__SWE_ASSISTANT_TEST__.getProposal()
    return p && p.items && p.items[0] ? p.items[0].cmd.name : null
  })
  await page.click('[data-swe-action="run-proposal"]')
  await page.waitForTimeout(700)
  const got = (await engine()).sel
  check('"' + sent + '" reaches the right object: ' + why,
    proposed === sent && got === want, { sent, proposed, got, want })
}

/* 14d. the naming reference ships with the panel and rides with the prompt - */
// The grammar is not allowed to live only in the panel's head: it is a file
// (naming-reference.js) that the loader injects before the panel, that any
// other agent can read, and that the panel pastes into every system message.
const wiring = await page.evaluate(() => {
  const tags = Array.from(document.querySelectorAll('script[data-swe-assistant]'))
    .filter((s) => s.getAttribute('data-swe-assistant') === 'reference')
    .map((s) => s.getAttribute('src') || '')
  const ref = window.SWE_NAMING_REFERENCE
  const viaBridge = window.__SWE_AI_BRIDGE__.namingReference()
  return {
    refTags: tags,
    order: Array.from(document.querySelectorAll('script[data-swe-assistant]'))
      .map((s) => s.getAttribute('data-swe-assistant')),
    hasGlobal: !!ref,
    version: ref && ref.version,
    bridgeConstellations: viaBridge ? viaBridge.constellations.length : -1,
    bridgePromptZh: viaBridge ? viaBridge.prompt.zh.length : -1,
    enHasHeading: !!(ref && /case-insensitive, space-sensitive/.test(ref.toPrompt('en'))),
    compactChars: ref ? ref.toPrompt('zh').length : -1,
    fullChars: ref ? ref.toPrompt('zh', { level: 'full' }).length : -1,
    fullHasTable: !!(ref && /UMi 小熊座 Ursa Minor/.test(ref.toPrompt('zh', { level: 'full' }))),
    grammarKinds: ref ? Object.keys(ref.grammar || {}).length : -1
  }
})
check('the references are injected as their own scripts, ahead of the panel (0.14.0 adds sky-targets)',
  wiring.refTags.length === 2 && /naming-reference\.js/.test(wiring.refTags[0]) &&
  /sky-targets\.js/.test(wiring.refTags[1]) &&
  wiring.order.indexOf('reference') === 0, wiring)
check('any agent in the page can read the reference',
  wiring.hasGlobal && /^\d+\.\d+\.\d+$/.test(wiring.version || ''), wiring.version)
check('the bridge hands the same reference to other agents',
  wiring.bridgeConstellations === 88 && wiring.bridgePromptZh > 600, wiring)
check('the reference renders an English prompt as well', wiring.enHasHeading)
check('the reference states the grammar as four regexes, not prose',
  wiring.grammarKinds === 4, wiring.grammarKinds)
check('the compact block is a fraction of the full one',
  wiring.compactChars > 600 && wiring.compactChars < wiring.fullChars * 0.4,
  { compact: wiring.compactChars, full: wiring.fullChars })
check('the full block still exists for models that need the tables',
  wiring.fullHasTable && wiring.fullChars > 3000, wiring.fullChars)

await control({ mode: 'ok', delayMs: 0, text: null, commands: [{ type: 'select_object', name: 'NAME Jupiter', lock: false }] })
await ask('看看木星')
await page.waitForTimeout(500)
const sentStats = await stats()
const sysPrompt = (sentStats.lastBody && sentStats.lastBody.messages && sentStats.lastBody.messages[0] &&
  sentStats.lastBody.messages[0].content) || ''
check('the prompt sent to the model carries every measured shape',
  ['NAME Jupiter', 'CON western Ori', '* alf Ori', 'M 31', 'object_not_found'].every((s) => sysPrompt.includes(s)),
  sysPrompt.length)
check('the prompt states each shape as a regex a model can check itself against',
  ['^NAME [A-Za-z]+$', '^CON western [A-Z][A-Za-z]{2}$'].every((s) => sysPrompt.includes(s)))
check('the prompt is the compact block, not the table-heavy one, and not the fallback',
  sysPrompt.length > 900 && sysPrompt.length < 3000 && !/```/.test(sysPrompt), { chars: sysPrompt.length })
check('the prompt keeps the request and the command spec too',
  sysPrompt.includes('看看木星') && sysPrompt.includes('set_fov'))

// The reference is an extra file; a broken install, a stripped package or a
// 404 must degrade to the panel's own short rules, not to a prompt with no
// naming guidance at all. Simulated here by hiding the global for one call.
await page.evaluate(() => { window.__SWE_NAMING_SAVED__ = window.SWE_NAMING_REFERENCE; delete window.SWE_NAMING_REFERENCE })
await ask('看看木星')
await page.waitForTimeout(500)
const fallbackStats = await stats()
const fallbackPrompt = (fallbackStats.lastBody && fallbackStats.lastBody.messages &&
  fallbackStats.lastBody.messages[0] && fallbackStats.lastBody.messages[0].content) || ''
await page.evaluate(() => { window.SWE_NAMING_REFERENCE = window.__SWE_NAMING_SAVED__; delete window.__SWE_NAMING_SAVED__ })
check('with no reference the panel still teaches the four shapes',
  ['NAME Jupiter', 'CON western Ori', 'M 31'].every((x) => fallbackPrompt.includes(x)) &&
  fallbackPrompt.length > 500, fallbackPrompt.length)
check('the fallback is the short one, and the reference is back afterwards',
  fallbackPrompt.length < sysPrompt.length &&
  (await page.evaluate(() => !!window.SWE_NAMING_REFERENCE)),
  { fallback: fallbackPrompt.length, full: sysPrompt.length })

/* 14e. R1 — a proposal is bound to the sky it was written for ------------- */
// The frozen context is captured when the request is SENT. Waiting for a slow
// model while the teacher selects something else must invalidate the answer,
// not silently attach it to the new selection.
await page.click('[data-swe-action="discard-proposal"]').catch(() => {})
await control({ mode: 'ok', delayMs: 0, text: null, commands: null })
await select('M 31')
await page.waitForTimeout(600)
await control({ delayMs: 1800, text: null, commands: [{ type: 'set_layer', layer: 'atmosphere', visible: false }] })
await showTab('sky')
await page.fill('.swe-ask', '关掉大气')
await page.click('[data-swe-action="ask"]')
await page.waitForTimeout(300)
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'select_object', name: '* alf Ori', lock: false }))
await page.waitForSelector('[data-swe-proposal] .swe-cmd', { timeout: 20000 }).catch(() => {})
const ctxWarn = await page.textContent('[data-swe-ask-status]').catch(() => '')
check('a proposal answered late names what moved while it was in flight',
  /变了|变化|changed/i.test(ctxWarn) && /天体|object/i.test(ctxWarn), ctxWarn)
const beforeCtxRun = await engine()
check('a proposal written for the previous selection is disabled before it can run',
  await page.getAttribute('[data-swe-action="run-proposal"]', 'disabled') !== null)
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.forceRunProposal())
await page.waitForTimeout(1200)
const afterCtxRun = await engine()
check('a proposal written for the previous selection is refused',
  afterCtxRun.atm === beforeCtxRun.atm, { atm: afterCtxRun.atm })
check('the refusal says the batch is void',
  /作废|void/i.test(await page.textContent('.swe-status')), await page.textContent('.swe-status'))

// The same must hold when only the clock moved (no selection change at all).
await control({ delayMs: 0 })
await ask('关掉大气')
const beforeTimeRun = await engine()
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({
  type: 'set_time', utc: '2026-11-05T12:00:00.000Z'
}))
await page.waitForTimeout(600)
check('a proposal written for another observing time is disabled',
  await page.getAttribute('[data-swe-action="run-proposal"]', 'disabled') !== null)
await page.evaluate(() => window.__SWE_ASSISTANT_TEST__.forceRunProposal())
await page.waitForTimeout(1200)
const afterTimeRun = await engine()
check('a proposal written for another observing time is refused',
  afterTimeRun.atm === beforeTimeRun.atm, { atm: afterTimeRun.atm, utc: afterTimeRun.utc })
const timeWarn = await page.textContent('.swe-status')
check('the refusal names the observing time, not just "something changed"',
  /时间|time/i.test(timeWarn), timeWarn)

/* 14f. R1 — a whole batch is refused when one command is invalid ---------- */
// The old code executed the valid subset, which quietly replaced the model's
// plan with a different one.
await control({ mode: 'ok', delayMs: 0, text: null, commands: [
  { type: 'set_fov', deg: 32 },
  { type: 'open_the_dome', target: 'moon' }
] })
await select('M 31')
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_fov', deg: 45 }))
await page.waitForTimeout(900)
await ask('打开圆顶并调整视场')
const beforeInvalid = await engine()
await page.click('[data-swe-action="run-proposal"]')
await page.waitForTimeout(1200)
const afterInvalid = await engine()
check('an invalid command refuses the whole batch, not just itself',
  Math.abs(afterInvalid.fov - beforeInvalid.fov) < 0.5, { before: beforeInvalid.fov, after: afterInvalid.fov })
check('the refusal is explained to the user',
  /未通过本地校验|local validation/i.test(await page.textContent('[data-swe-ask-status]')),
  await page.textContent('[data-swe-ask-status]'))
await page.click('[data-swe-action="discard-proposal"]').catch(() => {})

/* 14g. R2 — "accepted but unverified" is not a success -------------------- */
// The bridge distinguishes applied from timeout. The batch must stop on the
// second one instead of reporting it as done and running a dependent command.
await control({ mode: 'ok', delayMs: 0, text: null, commands: [
  { type: 'set_layer', layer: 'atmosphere', visible: false },
  { type: 'set_time_speed', factor: 0 },
  { type: 'set_fov', deg: 12 }
] })
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_layer', layer: 'atmosphere', visible: true }))
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_fov', deg: 45 }))
await page.waitForTimeout(700)
await page.evaluate(() => {
  const b = window.__SWE_AI_BRIDGE__
  window.__SWE_ORIG_EXEC__ = b.executeCommand
  // A command the engine accepts but that cannot be verified in time.
  b.executeCommand = function (cmd) {
    if (cmd && cmd.type === 'set_time_speed') {
      return Promise.resolve({ ok: true, status: 'timeout', command: cmd.type, readback: { factor: cmd.factor } })
    }
    return window.__SWE_ORIG_EXEC__.call(b, cmd)
  }
})
await ask('关掉大气并让时间停下来')
await page.click('[data-swe-action="run-proposal"]')
await page.waitForFunction(() => {
  const n = document.querySelector('[data-swe-ask-status]')
  return n && /未验证|not counted as done|unverified/i.test(n.textContent)
}, null, { timeout: 15000 }).catch(() => {})
const afterTimeout = await engine()
const timeoutText = await page.textContent('[data-swe-ask-status]')
check('a timed-out command is reported as unverified, not as success',
  /未验证|not counted as done/i.test(timeoutText) && /timeout/i.test(timeoutText), timeoutText.slice(0, 120))
check('the commands after a timed-out one are not sent',
  Math.abs(afterTimeout.fov - 45) < 0.5, afterTimeout.fov)
check('the timeout did not silently replay the batch',
  !/1 条成功|1 succeeded/.test(timeoutText), timeoutText.slice(0, 80))
await page.evaluate(() => { window.__SWE_AI_BRIDGE__.executeCommand = window.__SWE_ORIG_EXEC__ })

/* 14g2. R2b — the batch's own rate change is not an outside clock change -- */
// The clock keeps running at the old rate until set_time_speed lands, so the
// interval that follows it is explained by two rates, not one. Checking the
// whole interval at the new rate made "pause, then reframe" look like an
// outside change and stopped the batch at command two - or, when the rate
// change was last, reported a failure instead of a finished batch.
const doneText = (s) => /执行完成|Done:/.test(s)
const cleanDone = async (label, commands, setup, expectFov) => {
  await page.click('[data-swe-action="discard-proposal"]').catch(() => {})
  await control({ mode: 'ok', delayMs: 0, text: null, commands })
  await page.evaluate((c) => window.__SWE_AI_BRIDGE__.executeCommand(c), setup)
  await page.waitForTimeout(1300)
  await ask(label)
  const preRunNote = await page.textContent('[data-swe-ask-status]').catch(() => '')
  if (preRunNote && preRunNote.trim()) console.log('#   before run: ' + preRunNote.slice(0, 160))
  await page.click('[data-swe-action="run-proposal"]')
  await page.waitForFunction(() => {
    const n = document.querySelector('[data-swe-ask-status]')
    return n && (/执行完成|Done:/.test(n.textContent) || /中途|outside|变化/.test(n.textContent))
  }, null, { timeout: 15000 }).catch(() => {})
  const text = await page.textContent('[data-swe-ask-status]')
  const after = await engine()
  check('"' + label + '": the batch finishes instead of blaming an outside change',
    doneText(text), text.slice(0, 120))
  check('"' + label + '": every command in it ran',
    Math.abs(after.fov - expectFov) < 0.5, { fov: after.fov, want: expectFov })
}

// The sky is already moving at a real rate, and the batch pauses it.
// The premise fix the round-1 review reply pre-approved: the ASK happens
// while the clock runs, and at 3600x a single slow render frame (SwiftShader,
// machine load) reads as a clock JUMP, so the proposal was invalidated before
// the batch could own its rate change. 30x keeps the same semantics - clock
// running, batch changes the rate itself - with the jump floor (2 s of sim
// time) absorbing realistic render lag.
await cleanDone('让时间停下来，再把视场调到 30 度', [
  { type: 'set_time_speed', factor: 0 },
  { type: 'set_fov', deg: 30 }
], { type: 'set_time_speed', factor: 30 }, 30)

// Still moving, and the batch reverses it as its LAST command: the check that
// used to run after the final command reported a failure for a finished batch.
await cleanDone('视场调到 12 度，然后让时间倒着走', [
  { type: 'set_fov', deg: 12 },
  { type: 'set_time_speed', factor: -60 }
], { type: 'set_time_speed', factor: 30 }, 12)

// Paused, and the batch starts the clock again at another rate.
await cleanDone('把视场调到 20 度，再用 7200 倍跑起来', [
  { type: 'set_fov', deg: 20 },
  { type: 'set_time_speed', factor: 7200 }
], { type: 'set_time_speed', factor: 0 }, 20)
// 14g3. High-speed jump boundary (review round 2, evidence note 5): the
// premise fix above asks at 30x; this case independently checks that at
// 3600x a REAL clock jump - a bridge set_time, which owns its jump - is
// still counted and visible, so the lower ask rate did not move the
// detection boundary.
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_time_speed', factor: 3600 }))
await page.waitForTimeout(600)
const jumps0 = await page.evaluate(() => window.__SWE_AI_BRIDGE__.readState().time.jumps)
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_time', utc: '2026-11-07T13:00:00.000Z' }))
await page.waitForTimeout(600)
const jumps1 = await page.evaluate(() => window.__SWE_AI_BRIDGE__.readState().time.jumps)
check('at 3600x a real clock jump is still counted (the boundary did not move)',
  jumps1 > jumps0, { jumps0, jumps1 })

// Leave the clock where the rest of the suite expects it.
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_time_speed', factor: 0 }))
await page.waitForTimeout(400)

/* 14h. R3 — discarding a running batch stops the rest -------------------- */
await control({ mode: 'ok', delayMs: 0, text: null, commands: [
  { type: 'set_fov', deg: 30 },
  { type: 'set_fov', deg: 12 }
] })
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_fov', deg: 45 }))
await page.waitForTimeout(700)
await page.evaluate(() => {
  const b = window.__SWE_AI_BRIDGE__
  window.__SWE_ORIG_EXEC__ = b.executeCommand
  window.__SWE_EXEC_CALLS__ = []
  // Slow enough that the discard button can be pressed mid-batch.
  b.executeCommand = function (cmd) {
    window.__SWE_EXEC_CALLS__.push(cmd && cmd.type)
    return window.__SWE_ORIG_EXEC__.call(b, cmd)
      .then((r) => new Promise((resolve) => setTimeout(() => resolve(r), 900)))
  }
})
await ask('把视场调到 30 度再调到 12 度')
await page.click('[data-swe-action="run-proposal"]')
await page.waitForTimeout(250)
await page.click('[data-swe-action="discard-proposal"]')
await page.waitForTimeout(2500)
const calls = await page.evaluate(() => window.__SWE_EXEC_CALLS__ || [])
check('discarding mid-batch sends no further command', calls.length === 1, calls)
check('the cancel message says what was already sent',
  /取消|Cancel/i.test(await page.textContent('[data-swe-ask-status]')),
  await page.textContent('[data-swe-ask-status]'))
await page.evaluate(() => { window.__SWE_AI_BRIDGE__.executeCommand = window.__SWE_ORIG_EXEC__ })

/* 14i. R5 — the timeout covers the body, not only the headers ------------ */
await page.evaluate(() => { window.__SWE_AI_TIMEOUT_MS__ = 900 })
await control({ mode: 'stallBody' })
await showTab('sky')
await page.fill('.swe-ask', '关掉大气')
await page.click('[data-swe-action="ask"]')
await page.waitForFunction(() => {
  const n = document.querySelector('[data-swe-ask-status]')
  return n && /超时|timed out/i.test(n.textContent)
}, null, { timeout: 8000 }).catch(() => {})
const stalled = await page.textContent('[data-swe-ask-status]')
check('a reply whose body stalls is cancelled by the timeout',
  /超时|timed out/i.test(stalled), stalled)
check('the panel does not stay in "parsing" forever',
  !/正在解析|Parsing/i.test(stalled), stalled)
await control({ mode: 'ok', delayMs: 0 })
await page.evaluate(() => { delete window.__SWE_AI_TIMEOUT_MS__ })

/* 14j. R7 — editing the endpoint invalidates in-flight answers ----------- */
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'select_object', name: 'M 31', lock: false }))
await page.waitForTimeout(700)
await control({ delayMs: 2200, text: 'ANSWER-OLD-ENDPOINT' })
await explain()
await page.waitForTimeout(400)
await configureAi({ baseUrl: FAKE + '/alt/v1' })
await page.waitForTimeout(3000)
const afterSwitch = await page.textContent('[data-swe-ai-text]').catch(() => '')
check('an answer for the previous endpoint is dropped after a settings change',
  !/ANSWER-OLD-ENDPOINT/.test(afterSwitch), afterSwitch.slice(0, 40))

await control({ delayMs: 2200, text: 'ANSWER-AFTER-CLEAR' })
await explain()
await page.waitForTimeout(400)
await showTab('ai')
await page.click('[data-swe-action="ai-clear"]')
await page.waitForTimeout(3000)
check('clearing the settings drops an answer already in flight',
  !/ANSWER-AFTER-CLEAR/.test(await page.textContent('.swe-panel')), 'text found')
await configureAi()
await control({ delayMs: 0, text: null, mode: 'ok' })

/* 14k. R1b — a range or enum error is caught before the batch starts ------ */
// Structural checking only looked at the type and the field names, so
// `set_fov {deg: 999}` and an unknown layer looked valid in the preview: the
// first command ran, and the second only failed once it reached the bridge.
// The preview now asks the bridge's own validator, so the whole batch is
// refused before anything is written.
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_layer', layer: 'atmosphere', visible: true }))
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_fov', deg: 45 }))
await page.waitForTimeout(900)
await select('M 31')
await page.waitForTimeout(500)

await control({ mode: 'ok', delayMs: 0, text: null, commands: [
  { type: 'set_layer', layer: 'atmosphere', visible: false },
  { type: 'set_fov', deg: 999 }
] })
await ask('关掉大气，视场跳到 999 度')
const rangePreview = await page.textContent('[data-swe-proposal]')
check('an out-of-range value is marked in the preview',
  (await page.$$('[data-swe-proposal] .swe-cmd-bad')).length === 1, rangePreview.slice(0, 120))
check('the preview says the value is out of range',
  /范围|range/i.test(rangePreview), rangePreview.slice(0, 160))
const beforeRangeRun = await engine()
await page.click('[data-swe-action="run-proposal"]')
await page.waitForTimeout(1200)
const afterRangeRun = await engine()
check('an illegal command late in the batch stops the legal one before it',
  afterRangeRun.atm === beforeRangeRun.atm && Math.abs(afterRangeRun.fov - beforeRangeRun.fov) < 0.5,
  { atm: afterRangeRun.atm, fov: afterRangeRun.fov, wasAtm: beforeRangeRun.atm })
check('the refusal is reported as a local validation failure',
  /未通过本地校验|local validation/i.test(await page.textContent('[data-swe-ask-status]')),
  await page.textContent('[data-swe-ask-status]'))
await page.click('[data-swe-action="discard-proposal"]').catch(() => {})

await control({ mode: 'ok', delayMs: 0, text: null, commands: [
  { type: 'set_fov', deg: 30 },
  { type: 'set_layer', layer: 'aurora', visible: true }
] })
await ask('视场 30 度，打开极光层')
const layerPreview = await page.textContent('[data-swe-proposal]')
check('an unknown layer is caught in the preview',
  /图层|layer/i.test(layerPreview) &&
  (await page.$$('[data-swe-proposal] .swe-cmd-bad')).length === 1, layerPreview.slice(0, 160))
await page.click('[data-swe-action="discard-proposal"]').catch(() => {})

await control({ mode: 'ok', delayMs: 0, text: null, commands: [
  { type: 'set_fov', deg: 30 },
  { type: 'set_layer', layer: 'atmosphere', visible: 'yes' }
] })
await ask('视场 30 度，大气 visible 写 yes')
const typePreview = await page.textContent('[data-swe-proposal]')
check('a non-boolean visible is caught in the preview',
  /true 或 false|boolean/i.test(typePreview) &&
  (await page.$$('[data-swe-proposal] .swe-cmd-bad')).length === 1, typePreview.slice(0, 160))
await page.click('[data-swe-action="discard-proposal"]').catch(() => {})

/* 14l. R7b — changing the AI settings mid-batch stops the batch ----------- */
// Editing the endpoint cleared proposalBusy, which unlocked the confirm button
// while the batch's own closure kept sending the rest of the plan.
await control({ mode: 'ok', delayMs: 0, text: null, commands: [
  { type: 'set_fov', deg: 30 },
  { type: 'set_fov', deg: 12 },
  { type: 'set_fov', deg: 20 }
] })
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_fov', deg: 45 }))
await page.waitForTimeout(800)
await page.evaluate(() => {
  const b = window.__SWE_AI_BRIDGE__
  window.__SWE_ORIG_EXEC__ = b.executeCommand
  window.__SWE_EXEC_CALLS__ = []
  b.executeCommand = function (cmd) {
    window.__SWE_EXEC_CALLS__.push(cmd && cmd.type)
    return window.__SWE_ORIG_EXEC__.call(b, cmd)
      .then((r) => new Promise((resolve) => setTimeout(() => resolve(r), 900)))
  }
})
await ask('视场调到 30 度，再 12 度，再 20 度')
await page.click('[data-swe-action="run-proposal"]')
await page.waitForTimeout(250)
await configureAi({ baseUrl: FAKE + '/alt/v1' })
await page.waitForTimeout(3200)
const callsCfg = await page.evaluate(() => window.__SWE_EXEC_CALLS__ || [])
check('changing the AI settings mid-batch sends no further command', callsCfg.length === 1, callsCfg)
const cfgStopText = await page.textContent('[data-swe-ask-status]')
check('the stop says the batch was cancelled and how many went out',
  /已停止|stopped/i.test(cfgStopText) && /1/.test(cfgStopText), cfgStopText.slice(0, 120))
check('the confirm button is not left unlocked for a re-run',
  (await page.$$('[data-swe-proposal] .swe-cmd')).length === 0)
await page.evaluate(() => { window.__SWE_AI_BRIDGE__.executeCommand = window.__SWE_ORIG_EXEC__ })
await configureAi()
await page.waitForTimeout(300)

/* 14m. R1c — an outside change during a command stops the rest ------------ */
// The selection changed while command 1 was animating. Re-anchoring after the
// command would have adopted that selection as if the batch had made it.
await control({ mode: 'ok', delayMs: 0, text: null, commands: [
  { type: 'set_fov', deg: 30 },
  { type: 'set_fov', deg: 12 },
  { type: 'set_fov', deg: 20 }
] })
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_fov', deg: 45 }))
await page.waitForTimeout(800)
await page.evaluate(() => {
  const b = window.__SWE_AI_BRIDGE__
  window.__SWE_ORIG_EXEC__ = b.executeCommand
  window.__SWE_EXEC_CALLS__ = []
  b.executeCommand = function (cmd) {
    window.__SWE_EXEC_CALLS__.push(cmd && cmd.type)
    return window.__SWE_ORIG_EXEC__.call(b, cmd)
      .then((r) => new Promise((resolve) => setTimeout(() => resolve(r), 900)))
  }
})
await ask('视场调到 30 度，再 12 度，再 20 度')
await page.click('[data-swe-action="run-proposal"]')
await page.waitForTimeout(250)
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'select_object', name: '* alf Ori', lock: false }))
await page.waitForTimeout(3200)
const callsOutside = (await page.evaluate(() => window.__SWE_EXEC_CALLS__ || []))
  // The test itself sends a select_object through the same wrapper, so only
  // the batch's own commands are counted here.
  .filter((t) => t === 'set_fov')
check('an outside change mid-batch sends no further command', callsOutside.length === 1, callsOutside)
const outsideText = await page.textContent('[data-swe-ask-status]')
check('the stop names the outside change', /外部|outside|changed|变化/i.test(outsideText), outsideText.slice(0, 120))
await page.evaluate(() => { window.__SWE_AI_BRIDGE__.executeCommand = window.__SWE_ORIG_EXEC__ })
await control({ mode: 'ok', delayMs: 0, text: null, commands: null })

/* 14m2. a different view during a command stops the rest ------------------ */
// The plan is bound to the view it was written for. contextChanges() has always
// compared the view id; the check that runs after each command did not, so a
// host that swapped the view while a command was animating had the new view
// adopted by the re-anchor and the rest of the plan applied to it.
await control({ mode: 'ok', delayMs: 0, text: null, commands: [
  { type: 'set_fov', deg: 30 },
  { type: 'set_fov', deg: 12 }
] })
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_fov', deg: 45 }))
await page.waitForTimeout(600)
await page.evaluate(() => {
  const b = window.__SWE_AI_BRIDGE__
  window.__SWE_ORIG_EXEC__ = b.executeCommand
  window.__SWE_ORIG_READ__ = b.readState
  window.__SWE_EXEC_CALLS__ = []
  b.executeCommand = function (cmd) {
    window.__SWE_EXEC_CALLS__.push(cmd && cmd.type)
    return window.__SWE_ORIG_EXEC__.call(b, cmd)
      .then((r) => new Promise((resolve) => setTimeout(() => resolve(r), 900)))
  }
})
await ask('视场调到 30 度，再 12 度')
await page.click('[data-swe-action="run-proposal"]')
await page.waitForTimeout(200)
await page.evaluate(() => {
  const b = window.__SWE_AI_BRIDGE__
  // Only the published method is replaced; the loader keeps reading the real
  // engine through its own closure, so this is a host whose view id changed.
  b.readState = function () {
    const st = window.__SWE_ORIG_READ__.call(b)
    return st ? Object.assign({}, st, { viewId: 'view-somewhere-else' }) : st
  }
})
await page.waitForTimeout(2600)
const callsView = (await page.evaluate(() => window.__SWE_EXEC_CALLS__ || []))
  .filter((t) => t === 'set_fov')
check('a view that changed mid-batch sends no further command', callsView.length === 1, callsView)
check('the stop names the view',
  /视图|view/i.test(await page.textContent('[data-swe-ask-status]')),
  (await page.textContent('[data-swe-ask-status]')).slice(0, 120))
await page.evaluate(() => {
  window.__SWE_AI_BRIDGE__.executeCommand = window.__SWE_ORIG_EXEC__
  window.__SWE_AI_BRIDGE__.readState = window.__SWE_ORIG_READ__
})
await control({ mode: 'ok', delayMs: 0, text: null, commands: null })

/* 14m3. an outside clock jump during a rate change is not hidden by it ----- */
// The batch's own set_time_speed has to be allowed a wide band of clock
// movement: the switch happens at an instant the panel cannot observe. That
// allowance used to cover the whole command, so a teacher jumping the clock in
// the same window was adopted instead of stopping the batch. The bridge now
// counts foreign jumps frame by frame, so the allowance is one frame of sky.
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_time_speed', factor: 0 }))
await page.waitForTimeout(400)
await control({ mode: 'ok', delayMs: 0, text: null, commands: [
  { type: 'set_time_speed', factor: 3600 },
  { type: 'set_fov', deg: 22 }
] })
await ask('用 3600 倍跑起来，然后把视场调到 22 度')
await page.evaluate(() => {
  const b = window.__SWE_AI_BRIDGE__
  window.__SWE_ORIG_EXEC__ = b.executeCommand
  window.__SWE_EXEC_CALLS__ = []
  b.executeCommand = function (cmd) {
    window.__SWE_EXEC_CALLS__.push(cmd && cmd.type)
    return window.__SWE_ORIG_EXEC__.call(b, cmd)
      .then((r) => new Promise((resolve) => setTimeout(() => resolve(r), 900)))
  }
})
await page.click('[data-swe-action="run-proposal"]')
await page.waitForTimeout(200)
const jumped = await page.evaluate(() => {
  const stel = document.getElementById('app').__vue__.$stel
  // +30 minutes of sky, written straight into the engine: this is the host's
  // own time control, not a command from the panel.
  stel.core.observer.utc = stel.core.observer.utc + (30 / 1440)
  return stel.core.observer.utc
})
await page.waitForTimeout(2600)
const callsJump = await page.evaluate(() => window.__SWE_EXEC_CALLS__ || [])
check('an outside jump during a rate change sends no further command',
  callsJump.filter((t) => t === 'set_fov').length === 0, callsJump)
const jumpText = await page.textContent('[data-swe-ask-status]')
check('the stop names the observing time', /观测时间|observing time/i.test(jumpText), jumpText.slice(0, 120))
check('the jump was not adopted as part of the batch',
  Math.abs((await engine()).fov - 22) > 0.5, { jumped, fov: (await engine()).fov })
await page.evaluate(() => { window.__SWE_AI_BRIDGE__.executeCommand = window.__SWE_ORIG_EXEC__ })
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_time_speed', factor: 0 }))
await control({ mode: 'ok', delayMs: 0, text: null, commands: null })

/* 14m4. a batch's own set_time is not a jump it made for itself ---------- */
// The bridge used to notice a jump on the frame after the write, i.e. after the
// command had returned and the batch had re-anchored its context. A batch of
// "set the date, then animate" was therefore stopped by its own first command:
// the late signal looked like somebody else moving the clock. The write is now
// counted inside the command, so the batch survives - and the counter still
// moves by exactly one, because counting is not the same as hiding.
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_time_speed', factor: 0 }))
await page.waitForTimeout(500)
const ownTime = await page.evaluate(() => {
  const st = window.__SWE_AI_BRIDGE__.readState()
  return { utc: st.time.utc, jumps: st.time.jumps }
})
await control({ mode: 'ok', delayMs: 0, text: null, commands: [
  { type: 'set_time', utc: '2026-01-15T20:00:00Z' },
  { type: 'set_fov', deg: 22 },
  { type: 'set_fov', deg: 40 }
] })
await ask('把观测时间设到 2026 年 1 月 15 日 20 点，然后把视场调到 22 度，再 40 度')
await page.evaluate(() => {
  const b = window.__SWE_AI_BRIDGE__
  window.__SWE_ORIG_EXEC__ = b.executeCommand
  window.__SWE_EXEC_CALLS__ = []
  b.executeCommand = function (cmd) {
    window.__SWE_EXEC_CALLS__.push(cmd && cmd.type)
    return window.__SWE_ORIG_EXEC__.call(b, cmd)
  }
})
await page.click('[data-swe-action="run-proposal"]')
await page.waitForTimeout(5200)
const callsOwn = await page.evaluate(() => window.__SWE_EXEC_CALLS__ || [])
check('a batch that sets the time itself runs every command',
  callsOwn.filter((t) => t === 'set_fov').length === 2, callsOwn)
check('its last command was applied, not dropped',
  Math.abs((await engine()).fov - 40) < 0.5, { fov: (await engine()).fov })
const ownTimeText = await page.textContent('[data-swe-ask-status]')
check('the batch ends as finished rather than stopped mid-run',
  /完成|done/i.test(ownTimeText) && !/停止|stopped/i.test(ownTimeText), ownTimeText.slice(0, 120))
const jumpsAfter = await page.evaluate(() => window.__SWE_AI_BRIDGE__.readState().time.jumps)
check('the write was counted once, not swallowed',
  typeof ownTime.jumps === 'number' && jumpsAfter === ownTime.jumps + 1,
  { before: ownTime.jumps, after: jumpsAfter })
await page.evaluate(() => { window.__SWE_AI_BRIDGE__.executeCommand = window.__SWE_ORIG_EXEC__ })
await page.evaluate((utc) => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_time', utc }), ownTime.utc)
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'set_time_speed', factor: 0 }))
await control({ mode: 'ok', delayMs: 0, text: null, commands: null })

/* 14n. an explanation does not survive a selection round trip ------------ */
// A -> B -> A leaves the panel on the object the answer is about, but the
// answer was written while the teacher had already moved on. Dropping it is
// the only honest option: the request predates the round trip.
await control({ delayMs: 1600, text: 'ANSWER-FOR-FIRST-VISIT' })
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'select_object', name: 'M 31', lock: false }))
await page.waitForTimeout(800)
await explain()
await page.waitForTimeout(300)
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'select_object', name: '* alf Ori', lock: false }))
await page.waitForTimeout(400)
await page.evaluate(() => window.__SWE_AI_BRIDGE__.executeCommand({ type: 'select_object', name: 'M 31', lock: false }))
await page.waitForTimeout(3000)
check('an explanation that spans a selection change is dropped',
  !/ANSWER-FOR-FIRST-VISIT/.test(await page.textContent('.swe-panel')),
  (await page.textContent('.swe-panel')).slice(0, 80))
check('the panel says why the explanation was dropped',
  /选择变过|selection changed/i.test(await page.textContent('.swe-status')),
  await page.textContent('.swe-status'))
await control({ delayMs: 0, text: null, mode: 'ok' })

/* 15. remember / clear settings ---------------------------------------- */
await showTab('ai')
const storedBefore = await page.evaluate(() => localStorage.getItem('swe-assistant.ai'))
check('settings are not persisted while "remember" is off', storedBefore === null, storedBefore)
await page.check('.swe-ai-remember')
await page.waitForTimeout(300)
const storedOn = await page.evaluate(() => localStorage.getItem('swe-assistant.ai'))
check('ticking "remember" persists the settings', !!storedOn && /fake-teacher/.test(storedOn))
check('the storage risk is stated before opting in',
  /localStorage|公共电脑|shared machine/i.test(await page.textContent('.swe-ai .swe-placeholder')))
await page.click('[data-swe-action="ai-clear"]')
await page.waitForTimeout(400)
const storedAfter = await page.evaluate(() => localStorage.getItem('swe-assistant.ai'))
check('clearing removes the stored settings', storedAfter === null, storedAfter)
check('clearing resets the form', (await page.inputValue('.swe-ai-url')) === '')

/* 16. console hygiene -------------------------------------------------- */
check('no unexpected console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3))

/* 17. the language does not come from the browser ---------------------- */
// Last, because reloading drops the in-memory AI settings used above. This
// page clears localStorage on every navigation (see addInitScript), so after
// the reload we are looking at the *default*: an English-language browser and
// no stored choice must still produce a Chinese host and a Chinese panel.
// `swe.uiLang` is written back by the panel itself when it applies the host
// language at startup, so the assertion is "nothing English was stored", not
// "nothing was stored".
const browserLang = await page.evaluate(() => navigator.language)
await page.reload({ waitUntil: 'load' })
await page.waitForSelector('[data-swe-action="lang"]', { timeout: 30000 })
await page.waitForTimeout(1200)
const afterReload = await page.evaluate(() => ({
  stored: localStorage.getItem('swe.uiLang'),
  host: (document.getElementById('app') || {}).innerText || '',
  lang: window.__SWE_ASSISTANT_TEST__.getLanguage()
}))
check('a fresh session defaults to Chinese even in an English browser',
  /^en/i.test(browserLang) && afterReload.stored !== 'en' && afterReload.lang === 'zh' &&
  /搜索|观测/.test(afterReload.host),
  { browserLang, stored: afterReload.stored, lang: afterReload.lang,
    host: afterReload.host.replace(/\s+/g, ' ').slice(0, 50) })

/* 18. R6 — site, time zone and language survive a reload ----------------- */
// A separate browser context on purpose: the page above clears localStorage on
// every navigation (test 17 needs a virgin session), which is exactly what this
// test must NOT do. Without a reload this is only a same-page switch, and it
// was a same-page switch that hid the bug: loadPrefs() existed but nothing
// called it, so every reload re-applied Shanghai and saved it over the choice.
const persistCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
const pp = await persistCtx.newPage()
await pp.route('**://fonts.googleapis.com/**', (r) => r.abort())
await pp.route('**://fonts.gstatic.com/**', (r) => r.abort())
const persistErrors = []
pp.on('pageerror', (e) => persistErrors.push(e.message))
const waitEngine = (p) => p.waitForFunction(() => {
  const e = document.getElementById('app')
  const s = e && e.__vue__ && e.__vue__.$stel
  try { return !!(s && s.getObj('M 31')) } catch (_) { return false }
}, null, { timeout: 90000 })

await pp.goto(URL_, { waitUntil: 'load' })
await pp.waitForSelector('[data-swe-assistant="panel"]', { timeout: 60000 })
await waitEngine(pp)
await pp.waitForTimeout(1500)

await pp.evaluate(() => window.__SWE_ASSISTANT_TEST__.showTab('view'))
await pp.fill('.swe-lat', '48.8566')
await pp.fill('.swe-lng', '2.3522')
await pp.click('[data-i18n="loc.apply"]')
await pp.waitForTimeout(1500)
await pp.evaluate(() => window.__SWE_ASSISTANT_TEST__.showTab('time'))
await pp.selectOption('.swe-tz', 'Europe/Berlin')
await pp.waitForTimeout(400)
await pp.click('[data-swe-action="lang"]')
await pp.waitForTimeout(800)
const prefsSaved = await pp.evaluate(() => window.__SWE_ASSISTANT_TEST__.getPrefs())
check('the setup really changed site, zone and language',
  !!prefsSaved.location && Math.abs(prefsSaved.location.lat - 48.8566) < 0.01 &&
  prefsSaved.tz === 'Europe/Berlin' && prefsSaved.language === 'en', prefsSaved)

await pp.reload({ waitUntil: 'load' })
await pp.waitForSelector('[data-swe-assistant="panel"]', { timeout: 60000 })
await waitEngine(pp)
await pp.waitForTimeout(3000)
const restored = await pp.evaluate(() => {
  const stel = document.getElementById('app').__vue__.$stel
  const tz = document.querySelector('.swe-tz')
  return {
    prefs: window.__SWE_ASSISTANT_TEST__.getPrefs(),
    lang: window.__SWE_ASSISTANT_TEST__.getLanguage(),
    title: document.querySelector('.swe-title').textContent,
    lat: stel.core.observer.latitude * 180 / Math.PI,
    lng: stel.core.observer.longitude * 180 / Math.PI,
    tzSelect: tz ? tz.value : null,
    hostText: (document.getElementById('app') || {}).innerText || ''
  }
})
check('the saved site is restored instead of being replaced by the default',
  Math.abs(restored.lat - 48.8566) < 0.05 && Math.abs(restored.lng - 2.3522) < 0.05 &&
  !!restored.prefs.location && Math.abs(restored.prefs.location.lat - 48.8566) < 0.01,
  { lat: restored.lat, lng: restored.lng, saved: restored.prefs.location })
check('the saved time zone is restored in the form and in prefs',
  restored.prefs.tz === 'Europe/Berlin' && restored.tzSelect === 'Europe/Berlin',
  { tz: restored.prefs.tz, select: restored.tzSelect })
check('the saved assistant language is restored',
  restored.lang === 'en' && restored.title === 'Teaching Assistant',
  { lang: restored.lang, title: restored.title })
check('the host chrome follows the restored language from the first frame',
  /Search|OBSERVE/.test(restored.hostText), restored.hostText.replace(/\s+/g, ' ').slice(0, 60))
check('restoring preferences raised no page errors', persistErrors.length === 0, persistErrors.slice(0, 2))
await persistCtx.close()

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
await browser.close()
fake.kill()
process.exit(failures === 0 ? 0 : 1)
