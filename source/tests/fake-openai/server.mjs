/* Fake OpenAI-compatible endpoint for tests.
 *
 * TEST ONLY. This is not a product component: it never reaches a real model,
 * it holds no credentials, and it binds loopback only. It exists so the client
 * can be exercised end to end without calling anything paid (task book 9,
 * stage C: "default block real model egress").
 *
 *   node tests/fake-openai/server.mjs [port]
 *
 * Routes
 *   GET  /v1/models              model list
 *   POST /v1/chat/completions    canned answer, chosen by the system prompt
 *   GET  /__stats                request counters + last request, for assertions
 *   POST /__control              {"mode":"ok|slow|401|404|429|500|malformed|shape|empty",
 *                                 "delayMs":0, "commands":[...], "text":"..."}
 *   POST /__reset                clear counters and control state
 */
import http from 'node:http'

const PORT = Number(process.argv[2] || 8951)

let control = { mode: 'ok', delayMs: 0, commands: null, text: null }
let stats = { models: 0, chat: 0, lastAuth: null, lastBody: null, lastPath: null, lastModel: null, aborted: 0 }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '600'
}

function json (res, status, body, extra) {
  const payload = JSON.stringify(body)
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  }, CORS, extra || {}))
  res.end(payload)
}

function readBody (req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => resolve(raw))
  })
}

// The client sends the whole instruction in the system message, so the fake
// server can answer the right shape without parsing the user text.
function looksLikeCommandRequest (body) {
  const sys = body && body.messages && body.messages[0] && body.messages[0].content
  if (typeof sys !== 'string') return false
  return /转换成星图命令|sky-map commands/.test(sys)
}

function looksLikeExplanationRequest (body) {
  const sys = body && body.messages && body.messages[0] && body.messages[0].content
  if (typeof sys !== 'string') return false
  return /天文教学助手|astronomy teaching assistant/.test(sys)
}

function defaultCommands () {
  return [
    { type: 'set_layer', layer: 'atmosphere', visible: false },
    { type: 'set_fov', deg: 20 }
  ]
}

function contentFor (body) {
  if (control.text !== null) return control.text
  if (looksLikeCommandRequest(body)) {
    const cmds = control.commands || defaultCommands()
    return JSON.stringify({ commands: cmds, say: 'fake: applied the requested sky change' })
  }
  if (looksLikeExplanationRequest(body)) {
    return '这是一段由 fake 服务生成的讲解文字，用于验证客户端链路，不包含真实天文结论。'
  }
  return 'fake: no matching prompt shape'
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    res.end()
    return
  }

  const url = new URL(req.url, 'http://127.0.0.1')
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (path === '/__reset' && req.method === 'POST') {
    control = { mode: 'ok', delayMs: 0, commands: null, text: null }
    stats = { models: 0, chat: 0, lastAuth: null, lastBody: null, lastPath: null, lastModel: null, aborted: 0 }
    return json(res, 200, { ok: true })
  }

  if (path === '/__stats') {
    return json(res, 200, stats)
  }

  if (path === '/__control' && req.method === 'POST') {
    const raw = await readBody(req)
    try {
      const patch = JSON.parse(raw || '{}')
      control = Object.assign({}, control, patch)
    } catch (e) {
      return json(res, 400, { error: 'bad control json' })
    }
    return json(res, 200, control)
  }

  if (path.endsWith('/models') && req.method === 'GET') {
    stats.models += 1
    stats.lastAuth = req.headers.authorization || null
    stats.lastPath = path
    if (control.delayMs) await new Promise((r) => setTimeout(r, control.delayMs))
    if (control.mode === '401') return json(res, 401, { error: { message: 'invalid api key' } })
    if (control.mode === '404') return json(res, 404, { error: { message: 'not found' } })
    if (control.mode === '429') return json(res, 429, { error: { message: 'rate limited' } })
    if (control.mode === '500') return json(res, 500, { error: { message: 'boom' } })
    if (control.mode === 'malformed') {
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, CORS))
      return res.end('{ this is not json')
    }
    return json(res, 200, { object: 'list', data: [{ id: 'fake-teacher', object: 'model' }] })
  }

  if (path.endsWith('/chat/completions') && req.method === 'POST') {
    stats.chat += 1
    stats.lastAuth = req.headers.authorization || null
    stats.lastPath = path

    // Track a real client abort. Do NOT test req.destroyed: Node marks the
    // request stream destroyed once the body has been consumed, which would
    // make every well-formed request look abandoned.
    let aborted = false
    req.on('aborted', () => { aborted = true })
    res.on('close', () => { if (!res.writableEnded) aborted = true })

    const raw = await readBody(req)
    let body = null
    try { body = JSON.parse(raw) } catch (e) {}
    stats.lastBody = body
    stats.lastModel = body && body.model

    if (control.delayMs) {
      await new Promise((r) => setTimeout(r, control.delayMs))
    }
    if (aborted) { stats.aborted += 1; return }

    if (control.mode === '401') return json(res, 401, { error: { message: 'invalid api key' } })
    if (control.mode === '404') return json(res, 404, { error: { message: 'not found' } })
    if (control.mode === '429') return json(res, 429, { error: { message: 'rate limited' } })
    if (control.mode === '500') return json(res, 500, { error: { message: 'boom' } })
    if (control.mode === 'malformed') {
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, CORS))
      return res.end('<<not json>>')
    }
    if (control.mode === 'shape') return json(res, 200, { choices: [] })
    if (control.mode === 'empty') {
      return json(res, 200, { choices: [{ message: { role: 'assistant', content: '   ' } }] })
    }
    // Headers arrive, the body never finishes. A client that stops its timer
    // when the headers land will hang here until the socket dies, which is
    // exactly what review item R5 is about.
    if (control.mode === 'stallBody') {
      res.writeHead(200, Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        // Deliberately larger than what is written: the runtime has no reason
        // to treat the body as complete.
        'Content-Length': '4096'
      }, CORS))
      res.write('{"id":"chatcmpl-stall","choices":[')
      return // no res.end()
    }

    return json(res, 200, {
      id: 'chatcmpl-fake',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: stats.lastModel || 'fake-teacher',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: contentFor(body) },
        finish_reason: 'stop'
      }]
    })
  }

  return json(res, 404, { error: { message: 'no such route: ' + path } })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('[fake-openai] listening on http://127.0.0.1:' + PORT + '/v1')
  console.log('[fake-openai] TEST ONLY — no real model, no credentials, loopback only')
})
