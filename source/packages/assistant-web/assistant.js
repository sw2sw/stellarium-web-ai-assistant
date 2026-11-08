/* Stellarium Web AI Teaching Assistant - panel
 * Copyright (c) 2026 - project contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Plain JS on purpose: this file is replaced on every assistant update, so it
 * must not require a bundler or a host rebuild. It only talks to the host
 * through window.__SWE_AI_BRIDGE__ (see loader.js).
 *
 * Scope of this build (per task book P0-3): bilingual UI, Shanghai default
 * site, natural-language input with a preview/confirm step, on-demand
 * explanation, and TWO interchangeable model sources:
 *
 *   custom   browser-direct OpenAI-compatible endpoint, key held in this tab
 *   server   same-origin /api/ai/chat, no key in the browser at all
 *
 * The two keep separate settings and separate request paths, and neither falls
 * back to the other. A server failure is reported as a server failure: silently
 * retrying with the teacher's own key would be a second bill they did not ask
 * for, on an endpoint they did not choose.
 *
 * Invariants kept from earlier stages:
 *   - selection alone never triggers a model call (task book 5.4);
 *   - a success is only reported after the engine reads the value back;
 *   - a frozen snapshot is never rewritten, only marked stale;
 *   - the model only ever proposes; the panel validates, previews, asks, then
 *     executes and reads back.
 */
(function () {
  'use strict'

  var VERSION = '0.14.0'
  var UI_KEY = '__SWE_ASSISTANT_UI__'
  var TEST_KEY = '__SWE_ASSISTANT_TEST__'
  var PANEL_KEY = 'swe-assistant.panel'
  var LANG_KEY = 'swe-assistant.lang'
  var PREF_KEY = 'swe-assistant.prefs'
  var AI_KEY = 'swe-assistant.ai'
  var PANEL_ATTR = 'data-swe-assistant'
  var PROTOCOL_EXPECTED = 2

  // First-use observing site. Explicitly a simulated site, not the visitor's
  // real position (task book 5.2).
  var DEFAULT_SITE = {
    lat: 31.2304,
    lng: 121.4737,
    elevation: 4,
    tz: 'Asia/Shanghai',
    name: '上海'
  }

  var TIME_ZONES = [
    'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Kolkata',
    'Europe/London', 'Europe/Berlin', 'America/New_York',
    'America/Los_Angeles', 'UTC'
  ]

  // Server AI is announced by the deployment through a same-origin capability
  // endpoint. Until that answers, the option says "not provided" instead of
  // looking like a connection failure on the user's side. Nothing here is ever
  // trusted to contain a credential: the endpoint returns a model name, a
  // revision and a boolean.
  var SERVER_AI = {
    available: false,
    model: '',
    note: '',
    revision: 0,
    authRequired: false,
    authenticated: false,
    role: null,
    checked: false,
    error: null,
    // Non-reversible tag of this browser's session cookie, as the server last
    // reported it. It is how this tab can tell that ANOTHER tab re-logged-in
    // (the cookie jar is shared, the page-local authGen is not) without the
    // session id itself ever reaching the page (R3 supplement).
    sessionTag: null,
    // Whether the last read of the two status endpoints actually succeeded.
    // A failed read leaves the values above standing (the teacher still gets
    // the last known display), but a confirm must not run a plan on the
    // strength of a read that never happened.
    verified: false
  }

  // Which passphrase the current server session belongs to, as far as this tab
  // knows. It is a counter rather than the passphrase itself: the panel only
  // needs to tell "same session" from "different session", and a number cannot
  // leak a secret into a DOM attribute or a console log. Every login and every
  // logout bumps it (R3).
  var authGen = 0
  // When the two public status endpoints were last read. Used to decide whether
  // an ask or a confirm has to re-read them first (R7/R3) without turning every
  // click into two round-trips.
  var statusAt = 0
  var statusInflight = null
  // How old the cached status may be before an ask or a confirm re-reads it.
  // Short enough that an operator saving a config is noticed by the next
  // question, long enough that a classroom's worth of clicks does not turn into
  // a stream of extra round-trips.
  var STATUS_TTL_MS = 15000

  // The generation deadline. 180 s, not 45 s: a cold local model loading from
  // disk and then answering a teaching question routinely needs more than a
  // minute, and the old 45 s limit turned a working setup into "timeout". This
  // value is part of the deployment hot-patch that was running on the candidate
  // server; it now lives in the source so the next build does not regress it.
  var GEN_TIMEOUT_MS = 180000
  // The endpoint probe stays short: it is a reachability check, not a
  // generation, and a hanging /models should not look like a hanging model.
  var PROBE_TIMEOUT_MS = 15000

  if (window[UI_KEY]) return
  var bridge = window.__SWE_AI_BRIDGE__
  if (!bridge) return
  window[UI_KEY] = true

  var el = {}
  var state = null
  var collapsed = false
  // Which tab is showing. Kept at module scope because savePanelPrefs() needs
  // it and it outlives a collapse/expand cycle.
  var activeTab = 'sky'
  // Set by buildPanel once the tabs exist; lets tests (and a future agent
  // surface) switch panes without simulating a click on a hidden element.
  var showTabRef = null
  // Same idea for the AI source radio: the click path is what a teacher uses,
  // this is what a test uses when it needs to prove the guard rather than the
  // widget.
  var setSourceRef = null
  var lang = 'zh'
  var prefs = { location: null, tz: DEFAULT_SITE.tz, language: 'zh' }
  // `source` selects which client is used. The custom fields below belong to
  // the custom client only and are kept while the server client is selected, so
  // switching back does not make the teacher retype an endpoint. In server mode
  // they are neither shown nor sent anywhere.
  var ai = { source: 'custom', baseUrl: '', model: '', apiKey: '', remember: false }

  // A frozen payload must not be rewritten when the sky moves on.
  var frozen = null
  var lastExplainKey = null

  // Explanation request bookkeeping. A response is only accepted while its id
  // is still the newest one, which is what stops A -> B -> A from showing A's
  // first answer as if it belonged to the second visit to A.
  var explainSeq = 0
  var explainBusy = false
  var explanation = null
  var explainAbort = null

  // Multi-turn chat (0.14.0). Sessions live in this tab's memory only - there
  // is no chat storage anywhere, server or local. `seq` invalidates in-flight
  // requests when the session ends (close, clear, config change, logout): a
  // late reply must never land in a session the user has already left.
  var chat = {
    open: false,
    topic: null,        // { designation, displayName } when continuing about a body
    origin: null,       // { explanation, snapshotPayload, snapshotId } from 讲解
    messages: [],       // { role: 'user' | 'assistant' | 'note', text, at, id? }
    pendingDigest: null,// recommendation digest attached to the next send
    busy: false,
    abort: null,
    seq: 0,
    msgSeq: 0,          // per-message id: failure recovery is bound to THIS id,
                        // not to "whatever sits last in the array" (R9, round 3)
    truncated: 0
  }
  // History cap (0.14.0): the system rules plus the most recent messages are
  // sent; older turns are dropped oldest-first and the UI says how many were
  // omitted. No model-side summarisation - the cap is honest and cheap.
  var CHAT_MAX_MESSAGES = 12
  // R9 (review round 2): the history cap alone let one huge paste poison every
  // later turn - the server refuses messages over 12000 chars and payloads
  // over 24000, so a rejected turn kept failing forever. The panel now
  // enforces the same budget BEFORE sending: a single message is refused with
  // a recoverable note (the text goes back to the input, never silently
  // rewritten), and the composed payload sheds its OLDEST history to fit.
  var CHAT_MAX_MESSAGE_CHARS = 8000
  var CHAT_BUDGET_CHARS = 20000
  var CHAT_ORIGIN_CITE_CHARS = 2000
  // R9 (review round 3): the composed payload is checked against the SERVER's
  // real per-message and count limits, not only the total. One oversized
  // assistant reply in the history (or an over-large composed system message)
  // fails the server's per-message check no matter how small the total is.
  var CHAT_SERVER_MESSAGE_CHARS = 12000
  var CHAT_SERVER_MAX_MESSAGES = 24

  // Current-time recommendation (0.14.0). Computed on click only: opening the
  // panel, switching language or changing the selection never runs a query or
  // a model call.
  var recState = { result: null, snapshotPayload: null, at: 0, busy: false }
  // External curated-target provider (0.14.0). Loaded once from a same-origin
  // static file next to the assistant bundle; a missing or corrupt file only
  // disables the extra provider, never the builtin Moon-and-planets one.
  var externalTargets = []
  var externalSource = null
  var externalError = null

  // Command proposal produced by the model, awaiting an explicit confirm.
  var proposalSeq = 0
  var proposal = null
  var proposalBusy = false
  // A batch run in progress owns this token. Discarding (or a config change)
  // bumps it, which is what stops a half-executed plan from sending the rest
  // of its commands: the obsolete closure sees a different token and returns.
  var execSeq = 0
  // The token of the batch that is actually running, 0 when no batch is. It is
  // separate from proposalBusy because that flag is also true while waiting
  // for the model: editing the AI settings must abandon a pending answer, but
  // it must stop a running batch, and those are different actions.
  var runningExec = 0
  // How many commands of the current batch have actually been handed to the
  // bridge. Needed by the cancel message: the ones already sent cannot be
  // recalled, and saying which is which is the honest part of cancelling.
  var execSent = 0

  // How many times the current selection has changed hands. Comparing ids is
  // not enough: A -> B -> A ends on the same id, so a plan written for the
  // first visit to A would look valid again. The epoch only ever goes up.
  var skyEpoch = 0
  var lastSelectionKey = null

  // Endpoint identity (base URL + model + key). Bumped whenever the user edits
  // the AI settings, so a response that was already in flight for the previous
  // endpoint can be recognised as belonging to a configuration that no longer
  // exists and be dropped instead of written into the UI.
  var configSeq = 0

  var lastAppliedLoc = null
  var pendingLoc = null
  var locSamples = []
  // A field the teacher is editing must not be overwritten by the two-second
  // state poll. Without this, typing a latitude and then moving on to the
  // longitude let the next poll put the engine's latitude back, so "apply" sent
  // a mixed site: the new longitude with the old latitude.
  var locDirty = false
  var timeDirty = false
  var flashTimer = null
  var flashUntil = 0

  /* ------------------------------------------------------------- i18n */

  var M = {
    zh: {
      'app.title': '教学助手',
      'app.collapse': '折叠 / 展开',
      'lang.switch': 'English',
      'lang.name': '中文',

      'status.connecting': '正在连接星图引擎…',
      'status.ready': '已连接 · 桥接 v{loader} · 协议 {protocol} · 视图 {view} · rev {rev}',
      'status.noEngine': '星图引擎未就绪',
      'status.incompatible': '桥接协议 v{bridge} 与本助手要求的 v{want} 不兼容，控制功能已停用',

      'sec.object': '当前天体',
      'sec.explain': '讲解',
      'sec.input': '助手输入',
      'sec.layers': '图层',
      'sec.time': '观测时间',
      'sec.location': '观测地点',
      'sec.fov': '视场',
      'sec.ai': 'AI 设置',

      // Four panes instead of one long column: the sidebar had grown to seven
      // stacked sections plus the AI form, which pushed the input box off the
      // screen on a laptop. Each tab is one job.
      'tab.sky': '星空',
      'tab.view': '视图',
      'tab.time': '时间',
      'tab.ai': '设置',
      'tab.hint.sky': '当前天体、讲解、自然语言输入',
      'tab.hint.view': '图层、视场、观测地点',
      'tab.hint.time': '跳转时刻、播放暂停、时间流速',
      'tab.hint.ai': 'AI 来源与连接设置',

      'time.speed': '流速',
      'time.play': '继续',
      'time.pause': '暂停',
      'time.running': '运行中',
      'time.stopped': '已暂停',
      'time.rate': '{v}× 实时',
      'time.preset': '{label}',
      'time.p1': '实时',
      'time.p60': '1 分/秒',
      'time.p3600': '1 时/秒',
      'time.p86400': '1 天/秒',
      'time.custom': '自定义倍率',
      'time.runFor': '连续走',
      'time.hours': '模拟小时',
      'time.run': '开跑',
      'time.autoStop': '走完自动停',
      'time.speedNote': '流速 N× 表示每 1 秒真实时间走 N 秒模拟时间；86400× 是每秒一天。填了模拟小时数就会走完自动停。',
      'time.speedBad': '倍率必须在 0.0001 到 86400 之间',

      'obj.none': '未选中天体。在星图上点选，或在上方搜索框选择。',
      'obj.typeUnknown': '类型未知',
      'obj.mag': '星等',
      'obj.az': '方位角',
      'obj.alt': '高度角',
      'obj.ra': '赤经',
      'obj.dec': '赤纬',
      'obj.readback': '以上为星图引擎读回的真实数值。',
      'obj.belowHorizon': '当前在地平线以下，不可见。',

      'layer.atmosphere': '大气',
      'layer.constellation_lines': '星座线',
      'layer.constellation_labels': '星座名',
      'layer.landscape': '地景',
      'layer.milkyway': '银河',
      'layer.equatorial_grid': '赤道网格',
      'layer.azimuthal_grid': '地平网格',

      'time.apply': '应用',
      'time.now': '现在',
      'time.note': '输入按所选时区（{tz}）解释，发送给引擎前换算成带 Z 的 UTC；引擎本身没有时区概念。',
      'time.zone': '时区',
      'time.bad': '时间格式不正确',

      'loc.lat': '纬度',
      'loc.lng': '经度',
      'loc.apply': '应用地点',
      'loc.default': '默认站点：上海（模拟位置，不代表你的真实位置）。',
      'loc.custom': '已使用你设定的地点，刷新后仍会保留。',
      'loc.bad': '经纬度必须是数字：纬度 -90~90，经度 -180~180',
      'loc.reset': '恢复默认',

      'fov.label': '视场 {fov} · 地点 {lat} / {lng}',

      'explain.hint': '先选中一个天体，再点击「讲解」。点选本身不会产生模型请求。',
      'explain.run': '讲解',
      'explain.busy': '正在生成…',
      'explain.cancel': '取消',
      'explain.empty': '模型没有返回可显示的文字。',
      'explain.disclaimer': 'AI生成内容仅供参考，可能存在错误；天体数据以星图引擎读回值为准。',
      'explain.stale': '这段讲解针对的是当时的快照（snapshotId={id}），天空或选择已经变化。',
      'explain.ctxChanged': '讲解请求期间选择变过（包括又切回来），这份回答已丢弃，请重新生成。',
      'explain.needAi': '尚未配置 AI，无法生成讲解。请先在下方「AI 设置」中填写端点。',
      'explain.offline': '连接 AI 失败：{msg}。星图本身不受影响。',
      'explain.snapshot': '将要发送的观测快照（不含精确地点）',
      // --- chat popup (0.14.0) ---
      'chat.title': '与 AI 助手交流',
      'chat.disclaimer': 'AI生成内容仅供参考，可能存在错误。',
      'chat.close': '关闭',
      'chat.clear': '清空会话',
      'chat.retopic': '改聊当前天体',
      'chat.retopped': '已切换讨论对象：{name}。',
      'chat.about': '讨论对象：{name}',
      'chat.aboutNone': '讨论对象：未选择（泛问星空）',
      'chat.placeholder': '输入问题…',
      'chat.send': '发送',
      'chat.stop': '停止生成',
      'chat.continue': '继续交流',
      'chat.askSky': '问问星空',
      'chat.empty': '直接输入问题，或点下面的快捷问题。',
      'chat.quickEye': '肉眼能看到什么？',
      'chat.quickScope': '小望远镜怎么看？',
      'chat.quickWhat': '现在适合看什么？',
      'chat.quickWhy': '为什么会这样？',
      'chat.whyNeedTopic': '"为什么会这样"需要先有讨论对象：请先在星图中选择天体，或换个问题。',
      'chat.truncated': '为控制上下文长度，已省略较早的 {n} 条消息（只保留最近部分对话）。',
      'chat.droppedLong': '已移出 {n} 条超过单条上限（{max} 字符）的历史消息，否则服务器会拒绝整个对话；记录中仍可见。',
      'chat.digestShed': '推荐摘要过长，本次请求未携带；推荐结果仍在面板中。',
      'chat.snapshotShed': '发送时快照过长，本次请求未携带。',
      'chat.payloadTooLong': '组装后的请求仍超过单条上限，未发送。请清空会话或缩短讲解内容后重试；原文已放回输入框。',
      'chat.memoryNote': '本页不持久保存会话：刷新或关闭页面即消失，本站不另建聊天存储。发送时，相关对话与星图数据会交给所选 AI 服务处理（服务器模式经本站转发）；供应商是否留存取决于其自身政策。',
      'chat.needAi': '尚未配置模型，无法生成回答。程序筛选的推荐结果仍可在面板中查看。',
      'chat.stoppedNote': '已停止本地请求。若上游已开始生成，该次额度可能已被计入。',
      'chat.clearedNote': '会话已清空。',
      'chat.closedNote': '弹窗已关闭，在途请求已取消。',
      'chat.configChangedNote': 'AI 配置已变化，在途请求已取消；下次发送将使用新配置。',
      'chat.error': '本轮回答失败：{msg}',
      'chat.unverifiedNote': '无法核实服务器与登录状态，这次发送已取消（未产生费用）。请稍后重试。',
      'chat.busyNote': '当前有请求正在生成；请先停止或等待回答后再点快捷问题。',
      'chat.tooLong': '这段文字太长（{n} 字符，上限 {max}），未发送。请拆分或缩短后重试；原文已放回输入框。',

      // --- recommendation (0.14.0) ---
      'sec.recommend': '现在适合看什么',
      'rec.run': '看看现在的推荐',
      'rec.hint': '点击上方按钮，按当前星图时刻筛选肉眼与小望远镜目标。',
      'rec.bridgeOld': '桥接版本过低或引擎不可用，无法进行只读查询。',
      'rec.group_eye': '肉眼观看',
      'rec.group_scope': '小型望远镜目视',
      'rec.view': '在星图中查看',
      'rec.where': '{dir}方向，高度 {alt}°',
      'rec.whereUnknown': '位置读数缺失',
      'rec.mag': '亮度 {mag} 等',
      'rec.illum': '照亮 {pct}%',
      'rec.limits': '注意：',
      'rec.timeScope': '按当前星图时刻（UTC {utc}）筛选；不覆盖整晚。',
      'rec.site': '模拟地点：纬 {lat}°，经 {lng}°（已舍入）。',
      'rec.externalBad': '外置目标文件无效，已忽略；内置月球行星推荐不受影响。',
      'explain.freeze': '冻结此快照',
      'explain.frozen': '已冻结 snapshotId={id}',
      'explain.frozenSame': '（与当前天空一致）',
      'explain.frozenStale': '（天空已变化，此快照已过期，不会用于新的请求）',
      'explain.freezeFailed': '引擎未就绪，无法冻结快照',
      'explain.below': '（该天体当前在地平线以下）',

      'input.placeholder': '例如：把时间调到今晚八点，看看木星',
      'input.send': '解析',
      'input.needAi': '尚未配置 AI，无法解析自然语言。下方的图层、时间、地点按钮仍可直接使用。',
      'input.serverUnverified': '暂时无法核实服务器状态，这次提问没有发送（未产生费用）。请稍后重试。',
      'input.parsing': '正在解析…',
      'input.cancel': '取消',
      'input.preview': '模型给出 {n} 条命令，确认后才会执行：',
      'input.confirm': '确认执行',
      'input.discard': '放弃',
      'input.executing': '执行中…',
      'input.stale': '星图状态已变化（选择、时间、地点或视场不同了），这份命令已作废，请重新生成。',
      'input.say': '模型说明：',
      'input.noCommands': '模型没有给出可执行的命令。',
      'input.rejected': '命令被本地校验拒绝：{msg}',
      'input.done': '执行完成：{ok} 条成功，{fail} 条失败。',
      'input.partial': '第 {i} 条失败后停止：{msg}',
      // The model answered after the teacher had already moved the sky on.
      // Says which parts moved, so "重新问一次" is an informed decision.
      'input.ctxChanged': '这份命令是按提问时的星图状态生成的，等待回答期间这些内容变了：{fields}。整批已作废，请重新提问。',
      'input.staleBanner': '这份命令已作废（{fields} 变了），不能再执行。请重新提问。',
      'input.staleLocked': '这份命令在显示时就已经作废（{fields} 变了），不会执行。',
      'input.ctxMidRun': '执行到一半时星图被外部改动（{fields} 变了），剩下 {rest} 条没有发出。',
      'input.cfgStopBatch': 'AI 配置已更改，正在执行的批次已停止：已发出 {sent} 条，无法撤回，其余未发出。',
      'input.invalid': '有 {n} 条命令未通过本地校验（{msg}）。整批不予执行，避免悄悄改掉模型的计划。',
      // ok && status === 'timeout': the bridge accepted it but could not see the
      // result settle. Never counted as success, never followed by more commands.
      'input.unverified': '第 {i} 条已发出，但桥接层在超时前没读到终态（status={status}），未验证，不能算成功。后续 {rest} 条没有发出，也不会自动重放。读回：{readback}',
      'input.cancelled': '已取消：剩余 {rest} 条没有发出。已经发出的 {sent} 条无法撤回。',
      'input.cfgDropped': 'AI 配置已更改，上一次请求的回答已丢弃。',
      'input.serverChanged': '服务器配置或登录状态在生成之后变了，这份命令没有执行。请重新提问。',

      // Field names used by input.ctxChanged. The panel names what moved
      // instead of saying "something changed".
      'ctx.selection': '选中的天体',
      'ctx.view': '视图',
      'ctx.time': '观测时间',
      'ctx.site': '观测地点',
      'ctx.fov': '视场',
      'ctx.speed': '时间倍率',

      'ai.source': 'AI 来源',
      'ai.custom': '自定义 AI（浏览器直连）',
      'ai.server': '服务器 AI',
      'ai.serverUnavailable': '服务器 AI 尚未提供',
      'ai.serverHint': '本站尚未提供服务器 AI：这个部署没有开放该选项，只能用自定义 AI。',
      'ai.serverChecking': '正在检查本站是否提供服务器 AI…',
      'ai.serverLive': '服务器 AI 可用：{model}',
      'ai.serverReady': '已连接服务器 AI（{model}，配置 rev {rev}）。本页不持有供应商 Key。',
      'ai.serverNeedLogin': '本站提供服务器 AI，需要课堂口令才能使用。',
      'ai.serverUnavailableLong': '本站没有提供服务器 AI。可以改用自定义 AI（浏览器直连）。',
      'ai.serverRefresh': '刷新状态',
      'ai.serverOff': '服务器 AI 当前未开放。',
      'ai.serverOk': '服务器 AI 可用，模型 {model}。',
      'ai.pass': '课堂口令',
      'ai.passPh': '由老师提供，不是供应商 Key',
      'ai.signIn': '登录',
      'ai.signOut': '退出登录',
      'ai.passEmpty': '请输入课堂口令',
      'ai.passWrong': '口令不正确',
      'ai.passFailed': '登录失败',
      'ai.signingIn': '登录中…',
      'ai.signedIn': '已登录，可以使用服务器 AI',
      'ai.serverPrivacy': '使用服务器 AI 时，提问会发送到本站服务器，再由服务器转发给学校配置的模型；本浏览器不保存供应商 Key。',
      'ai.baseUrl': 'Base URL',
      'ai.baseUrlPh': '例如 http://127.0.0.1:11434/v1',
      'ai.model': '模型',
      'ai.modelPh': '例如 qwen2.5:7b',
      'ai.apiKey': 'API Key（可留空）',
      'ai.apiKeyPh': '留空则不发送 Authorization 头',
      'ai.remember': '记住配置（保存在本浏览器）',
      'ai.rememberWarn': '勾选后 Base URL、模型名和 API Key 会写入本浏览器的 localStorage。同一台电脑的其他使用者可以读到它；公共电脑请不要勾选。',
      'ai.clear': '清除已保存配置',
      'ai.cleared': '已清除本浏览器保存的 AI 配置',
      'ai.test': '测试连接',
      'ai.testing': '测试中…',
      'ai.testOk': '端点可达（{n} 个模型）。注意：这只证明接口可访问，不代表生成调用一定成功。',
      'ai.testNoModels': '端点可达，但没有返回模型列表。这不代表生成调用可用。',
      'ai.endpoint': '实际请求地址：{url}',
      'ai.endpointEmpty': '尚未填写 Base URL',
      'ai.inMemory': '未勾选「记住配置」时，配置只存在当前页面内存里，刷新即丢失。',
      'ai.savedHint': '配置已保存在本浏览器。',
      'ai.memoryHint': '配置仅在当前页面有效。',
      'ai.keyNeverSent': 'API Key 只发送给你填写的端点，不经过本站服务器。',

      'err.network': '无法连接到端点（网络或 CORS 限制）',
      'err.mixed': 'HTTPS 页面不能直接访问 HTTP 端点',
      'err.timeout': '请求超时',
      'err.abort': '已取消',
      'err.auth': '认证失败（401/403），请检查 API Key',
      'err.notfound': '路径不存在（404），请检查 Base URL 是否包含 /v1',
      'err.rate': '请求过于频繁（429）',
      'err.server': '端点返回服务器错误（{code}）',
      'err.malformed': '响应不是合法 JSON',
      'err.shape': '响应缺少 choices[0].message.content',
      'err.empty': '模型返回了空内容',
      'err.badJson': '模型返回的内容不是合法 JSON',
      'err.serverAuth': '服务器 AI 认证失败：请先在 AI 设置里输入课堂口令',
      'err.serverQuota': '今日额度已用完，请明天再试或联系老师',
      'err.serverOff': '服务器 AI 当前未开放',
      'err.serverReject': '服务器拒绝了这次请求',
      'err.serverTimeout': '服务器等待模型超时',
      'err.serverUpstream': '服务器没能从模型拿到结果',
      'err.serverTooLarge': '请求内容过大',
      'err.serverCrossSite': '跨站请求被拒绝',
      'err.configChanged': '服务器配置刚刚变更，这次回答已作废，请重试'
    },
    en: {
      'app.title': 'Teaching Assistant',
      'app.collapse': 'Collapse / expand',
      'lang.switch': '中文',
      'lang.name': 'English',

      'status.connecting': 'Connecting to the sky engine…',
      'status.ready': 'Connected · bridge v{loader} · protocol {protocol} · view {view} · rev {rev}',
      'status.noEngine': 'Sky engine not ready',
      'status.incompatible': 'Bridge protocol v{bridge} does not match the v{want} this assistant needs; controls disabled',

      'sec.object': 'Current object',
      'sec.explain': 'Explanation',
      'sec.input': 'Ask the assistant',
      'sec.layers': 'Layers',
      'sec.time': 'Observing time',
      'sec.location': 'Observing site',
      'sec.fov': 'Field of view',
      'sec.ai': 'AI settings',

      'tab.sky': 'Sky',
      'tab.view': 'View',
      'tab.time': 'Time',
      'tab.ai': 'AI',
      'tab.hint.sky': 'Current object, explanation, ask box',
      'tab.hint.view': 'Layers, field of view, observing site',
      'tab.hint.time': 'Jump to a moment, play/pause, time rate',
      'tab.hint.ai': 'AI source and connection settings',

      'time.speed': 'Rate',
      'time.play': 'Resume',
      'time.pause': 'Pause',
      'time.running': 'running',
      'time.stopped': 'paused',
      'time.rate': '{v}× real time',
      'time.preset': '{label}',
      'time.p1': 'real time',
      'time.p60': '1 min/s',
      'time.p3600': '1 h/s',
      'time.p86400': '1 day/s',
      'time.custom': 'Custom rate',
      'time.runFor': 'Run for',
      'time.hours': 'simulated hours',
      'time.run': 'Run',
      'time.autoStop': 'stops when done',
      'time.speedNote': 'N× means N simulated seconds per real second; 86400× is one day per second. Fill in simulated hours to stop automatically.',
      'time.speedBad': 'Rate must be between 0.0001 and 86400',

      'obj.none': 'No object selected. Click one on the sky or pick one above.',
      'obj.typeUnknown': 'type unknown',
      'obj.mag': 'Mag',
      'obj.az': 'Azimuth',
      'obj.alt': 'Altitude',
      'obj.ra': 'RA',
      'obj.dec': 'Dec',
      'obj.readback': 'Values above are read back from the sky engine.',
      'obj.belowHorizon': 'Currently below the horizon and not visible.',

      'layer.atmosphere': 'Atmosphere',
      'layer.constellation_lines': 'Const. lines',
      'layer.constellation_labels': 'Const. names',
      'layer.landscape': 'Landscape',
      'layer.milkyway': 'Milky Way',
      'layer.equatorial_grid': 'Equatorial grid',
      'layer.azimuthal_grid': 'Azimuth grid',

      'time.apply': 'Apply',
      'time.now': 'Now',
      'time.note': 'The input is read in the selected zone ({tz}) and converted to UTC with Z before it reaches the engine, which has no timezone concept.',
      'time.zone': 'Time zone',
      'time.bad': 'Invalid time format',

      'loc.lat': 'Latitude',
      'loc.lng': 'Longitude',
      'loc.apply': 'Apply site',
      'loc.default': 'Default site: Shanghai (simulated position, not your real location).',
      'loc.custom': 'Using your chosen site; it is kept after reload.',
      'loc.bad': 'Latitude must be -90..90 and longitude -180..180',
      'loc.reset': 'Reset to default',

      'fov.label': 'FOV {fov} · site {lat} / {lng}',

      'explain.hint': 'Select an object first, then press Explain. Selecting alone never calls the model.',
      'explain.run': 'Explain',
      'explain.busy': 'Generating…',
      'explain.cancel': 'Cancel',
      'explain.empty': 'The model returned no displayable text.',
      'explain.disclaimer': 'AI-generated content is for reference only and may contain errors; object data comes from engine read-back.',
      'explain.stale': 'This explanation was written for snapshotId={id}; the sky or the selection has changed since.',
      'explain.ctxChanged': 'The selection changed while this explanation was being written (even if it came back), so the answer was dropped. Please run it again.',
      'explain.needAi': 'No AI configured yet, so no explanation can be generated. Fill in the endpoint under AI settings.',
      'explain.offline': 'Could not reach the AI: {msg}. The sky map is unaffected.',
      'explain.snapshot': 'Observation snapshot that would be sent (no precise site)',
      // --- chat popup (0.14.0) ---
      'chat.title': 'Talk to the AI assistant',
      'chat.disclaimer': 'AI-generated content is for reference only and may contain errors.',
      'chat.close': 'Close',
      'chat.clear': 'Clear session',
      'chat.retopic': 'Discuss the selected object',
      'chat.retopped': 'Now discussing: {name}.',
      'chat.about': 'Discussing: {name}',
      'chat.aboutNone': 'Discussing: nothing selected (open questions)',
      'chat.placeholder': 'Type a question…',
      'chat.send': 'Send',
      'chat.stop': 'Stop',
      'chat.continue': 'Continue in chat',
      'chat.askSky': 'Ask the sky',
      'chat.empty': 'Type a question, or tap a quick question below.',
      'chat.quickEye': 'What can I see by naked eye?',
      'chat.quickScope': 'What about a small telescope?',
      'chat.quickWhat': 'What is worth seeing now?',
      'chat.quickWhy': 'Why is that?',
      'chat.whyNeedTopic': '"Why is that" needs a discussion object: select something in the chart first, or ask a different question.',
      'chat.truncated': 'To bound the context, {n} earlier message(s) were omitted (only the recent turns are kept).',
      'chat.droppedLong': 'Removed {n} history message(s) over the per-message limit ({max} chars) - the server would refuse the whole conversation; they remain visible in the transcript.',
      'chat.digestShed': 'The recommendation digest was too long and is not part of this request; the panel still shows it.',
      'chat.snapshotShed': 'The send-time snapshot was too long and is not part of this request.',
      'chat.payloadTooLong': 'The composed request still exceeds the per-message limit and was NOT sent. Clear the conversation or shorten the explanation, then retry; the text is back in the input box.',
      'chat.memoryNote': 'The session is not persisted on this page and there is no separate chat storage here; it is gone on reload. Sending a message submits the relevant conversation and chart data to the AI service you selected (server mode routes through this site); what the provider retains is governed by its own policy.',
      'chat.needAi': 'No model configured, so no answer can be generated. The program-side recommendation still works in the panel.',
      'chat.stoppedNote': 'Local request stopped. If the upstream already started generating, its quota may already be spent.',
      'chat.clearedNote': 'Session cleared.',
      'chat.closedNote': 'Popup closed; in-flight request cancelled.',
      'chat.configChangedNote': 'The AI configuration changed; the in-flight request was cancelled. The next send uses the new configuration.',
      'chat.error': 'This turn failed: {msg}',
      'chat.unverifiedNote': 'The server and sign-in state could not be verified, so nothing was sent (nothing was spent). Try again shortly.',
      'chat.busyNote': 'A reply is still generating; stop it or wait before tapping a quick question.',
      'chat.tooLong': 'This text is too long ({n} chars, limit {max}) and was NOT sent. Split or shorten it; the original is back in the input box.',

      // --- recommendation (0.14.0) ---
      'sec.recommend': 'What to look at now',
      'rec.run': 'Recommend for now',
      'rec.hint': 'Tap the button above to shortlist naked-eye and small-telescope targets for the current chart time.',
      'rec.bridgeOld': 'The bridge is too old or the engine is unavailable for read-only queries.',
      'rec.group_eye': 'Naked eye',
      'rec.group_scope': 'Small telescope',
      'rec.view': 'View in chart',
      'rec.where': '{dir}, altitude {alt}°',
      'rec.whereUnknown': 'position reading missing',
      'rec.mag': 'mag {mag}',
      'rec.illum': '{pct}% lit',
      'rec.limits': 'Note: ',
      'rec.timeScope': 'Selected for the CURRENT chart time (UTC {utc}); not a whole-night plan.',
      'rec.site': 'Simulated site: lat {lat}°, lng {lng}° (rounded).',
      'rec.externalBad': 'The external target file is invalid and was ignored; the builtin Moon-and-planets provider is unaffected.',
      'explain.freeze': 'Freeze this snapshot',
      'explain.frozen': 'Frozen snapshotId={id}',
      'explain.frozenSame': '(matches the current sky)',
      'explain.frozenStale': '(the sky moved on; this snapshot is stale and will not be used for new requests)',
      'explain.freezeFailed': 'Engine not ready, cannot freeze a snapshot',
      'explain.below': '(this object is currently below the horizon)',

      'input.placeholder': 'e.g. set the time to 8pm tonight and look at Jupiter',
      'input.send': 'Parse',
      'input.needAi': 'No AI configured, so natural language cannot be parsed. The layer, time and site buttons below still work.',
      'input.serverUnverified': 'The server status could not be verified, so this question was not sent (nothing was spent). Try again shortly.',
      'input.parsing': 'Parsing…',
      'input.cancel': 'Cancel',
      'input.preview': 'The model proposed {n} command(s); nothing runs until you confirm:',
      'input.confirm': 'Run them',
      'input.discard': 'Discard',
      'input.executing': 'Running…',
      'input.stale': 'The sky changed (different selection or view), so this batch is void. Please ask again.',
      'input.say': 'Model note:',
      'input.noCommands': 'The model proposed no executable commands.',
      'input.rejected': 'Rejected by local validation: {msg}',
      'input.done': 'Done: {ok} succeeded, {fail} failed.',
      'input.partial': 'Stopped at command {i}: {msg}',
      'input.ctxChanged': 'These commands were written for the sky as it was when you asked; while waiting, this changed: {fields}. The batch is void — please ask again.',
      'input.staleBanner': 'These commands are void ({fields} changed) and cannot run. Please ask again.',
      'input.staleLocked': 'These commands were already void when they appeared ({fields} changed); nothing was run.',
      'input.ctxMidRun': 'The sky changed from outside while the batch was running ({fields}); the remaining {rest} commands were not sent.',
      'input.cfgStopBatch': 'The AI settings changed, so the running batch was stopped: {sent} command(s) were already sent and cannot be recalled, the rest were not.',
      'input.invalid': '{n} command(s) failed local validation ({msg}). The whole batch is refused rather than quietly running a subset of the model\'s plan.',
      'input.unverified': 'Command {i} was sent, but the bridge could not read a settled result before the timeout (status={status}) — unverified, so it is not counted as done. The remaining {rest} were not sent and will not be replayed. Read-back: {readback}',
      'input.cancelled': 'Cancelled: the remaining {rest} command(s) were not sent. The {sent} already sent cannot be undone.',
      'input.cfgDropped': 'The AI settings changed, so the previous request\'s answer was dropped.',
      'input.serverChanged': 'The server configuration or sign-in changed after this plan was generated, so it was not run. Please ask again.',

      'ctx.selection': 'the selected object',
      'ctx.view': 'the view',
      'ctx.time': 'the observing time',
      'ctx.site': 'the observing site',
      'ctx.fov': 'the field of view',
      'ctx.speed': 'the time rate',

      'ai.source': 'AI source',
      'ai.custom': 'Custom AI (browser direct)',
      'ai.server': 'Server AI',
      'ai.serverUnavailable': 'Server AI is not provided',
      'ai.serverHint': 'Server AI is not provided by this site: this deployment has not enabled it, so only custom AI is available.',
      'ai.serverChecking': 'Checking whether this site provides server AI…',
      'ai.serverLive': 'Server AI available: {model}',
      'ai.serverReady': 'Connected to server AI ({model}, config rev {rev}). No vendor key is held in this page.',
      'ai.serverNeedLogin': 'This site provides server AI, but a class passphrase is required.',
      'ai.serverUnavailableLong': 'This site does not provide server AI. Custom AI (browser direct) is still available.',
      'ai.serverRefresh': 'Refresh status',
      'ai.serverOff': 'Server AI is currently switched off.',
      'ai.serverOk': 'Server AI is available, model {model}.',
      'ai.pass': 'Class passphrase',
      'ai.passPh': 'Provided by your teacher, not a vendor key',
      'ai.signIn': 'Sign in',
      'ai.signOut': 'Sign out',
      'ai.passEmpty': 'Enter the class passphrase',
      'ai.passWrong': 'That passphrase is not valid',
      'ai.passFailed': 'Sign-in failed',
      'ai.signingIn': 'Signing in…',
      'ai.signedIn': 'Signed in; server AI is usable',
      'ai.serverPrivacy': 'With server AI, your question goes to this site\'s server, which forwards it to the model the school configured. This browser never holds a vendor key.',
      'ai.baseUrl': 'Base URL',
      'ai.baseUrlPh': 'e.g. http://127.0.0.1:11434/v1',
      'ai.model': 'Model',
      'ai.modelPh': 'e.g. qwen2.5:7b',
      'ai.apiKey': 'API key (optional)',
      'ai.apiKeyPh': 'Left empty, no Authorization header is sent',
      'ai.remember': 'Remember settings (stored in this browser)',
      'ai.rememberWarn': 'If ticked, the Base URL, model name and API key are written to this browser localStorage. Other people using this computer can read them; do not tick this on a shared machine.',
      'ai.clear': 'Clear saved settings',
      'ai.cleared': 'Saved AI settings cleared from this browser',
      'ai.test': 'Test connection',
      'ai.testing': 'Testing…',
      'ai.testOk': 'Endpoint reachable ({n} models). Note: this only proves the API answers, not that generation works.',
      'ai.testNoModels': 'Endpoint reachable but returned no model list. This does not mean generation works.',
      'ai.endpoint': 'Request URL: {url}',
      'ai.endpointEmpty': 'Base URL is empty',
      'ai.inMemory': 'Without "remember", settings live only in this page and are lost on reload.',
      'ai.savedHint': 'Settings are stored in this browser.',
      'ai.memoryHint': 'Settings are valid for this page only.',
      'ai.keyNeverSent': 'The API key goes only to the endpoint you entered, never to this site\'s server.',

      'err.network': 'Cannot reach the endpoint (network or CORS restriction)',
      'err.mixed': 'An HTTPS page cannot call an HTTP endpoint directly',
      'err.timeout': 'Request timed out',
      'err.abort': 'Cancelled',
      'err.auth': 'Authentication failed (401/403); check the API key',
      'err.notfound': 'Path not found (404); check whether the Base URL should include /v1',
      'err.rate': 'Too many requests (429)',
      'err.server': 'Endpoint returned a server error ({code})',
      'err.malformed': 'Response was not valid JSON',
      'err.shape': 'Response has no choices[0].message.content',
      'err.empty': 'The model returned empty content',
      'err.badJson': 'The model output was not valid JSON',
      'err.serverAuth': 'Server AI refused this browser: enter the class passphrase in AI settings',
      'err.serverQuota': 'Today\'s quota is used up. Try tomorrow, or ask your teacher.',
      'err.serverOff': 'Server AI is currently switched off',
      'err.serverReject': 'The server rejected this request',
      'err.serverTimeout': 'The server timed out waiting for the model',
      'err.serverUpstream': 'The server could not get an answer from the model',
      'err.serverTooLarge': 'The request was too large',
      'err.serverCrossSite': 'A cross-site request was refused',
      'err.configChanged': 'The server configuration changed; this answer was discarded, please retry'
    }
  }

  function t (key, params) {
    var table = M[lang] || M.zh
    var s = table[key]
    if (s === undefined) s = (M.zh[key] !== undefined ? M.zh[key] : key)
    if (!params) return s
    return s.replace(/\{(\w+)\}/g, function (m, k) {
      return params[k] === undefined || params[k] === null ? m : String(params[k])
    })
  }

  /* ---------------------------------------------------------- helpers */

  function h (tag, attrs, children) {
    var node = document.createElement(tag)
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') node.textContent = attrs[k]
        else if (k === 'class') node.className = attrs[k]
        else if (k === 'html') node.innerHTML = attrs[k]
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k])
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k])
      })
    }
    ;(children || []).forEach(function (c) { if (c) node.appendChild(c) })
    return node
  }

  // Text node whose content is refreshed by applyLanguage().
  function tx (tag, key, attrs) {
    var a = {}
    if (attrs) Object.keys(attrs).forEach(function (k) { a[k] = attrs[k] })
    a['data-i18n'] = key
    var node = h(tag, a)
    node.textContent = t(key)
    return node
  }

  function fmt (v, digits, unit) {
    if (v === null || v === undefined || !isFinite(v)) return '—'
    return v.toFixed(digits === undefined ? 2 : digits) + (unit || '')
  }

  function pad2 (n) { return (n < 10 ? '0' : '') + n }

  function fmtInZone (iso, tz) {
    if (!iso) return '—'
    var d = new Date(iso)
    if (isNaN(d.getTime())) return '—'
    try {
      var parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      }).formatToParts(d)
      var o = {}
      parts.forEach(function (p) { o[p.type] = p.value })
      return o.year + '-' + o.month + '-' + o.day + ' ' + (o.hour === '24' ? '00' : o.hour) + ':' + o.minute
    } catch (e) {
      return d.toISOString().slice(0, 16).replace('T', ' ')
    }
  }

  // Local wall-clock string in `tz` -> Date. Two passes so DST transitions
  // settle; the engine only ever receives the resulting UTC instant.
  function zonedToUtc (localStr, tz) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(localStr)
    if (!m) return null
    var Y = +m[1], Mo = +m[2], D = +m[3], Hh = +m[4], Mi = +m[5]
    var target = Date.UTC(Y, Mo - 1, D, Hh, Mi)
    var guess = target
    for (var i = 0; i < 2; i++) {
      var parts
      try {
        parts = new Intl.DateTimeFormat('en-US', {
          timeZone: tz, hour12: false,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit'
        }).formatToParts(new Date(guess))
      } catch (e) { return new Date(target) }
      var o = {}
      parts.forEach(function (p) { o[p.type] = p.value })
      var asIfUtc = Date.UTC(+o.year, +o.month - 1, +o.day, (+o.hour) % 24, +o.minute)
      guess += target - asIfUtc
    }
    return new Date(guess)
  }

  function isoOf (d) { return d && !isNaN(d.getTime()) ? d.toISOString() : null }

  function samePlace (a, b) {
    if (!a || !b) return false
    return Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lng - b.lng) < 0.01
  }

  /* ----------------------------------------------------------- storage */

  function readJson (key, fallback) {
    try {
      var raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : fallback
    } catch (e) { return fallback }
  }

  function writeJson (key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch (e) {}
  }

  function removeKey (key) {
    try { localStorage.removeItem(key) } catch (e) {}
  }

  function loadPrefs () {
    var p = readJson(PREF_KEY, {}) || {}
    prefs.language = p.language === 'en' ? 'en' : 'zh'
    prefs.tz = typeof p.tz === 'string' && p.tz ? p.tz : DEFAULT_SITE.tz
    prefs.location = (p.location && isFinite(p.location.lat) && isFinite(p.location.lng))
      ? {
          lat: p.location.lat,
          lng: p.location.lng,
          elevation: isFinite(p.location.elevation) ? p.location.elevation : 0,
          tz: p.location.tz || prefs.tz,
          // Kept, so a restored custom site still reads as custom in the panel
          // instead of being relabelled as the built-in default.
          userSet: p.location.userSet === true
        }
      : null
    // Language has its own key so clearing AI settings never resets the UI.
    var savedLang = null
    try { savedLang = localStorage.getItem(LANG_KEY) } catch (e) {}
    if (savedLang === 'en' || savedLang === 'zh') prefs.language = savedLang
    lang = prefs.language
  }

  function savePrefs () {
    writeJson(PREF_KEY, { tz: prefs.tz, location: prefs.location, language: lang })
    try { localStorage.setItem(LANG_KEY, lang) } catch (e) {}
  }

  function loadAi () {
    var saved = readJson(AI_KEY, null)
    if (saved && typeof saved === 'object') {
      // The source is restored, not forced to custom. Whether the server option
      // is actually usable is decided later by refreshServerStatus(); until
      // then a restored 'server' selection shows as unavailable rather than
      // being silently rewritten to custom behind the teacher's back.
      ai.source = saved.source === 'server' ? 'server' : 'custom'
      ai.baseUrl = typeof saved.baseUrl === 'string' ? saved.baseUrl : ''
      ai.model = typeof saved.model === 'string' ? saved.model : ''
      ai.apiKey = typeof saved.apiKey === 'string' ? saved.apiKey : ''
      ai.remember = true
    }
  }

  function persistAiIfAsked () {
    if (ai.remember) {
      writeJson(AI_KEY, {
        baseUrl: ai.baseUrl, model: ai.model, apiKey: ai.apiKey, source: ai.source
      })
    } else {
      removeKey(AI_KEY)
    }
  }

  /* ------------------------------------------------------ bridge glue */

  // Structure only: known type, no surprise fields, required fields present.
  // This is the fallback for a bridge older than 0.7.0, which had no
  // validateCommand; it deliberately says nothing about values, because the
  // panel must not keep a second opinion about ranges and layer names.
  function commandStructure (cmd) {
    var SPEC = {
      read_state: { keys: ['type'], required: [] },
      set_layer: { keys: ['type', 'layer', 'visible'], required: ['layer', 'visible'] },
      set_layer_flag: { keys: ['type', 'layer', 'visible'], required: ['layer', 'visible'] },
      select_object: { keys: ['type', 'name', 'lock'], required: ['name'] },
      set_time: { keys: ['type', 'utc'], required: ['utc'] },
      set_time_speed: { keys: ['type', 'factor', 'simHours'], required: ['factor'] },
      set_location: { keys: ['type', 'lat', 'lng', 'elevation'], required: ['lat', 'lng'] },
      set_fov: { keys: ['type', 'deg'], required: ['deg'] }
    }
    if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return 'not an object'
    var spec = SPEC[cmd.type]
    if (!spec) return 'unknown type: ' + String(cmd.type)
    var keys = Object.keys(cmd)
    for (var i = 0; i < keys.length; i++) {
      if (spec.keys.indexOf(keys[i]) < 0) return 'unexpected field: ' + keys[i]
    }
    for (var j = 0; j < spec.required.length; j++) {
      if (cmd[spec.required[j]] === undefined) return 'missing field: ' + spec.required[j]
    }
    return null
  }

  // Full check, for a plan the teacher is about to approve.
  //
  // Structure alone is not enough: `set_fov {deg: 999}` and `set_layer`
  // with an unknown layer name pass it, get shown as valid, and only fail
  // when the bridge rejects them - after the earlier commands of the same
  // batch have already been written. The bridge's validateCommand is the
  // authority (it owns the ranges, the layer list and the ISO rule), so it is
  // asked here too. A bridge that predates 0.7.0 has no such method and falls
  // back to the structural check.
  function commandAllowed (cmd) {
    var structural = commandStructure(cmd)
    if (structural) return structural
    if (!bridge || typeof bridge.validateCommand !== 'function') return null
    var v = null
    try { v = bridge.validateCommand(cmd) } catch (e) { return null }
    if (!v || v.ok !== false) return null
    var msg = v.error && v.error.message ? v.error.message : 'rejected'
    var code = v.error && v.error.code ? v.error.code : ''
    return code ? msg + ' [' + code + ']' : msg
  }

  function runCommand (cmd) {
    // The bridge only reports `applied` after reading the engine back and, for
    // animated commands, after the view has settled.
    var pending
    try { pending = bridge.executeCommand(cmd) } catch (e) {
      return Promise.resolve(handleResult({ ok: false, status: 'failed', error: { code: 'threw', message: String(e && e.message || e) } }))
    }
    if (!pending || typeof pending.then !== 'function') return Promise.resolve(handleResult(pending))
    return pending.then(handleResult, function (e) {
      flash(t('err.network', { msg: '' }) + ' ' + (e && e.message ? e.message : ''))
      return null
    })
  }

  function handleResult (res) {
    if (!res) return null
    if (!res.ok) {
      flash(res.error ? res.error.message : t('input.rejected', { msg: '' }))
      return res
    }
    if (res.status === 'timeout') {
      flash(t('err.timeout'))
    }
    if (res.state) applyState(res.state)
    return res
  }

  function flash (msg) {
    if (!el.status) return
    el.status.textContent = msg
    el.status.classList.add('swe-err')
    flashUntil = Date.now() + 5000
    clearTimeout(flashTimer)
    flashTimer = setTimeout(function () {
      flashUntil = 0
      el.status.classList.remove('swe-err')
      renderStatus()
    }, 5000)
  }

  /* --------------------------------------------------------- AI client */

  function resolveEndpoint (base, kind) {
    var b = String(base || '').trim()
    if (!b) return null
    b = b.replace(/\/+$/, '')
    if (/\/chat\/completions$/.test(b)) {
      return kind === 'chat' ? b : b.replace(/\/chat\/completions$/, '/models')
    }
    if (/\/models$/.test(b)) {
      return kind === 'models' ? b : b.replace(/\/models$/, '/chat/completions')
    }
    // Keep the user's path prefix. Only add /v1 when there is no version
    // segment already, so "…/v1" never becomes "…/v1/v1".
    if (/\/v\d+$/.test(b)) return b + (kind === 'chat' ? '/chat/completions' : '/models')
    return b + '/v1' + (kind === 'chat' ? '/chat/completions' : '/models')
  }

  /* Is a model call possible right now, under the source that is selected?
   *
   * The two answers are deliberately different. A server selection is usable
   * only when the deployment says the feature is live AND this browser has a
   * passphrase; a custom selection needs an endpoint and a model name. Neither
   * condition is allowed to stand in for the other. */
  function aiConfigured () {
    if (ai.source === 'server') {
      return !!(SERVER_AI.available && (!SERVER_AI.authRequired || SERVER_AI.authenticated))
    }
    return !!(ai.baseUrl && ai.model)
  }

  // Which endpoint a request belongs to. Captured before the await and checked
  // after it: an answer produced for the configuration the user has just
  // replaced is not an answer to anything, and must not be written into the
  // panel as if it were.
  function configToken () {
    return { seq: configSeq }
  }

  function configStillCurrent (token) {
    return !!token && token.seq === configSeq
  }

  // Called whenever the endpoint identity actually changes (not on every
  // keystroke: the caller compares old and new first).
  function noteConfigChanged () {
    configSeq += 1
    // A probe that is still waiting belongs to the old endpoint too; its
    // "testing…" spinner would never be cleared by its own callback.
    if (el.aiTestBtn) el.aiTestBtn.disabled = false
    if (el.aiTestOut && /…/.test(el.aiTestOut.textContent || '')) setAiTest('', 'warn')
    if (explainBusy || explainAbort) {
      explainSeq += 1
      if (explainAbort) { try { explainAbort.abort() } catch (e) {} }
      explainAbort = null
      explainBusy = false
      renderExplain()
    }
    // A chat request in flight belongs to the configuration it was sent
    // under. The session stays in memory, but the in-flight request is
    // aborted and a note says what happened; the next send uses the new
    // configuration (0.14.0).
    if (chat.busy || chat.abort) {
      chatAbortActive('chat.configChangedNote')
    }
    if (runningExec) {
      // A batch is mid-flight. Dropping proposalBusy alone used to leave the
      // batch's own closure alive: it kept sending the rest of the plan while
      // the panel showed no complete proposal, and the now-unlocked confirm
      // button could start it a second time. Changing the configuration is a
      // cancellation of the run, so the token has to die here.
      var sentNow = execSent
      execSeq += 1
      runningExec = 0
      proposalSeq += 1
      proposal = null
      proposalBusy = false
      if (el.askBtn) el.askBtn.disabled = false
      if (el.askStatus) {
        el.askStatus.textContent = t('input.cfgStopBatch', { sent: sentNow })
        el.askStatus.className = 'swe-note swe-err-text'
      }
      renderProposal()
    } else if (proposalBusy) {
      proposalSeq += 1
      proposalBusy = false
      if (el.askBtn) el.askBtn.disabled = false
      if (el.askStatus) {
        el.askStatus.textContent = t('input.cfgDropped')
        el.askStatus.className = 'swe-note'
      }
      renderProposal()
    } else if (proposal) {
      // Shown but not confirmed: it was written for the endpoint that no
      // longer exists. Leaving it clickable invited a confirm that would have
      // run under a different configuration than the one it was previewed in.
      proposal = null
      renderProposal()
    }
  }

  // One request, no retries. `signal` lets the caller cancel; a timeout is
  // reported distinctly from a user cancellation.
  //
  // The timer covers the WHOLE exchange, not just the response headers. An
  // endpoint that answers 200 and then stops writing used to leave the panel
  // saying "生成中" for as long as the socket stayed open, because the timer was
  // cleared as soon as fetch() resolved. It is now torn down in one place,
  // after the body has been read or after the request has failed.
  function aiRequest (url, init, timeoutMs, externalSignal) {
    var ctrl = new AbortController()
    var timedOut = false
    var timer = null
    var cleaned = false
    var onExternal = function () { try { ctrl.abort() } catch (e) {} }

    function cleanup () {
      if (cleaned) return
      cleaned = true
      if (timer !== null) { clearTimeout(timer); timer = null }
      if (externalSignal) {
        try { externalSignal.removeEventListener('abort', onExternal) } catch (e) {}
      }
    }

    timer = setTimeout(function () { timedOut = true; ctrl.abort() }, timeoutMs || GEN_TIMEOUT_MS)
    if (externalSignal) {
      if (externalSignal.aborted) onExternal()
      else externalSignal.addEventListener('abort', onExternal)
    }
    return fetch(url, {
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body,
      signal: ctrl.signal,
      mode: 'cors',
      // Custom endpoints are cross-origin by definition: sending cookies there
      // would leak this site's session to a third party. The server route is
      // same-origin and needs its cookie, so the choice is per call, never a
      // global switch on this helper.
      credentials: init.credentials || 'omit',
      cache: 'no-store'
    }).then(function (r) {
      // Deliberately still inside the timeout: a body that stalls mid-stream
      // must hit the same abort as a server that never answered.
      return r.text().then(function (text) {
        return { status: r.status, ok: r.ok, text: text }
      })
    }).then(function (out) {
      cleanup()
      return out
    }, function (e) {
      cleanup()
      if (timedOut) throw { code: 'timeout' }
      if (externalSignal && externalSignal.aborted) throw { code: 'abort' }
      throw { code: 'network', detail: e && e.message }
    })
  }

  function describeHttpFailure (r) {
    if (r.status === 401 || r.status === 403) return { code: 'auth' }
    if (r.status === 404) return { code: 'notfound' }
    if (r.status === 429) return { code: 'rate' }
    if (r.status >= 500) return { code: 'server', code2: r.status }
    return { code: 'server', code2: r.status }
  }

  /* The server route answers with stable codes, not HTTP semantics, because
   * "503" on this site means four different things: the feature is off, the
   * operator has not finished configuring it, this browser has no passphrase, or
   * the quota is spent. The teacher needs the right one. */
  function describeServerFailure (r) {
    var code = null
    try { code = (JSON.parse(r.text) || {}).error || null } catch (e) {}
    if (r.status === 401) return { code: 'serverAuth' }
    if (r.status === 403) return { code: code === 'cross_site' ? 'serverCrossSite' : 'serverAuth' }
    if (r.status === 429) return { code: 'serverQuota', detail: code }
    // 409 is the service telling us the configuration moved while this answer
    // was being produced, so the answer belongs to a question nobody is asking
    // any more. It is not a transport failure and must not be retried.
    if (r.status === 409) return { code: 'configChanged' }
    if (r.status === 413) return { code: 'serverTooLarge' }
    if (r.status === 503) return { code: 'serverOff' }
    if (r.status === 400) return { code: 'serverReject', detail: code }
    if (r.status === 504) return { code: 'serverTimeout', detail: code }
    if (r.status === 502) return { code: 'serverUpstream', detail: code }
    return { code: 'server', code2: r.status }
  }

  function errText (e) {
    if (!e) return t('err.network')
    if (e.code === 'auth') return t('err.auth')
    if (e.code === 'notfound') return t('err.notfound')
    if (e.code === 'rate') return t('err.rate')
    if (e.code === 'timeout') return t('err.timeout')
    if (e.code === 'abort') return t('err.abort')
    if (e.code === 'malformed') return t('err.malformed')
    if (e.code === 'shape') return t('err.shape')
    if (e.code === 'empty') return t('err.empty')
    if (e.code === 'badJson') return t('err.badJson')
    if (e.code === 'server') return t('err.server', { code: e.code2 })
    if (e.code === 'serverAuth') return t('err.serverAuth')
    if (e.code === 'serverQuota') return t('err.serverQuota')
    if (e.code === 'serverOff') return t('err.serverOff')
    if (e.code === 'serverReject') return t('err.serverReject')
    if (e.code === 'serverTimeout') return t('err.serverTimeout')
    if (e.code === 'serverUpstream') return t('err.serverUpstream')
    if (e.code === 'serverTooLarge') return t('err.serverTooLarge')
    if (e.code === 'serverCrossSite') return t('err.serverCrossSite')
    if (e.code === 'configChanged') return t('err.configChanged')
    if (e.code === 'network') {
      // Only the custom client can be pointed at a plain-HTTP endpoint; the
      // server route is same-origin and inherits the page's scheme.
      if (ai.source === 'custom' && typeof location !== 'undefined' &&
          location.protocol === 'https:' && /^http:\/\//i.test(ai.baseUrl)) return t('err.mixed')
      return t('err.network')
    }
    return t('err.network')
  }

  function authHeaders () {
    // An empty key must not produce a fabricated "Bearer " header.
    var hdrs = { 'Content-Type': 'application/json' }
    if (ai.apiKey) hdrs.Authorization = 'Bearer ' + ai.apiKey
    return hdrs
  }

  /* Server route: same-origin, cookie-authenticated, no key in this tab.
   *
   * Only `{messages}` is sent. The deployment refuses any other field, so
   * sending `model` or `temperature` here would be a 400, not a silent override
   * - which is the point: a browser must not be able to choose what it costs. */
  function serverChat (messages, opts) {
    var revisionAtSend = SERVER_AI.revision
    var timeoutMs = (opts && opts.timeoutMs) || window.__SWE_AI_TIMEOUT_MS__ || GEN_TIMEOUT_MS
    return aiRequest('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages }),
      credentials: 'same-origin'
    }, timeoutMs, opts && opts.signal)
      .then(function (r) {
        if (!r.ok) {
          var err = describeServerFailure(r)
          // The deployment moved on. Re-read it now, so the next ask carries
          // the current revision instead of walking into the same refusal.
          if (err.code === 'configChanged') refreshServerStatus()
          throw err
        }
        var data
        try { data = JSON.parse(r.text) } catch (e) { throw { code: 'malformed' } }
        if (!data || typeof data.content !== 'string') throw { code: 'shape' }
        if (!data.content.trim()) throw { code: 'empty' }
        // The operator may have changed the model or switched the feature off
        // while this answer was in flight. The deployment settles that itself
        // and answers 409, which is the case below. What this check adds is the
        // other order: the operator saved *before* this request was served, so
        // the answer is for a revision this tab had not seen yet.
        //
        // Treating that as "discarded" was the bug (R7): the cache stayed at
        // the old revision, so every later answer looked superseded too, and
        // the teacher paid for answer after answer that the panel threw away.
        // An answer stamped with a newer revision was produced under the
        // configuration that is current now - it is valid, and it is the cache
        // that is stale.
        if (typeof data.revision === 'number' && revisionAtSend &&
            data.revision !== revisionAtSend) {
          if (data.revision < revisionAtSend) throw { code: 'configChanged' }
          SERVER_AI.revision = data.revision
          statusAt = 0
          // The plan built from this answer must bind to the revision it was
          // ACTUALLY bought under (B2), not to the stale one this tab held at
          // send time - otherwise the confirm refuses a valid, paid answer.
          // The server already guarantees the configuration did not move
          // mid-flight (it answers 409 if it did), so its own stamp is the
          // authoritative revision for this plan.
          if (opts && typeof opts.onRevisionAccepted === 'function') {
            opts.onRevisionAccepted(data.revision)
          }
          // Quiet: this request is about to resolve, and a loud refresh would
          // cancel it on the way in.
          refreshServerStatus({ quiet: true })
        }
        return data.content
      })
  }

  function customChat (messages, opts) {
    var url = resolveEndpoint(ai.baseUrl, 'chat')
    if (!url) return Promise.reject({ code: 'network' })
    var body = JSON.stringify({
      model: ai.model,
      messages: messages,
      temperature: 0,
      stream: false
    })
    // A test seam only: the production deadline is GEN_TIMEOUT_MS. Tests set
    // window.__SWE_AI_TIMEOUT_MS__ so a timeout case does not wait three minutes.
    var timeoutMs = (opts && opts.timeoutMs) || window.__SWE_AI_TIMEOUT_MS__ || GEN_TIMEOUT_MS
    return aiRequest(url, { method: 'POST', headers: authHeaders(), body: body },
      timeoutMs, opts && opts.signal)
      .then(function (r) {
        if (!r.ok) throw describeHttpFailure(r)
        var data
        try { data = JSON.parse(r.text) } catch (e) { throw { code: 'malformed' } }
        var choice = data && data.choices && data.choices[0]
        var content = choice && choice.message && choice.message.content
        if (typeof content !== 'string') throw { code: 'shape' }
        if (!content.trim()) throw { code: 'empty' }
        return content
      })
  }

  // One entry point, two transports. Nothing above this line knows which one is
  // in use, and nothing here falls back to the other on failure.
  function chatCompletion (messages, opts) {
    return ai.source === 'server' ? serverChat(messages, opts) : customChat(messages, opts)
  }

  /* ------------------------------------------------- server AI discovery */

  // What this tab believes the deployment looks like. Captured before a refresh
  // and compared after it, so a refresh can tell "nothing moved" from "the
  // operator saved while this proposal was on screen" (R3).
  function serverSnapshot () {
    return {
      checked: SERVER_AI.checked,
      available: SERVER_AI.available,
      revision: SERVER_AI.revision,
      authenticated: SERVER_AI.authenticated,
      role: SERVER_AI.role,
      sessionTag: SERVER_AI.sessionTag
    }
  }

  function serverMoved (before) {
    if (!before || !before.checked) return false
    if (before.available !== SERVER_AI.available) return true
    if (before.revision !== SERVER_AI.revision) return true
    if (before.authenticated !== SERVER_AI.authenticated) return true
    if (before.role !== SERVER_AI.role) return true
    // A new tag means this browser's session was replaced - most plausibly by
    // another tab signing in again. Anything on screen was bought under the
    // old session and goes through the same invalidation path as any other
    // deployment change (R3 supplement).
    return (before.sessionTag || null) !== (SERVER_AI.sessionTag || null)
  }

  // Reads the two public endpoints. Never throws: a deployment without an
  // ai-service answers 404 to /api/* and that is a normal, supported state -
  // the assistant then simply reports "not provided".
  //
  // `opts.quiet` is for the resync that happens while a paid request is in
  // flight: it must update the cache without tearing down the answer that is
  // about to arrive. Every other refresh goes through the unified invalidation
  // path, because a plan on screen was written for the deployment that has just
  // been replaced, and confirming it would run under a different one.
  function refreshServerStatus (opts) {
    var quiet = !!(opts && opts.quiet)
    var token = configToken()
    var before = serverSnapshot()
    var read = false
    // C2-b: the pre-ask and pre-confirm paths WAIT on this read, so it needs a
    // deadline of its own - the 15 s probe budget, overridable by tests. The
    // request helper covers the whole exchange: a status endpoint that answers
    // its headers and then stalls hits the same abort as one that never
    // answers, instead of holding an ask or a confirm open forever.
    var deadline = (typeof window !== 'undefined' && window.__SWE_AI_STATUS_TIMEOUT_MS__) || PROBE_TIMEOUT_MS
    return aiRequest('/api/ai/config', {
      method: 'GET', credentials: 'same-origin'
    }, deadline).then(function (r) {
      if (!r.ok) throw new Error('no-config')
      var cfg = null
      try { cfg = JSON.parse(r.text) } catch (e) { throw new Error('no-config') }
      if (!configStillCurrent(token)) return
      SERVER_AI.available = !!(cfg && cfg.available)
      SERVER_AI.model = (cfg && typeof cfg.model === 'string') ? cfg.model : ''
      SERVER_AI.note = (cfg && typeof cfg.note === 'string') ? cfg.note : ''
      SERVER_AI.revision = (cfg && typeof cfg.revision === 'number') ? cfg.revision : 0
      SERVER_AI.authRequired = !!(cfg && cfg.authRequired)
      SERVER_AI.checked = true
      SERVER_AI.error = null
      read = true
      return aiRequest('/api/auth/status', {
        method: 'GET', credentials: 'same-origin'
      }, deadline).then(function (r) {
        // A non-2xx here is not "no session": it is "cannot see". Keeping the
        // old identity and calling the cache verified was the hole (R3
        // supplement) - a confirm that follows must refuse until a real read
        // succeeds.
        if (!r.ok) return null
        var st = null
        try { st = JSON.parse(r.text) } catch (e) { return null }
        return st
      }).then(function (st) {
        if (!configStillCurrent(token)) return
        if (!st) {
          SERVER_AI.verified = false
          SERVER_AI.sessionTag = null
          return
        }
        SERVER_AI.authenticated = !!st.authenticated
        SERVER_AI.role = st.role || null
        SERVER_AI.verified = true
        SERVER_AI.sessionTag = (st && typeof st.sessionTag === 'string') ? st.sessionTag : ''
      })
    }).catch(function () {
      if (!configStillCurrent(token)) return
      // C2-a: EVERY failed read - config or auth/status, network error,
      // non-2xx or deadline - leaves the same mark. The last known display
      // stays, but the session verdict is no longer verified: a paid ask held
      // against this cache used to ride a pre-outage "verified" flag all the
      // way into a generation and a confirm. The flag dies here, and the ask
      // and confirm paths check it explicitly.
      SERVER_AI.verified = false
      SERVER_AI.sessionTag = null
      // Not an error the teacher caused, and not a reason to hide the custom
      // client: this site simply has no server AI.
      SERVER_AI.available = false
      SERVER_AI.model = ''
      SERVER_AI.checked = true
      SERVER_AI.error = 'unreachable'
    }).then(function () {
      // A failed read is not a read: the next ask must try again rather than
      // treat a stale cache as freshly verified.
      if (read) statusAt = Date.now()
      if (!quiet && configStillCurrent(token) && serverMoved(before)) noteConfigChanged()
      renderAiState()
      renderAiBody()
    })
  }

  // Coalescing read used before a paid ask and before a confirm. Concurrent
  // callers share one round-trip; a cache younger than maxAgeMs is used as-is,
  // so clicking "确认" twice does not double the traffic.
  //
  // `quiet` is for the pre-ask read: at that moment nothing on screen belongs to
  // the new revision (askAssistant has already cleared the previous plan), so
  // the update must not run the invalidation path - doing so cancelled the very
  // question it was about to send.
  function ensureServerStatus (maxAgeMs, quiet) {
    if (SERVER_AI.checked && (Date.now() - statusAt) < maxAgeMs) return Promise.resolve()
    if (statusInflight) return statusInflight
    statusInflight = refreshServerStatus({ quiet: !!quiet }).then(function () {
      statusInflight = null
    }, function () { statusInflight = null })
    return statusInflight
  }

  // Classroom passphrase for the server route. Not the operator's admin token:
  // that one is for /admin and is never entered here.
  function serverLogin () {
    var value = el.aiPassInput ? el.aiPassInput.value : ''
    if (!value) { setAiTest(t('ai.passEmpty'), 'warn'); return }
    if (el.aiLoginBtn) el.aiLoginBtn.disabled = true
    setAiTest(t('ai.signingIn'), 'warn')
    aiRequest('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: value }),
      credentials: 'same-origin'
    }, PROBE_TIMEOUT_MS)
      .then(function (r) {
        if (!r.ok) {
          setAiTest(r.status === 403 ? t('ai.passWrong') : t('ai.passFailed'), 'err')
          return null
        }
        var d = null
        try { d = JSON.parse(r.text) } catch (e) {}
        if (el.aiPassInput) el.aiPassInput.value = ''
        // A new session is a new identity for the quota ledger. Anything on
        // screen was produced under the previous one (R3).
        authGen += 1
        noteConfigChanged()
        setAiTest(t('ai.signedIn'), 'ok')
        return d
      })
      .catch(function () { setAiTest(t('err.network'), 'err') })
      .then(function () {
        if (el.aiLoginBtn) el.aiLoginBtn.disabled = false
        return refreshServerStatus()
      })
  }

  function serverLogout () {
    // The passphrase stops counting the moment the teacher clicks, not when the
    // POST comes back: a plan generated under it must not stay confirmable
    // while the request is in flight, and a batch must not keep sending the
    // commands it has not sent yet (R3).
    authGen += 1
    noteConfigChanged()
    aiRequest('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }, PROBE_TIMEOUT_MS)
      .catch(function () {})
      .then(function () {
        setAiTest('', 'warn')
        return refreshServerStatus()
      })
  }

  function testConnection () {
    // Server mode has nothing to probe from here: the deployment owns the
    // endpoint, and a browser must not be able to make it fetch anything. The
    // honest action is to re-read the two public status endpoints.
    if (ai.source === 'server') {
      if (el.aiTestBtn) el.aiTestBtn.disabled = true
      setAiTest(t('ai.testing'), 'warn')
      refreshServerStatus().then(function () {
        if (el.aiTestBtn) el.aiTestBtn.disabled = false
        if (!SERVER_AI.available) { setAiTest(t('ai.serverOff'), 'err'); return }
        if (SERVER_AI.authRequired && !SERVER_AI.authenticated) { setAiTest(t('ai.serverNeedLogin'), 'err'); return }
        setAiTest(t('ai.serverOk', { model: SERVER_AI.model || '—' }), 'ok')
      })
      return
    }
    var url = resolveEndpoint(ai.baseUrl, 'models')
    if (!url) { setAiTest(t('ai.endpointEmpty'), 'warn'); return }
    // The probe is answered for whichever endpoint was configured when it was
    // sent; if that changed meanwhile, its verdict says nothing about the
    // endpoint now in the form, so it is dropped instead of shown.
    var token = configToken()
    if (el.aiTestBtn) el.aiTestBtn.disabled = true
    setAiTest(t('ai.testing'), 'warn')
    aiRequest(url, { method: 'GET', headers: ai.apiKey ? { Authorization: 'Bearer ' + ai.apiKey } : {} }, PROBE_TIMEOUT_MS)
      .then(function (r) {
        if (!configStillCurrent(token)) return
        if (!r.ok) throw describeHttpFailure(r)
        var n = null
        try {
          var d = JSON.parse(r.text)
          if (d && Array.isArray(d.data)) n = d.data.length
        } catch (e) {}
        setAiTest(n === null ? t('ai.testNoModels') : t('ai.testOk', { n: n }), 'ok')
      })
      .catch(function (e) {
        if (!configStillCurrent(token)) return
        setAiTest(errText(e), 'err')
      })
      .then(function () {
        if (!configStillCurrent(token)) return
        if (el.aiTestBtn) el.aiTestBtn.disabled = false
      })
  }

  function setAiTest (text, kind) {
    if (!el.aiTestOut) return
    el.aiTestOut.textContent = text
    el.aiTestOut.className = 'swe-note swe-ai-test ' + (kind === 'ok' ? 'swe-ok' : kind === 'err' ? 'swe-err-text' : '')
  }

  /* ------------------------------------------------------ explanation */

  // The payload an explanation (or chat turn) sends. `forModel` strips the
  // internal bookkeeping (snapshotId / revision / viewId): those are debugging
  // fields of THIS panel, and a teaching answer has no business reciting them.
  // Numbers keep only meaningful precision - a magnitude of 0.54598156453 is
  // the same sky as 0.5, and the long tail invites the model to read digits
  // aloud. `locationSent` stays false: the explanation never carries the site.
  function snapshotForModel (st, snapshotId, forModel) {
    var sel = st.selection
    var payload = {
      object: sel ? {
        designation: sel.displayName || sel.designation,
        type: sel.otypeName || null,
        magnitude: typeof sel.vmag === 'number' ? Math.round(sel.vmag * 10) / 10 : null,
        // R2: significant digits - the Moon at 0.0026 AU must not round to 0.
        distanceAu: typeof sel.distanceAu === 'number'
          ? Number(sel.distanceAu.toPrecision(3))
          : null
      } : null,
      observing: {
        utc: st.time ? st.time.utc : null,
        timeZone: prefs.tz,
        locationSent: false,
        altitudeDeg: sel && sel.alt !== null ? Math.round(sel.alt) : null,
        azimuthDeg: sel && sel.az !== null ? Math.round(sel.az) : null,
        fovDeg: st.view.fovDeg === null ? null : Math.round(st.view.fovDeg)
      }
    }
    if (!forModel) {
      payload.snapshotId = snapshotId
      payload.revision = st.revision
      payload.viewId = st.viewId
    }
    return payload
  }

  // 0.14.0: the old prompt asked for 80-140 characters from snapshot values
  // only, and got exactly that - a recitation of magnitudes and angles plus
  // filler like "有观测依据". The new one asks for the three-part teaching
  // answer, states the trust boundaries (reliable common knowledge is allowed
  // and must not be dressed up as measurement; everything dynamic is read
  // back), and bans the filler phrases outright. Length follows the content.
  function explanationPrompt (snap) {
    var below = snap.observing.altitudeDeg !== null && snap.observing.altitudeDeg < 0
    if (lang === 'en') {
      return [
        'You are an astronomy teaching assistant. The teacher will read your answer aloud beside the star chart.',
        'Write in English as ONE flowing answer in three parts, without headings:',
        '1) What the object is and why it is worth seeing - reliable astronomical common knowledge is allowed, but never present it as a live measurement.',
        '2) What the snapshot below means here - use ONLY its values, keep meaningful precision (no digit recitals), and say what those numbers imply for viewing right now.',
        '3) What to do next for the CURRENT field of view - one concrete suggestion (centre it, narrow the field, compare), and say whether that advice is for the chart, the naked eye, or an eyepiece.',
        'Boundaries: never invent distance, ring tilt, moon phase, weather, ground obstruction or real visibility; magnitude and altitude alone do not guarantee the object is visible or detailed; the observing site is the software\'s simulated location (say so when it matters); if weather is unknown add ONE short closing note, not a disclaimer in every paragraph.',
        'No filler sentences ("based on observations", "subject to actual sky conditions"). Length should follow the content, not a word count.',
        below
          ? 'The object is BELOW the horizon right now: state plainly that it cannot be observed at this moment.'
          : 'Do not claim naked-eye visibility unless the altitude and magnitude support it.',
        '',
        JSON.stringify(snap)
      ].join('\n')
    }
    return [
      '你是一个面向课堂的天文教学助手。老师会把你写的讲解在星图面板旁直接读出来。',
      '用中文写一段连贯的回答，分三层内容，不用小标题：',
      '1）它是什么、值得看什么：可以使用可靠的天文常识，但不要把常识伪装成实时测量或已验证的文献。',
      '2）当前快照说明什么：只使用快照里出现的数值，保留有意义的精度（不要逐位照念），并说明这些数值对"此刻观看"意味着什么。',
      '3）下一步怎么看：结合当前视场给一条具体建议（居中、缩小视场、对比等），并说明这条建议针对的是星图画面、肉眼实景还是目镜观测。',
      '边界：不编造距离、环倾角、月相、天气、地面遮挡与实际可见性；只有星等和高度不能保证看得见、更不能保证看清细节；观测地点是软件的模拟地点，必要时明确说明；天气未知时结尾用一句话统一提醒即可，不要每段都免责。',
      '禁止无信息套话（"有观测依据""仍以实际天空为准"之类一律不要）；篇幅以把三件事讲清楚为准，不设固定字数。',
      below
        ? '该天体当前高度角为负：必须明确说明它现在位于地平线以下、无法观测。'
        : '除非高度角和星等支持，否则不要断言肉眼现在可见。',
      '',
      JSON.stringify(snap)
    ].join('\n')
  }

  function requestExplanation () {
    if (!state || !state.selection) return
    if (!aiConfigured()) { flash(t('explain.needAi')); return }

    // A second press supersedes the first instead of being ignored: the user
    // changed their mind, and the seq guard drops whatever the old request
    // returns later.
    var snap = bridge.captureSnapshot()
    if (!snap) { flash(t('explain.freezeFailed')); return }

    var reqId = ++explainSeq
    // Frozen with the request: an answer about A that arrives after the
    // teacher went to B and back to A is about a moment they have left, and
    // showing it as the current object's explanation is misleading.
    var epochAtRequest = skyEpoch
    explainBusy = true
    explanation = null
    if (explainAbort) { try { explainAbort.abort() } catch (e) {} }
    explainAbort = new AbortController()
    renderExplain()

    var payload = snapshotForModel(snap, snap.snapshotId, true)
    var token = configToken()
    chatCompletion([
      { role: 'system', content: explanationPrompt(payload) },
      { role: 'user', content: lang === 'en' ? 'Explain this object.' : '请讲解这个天体。' }
    ], { signal: explainAbort.signal }).then(function (text) {
      // A late answer for an older request must never overwrite a newer one,
      // and an answer from an endpoint that is no longer configured must not
      // appear under the current one.
      if (reqId !== explainSeq || !configStillCurrent(token)) return
      if (epochAtRequest !== skyEpoch) {
        explainBusy = false
        flash(t('explain.ctxChanged'))
        renderExplain()
        return
      }
      explainBusy = false
      explanation = {
        id: reqId,
        text: text,
        snapshot: snap,
        snapshotId: snap.snapshotId,
        // R6: the origin of "继续交流" is THIS explanation, frozen at its own
        // moment - not whatever happens to be selected when the button is
        // clicked later.
        payload: snapshotForModel(snap, snap.snapshotId, true),
        objectId: snap.selection ? snap.selection.id : null,
        objectName: snap.selection ? (snap.selection.displayName || snap.selection.designation) : null,
        language: lang,
        at: Date.now()
      }
      renderExplain()
    }, function (e) {
      if (reqId !== explainSeq || !configStillCurrent(token)) return
      explainBusy = false
      if (e && e.code === 'abort') { renderExplain(); return }
      flash(t('explain.offline', { msg: errText(e) }))
      renderExplain()
    })
  }

  function cancelExplanation () {
    explainSeq += 1
    explainBusy = false
    if (explainAbort) { try { explainAbort.abort() } catch (e) {} explainAbort = null }
    renderExplain()
  }

  function freezeSnapshot () {
    var snap = bridge.captureSnapshot()
    if (!snap) { flash(t('explain.freezeFailed')); return }
    frozen = snap
    lastExplainKey = null
    renderExplain()
  }

  /* ------------------------------- multi-turn chat & recommendations --- */

  // 0.14.0. Two features that share one boundary: the engine (bridge) is the
  // only source of dynamic numbers, the model only explains what the program
  // selected, and every request is one explicit user action.

  var skyRef = window.SWE_SKY_TARGETS || null
  // The assistant bundle's own base URL, so an OPTIONAL curated-target file is
  // fetched from beside it. Same-origin by construction (the loader injected
  // this very script from there); no remote hosts, no keys, one quiet attempt
  // at init - never on open, never on language or selection changes.
  var ASSISTANT_BASE = (function () {
    try { return new URL('.', document.currentScript.src).href } catch (e) { return null }
  })()

  function chatQuickKeys () {
    return [
      { kind: 'eye', label: t('chat.quickEye') },
      { kind: 'scope', label: t('chat.quickScope') },
      { kind: 'what', label: t('chat.quickWhat') },
      { kind: 'why', label: t('chat.quickWhy') }
    ]
  }

  function ensureChatDom () {
    if (el.chatBackdrop) return
    el.chatBackdrop = h('div', { class: 'swe-chat-backdrop', 'data-swe-chat': 'backdrop' }, [
      el.chatBox = h('aside', {
        class: 'swe-chat', role: 'dialog', 'aria-modal': 'true',
        'aria-label': t('chat.title'), 'data-swe-chat': 'panel'
      }, [
        h('header', { class: 'swe-chat-head' }, [
          h('strong', { class: 'swe-chat-title', 'data-swe-chat': 'title', text: t('chat.title') }),
          el.chatTopic = h('span', { class: 'swe-chat-topic', 'data-swe-chat': 'topic' }),
          h('span', { class: 'swe-chat-head-btns' }, [
            el.chatRetopicBtn = h('button', {
              class: 'swe-btn', type: 'button', 'data-swe-action': 'chat-retopic',
              text: t('chat.retopic'), onclick: chatRetopic
            }),
            h('button', {
              class: 'swe-btn', type: 'button', 'data-swe-action': 'chat-clear',
              text: t('chat.clear'), onclick: clearChat
            }),
            h('button', {
              class: 'swe-btn', type: 'button', 'data-swe-action': 'chat-close',
              'aria-label': t('chat.close'), text: '×', onclick: closeChat
            })
          ])
        ]),
        h('p', { class: 'swe-note', 'data-swe-chat': 'disclaimer', text: t('chat.disclaimer') }),
        el.chatLog = h('div', { class: 'swe-chat-log', 'data-swe-chat': 'log' }),
        el.chatQuick = h('div', { class: 'swe-chat-quick', 'data-swe-chat': 'quick' }),
        h('footer', { class: 'swe-chat-foot' }, [
          el.chatInput = h('input', {
            class: 'swe-chat-input', type: 'text', 'data-swe-chat': 'input',
            'data-i18n-ph': 'chat.placeholder',
            placeholder: t('chat.placeholder')
          }),
          el.chatSendBtn = h('button', {
            class: 'swe-btn swe-primary', type: 'button', 'data-swe-action': 'chat-send',
            text: t('chat.send'), onclick: function () { chatSend(el.chatInput.value) }
          }),
          el.chatStopBtn = h('button', {
            class: 'swe-btn', type: 'button', 'data-swe-action': 'chat-stop',
            text: t('chat.stop'), onclick: chatStop
          })
        ]),
        h('p', { class: 'swe-note', 'data-swe-chat': 'memory', text: t('chat.memoryNote') }),
        el.chatTruncated = h('p', { class: 'swe-note', 'data-swe-chat': 'truncated' })
      ])
    ])
    el.chatInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        chatSend(el.chatInput.value)
      }
    })
    document.body.appendChild(el.chatBackdrop)
  }

  function renderChat () {
    if (!el.chatBackdrop) return
    // Chrome texts are rebuilt here rather than via data-i18n: the popup lives
    // on document.body, outside the panel that applyLanguage() walks.
    el.chatBox.setAttribute('aria-label', t('chat.title'))
    el.chatBox.querySelector('[data-swe-chat="title"]').textContent = t('chat.title')
    el.chatRetopicBtn.textContent = t('chat.retopic')
    el.chatBox.querySelector('[data-swe-action="chat-clear"]').textContent = t('chat.clear')
    el.chatSendBtn.textContent = t('chat.send')
    el.chatStopBtn.textContent = t('chat.stop')
    el.chatInput.setAttribute('placeholder', t('chat.placeholder'))
    el.chatBox.querySelector('[data-swe-chat="memory"]').textContent = t('chat.memoryNote')
    el.chatBox.querySelector('[data-swe-chat="disclaimer"]').textContent = t('chat.disclaimer')
    el.chatTopic.textContent = chat.topic
      ? t('chat.about', { name: chat.topic.displayName || chat.topic.designation })
      : t('chat.aboutNone')
    el.chatRetopicBtn.disabled = chat.busy || !state || !state.selection ||
      (chat.topic && state.selection.designation === chat.topic.designation)
    el.chatSendBtn.disabled = chat.busy
    el.chatStopBtn.style.display = chat.busy ? '' : 'none'
    el.chatTruncated.textContent = chat.truncated > 0
      ? t('chat.truncated', { n: chat.truncated })
      : ''

    el.chatLog.textContent = ''
    if (chat.messages.length === 0) {
      el.chatLog.appendChild(h('p', { class: 'swe-empty', 'data-swe-chat': 'empty', text: t('chat.empty') }))
    }
    chat.messages.forEach(function (m) {
      if (m.role === 'note') {
        el.chatLog.appendChild(h('p', { class: 'swe-note swe-chat-note', 'data-swe-chat-note': 'true', text: m.text }))
        return
      }
      el.chatLog.appendChild(h('div', { class: 'swe-msg swe-msg-' + m.role, 'data-swe-msg-role': m.role }, [
        h('p', { text: m.text })
      ]))
    })
    el.chatLog.scrollTop = el.chatLog.scrollHeight

    el.chatQuick.textContent = ''
    chatQuickKeys().forEach(function (q) {
      el.chatQuick.appendChild(h('button', {
        class: 'swe-btn swe-chat-chip', type: 'button',
        'data-swe-chat-quick': q.kind, text: q.label,
        onclick: function () { chatQuickAction(q.kind) }
      }))
    })
    el.chatLog.scrollTop = el.chatLog.scrollHeight
  }

  // Opens the popup. NEVER calls the model: mode 'continue' carries the body,
  // the original explanation and its snapshot as context for the FIRST send;
  // mode 'ask' is the no-selection entry.
  function openChat (mode, payload) {
    ensureChatDom()
    chat.open = true
    // The stylesheet keeps .swe-chat-backdrop display:none; the inline value
    // must OVERRIDE it ('' would fall back to the rule and hide the popup).
    el.chatBackdrop.style.display = 'block'
    if (mode === 'continue') {
      // R6: "继续交流" continues THIS EXPLANATION, from the object and
      // snapshot the explanation itself froze - even if the teacher has since
      // selected something else. Falling back to the current selection only
      // when no explanation exists.
      if (explanation) {
        chat.topic = {
          designation: explanation.objectId || explanation.objectName,
          displayName: explanation.objectName || explanation.objectId || chat.topic && chat.topic.displayName
        }
        chat.origin = {
          explanation: explanation.text,
          snapshotPayload: explanation.payload,
          snapshotId: explanation.snapshotId
        }
      } else if (state && state.selection) {
        chat.topic = {
          designation: state.selection.designation,
          displayName: state.selection.displayName || state.selection.designation
        }
        chat.origin = payload || null
      } else {
        chat.topic = null
        chat.origin = null
      }
    } else if (mode === 'ask') {
      chat.topic = null
      chat.origin = null
    }
    chat.pendingDigest = (payload && payload.digest) || chat.pendingDigest
    renderChat()
    if (el.chatInput) el.chatInput.focus()
  }

  function closeChat () {
    chat.open = false
    chatAbortActive('chat.closedNote')
    if (el.chatBackdrop) el.chatBackdrop.style.display = 'none'
    if (el.chatInput) el.chatInput.blur()
    // Focus goes back to the control that most plausibly opened the popup.
    if (el.askBtn) el.askBtn.focus()
  }

  function clearChat () {
    chatAbortActive('chat.clearedNote')
    chat.messages = []
    chat.topic = null
    chat.origin = null
    chat.pendingDigest = null
    chat.truncated = 0
    renderChat()
    if (el.chatInput) el.chatInput.focus()
  }

  // Aborts an in-flight generation and drops whatever it might still return.
  // The note says plainly that stopping the local request does not stop the
  // upstream: if generation already started, the quota may already be spent.
  function chatAbortActive (noteKey) {
    chat.seq += 1
    chat.busy = false
    if (chat.abort) { try { chat.abort.abort() } catch (e) {} chat.abort = null }
    if (noteKey) {
      chat.messages.push({ role: 'note', text: t(noteKey), at: Date.now() })
    }
    renderChat()
  }

  function chatNote (text) {
    chat.messages.push({ role: 'note', text: text, at: Date.now() })
    renderChat()
  }

  /* The system message separates the three kinds of content the model will
   * see: the rules (this text), engine readbacks (labelled snapshots and
   * digests), and the conversation. Prior assistant messages are part of the
   * conversation, NOT engine facts. */
  // Identity comparison key for "is the discussion object the same body as
  // the current selection": trimmed + case-folded, the retopic button's
  // equality check made whitespace/case tolerant.
  function desigKey (v) {
    return String(v || '').trim().toUpperCase()
  }

  /* The system message separates the three kinds of content the model will
   * see: the rules (this text), engine readbacks (labelled snapshots and
   * digests), and the conversation. Prior assistant messages are part of the
   * conversation, NOT engine facts. Returned in PARTS (R9, review round 3):
   * base rules + two optional engine-readback blocks, so the send path can
   * shed an over-long optional block visibly instead of shipping a payload
   * the server is guaranteed to refuse. */
  function chatSystemParts (freshPayload, freshOther) {
    var lines
    if (lang === 'en') {
      lines = [
        'You are an astronomy teaching assistant in a multi-turn conversation beside a planetarium chart.',
        'TRUST BOUNDARIES. Engine readbacks arrive as labelled JSON (snapshot, recommendation); they are the only live facts. Reliable astronomical common knowledge is allowed but must not be dressed up as measurement. Earlier assistant messages are conversation, not instrument readings.',
        'Never invent distance, ring tilt, moon phase, weather, obstruction or real visibility; magnitude and altitude alone do not guarantee visibility or detail; the observing site is the software\'s simulated location; keep unknown values unknown.',
        'The conversation does NOT control the chart. If the teacher wants a change, tell them which panel action to use.',
        'Answer in the teacher\'s language. Be concrete; no filler disclaimers in every paragraph.'
      ]
    } else {
      lines = [
        '你是星图软件面板旁的天文教学助手，与老师进行多轮交流。',
        '可信边界。引擎读回数据以带标签的 JSON 出现（快照、推荐结果），它们是仅有的实时事实；可靠的天文常识可以使用，但不得伪装成实时测量；此前助手的回复属于对话内容，不是仪器读数。',
        '不编造距离、环倾角、月相、天气、遮挡与实际可见性；只有星等和高度不能保证可见或看清；观测地点是软件模拟地点；缺失的数值保持未知。',
        '普通对话不操作星图。老师想改天空时，请告诉他使用面板上的哪个功能。',
        '用老师的语言回答，具体、直接，不要每段重复免责。'
      ]
    }
    if (chat.topic) {
      lines.push(lang === 'en'
        ? 'Current discussion object: ' + (chat.topic.displayName || chat.topic.designation) + '. Switching the chart selection does NOT change this topic unless the teacher asks to switch.'
        : '当前讨论对象：' + (chat.topic.displayName || chat.topic.designation) + '。切换星图选择不会改变这个话题，除非老师主动要求改聊。')
    } else {
      lines.push(lang === 'en'
        ? 'No specific object is selected; the teacher is asking about the sky in general.'
        : '当前没有特定讨论对象，老师在泛问星空。')
    }
    if (chat.origin && chat.origin.explanation) {
      var cite = chat.origin.explanation
      if (cite.length > CHAT_ORIGIN_CITE_CHARS) {
        // R9: a very long origin would eat the whole budget on its own. Quote
        // a bounded excerpt and SAY so - the model is not silently given a
        // rewritten history.
        cite = cite.slice(0, CHAT_ORIGIN_CITE_CHARS) +
          (lang === 'en' ? ' …[the explanation was longer; this is an excerpt]' : ' …[原讲解较长，此处为节选]')
      }
      lines.push(lang === 'en'
        ? 'The conversation continues after this explanation you wrote earlier:\n' + cite
        : '本次交流承接你此前写的讲解：\n' + cite)
    }
    if (chat.origin && chat.origin.snapshotPayload) {
      lines.push((lang === 'en' ? 'Snapshot at explanation time: ' : '讲解时快照：') +
        JSON.stringify(chat.origin.snapshotPayload))
    }
    // Optional part 1 (R9): the send-time snapshot. R6 (review round 3):
    // when the discussion object is a DIFFERENT body, the snapshot belongs to
    // the current selection and is labelled as such - it is never presented
    // as an update basis for the discussion object, which has no fresh
    // reading in this conversation.
    var fresh = null
    if (freshPayload) {
      if (freshOther && freshOther.name) {
        fresh = (lang === 'en'
          ? 'Snapshot at send time of the CURRENTLY SELECTED object (' + freshOther.name +
            '), which is NOT the discussion object: these readings belong to the selection; do NOT use them to update or infer the discussion object - it has no fresh reading in this conversation.'
          : '发送时快照——当前星图选中对象：' + freshOther.name +
            '。它与讨论对象不同：这些读数属于选中的对象，不得用来更新或推断讨论对象；讨论对象在本次对话中没有新读数。') +
          '\n' + JSON.stringify(freshPayload)
      } else {
        fresh = (lang === 'en' ? 'Snapshot at send time (fresher than the one above when the sky moved): ' : '发送时快照（若天空已变化，以此为准，与讲解时快照区分）：') +
          JSON.stringify(freshPayload)
      }
    }
    // Optional part 2 (R9): the recommendation digest.
    var digest = null
    if (chat.pendingDigest) {
      // R1 (review round 3): a retained digest may predate the current chart
      // time (a historical basis). The label must state its own vintage from
      // the attribution the digest carries, never claim "current chart time".
      var dg = chat.pendingDigest
      digest = (lang === 'en'
        ? 'Program-selected recommendation (computed for UTC ' + (dg.computedForUtc || 'unknown') +
          ', site ' + JSON.stringify(dg.computedForSite || null) +
          '; if the chart has moved on since, this is the HISTORICAL basis, not a fresh query; candidates are fixed; explain, do not re-select): '
        : '程序筛选的推荐结果（计算时刻 ' + (dg.computedForUtc || '未知') +
          '，地点 ' + JSON.stringify(dg.computedForSite || null) +
          '；若星图时刻已变化，这是历史依据而非新查询；候选已定，请解释而非重选）：') +
        JSON.stringify(dg)
    }
    return { base: lines, fresh: fresh, digest: digest }
  }

  function chatSystemPrompt (freshPayload, freshOther) {
    var p = chatSystemParts(freshPayload, freshOther)
    if (p.fresh) p.base.push(p.fresh)
    if (p.digest) p.base.push(p.digest)
    return p.base.join('\n')
  }

  // Last CHAT_MAX_MESSAGES non-note entries, oldest-first. Notes are UI state,
  // not conversation. The UI reports how many were dropped.
  function chatHistoryForModel () {
    var convo = chat.messages.filter(function (m) { return m.role !== 'note' })
    var overflow = convo.length > CHAT_MAX_MESSAGES ? convo.length - CHAT_MAX_MESSAGES : 0
    return {
      dropped: overflow,
      messages: convo.slice(convo.length - CHAT_MAX_MESSAGES).map(function (m) {
        return { role: m.role, content: m.text }
      })
    }
  }

  // R1 (review round 2): free-typed questions and the quick buttons share one
  // data path. A recommendation intent always has program-selected candidates
  // with real positions attached; the model never guesses the live sky.
  // A "now/tonight" question recomputes freshly (a new query, explicitly);
  // follow-ups reuse the retained digest as their historical basis.
  function recommendationIntent (text) {
    return /(适合看|值得看|看什么|能看什么|可以看|推荐|肉眼|望远镜|观测目标|what (?:should|can|is worth)|(?:see|watch|observe).*(?:tonight|now|today)|naked.?eye|telescope|recommend)/i.test(text)
  }
  function freshRecommendationIntent (text) {
    return /(现在|此刻|今晚|今天|now|tonight|today)/i.test(text)
  }
  // R1 (review round 3): a follow-up ABOUT an earlier recommendation ("刚才推
  // 荐的为什么适合望远镜？") must reuse that recommendation as its historical
  // basis, not silently recompute it at the moved chart time. The reference is
  // explicit wording, not a bare keyword: "刚才/上次/之前" or an English
  // pointer at what was just recommended.
  var HISTORICAL_REC_RE = /(?:刚才|刚刚|上次|之前|先前|前不久|you (?:just )?recommended|just recommended|the recommendation|(?:my|your|the) (?:earlier|previous) (?:recommendation|targets|list)|last time|earlier on)/i
  function historicalRecIntent (text) {
    return HISTORICAL_REC_RE.test(text)
  }

  /* R9 (review round 3): the composed payload must fit the server's real
   * limits before it leaves - per-message cap, message count, and total.
   * Three shedding stages, all visible to the caller:
   *   1. an OLD turn over the per-message cap (e.g. a very long assistant
   *      reply produced by another source) can NEVER be sent, so it is
   *      dropped from the payload; it stays visible in the transcript;
   *   2. turns beyond the server's message count are shed oldest-first;
   *   3. oldest non-system turns are shed until the total fits.
   * The system message (index 0) and the newest turn are never dropped; the
   * user's own text was already capped at the input box. */
  function makePayloadFit (messages) {
    var total = function (ms) {
      var n = 0
      ms.forEach(function (m) { n += m.content.length })
      return n
    }
    var droppedLong = 0
    var shed = 0
    var i
    for (i = messages.length - 1; i >= 1; i--) {
      if (messages[i].content.length > CHAT_SERVER_MESSAGE_CHARS) {
        messages.splice(i, 1)
        droppedLong += 1
      }
    }
    while (messages.length > CHAT_SERVER_MAX_MESSAGES) {
      messages.splice(1, 1)
      shed += 1
    }
    while (messages.length > 2 && total(messages) > CHAT_BUDGET_CHARS && shed < 200) {
      messages.splice(1, 1)
      shed += 1
    }
    return { droppedLong: droppedLong, shed: shed }
  }

  function chatSend (raw) {
    var text = (raw || '').trim()
    if (!el.chatInput) return
    if (chat.busy) return
    if (!text) return
    // R9: refuse an oversized single message BEFORE anything happens; the
    // original text goes back to the input box untouched for the user to
    // split - never silently rewritten.
    if (text.length > CHAT_MAX_MESSAGE_CHARS) {
      chatNote(t('chat.tooLong', { n: text.length, max: CHAT_MAX_MESSAGE_CHARS }))
      return
    }
    if (!aiConfigured()) {
      chatNote(t('chat.needAi'))
      return
    }
    el.chatInput.value = ''
    chat.busy = true
    renderChat()

    var mySeq = ++chat.seq
    // R4 (review round 2, priority): a server-mode send re-verifies the
    // deployment RIGHT BEFORE spending - the same cancellable read the
    // proposal path uses. A healthy chat route behind a failing status
    // endpoint must refuse, not spend; cancel/clear/config during the
    // preflight bumps the seq and the send never happens.
    var preflight = (ai.source === 'server') ? ensureServerStatus(0, true) : Promise.resolve()
    preflight.then(function () {
      try {
      if (mySeq !== chat.seq) return
      if (!aiConfigured()) {
        chat.busy = false
        chatNote(t('chat.needAi'))
        renderChat()
        return
      }
      if (ai.source === 'server' && !SERVER_AI.verified) {
        chat.busy = false
        chatNote(t('chat.unverifiedNote'))
        renderChat()
        return
      }

      // R1 (review round 3): recommendation intents go through the
      // deterministic data path, and the recompute decision follows the time
      // reference, not just the keywords:
      //   - a fresh "now/tonight" question ("现在呢？", with or without
      //     recommendation words) recomputes at the CURRENT chart time and
      //     replaces the retained digest (a new query, new attribution);
      //   - a follow-up ABOUT an earlier recommendation ("刚才推荐的为什么
      //     适合望远镜？") keeps the retained digest as its historical basis;
      //   - any other recommendation question recomputes (there is nothing
      //     historical to preserve when no digest is retained).
      var wantsRec = recommendationIntent(text)
      var freshTime = freshRecommendationIntent(text)
      var shouldCompute = freshTime ||
        (wantsRec && !(historicalRecIntent(text) && chat.pendingDigest))
      if (shouldCompute) {
        var computed = computeRecommendation()
        if (!computed || computed.error) {
          chat.busy = false
          chatNote(t('rec.bridgeOld'))
          if (el.chatInput && !el.chatInput.value) el.chatInput.value = text
          renderChat()
          return
        }
        publishRecommendation(computed)
        // A new query replaces the digest and carries its own time/site
        // attribution (R7); a historical follow-up keeps the retained one.
        chat.pendingDigest = skyRef
          ? skyRef.toModelDigest(computed.rec, lang, { utc: computed.utc, site: computed.site })
          : null
      }

      var userText = text

      // R6 (review round 3): the fresh snapshot belongs to the CURRENT
      // selection. When the discussion is a continued explanation of another
      // body, it goes out labelled as the selection's reading - never as an
      // update basis for the discussion object, which has no fresh reading
      // in this conversation.
      var freshSnap = bridge.captureSnapshot()
      var freshPayload = freshSnap ? snapshotForModel(freshSnap, freshSnap.snapshotId, true) : null
      var topicKey = chat.topic ? desigKey(chat.topic.designation) : null
      var selBody = (freshSnap && freshSnap.selection) || (state && state.selection) || null
      var selKey = selBody ? desigKey(selBody.designation) : null
      var freshOther = (topicKey && selKey && topicKey !== selKey)
        ? { name: String(selBody.displayName || selBody.designation || '') }
        : null

      // R9 (review round 3): compose the payload, then make it fit the
      // server's real per-message limit and total budget. Optional system
      // parts are shed with a visible note; a system message that still
      // cannot fit refuses the whole send (the typed text goes back to the
      // input box, unchanged) instead of failing on the server forever.
      var parts = chatSystemParts(freshPayload, freshOther)
      var sysLen = function (p) {
        return p.base.concat(p.fresh ? [p.fresh] : [], p.digest ? [p.digest] : []).join('\n').length
      }
      var shedDigest = false
      var shedSnapshot = false
      if (sysLen(parts) > CHAT_SERVER_MESSAGE_CHARS && parts.digest) {
        parts.digest = null
        shedDigest = true
      }
      if (sysLen(parts) > CHAT_SERVER_MESSAGE_CHARS && parts.fresh) {
        parts.fresh = null
        shedSnapshot = true
      }
      if (sysLen(parts) > CHAT_SERVER_MESSAGE_CHARS) {
        chat.busy = false
        chatNote(t('chat.payloadTooLong'))
        if (el.chatInput && !el.chatInput.value) el.chatInput.value = userText
        renderChat()
        return
      }
      var history = chatHistoryForModel()
      chat.truncated = history.dropped
      var messages = [{ role: 'system', content: parts.base
        .concat(parts.fresh ? [parts.fresh] : [])
        .concat(parts.digest ? [parts.digest] : [])
        .join('\n') }].concat(history.messages)
      messages.push({ role: 'user', content: userText })
      var fit = makePayloadFit(messages)
      chat.truncated += fit.droppedLong + fit.shed
      // The shedding is REPORTED, not silent: what the model will and will
      // not see is part of the trust boundary.
      if (fit.droppedLong) chatNote(t('chat.droppedLong', { n: fit.droppedLong, max: CHAT_SERVER_MESSAGE_CHARS }))
      if (shedDigest) chatNote(t('chat.digestShed'))
      if (shedSnapshot) chatNote(t('chat.snapshotShed'))
      renderChat()

      var myMsgId = ++chat.msgSeq
      chat.messages.push({ role: 'user', id: myMsgId, text: userText, at: Date.now() })
      chat.busy = true
      renderChat()

      var sendSeq = ++chat.seq
      var token = configToken()
      chat.abort = new AbortController()
      chatCompletion(messages, { signal: chat.abort.signal }).then(function (reply) {
        if (sendSeq !== chat.seq || !configStillCurrent(token)) return // late reply
        chat.busy = false
        chat.abort = null
        chat.messages.push({ role: 'assistant', text: reply, at: Date.now() })
        // The digest STAYS attached as the historical basis for follow-up
        // questions (R1); a new recommendation query replaces it.
        renderChat()
      }, function (e) {
        if (sendSeq !== chat.seq || !configStillCurrent(token)) return
        chat.busy = false
        chat.abort = null
        if (e && e.code === 'abort') { renderChat(); return }
        // R9 (review round 3): a failed turn must not poison the history.
        // The failed user message is recovered by the id it was bound to,
        // not by array position - a busy-time note (or any later UI message)
        // may sit after it, and only THIS turn's text goes back to the input
        // box for a recoverable retry. Nothing silently rewritten.
        for (var i = chat.messages.length - 1; i >= 0; i--) {
          if (chat.messages[i].id === myMsgId) {
            chat.messages.splice(i, 1)
            if (el.chatInput && !el.chatInput.value) el.chatInput.value = userText
            break
          }
        }
        chatNote(t('chat.error', { msg: errText(e) }))
      })
      } catch (e) {
        // A bug in the send path must be VISIBLE, never a latched busy flag
        // that silently swallows every later send.
        chat.busy = false
        chat.abort = null
        chatNote(t('chat.error', { msg: e && e.message ? e.message : 'unknown' }))
      }
    }, function () {
      // The preflight read itself failed (network/deadline) - fail closed.
      if (mySeq !== chat.seq) return
      chat.busy = false
      chatNote(t('chat.unverifiedNote'))
      renderChat()
    })
  }

  function chatStop () {
    chatAbortActive('chat.stoppedNote')
  }

  function chatRetopic () {
    if (!state || !state.selection) return
    // R6: the old topic's in-flight request belongs to the old discussion.
    // Cancelling here (seq bump + abort) is what keeps an old answer from
    // landing under the new topic; the historical turns stay, clearly
    // separated by the switch note, and the origin no longer describes the
    // new topic.
    chatAbortActive(null)
    chat.origin = null
    chat.pendingDigest = null
    chat.topic = {
      designation: state.selection.designation,
      displayName: state.selection.displayName || state.selection.designation
    }
    chatNote(t('chat.retopped', { name: chat.topic.displayName || chat.topic.designation }))
  }

  /* Quick questions are wired to behaviour, not placeholders:
   *   eye/scope/what -> compute the deterministic recommendation for the
   *                     current chart time, attach its digest, and send the
   *                     question (the model explains the fixed selection);
   *   why            -> a plain follow-up about the current discussion object.
   * Without a configured model the recommendation still renders in the panel
   * (requestRecommendation), and the chat says so instead of faking an AI
   * answer. */
  function chatQuickAction (kind) {
    // R8: a quick tap during a generating reply used to rewrite the topic to
    // "ask the sky", clear the digest, and then silently send nothing. Now it
    // changes NOTHING until the current turn is finished or stopped.
    if (chat.busy) { chatNote(t('chat.busyNote')); return }
    if (kind === 'why') {
      if (!chat.topic) { chatNote(t('chat.whyNeedTopic')); return }
      chatSend(t('chat.quickWhy'))
      return
    }
    var computed = computeRecommendation()
    if (!computed || computed.error) {
      chatNote(t('rec.bridgeOld'))
      return
    }
    var question = kind === 'scope' ? t('chat.quickScope') : t('chat.quickWhat')
    if (kind === 'eye') question = t('chat.quickEye')
    publishRecommendation(computed)
    if (!aiConfigured()) {
      chatNote(t('chat.needAi'))
      return
    }
    chat.pendingDigest = skyRef
      ? skyRef.toModelDigest(computed.rec, lang, { utc: computed.utc, site: computed.site })
      : null
    openChat('ask')
    chatSend(question)
  }

  /* ---------------------------------------------- current-time advice */

  function queryAllBodies (designations) {
    // The bridge caps one query at 16; chunk so a bigger curated file still
    // works without trying to lift the cap from the outside.
    var out = {}
    for (var i = 0; i < designations.length; i += skyRef.queryMax) {
      var r = bridge.queryBodies(designations.slice(i, i + skyRef.queryMax))
      if (!r || r.error) return { error: r && r.error }
      r.bodies.forEach(function (b) {
        if (!b.found) return
        // C1 (review round 3): index by the query string the bridge ANSWERED
        // (b.query, which the bridge trims), not by b.designation. The first
        // resolved designation is the object's canonical name and may differ
        // from the alias that was asked for - indexing by it made a
        // successful alias query unreadable ("found but not_found").
        var k = (typeof b.query === 'string' && b.query.trim())
          ? b.query.trim()
          : String(b.designation || '').trim()
        if (k) out[k] = b
      })
    }
    return { byDesignation: out }
  }

  // Deterministic selection for the CURRENT chart time. One click = one batch
  // of read-only queries; the sky never moves and the model is not involved.
  function computeRecommendation () {
    if (!skyRef) return { error: 'reference_missing' }
    var caps = bridge.getCapabilities ? bridge.getCapabilities() : null
    if (!caps || !caps.features || !caps.features.bodyQuery) return { error: 'bridge_old' }
    var snap = bridge.captureSnapshot()
    if (!snap) return { error: 'no_snapshot' }

    var targets = skyRef.builtin.targets.concat(externalTargets)
    // C1 (review round 3): send and index the TRIMMED query strings - the
    // bridge trims too, and the lookup side (withObservations) trims as well,
    // so every layer agrees on the same key.
    var designations = targets
      .map(function (t) { return String(t.designation || '').trim() })
      .filter(function (d) { return d })
    if (designations.indexOf('NAME Sun') < 0) designations.push('NAME Sun')
    var q = queryAllBodies(designations)
    if (q.error) return { error: q.error }

    var sun = q.byDesignation['NAME Sun'] || null
    var sunInput = sun
      ? { found: true, alt: sun.alt, az: sun.az }
      : { found: false, alt: null, az: null }
    var entries = skyRef.withObservations(targets, q.byDesignation)
    var rec = skyRef.recommend(entries, sunInput, { lang: lang })
    return {
      rec: rec,
      snapshotPayload: snapshotForModel(snap, snap.snapshotId, true),
      site: {
        lat: snap.location ? Math.round(snap.location.lat * 10) / 10 : null,
        lng: snap.location ? Math.round(snap.location.lng * 10) / 10 : null
      },
      utc: snap.time ? snap.time.utc : null,
      at: Date.now()
    }
  }

  function recItemNode (item) {
    var bits = []
    bits.push(item.direction !== null && item.altitudeDeg !== null
      ? t('rec.where', { dir: item.direction, alt: item.altitudeDeg })
      : t('rec.whereUnknown'))
    if (item.magnitude !== null) bits.push(t('rec.mag', { mag: item.magnitude }))
    if (item.illumPercent !== null) bits.push(t('rec.illum', { pct: item.illumPercent }))
    var row = h('div', { class: 'swe-rec-item', 'data-swe-rec-item': item.designation }, [
      h('div', { class: 'swe-rec-head' }, [
        h('strong', { text: item.name }),
        h('span', { class: 'swe-note', text: bits.join(' · ') }),
        h('button', {
          class: 'swe-btn', type: 'button', 'data-swe-action': 'rec-view',
          text: t('rec.view'),
          onclick: function () {
            runCommand({ type: 'select_object', name: item.designation, lock: false })
          }
        })
      ]),
      h('p', { class: 'swe-rec-features', text: item.features }),
      item.limits && item.limits.length
        ? h('p', { class: 'swe-note', text: t('rec.limits') + item.limits.join(' ') })
        : null
    ])
    return row
  }

  function renderRecommendation () {
    if (!el.recBox) return
    el.recBox.textContent = ''
    if (!recState.result) {
      el.recBox.appendChild(h('p', { class: 'swe-empty', text: t('rec.hint') }))
      if (externalError) {
        el.recBox.appendChild(h('p', { class: 'swe-note', 'data-swe-rec-external': 'invalid', text: t('rec.externalBad') }))
      }
      return
    }
    var rec = recState.result
    var meta = t('rec.timeScope', { utc: recState.utc || '—' }) +
      (recState.site && recState.site.lat !== null
        ? ' ' + t('rec.site', { lat: recState.site.lat, lng: recState.site.lng })
        : '')
    el.recBox.appendChild(h('p', { class: 'swe-note', 'data-swe-rec-timescope': 'true', text: meta }))
    if (externalError) {
      el.recBox.appendChild(h('p', { class: 'swe-note', 'data-swe-rec-external': 'invalid', text: t('rec.externalBad') }))
    }
    ;['eye', 'scope'].forEach(function (group) {
      var g = rec.groups[group]
      el.recBox.appendChild(h('div', { class: 'swe-rec-group', 'data-swe-rec-group': group }, [
        h('div', { class: 'swe-ai-label', text: t('rec.group_' + group) })
      ]))
      if (!g.items.length) {
        el.recBox.appendChild(h('p', { class: 'swe-empty', 'data-swe-rec-empty': group, text: g.emptyNote }))
        return
      }
      g.items.forEach(function (item) {
        el.recBox.appendChild(recItemNode(item))
      })
    })
  }

  /* R7: candidates and their time/site metadata are published ATOMICALLY -
   * the chat quick path and the panel button share this one function, so a
   * fresh selection can never be presented with a previous instant's
   * "computed at" again. */
  function publishRecommendation (computed) {
    recState.result = computed.rec
    recState.snapshotPayload = computed.snapshotPayload
    recState.site = computed.site
    recState.utc = computed.utc
    recState.at = computed.at
    renderRecommendation()
  }

  function requestRecommendation () {
    if (recState.busy) return
    if (!skyRef) { flash(t('rec.bridgeOld')); return }
    recState.busy = true
    renderRecommendation()
    var computed = computeRecommendation()
    recState.busy = false
    if (!computed || computed.error) {
      flash(t('rec.bridgeOld'))
      return
    }
    publishRecommendation(computed)
  }

  // The optional curated-target file: same-origin, data-only, one quiet
  // attempt at init. Missing (404/network) = fine, builtin only. Present but
  // invalid = builtin only PLUS a visible note in the recommendation box, so
  // a typo in a curated file is never mistaken for a working provider.
  function loadExternalTargets () {
    if (!ASSISTANT_BASE || !skyRef) return Promise.resolve()
    return fetch(ASSISTANT_BASE + 'curated-targets.json', {
      method: 'GET', cache: 'no-store'
    }).then(function (r) {
      if (!r.ok) return null
      return r.text()
    }).then(function (text) {
      if (text === null || text === undefined) return
      var doc
      try { doc = JSON.parse(text) } catch (e) {
        externalError = 'not_json'
        renderRecommendation()
        return
      }
      var v = skyRef.validateTargetFile(doc)
      if (!v.ok) {
        externalError = v.errors.join('; ')
        renderRecommendation()
        return
      }
      externalTargets = v.doc.targets
      externalSource = v.doc.source
      renderRecommendation()
    }).catch(function () {
      // No file deployed: the builtin provider runs alone, silently.
    })
  }

  /* -------------------------------------------------------- proposals */

  // Object naming is not style advice: the engine compares a name against each
  // object's designations exactly, so a near miss is object_not_found. The
  // rules, the constellation table and the few-shot replies all come from
  // naming-reference.js, which is loaded before this file (manifest.references)
  // so that the panel and any other agent read one spec. The fallback below is
  // deliberately short - it only covers that file failing to load, and it is
  // not allowed to be a second opinion about the grammar.
  var NAMING_FALLBACK = {
    zh: [
      'name 必须写成引擎认得的编号。规则（逐条实测，写错就查不到）：',
      '- 行星与日月**必须**带 NAME 前缀：NAME Jupiter、NAME Moon、NAME Sun。单独写 Jupiter 查不到。',
      '- 恒星写专名或拜耳编号：Sirius、Vega、* alf Ori。恒星的编号前面**不要**加 NAME（NAME Sirius 查不到）。',
      '- 深空天体写目录号，字母和数字之间**必须有一个空格**：M 31、M 42、NGC 7000。M31、NGC7000 都查不到。',
      '- 星座写 CON western 加三个字母的 IAU 缩写：CON western Ori。只写 Ori、Orion 或"猎户座"都查不到。',
      '- 大小写无所谓（m 42 等于 M 42），但空格一个都不能少。',
      '- 时间流速：set_time_speed 的 factor 0 停、1 实时、1000 每真实秒走 1000 模拟秒；加 simHours 走完自动停。先 set_time 再 set_time_speed。',
      '最多 4 条命令，不得出现其他类型或字段。',
      '',
      '请求：看看木星',
      '{"commands":[{"type":"select_object","name":"NAME Jupiter"}],"say":"已定位木星"}',
      '请求：把猎户座转到视野中央',
      '{"commands":[{"type":"select_object","name":"CON western Ori"}],"say":"已定位猎户座"}'
    ].join('\n'),
    en: [
      'name is matched by exact, case-insensitive comparison against the object catalogue.',
      'There is no fuzzy match. Each shape below was measured; the wrong one returns "not found":',
      '- planets and the Sun/Moon REQUIRE the NAME prefix: NAME Jupiter, NAME Moon, NAME Sun. Bare Jupiter fails.',
      '- stars use the proper name or Bayer code: Sirius, Vega, * alf Ori. Do NOT add NAME to a star (NAME Sirius fails).',
      '- deep sky uses the catalogue number with EXACTLY one space: M 31, M 42, NGC 7000. M31 and NGC7000 fail.',
      '- constellations use CON western plus the three-letter IAU abbreviation: CON western Ori. Bare Ori, Orion or the Chinese name fail here.',
      '- case does not matter (m 42 == M 42); spacing does.',
      '- Time flow: set_time_speed factor 0 stops, 1 is real time, 1000 runs 1000 simulated seconds per real second;',
      '  add simHours to stop by itself. set_time first, then set_time_speed.',
      'At most 4 commands; no other types or fields.',
      '',
      'request: show me Jupiter',
      '{"commands":[{"type":"select_object","name":"NAME Jupiter"}],"say":"Centred on Jupiter"}',
      'request: centre Orion',
      '{"commands":[{"type":"select_object","name":"CON western Ori"}],"say":"Centred on Orion"}'
    ].join('\n')
  }

  // Which form of the reference goes into the system prompt. 'compact' is the
  // default because the block is sent with every request and the reader may be
  // any provider's model: the name grammar as regexes, the time-flow rules and
  // five examples (~1.3k characters), and anything a model still gets wrong is
  // repaired locally by the bridge.
  // 'full' adds the 88-row constellation table and the name tables (~4.4k
  // characters) - worth it only if this deployment keeps meeting a model that
  // cannot follow the compact form.
  var NAMING_LEVEL = 'compact'

  function namingRef () {
    var ref = window.SWE_NAMING_REFERENCE
    return ref && typeof ref.toPrompt === 'function' ? ref : null
  }

  function namingText (lang) {
    var ref = namingRef()
    if (ref) {
      try {
        var text = ref.toPrompt(lang, { level: NAMING_LEVEL })
        if (typeof text === 'string' && text) return text
      } catch (e) {}
    }
    return NAMING_FALLBACK[lang === 'en' ? 'en' : 'zh']
  }

  function proposalPrompt (text) {
    var sel = state && state.selection
    var ctx = {
      utc: state && state.time ? state.time.utc : null,
      // Non-null once the bridge exposes it (0.6.0+). Telling the model the
      // clock is already running stops it from re-issuing a speed it cannot see.
      timeSpeed: state && state.time && typeof state.time.speed === 'number' ? state.time.speed : null,
      timeZone: prefs.tz,
      selected: sel ? (sel.displayName || sel.designation) : null,
      fovDeg: state && state.view ? state.view.fovDeg : null
    }
    var spec = [
      'set_layer / set_layer_flag: {"type","layer","visible"}',
      '  layer one of: atmosphere, constellation_lines, constellation_labels, constellation_images, landscape, milkyway, stars, dsos, equatorial_grid, azimuthal_grid, meridian',
      'select_object: {"type","name","lock"?}',
      'set_time: {"type","utc"}  utc is ISO 8601 WITH timezone, e.g. 2026-10-30T12:00:00Z',
      'set_time_speed: {"type","factor","simHours"?}  factor 0 stops, 1 is real time, 1000 runs a day in 86 s;',
      '  add simHours to stop by itself after that many simulated hours (set_time first, this second)',
      'set_location: {"type","lat","lng","elevation"?}',
      'set_fov: {"type","deg"}  0.05..180'
    ].join('\n')

    var naming = namingText(lang)

    if (lang === 'en') {
      return [
        'You convert a teacher request into sky-map commands.',
        'Reply with JSON only, no prose, no markdown fence.',
        'Shape: {"commands":[ ... ], "say": "one short sentence"}',
        'Allowed commands:',
        spec,
        '',
        naming,
        '',
        'No other types or fields. If the request is not a sky action,',
        'reply {"commands":[],"say":"..."} and explain briefly in "say".',
        'Context: ' + JSON.stringify(ctx),
        '',
        'Request: ' + text
      ].join('\n')
    }
    return [
      '你把老师的自然语言请求转换成星图命令。',
      '只输出 JSON，不要解释文字，不要 markdown 代码块。',
      '格式：{"commands":[ ... ], "say": "一句简短说明"}',
      '允许的命令：',
      spec,
      '',
      naming,
      '',
      '不得出现其他类型或字段。如果请求不是星图动作，返回 {"commands":[],"say":"..."} 并在 say 里简短说明。',
      '当前上下文：' + JSON.stringify(ctx),
      '',
      '请求：' + text
    ].join('\n')
  }

  function parseProposal (raw) {
    var text = String(raw || '').trim()
    // Tolerate a fenced block, but never eval anything.
    var fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)
    if (fence) text = fence[1]
    var data
    try { data = JSON.parse(text) } catch (e) {
      var s = text.indexOf('{')
      var e2 = text.lastIndexOf('}')
      if (s < 0 || e2 <= s) throw { code: 'badJson' }
      try { data = JSON.parse(text.slice(s, e2 + 1)) } catch (e3) { throw { code: 'badJson' } }
    }
    if (!data || typeof data !== 'object') throw { code: 'badJson' }
    var cmds = Array.isArray(data.commands) ? data.commands : []
    if (cmds.length > 4) throw { code: 'badJson' }
    return { commands: cmds, say: typeof data.say === 'string' ? data.say : '' }
  }

  /* --- the sky state a proposal was written for -------------------------
   * A proposal is model output about a specific sky. Between the request and
   * the confirm click the teacher can select another object, jump the clock or
   * change the site (in the panel or in the host's own UI), and the commands
   * that arrive afterwards are answers to a question nobody is asking any
   * more. So the context is frozen when the request is SENT, checked when the
   * answer arrives, and checked again before the first command runs.
   *
   * A running clock is not a change: the engine advances observer.utc every
   * frame. The time check therefore allows the drift the current rate explains,
   * plus a few seconds of slack for polling. Our own commands are also not a
   * change - the batch is validated once, before it starts, and is not
   * re-validated against commands it issued itself. */

  // Killing a plan because a running clock moved is wrong, so the check has to
  // separate "the clock is doing what its rate says" from "somebody moved it".
  //
  // The authority is the bridge (0.9.0+): readState().time.jumps counts clock
  // jumps, taken frame by frame, so the allowance there is one frame of sky
  // instead of a whole command's worth - which is why a jump made while a rate
  // change was in flight is still caught instead of being hidden under the
  // band that rate change needs. The count does not say who jumped, so a batch
  // command that sets the time itself is exempted by name, not by value.
  //
  // Older bridges only report the clock, so the movement has to be judged from
  // the numbers. Those constants are kept for that fallback and are no longer
  // used when a counter is available.
  var CTX_TIME_TOLERANCE_MS = 5000
  // ...but a fixed few seconds is not enough on its own. The engine integrates
  // its own frame time, so the rate it realises over a short interval is
  // routinely 10-20% off the nominal factor (measured 2880-4388x for a set
  // 3600x). Comparing against the nominal factor with a fixed slack voided
  // every plan made while the sky was running fast. The allowance therefore
  // also covers a share of the movement being predicted: a pause, a reverse or
  // a jump moves the clock by 100% or more, and a rate change is its own
  // field, so real outside changes are still caught.
  var CTX_RATE_TOLERANCE = 0.35
  // The engine also only writes observer.utc once per animation frame, so any
  // read is up to one frame behind the wall clock. That lag scales with the
  // rate too, hence the second term below.
  var CTX_FRAME_SLACK_MS = 40

  // Called on every state tick before any context is compared. Only a real
  // change of the selected object bumps the epoch, and the epoch bumps even
  // when the object comes back to the one it started from: A -> B -> A ends on
  // the same id, but it is not the sky the question was asked about.
  function noteSelectionEpoch (st) {
    var key = st && st.selection ? (st.selection.id || st.selection.designation || null) : null
    if (key !== lastSelectionKey) {
      lastSelectionKey = key
      skyEpoch += 1
    }
  }

  function captureContext (fresh) {
    var st = state
    if (fresh && bridge && typeof bridge.readState === 'function') {
      // The subscription tick is up to half a second old. "Did anything move
      // while that command ran" is a question about the sky now, not about the
      // sky a poll ago - and the bridge can answer it directly.
      try { var live = bridge.readState(); if (live) st = live } catch (e) {}
    }
    return {
      viewId: st ? st.viewId : null,
      selectionId: st && st.selection ? (st.selection.id || st.selection.designation || null) : null,
      epoch: skyEpoch,
      utcMs: st && st.time && st.time.utc ? Date.parse(st.time.utc) : null,
      speed: st && st.time && typeof st.time.speed === 'number' ? st.time.speed : 0,
      // Bridges from 0.9.0 count clock jumps; null means this bridge cannot
      // tell us and the movement has to be judged from the clock itself.
      // The counter does not say who jumped, so the command that owns the
      // clock is exempted by the caller (see foreignChanges).
      timeJumps: st && st.time && typeof st.time.jumps === 'number' ? st.time.jumps : null,
      lat: st && st.location ? st.location.lat : null,
      lng: st && st.location ? st.location.lng : null,
      fovDeg: st && st.view ? st.view.fovDeg : null,
      // The read timestamp, not Date.now(): the clock value and this stamp
      // come from the same read, so the drift check compares like with like
      // even when the panel is looking at a state a poll or two old.
      at: st && st.readAt ? Date.parse(st.readAt) : Date.now()
    }
  }

  // true when the two numbers differ by more than `tol`; a null on either side
  // only counts when the other side has a value.
  function numMoved (a, b, tol) {
    var na = typeof a === 'number' && isFinite(a)
    var nb = typeof b === 'number' && isFinite(b)
    if (!na && !nb) return false
    if (!na || !nb) return true
    return Math.abs(a - b) > tol
  }

  // Did the clock leave the band its rate predicts? Compared against the
  // predicted simulation instant, not a fixed offset from where it started,
  // so a normal run never trips it and a pause, a reverse or a jump always do.
  //
  // `rateChanged` is set when the batch itself is what changed the rate. The
  // switch happens at an instant we cannot observe: within one interval the
  // clock ran at the old rate for a while and at the new one for the rest, so
  // the honest prediction is the whole band between the two rates. Demanding
  // the whole interval at the new rate made every "pause, then reframe" batch
  // look like somebody else had touched the clock, and cut it at command two.
  function timeDrifted (pre, now, rateChanged) {
    if (pre.utcMs === null) return now.utcMs !== null
    if (now.utcMs === null) return true
    var elapsedSec = Math.max(0, (now.at - pre.at) / 1000)
    var was = typeof pre.speed === 'number' ? pre.speed : 0
    var is = typeof now.speed === 'number' ? now.speed : 0
    var lo = (rateChanged ? Math.min(was, is) : is) * elapsedSec * 1000
    var hi = (rateChanged ? Math.max(was, is) : is) * elapsedSec * 1000
    var tol = Math.max(CTX_TIME_TOLERANCE_MS, CTX_RATE_TOLERANCE * Math.max(Math.abs(lo), Math.abs(hi))) +
      Math.max(Math.abs(was), Math.abs(is)) * CTX_FRAME_SLACK_MS
    var delta = now.utcMs - pre.utcMs
    return delta < lo - tol || delta > hi + tol
  }

  // Did the clock move in a way the batch did not ask for? A bridge that
  // counts foreign jumps is believed over arithmetic: at 3600x the arithmetic
  // has to allow roughly a minute of sky per frame, which is wider than the
  // jumps it is supposed to catch. A bridge without the counter (before 0.9.0)
  // falls back to the predicted band.
  function timeMoved (pre, now, rateChanged) {
    if (pre.timeJumps !== null && now.timeJumps !== null) return now.timeJumps !== pre.timeJumps
    return timeDrifted(pre, now, rateChanged)
  }

  // Returns the list of context keys that moved, empty when the sky is still
  // the one the proposal was written for.
  function contextChanges (frozenCtx) {
    if (!frozenCtx) return []
    var now = captureContext(true)
    var moved = []
    if (now.viewId !== frozenCtx.viewId) moved.push('view')
    if (now.epoch !== frozenCtx.epoch) moved.push('selection')
    else if (now.selectionId !== frozenCtx.selectionId) moved.push('selection')
    if (numMoved(now.lat, frozenCtx.lat, 0.05) || numMoved(now.lng, frozenCtx.lng, 0.05)) {
      moved.push('site')
    }
    if (numMoved(now.fovDeg, frozenCtx.fovDeg, 0.5)) moved.push('fov')
    // Pausing, reversing or re-rating the clock changes what "a while later"
    // means, so it invalidates the timing the commands were written for even
    // when the current instant happens to be close to the frozen one.
    if (numMoved(now.speed, frozenCtx.speed, 1e-6)) moved.push('speed')
    if (timeMoved(frozenCtx, now, false)) moved.push('time')
    return moved
  }

  // Which field a command is expected to change by itself. Used while a batch
  // runs: anything outside this list that moves was done by somebody else.
  function commandFields (cmd) {
    if (!cmd) return []
    switch (cmd.type) {
      case 'select_object': return ['selection']
      case 'set_time': return ['time']
      case 'set_time_speed': return ['speed']
      case 'set_location': return ['site']
      case 'set_fov': return ['fov']
      default: return []
    }
  }

  // Fields that moved since `pre` without the command that just ran being the
  // author, including a change made *while* that command was in flight. This
  // is what a plain re-anchor would hide: re-anchoring after the command would
  // adopt a selection the teacher made during the animation as if the batch
  // had done it.
  function foreignChanges (pre, own) {
    var now = captureContext(true)
    var out = []
    // A different view id means the panel is looking at a different host
    // instance than the one the plan was written for (a reload, a hot-swapped
    // bridge, a second page). Nothing in the plan is valid there.
    if (now.viewId !== pre.viewId) out.push('view')
    if (own.indexOf('selection') < 0 && now.epoch !== pre.epoch) out.push('selection')
    else if (own.indexOf('selection') < 0 && now.selectionId !== pre.selectionId) out.push('selection')
    if (own.indexOf('speed') < 0 && numMoved(now.speed, pre.speed, 1e-6)) out.push('speed')
    if (own.indexOf('site') < 0 &&
        (numMoved(now.lat, pre.lat, 0.05) || numMoved(now.lng, pre.lng, 0.05))) out.push('site')
    if (own.indexOf('fov') < 0 && numMoved(now.fovDeg, pre.fovDeg, 0.5)) out.push('fov')
    // A set_time through the bridge is counted the instant it is written, so
    // the command that owns the clock carries its own jump inside this window
    // and is exempted by field name. Anything else that moves the counter came
    // from outside - including a set_time sent by somebody else, which is why
    // the exemption is per command and never global. A command allowed to
    // change the rate is not a jump either: it is the same instant at a
    // different speed.
    if (own.indexOf('time') < 0 && timeMoved(pre, now, own.indexOf('speed') >= 0)) out.push('time')
    return out
  }

  function contextFieldNames (keys) {
    return keys.map(function (k) { return t('ctx.' + k) }).join('、')
  }

  function askAssistant () {
    var text = (el.askInput.value || '').trim()
    if (!text) return
    if (!aiConfigured()) { flash(t('input.needAi')); return }
    if (proposalBusy) return

    var reqId = ++proposalSeq
    // Frozen BEFORE the request leaves, so the answer is bound to the sky the
    // teacher was looking at when they asked, not to whatever is on screen when
    // the model happens to reply.
    var ctx = captureContext(true)
    proposalBusy = true
    proposal = null
    renderProposal()
    if (el.askBtn) el.askBtn.disabled = true
    if (el.askStatus) { el.askStatus.textContent = t('input.parsing'); el.askStatus.className = 'swe-note' }

    // The server route is paid, so the revision is verified before the request
    // leaves rather than after it has been paid for. A fresh cache costs
    // nothing; a stale one costs one cheap GET, never a second generation (R7).
    var ready = ai.source === 'server' ? ensureServerStatus(STATUS_TTL_MS, true) : Promise.resolve()

    function arrived (raw) {
      if (reqId !== proposalSeq || !configStillCurrent(token)) return
      proposalBusy = false
      if (el.askBtn) el.askBtn.disabled = false
      var parsed
      try { parsed = parseProposal(raw) } catch (e) {
        if (el.askStatus) { el.askStatus.textContent = errText(e); el.askStatus.className = 'swe-note swe-err-text' }
        return
      }
      var checked = []
      for (var i = 0; i < parsed.commands.length; i++) {
        var problem = commandAllowed(parsed.commands[i])
        checked.push({ cmd: parsed.commands[i], problem: problem })
      }
      var moved = contextChanges(ctx)
      proposal = {
        id: reqId,
        items: checked,
        say: parsed.say,
        context: ctx,
        contextMoved: moved,
        // What this plan is allowed to run under. A server-sourced plan is
        // bound to the revision and the session it was previewed in; changing
        // either makes the confirm a refusal, not a silent run (R3).
        bind: bind,
        // Latched here as well as on every later state tick: an answer that
        // arrives after the sky moved is void from the moment it is shown.
        stale: moved.length > 0,
        staleFields: moved,
        at: Date.now()
      }
      if (moved.length) {
        if (el.askStatus) {
          el.askStatus.textContent = t('input.ctxChanged', { fields: contextFieldNames(moved) })
          el.askStatus.className = 'swe-note swe-err-text'
        }
      } else if (el.askStatus) {
        el.askStatus.textContent = ''
      }
      renderProposal()
    }

    function failed (e) {
      if (reqId !== proposalSeq || !configStillCurrent(token)) return
      proposalBusy = false
      if (el.askBtn) el.askBtn.disabled = false
      if (e && e.code === 'abort') { renderProposal(); return }
      if (el.askStatus) { el.askStatus.textContent = errText(e); el.askStatus.className = 'swe-note swe-err-text' }
      renderProposal()
    }

    var token = null
    var bind = null
    ready.then(function () {
      // The pre-flight refresh may itself have invalidated this ask (the
      // deployment moved, so the plan would have been written for the old one).
      if (reqId !== proposalSeq) return
      // C2-a: the pre-ask read must have SUCCEEDED before a paid question is
      // sent. A quiet read that failed used to leave the previous "verified"
      // flag standing, and an answer bought under it would ride that flag into
      // a confirm. Blocking here costs one retry click; generating against a
      // deployment this tab cannot currently see costs money.
      if (ai.source === 'server' && !SERVER_AI.verified) {
        proposalBusy = false
        if (el.askBtn) el.askBtn.disabled = false
        if (el.askStatus) {
          el.askStatus.textContent = t('input.serverUnverified')
          el.askStatus.className = 'swe-note swe-err-text'
        }
        renderProposal()
        return
      }
      token = configToken()
      bind = ai.source === 'server' ? bindNow() : null
      return chatCompletion([
        { role: 'system', content: proposalPrompt(text) },
        { role: 'user', content: text }
      ], {
        // The answer's own revision re-binds the plan (B2). Only the revision
        // moves: the auth generation must still be the one this plan was
        // previewed in, and a mid-flight login/logout has already torn this
        // request down through noteConfigChanged. Re-binding to anything else
        // (the "current" revision at confirm time, say) would dress a stale
        // plan up as a fresh one.
        onRevisionAccepted: function (rev) {
          if (bind && authGen === bind.authGen) bind.revision = rev
        }
      }).then(arrived, failed)
    })
  }

  // Is this plan still runnable under the deployment it was previewed in?
  // A plan is bound to: the configuration revision (which covers the model,
  // the endpoint and whether the feature is on at all), the session counter
  // (login/logout), the session's own verdict as last read, and a tag of the
  // server session itself. Comparing only the revision missed the logout case;
  // comparing only the session missed the operator saving a new model (R3);
  // comparing only this tab's counters missed another tab of the same browser
  // signing in as the same role, and missed a status endpoint that answered
  // non-2xx while the old identity stayed on display (R3 supplement).
  function bindCurrent (bind) {
    if (!bind) return true
    // The confirm must be able to RE-verify, not just compare caches: after a
    // failed status read the fields below may describe a pre-outage world.
    if (!SERVER_AI.verified || !bind.verified) return false
    if (SERVER_AI.revision !== bind.revision) return false
    if (authGen !== bind.authGen) return false
    if (SERVER_AI.authenticated !== bind.authenticated) return false
    if ((SERVER_AI.role || null) !== (bind.role || null)) return false
    // Another tab shares this browser's cookie jar: a re-login there replaced
    // this session too, and nothing page-local could have noticed.
    return (SERVER_AI.sessionTag || null) === (bind.sessionTag || null)
  }

  function bindNow () {
    return {
      revision: SERVER_AI.revision,
      authGen: authGen,
      authenticated: SERVER_AI.authenticated,
      role: SERVER_AI.role || null,
      // Tag of the server session, not a secret: the server derives it from
      // this browser's session cookie, so any tab signing in produces a new
      // one for the whole browser.
      sessionTag: SERVER_AI.sessionTag,
      // Whether the session's verdict was actually readable when the plan was
      // bought. A plan bought during a status outage is never confirmed on
      // the strength of that outage-era cache.
      verified: SERVER_AI.verified
    }
  }

  function runProposal () {
    if (!proposal || proposalBusy) return
    // Already ruled void while it was on screen. Re-checking only the current
    // values here was the hole: A -> B -> A put the sky back to the frozen
    // values, so a plan that had been announced as void ran anyway.
    if (proposal.stale) {
      flash(t('input.staleLocked', { fields: contextFieldNames(proposal.staleFields || []) }))
      proposal = null
      renderProposal()
      return
    }
    var moved = contextChanges(proposal.context)
    if (moved.length) {
      proposal.stale = true
      proposal.staleFields = moved
      flash(t('input.ctxChanged', { fields: contextFieldNames(moved) }))
      proposal = null
      renderProposal()
      return
    }
    // All or nothing. Running only the valid subset used to be silent: the
    // model asked for three things, one was rejected, and two ran as if that
    // had been the plan. Refusing the batch keeps the plan the teacher saw.
    var bad = proposal.items.filter(function (it) { return !!it.problem })
    if (bad.length) {
      if (el.askStatus) {
        el.askStatus.textContent = t('input.invalid', { n: bad.length, msg: bad[0].problem })
        el.askStatus.className = 'swe-note swe-err-text'
      }
      return
    }

    var items = proposal.items.slice()
    var batchCtx = proposal.context
    var bind = proposal.bind || null

    if (!bind) { execProposal(items, batchCtx); return }

    // A server-sourced plan is confirmed against the deployment as it is now,
    // not as it was when the panel rendered it. This is the one place where a
    // plan that looked fine a minute ago can still be refused, and it is worth
    // a single cheap GET: the alternative is running a plan the operator has
    // already replaced, or one bought under somebody else's passphrase.
    if (!bindCurrent(bind)) {
      refuseStalePlan()
      return
    }
    proposalBusy = true
    renderProposal()
    ensureServerStatus(0).then(function () {
      // The refresh itself may have invalidated the plan (noteConfigChanged
      // clears it and reports why), in which case there is nothing left to run.
      if (!proposal || proposal.bind !== bind) return
      proposalBusy = false
      if (!bindCurrent(bind)) { refuseStalePlan(); return }
      execProposal(items, batchCtx)
    })
  }

  function refuseStalePlan () {
    proposal = null
    renderProposal()
    if (el.askStatus) {
      el.askStatus.textContent = t('input.serverChanged')
      el.askStatus.className = 'swe-note swe-err-text'
    }
  }

  function execProposal (items, batchCtx) {
    // The batch, not the proposal object, owns the run: "放弃" clears the
    // proposal, so keying the run on it would make cancellation impossible.
    var token = ++execSeq
    runningExec = token
    execSent = 0
    // Re-anchored after every applied command: the batch is allowed to change
    // the sky itself, but anything that moves afterwards is somebody else.
    proposalBusy = true
    renderProposal()

    var ok = 0
    var fail = 0
    var unverified = 0
    var sent = 0
    var i = 0

    function stop (text, isErr) {
      if (runningExec === token) runningExec = 0
      proposalBusy = false
      if (el.askStatus) {
        el.askStatus.textContent = text
        el.askStatus.className = 'swe-note' + (isErr ? ' swe-err-text' : '')
      }
      proposal = null
      renderProposal()
    }

    function step () {
      // Cancelled (or superseded) while the previous command was in flight.
      if (token !== execSeq) return
      // Somebody else changed the sky between two commands (a second tab, the
      // host's own UI, a keyboard shortcut). Continuing would apply the rest
      // of the plan to a sky it was not written for.
      if (batchCtx) {
        var drift = contextChanges(batchCtx)
        if (drift.length) {
          stop(t('input.ctxMidRun', {
            fields: contextFieldNames(drift), rest: items.length - i
          }), true)
          return
        }
      }
      if (i >= items.length) {
        stop(t('input.done', { ok: ok, fail: fail + unverified }), (fail + unverified) > 0)
        return
      }
      var item = items[i]
      sent = i + 1
      execSent = sent
      var preCtx = captureContext(true)
      runCommand(item.cmd).then(function (res) {
        // Checked again after the await: the user may have pressed 放弃 while
        // this command was running, and nothing may be sent after that.
        if (token !== execSeq) return
        if (res && res.ok && res.status === 'applied') {
          ok += 1
          item.result = res.status
          i += 1
          // The batch authored this command's own field, but nothing else.
          // Checking before re-anchoring is what catches a selection made
          // during the animation; re-anchoring alone would swallow it.
          var foreign = foreignChanges(preCtx, commandFields(item.cmd))
          if (foreign.length) {
            stop(t('input.ctxMidRun', {
              fields: contextFieldNames(foreign), rest: items.length - i
            }), true)
            return
          }
          batchCtx = captureContext(true)
          step()
          return
        }
        if (res && res.ok) {
          // The bridge accepted the command but could not read a settled end
          // state. That is not a success, and the next command may depend on
          // it, so the batch stops here and does not replay anything.
          unverified += 1
          item.result = String(res.status) + ' (unverified)'
          i += 1
          stop(t('input.unverified', {
            i: i,
            status: String(res.status),
            rest: items.length - i,
            readback: JSON.stringify(res.readback || null).slice(0, 200)
          }), true)
          renderProposal()
          return
        }
        fail += 1
        item.result = res && res.error ? res.error.message : 'failed'
        i += 1
        stop(t('input.partial', { i: i, msg: item.result }), true)
        renderProposal()
      })
    }
    step()
  }

  function discardProposal () {
    // Two different jobs share this button: dropping a plan that has not run,
    // and stopping a batch that is already running. The second one must be able
    // to cut the remaining commands, which is what execSeq does.
    var wasRunning = runningExec !== 0
    var rest = wasRunning && proposal ? Math.max(0, proposal.items.length - execSent) : 0
    proposalSeq += 1
    execSeq += 1
    runningExec = 0
    proposal = null
    proposalBusy = false
    if (el.askBtn) el.askBtn.disabled = false
    if (el.askStatus) {
      el.askStatus.textContent = wasRunning
        ? t('input.cancelled', { rest: rest, sent: execSent })
        : ''
      el.askStatus.className = 'swe-note'
    }
    renderProposal()
  }

  /* ------------------------------------------------------ render bits */

  function renderStatus () {
    if (!el.status) return
    // A transient message must survive the next state tick, otherwise the user
    // never gets to read why something was refused.
    if (Date.now() < flashUntil) return
    if (!state) {
      el.status.textContent = t('status.noEngine')
      el.status.classList.add('swe-warn')
      return
    }
    el.status.classList.remove('swe-warn')
    el.status.textContent = t('status.ready', {
      loader: bridge.loaderVersion,
      protocol: bridge.protocolVersion,
      view: state.viewId.slice(-4),
      rev: state.revision
    })
  }

  function renderSelection () {
    if (!el.selBox) return
    el.selBox.textContent = ''
    var s = state && state.selection
    if (!s) {
      el.selBox.appendChild(h('p', { class: 'swe-empty', text: t('obj.none') }))
      return
    }
    el.selBox.appendChild(h('div', { class: 'swe-obj-name', text: s.displayName || s.designation || s.id || '?' }))
    el.selBox.appendChild(h('div', { class: 'swe-obj-type', text: s.otypeName || s.otype || t('obj.typeUnknown') }))
    el.selBox.appendChild(h('div', { class: 'swe-grid' }, [
      row(t('obj.mag'), value(fmt(s.vmag, 2))),
      row(t('obj.az'), value(fmt(s.az, 1, '°'))),
      row(t('obj.alt'), value(fmt(s.alt, 1, '°'))),
      row(t('obj.ra'), value(s.ra === null ? '—' : fmt(s.ra * 12 / Math.PI, 3, 'h'))),
      row(t('obj.dec'), value(s.dec === null ? '—' : fmt(s.dec * 180 / Math.PI, 2, '°')))
    ]))
    el.selBox.appendChild(h('p', { class: 'swe-note', text: t('obj.readback') }))
    if (s.alt !== null && s.alt < 0) {
      el.selBox.appendChild(h('p', { class: 'swe-placeholder', text: t('obj.belowHorizon') }))
    }
  }

  function row (label, valueEl) {
    return h('div', { class: 'swe-row' }, [
      h('span', { class: 'swe-k', text: label }),
      valueEl
    ])
  }

  function value (text, cls) {
    return h('span', { class: 'swe-v ' + (cls || ''), text: text })
  }

  function renderLayers () {
    if (!el.layersBox) return
    var L = (state && state.layers) || {}
    Array.prototype.forEach.call(el.layersBox.querySelectorAll('button[data-layer]'), function (btn) {
      var v = L[btn.dataset.layer]
      var on = v === true
      btn.setAttribute('aria-pressed', on ? 'true' : 'false')
      btn.classList.toggle('on', on)
      btn.classList.toggle('unknown', v === null || v === undefined)
    })
  }

  function renderTime () {
    if (!el.timeInput || !state || !state.time) return
    if (!timeDirty && document.activeElement !== el.timeInput) {
      el.timeInput.value = fmtInZone(state.time.utc, prefs.tz).replace(' ', 'T')
    }
    if (el.timeText) {
      el.timeText.textContent = fmtInZone(state.time.utc, prefs.tz) + ' · ' + prefs.tz
    }
    // Time rate: the panel mirrors what the engine reports, so a change made
    // by a model command shows up in the UI without the teacher touching it.
    var sp = typeof state.time.speed === 'number' ? state.time.speed : null
    if (el.speedNow) {
      el.speedNow.textContent = sp === null
        ? ''
        : (sp === 0
            ? t('time.stopped') + ' · ' + t('time.rate', { v: 0 })
            : t('time.rate', { v: sp }) + ' · ' + t('time.running'))
    }
    if (el.speedPlayBtn) {
      el.speedPlayBtn.textContent = sp === 0 || sp === null ? t('time.play') : t('time.pause')
    }
    if (el.speedPresetBtns) {
      for (var pi = 0; pi < el.speedPresetBtns.length; pi++) {
        var btn = el.speedPresetBtns[pi]
        var f = Number(btn.getAttribute('data-swe-speed'))
        btn.classList.toggle('swe-speed-on', sp !== null && Math.abs(sp - f) < 1e-9)
      }
    }
  }

  function renderLocation () {
    if (el.locText) {
      el.locText.textContent = prefs.location && prefs.location.userSet
        ? t('loc.custom')
        : t('loc.default')
    }
    if (el.locLat && !locDirty && document.activeElement !== el.locLat && state && state.location) {
      el.locLat.value = fmt(state.location.lat, 4, '')
    }
    if (el.locLng && !locDirty && document.activeElement !== el.locLng && state && state.location) {
      el.locLng.value = fmt(state.location.lng, 4, '')
    }
  }

  function renderView () {
    if (!el.viewText || !state) return
    el.viewText.textContent = t('fov.label', {
      fov: fmt(state.view.fovDeg, 1, '°'),
      lat: fmt(state.location && state.location.lat, 2, '°'),
      lng: fmt(state.location && state.location.lng, 2, '°')
    })
  }

  function renderExplain () {
    if (!el.explainBox) return
    var sig = [
      state ? (state.selection ? state.selection.id : 'none') : 'none',
      state ? state.snapshotId : 'x',
      explanation ? explanation.id : 0,
      explainBusy ? 1 : 0,
      frozen ? frozen.snapshotId : 0,
      lang
    ].join('|')
    if (sig === lastExplainKey) { renderFrozenState(); return }
    lastExplainKey = sig
    el.explainBox.textContent = ''

    if (!state || !state.selection) {
      el.explainBox.appendChild(h('p', { class: 'swe-empty', text: t('explain.hint') }))
      el.explainBox.appendChild(h('div', { class: 'swe-row-btns' }, [
        h('button', {
          class: 'swe-btn', type: 'button', 'data-swe-action': 'chat-ask',
          'data-swe-chat-ask': 'true',
          text: t('chat.askSky'),
          onclick: function () { openChat('ask') }
        }),
        h('button', {
          class: 'swe-btn', type: 'button', 'data-swe-action': 'recommend',
          text: t('rec.run'), onclick: requestRecommendation
        })
      ]))
      if (frozen) el.explainBox.appendChild(renderFrozen())
      return
    }

    var btns = h('div', { class: 'swe-row-btns' }, [
      h('button', {
        class: 'swe-btn swe-primary',
        type: 'button',
        'data-swe-action': 'explain',
        text: explainBusy ? t('explain.busy') : t('explain.run'),
        onclick: requestExplanation
      }),
      h('button', {
        class: 'swe-btn', type: 'button', 'data-swe-action': 'chat-continue',
        'data-swe-chat-continue': 'true',
        text: t('chat.continue'),
        onclick: function () { openChat('continue', null) }
      }),
      explainBusy ? h('button', {
        class: 'swe-btn', type: 'button', text: t('explain.cancel'), onclick: cancelExplanation
      }) : null,
      h('button', {
        class: 'swe-btn',
        type: 'button',
        'data-swe-action': 'freeze',
        text: t('explain.freeze'),
        onclick: freezeSnapshot
      })
    ])
    el.explainBox.appendChild(btns)

    if (!aiConfigured()) {
      el.explainBox.appendChild(h('p', { class: 'swe-placeholder', text: t('explain.needAi') }))
    }

    if (explanation) {
      var stale = !snapshotIsCurrent(explanation.snapshot)
      el.explainBox.appendChild(h('div', { class: 'swe-ai-block' }, [
        h('div', { class: 'swe-ai-label', text: t('explain.disclaimer') }),
        h('div', {
          class: 'swe-ai-text',
          'data-swe-ai-text': 'true',
          'data-swe-explanation-stale': stale ? 'true' : 'false'
        }, [h('p', { text: explanation.text })]),
        stale ? h('p', {
          class: 'swe-placeholder swe-stale',
          'data-swe-explanation-stale-note': 'true',
          text: t('explain.stale', { id: explanation.snapshotId })
        }) : null
      ]))
    }

    var details = h('details', { class: 'swe-details' }, [
      h('summary', { text: t('explain.snapshot') }),
      h('pre', {
        class: 'swe-pre',
        text: JSON.stringify(snapshotForModel(state, state.snapshotId), null, 2)
      })
    ])
    el.explainBox.appendChild(details)
    if (frozen) el.explainBox.appendChild(renderFrozen())
  }

  function snapshotIsCurrent (snap) {
    if (!snap) return false
    // Material check when the bridge offers it; the raw counter otherwise,
    // which is stricter but still correct.
    if (typeof bridge.isSnapshotCurrent === 'function') return bridge.isSnapshotCurrent(snap)
    return bridge.isCurrentSnapshot(snap.snapshotId)
  }

  function renderFrozen () {
    var stale = !snapshotIsCurrent(frozen)
    return h('div', { class: 'swe-frozen', 'data-swe-frozen': 'true' }, [
      h('p', {
        class: stale ? 'swe-placeholder swe-stale' : 'swe-note',
        'data-swe-frozen-stale': stale ? 'true' : 'false',
        text: t('explain.frozen', { id: frozen.snapshotId }) +
          (stale ? t('explain.frozenStale') : t('explain.frozenSame'))
      }),
      h('pre', {
        class: 'swe-pre',
        'data-swe-frozen-body': 'true',
        text: JSON.stringify(snapshotForModel(frozen, frozen.snapshotId), null, 2)
      })
    ])
  }

  function renderFrozenState () {
    if (!el.explainBox || !frozen) return
    var old = el.explainBox.querySelector('[data-swe-frozen]')
    if (old) old.remove()
    el.explainBox.appendChild(renderFrozen())
  }

  function renderProposal () {
    if (!el.proposalBox) return
    el.proposalBox.textContent = ''
    if (!proposal) return
    if (proposal.items.length === 0) {
      el.proposalBox.appendChild(h('p', { class: 'swe-empty', text: t('input.noCommands') }))
      if (proposal.say) el.proposalBox.appendChild(h('p', { class: 'swe-note', text: t('input.say') + proposal.say }))
      return
    }
    el.proposalBox.appendChild(h('p', {
      class: 'swe-placeholder' + (proposal.stale ? ' swe-stale' : ''),
      'data-swe-proposal-stale': proposal.stale ? 'true' : 'false',
      text: proposal.stale
        ? t('input.staleBanner', { fields: contextFieldNames(proposal.staleFields || []) })
        : t('input.preview', { n: proposal.items.length })
    }))
    if (proposal.say) el.proposalBox.appendChild(h('p', { class: 'swe-note', text: t('input.say') + proposal.say }))
    el.proposalBox.appendChild(h('ul', { class: 'swe-cmds' }, proposal.items.map(function (it) {
      return h('li', {
        class: 'swe-cmd' + (it.problem ? ' swe-cmd-bad' : ''),
        'data-swe-cmd': it.cmd && it.cmd.type ? it.cmd.type : 'invalid'
      }, [
        h('code', { text: JSON.stringify(it.cmd) }),
        it.problem ? h('span', { class: 'swe-err-text', text: ' — ' + it.problem }) : null,
        it.result ? h('span', { class: 'swe-note', text: ' → ' + it.result }) : null
      ])
    })))
    var usable = !proposal.stale && proposal.items.some(function (it) { return !it.problem })
    el.proposalBox.appendChild(h('div', { class: 'swe-row-btns' }, [
      h('button', {
        class: 'swe-btn swe-primary',
        type: 'button',
        'data-swe-action': 'run-proposal',
        text: proposalBusy ? t('input.executing') : t('input.confirm'),
        disabled: (!usable || proposalBusy) ? 'disabled' : null,
        onclick: runProposal
      }),
      h('button', {
        class: 'swe-btn',
        type: 'button',
        'data-swe-action': 'discard-proposal',
        text: t('input.discard'),
        onclick: discardProposal
      })
    ]))
  }

  function renderAiState () {
    // The server option is offered exactly when the deployment says the feature
    // exists. It is offered even without a passphrase, because a teacher who has
    // one should be able to type it here rather than guess why the radio is dead.
    if (el.aiServerRadio) {
      el.aiServerRadio.disabled = !SERVER_AI.available
      el.aiServerRadio.checked = ai.source === 'server'
    }
    if (el.aiServerLabel) {
      el.aiServerLabel.className = 'swe-radio' + (SERVER_AI.available ? '' : ' swe-disabled')
    }
    if (el.aiCustomRadio) el.aiCustomRadio.checked = ai.source === 'custom'
    if (el.aiServerHint) {
      if (SERVER_AI.available) {
        el.aiServerHint.className = 'swe-note swe-ai-server-hint swe-ok'
        el.aiServerHint.textContent = SERVER_AI.note
          ? t('ai.serverLive', { model: SERVER_AI.model || '—' }) + ' ' + SERVER_AI.note
          : t('ai.serverLive', { model: SERVER_AI.model || '—' })
      } else {
        el.aiServerHint.className = 'swe-note swe-ai-server-hint'
        el.aiServerHint.textContent = SERVER_AI.checked
          ? t('ai.serverHint')
          : t('ai.serverChecking')
      }
    }
    if (el.aiEndpoint) {
      var url = resolveEndpoint(ai.baseUrl, 'chat')
      el.aiEndpoint.textContent = url ? t('ai.endpoint', { url: url }) : t('ai.endpointEmpty')
    }
    if (el.aiStoreHint) {
      el.aiStoreHint.textContent = ai.remember ? t('ai.savedHint') : t('ai.memoryHint')
    }
    renderAiBody()
  }

  /* Shows the half of the pane that belongs to the selected source. The custom
   * fields are hidden, not cleared: switching back must not make the teacher
   * retype an endpoint, and their values are never sent while server mode is
   * selected. */
  function renderAiBody () {
    var server = ai.source === 'server'
    if (el.aiCustomFields) el.aiCustomFields.style.display = server ? 'none' : ''
    if (el.aiServerBox) el.aiServerBox.style.display = server ? '' : 'none'
    if (el.aiTestBtn) {
      el.aiTestBtn.textContent = server ? t('ai.serverRefresh') : t('ai.test')
    }
    if (el.aiPassRow) {
      el.aiPassRow.style.display = (server && SERVER_AI.authRequired && !SERVER_AI.authenticated) ? '' : 'none'
    }
    if (el.aiSessionRow) {
      el.aiSessionRow.style.display = (server && SERVER_AI.authenticated) ? '' : 'none'
    }
    if (el.aiServerState) {
      var text
      if (!SERVER_AI.available) text = t('ai.serverUnavailableLong')
      else if (SERVER_AI.authRequired && !SERVER_AI.authenticated) text = t('ai.serverNeedLogin')
      else text = t('ai.serverReady', { model: SERVER_AI.model || '—', rev: SERVER_AI.revision })
      el.aiServerState.textContent = text
    }
  }

  // The host has its own locale (host_locales zh.json). The panel's switch owns
  // it, so the site looks the same whatever the OS/browser is set to. A host
  // built without the hook (older dist) simply keeps its own language.
  function syncHostLanguage () {
    var setter = window.__SWE_SET_LANG__
    if (typeof setter !== 'function') return false
    try { return setter(lang) === true } catch (e) { return false }
  }

  function applyLanguage () {
    if (!el.panel) return
    el.panel.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en')
    Array.prototype.forEach.call(el.panel.querySelectorAll('[data-i18n]'), function (n) {
      n.textContent = t(n.getAttribute('data-i18n'))
    })
    Array.prototype.forEach.call(el.panel.querySelectorAll('[data-i18n-ph]'), function (n) {
      n.setAttribute('placeholder', t(n.getAttribute('data-i18n-ph')))
    })
    if (el.langBtn) el.langBtn.textContent = t('lang.switch')
    // Titles are not data-i18n text nodes, so they need their own pass.
    if (el.speedPresetBtns) {
      for (var pi = 0; pi < el.speedPresetBtns.length; pi++) {
        var pb = el.speedPresetBtns[pi]
        var pf = pb.getAttribute('data-swe-speed')
        pb.title = pf + '× · ' + t('time.p' + pf)
      }
    }
    syncHostLanguage()
    lastExplainKey = null
    renderStatus()
    renderSelection()
    renderTime()
    renderLocation()
    renderView()
    renderExplain()
    renderProposal()
    renderAiState()
    // 0.14.0 surfaces. Chat history keeps the language it was written in;
    // only the chrome (title, chips, buttons) re-renders.
    renderChat()
    renderRecommendation()
  }

  function applyState (st) {
    if (!st) return
    state = st
    // Before anything compares contexts: this is what turns A -> B -> A into
    // a detectable change rather than a return to the starting value.
    noteSelectionEpoch(st)
    noteLocationFromHost(st)
    renderStatus()
    renderSelection()
    renderLayers()
    renderTime()
    renderLocation()
    renderView()
    noteProposalStale()
    renderExplain()
  }

  // A plan already shown as written for a different sky stays dead. The check
  // used to run only at click time against the current values, so A -> B
  // (marked void) -> A made the same plan look valid again and executable.
  // Now the verdict is latched: once the sky has moved, the plan cannot be
  // revived by moving it back.
  function noteProposalStale () {
    if (!proposal || proposal.stale) return
    // A running batch keeps its own anchor and checks between commands; it
    // would otherwise mark itself void with the commands it issued itself.
    if (runningExec) return
    var moved = contextChanges(proposal.context)
    if (!moved.length) return
    proposal.stale = true
    proposal.staleFields = moved
    if (el.askStatus) {
      el.askStatus.textContent = t('input.ctxChanged', { fields: contextFieldNames(moved) })
      el.askStatus.className = 'swe-note swe-err-text'
    }
    renderProposal()
  }

  // A site chosen in the host's own UI must survive a reload. Our own writes
  // are excluded so applying the default never looks like a user choice.
  function noteLocationFromHost (st) {
    if (!st.location) return
    if (pendingLoc && samePlace(st.location, pendingLoc)) return
    if (lastAppliedLoc && samePlace(st.location, lastAppliedLoc)) return
    if (prefs.location && samePlace(st.location, prefs.location)) return
    if (!prefs.location) return
    locSamples.push({ at: Date.now(), lat: st.location.lat, lng: st.location.lng })
    if (locSamples.length > 3) locSamples.shift()
    if (locSamples.length === 3) {
      var a = locSamples[0]
      var c = locSamples[2]
      if (samePlace(a, c) && c.at - a.at > 1200) {
        prefs.location = { lat: c.lat, lng: c.lng, elevation: st.location.elevation || 0, tz: prefs.tz, userSet: true }
        savePrefs()
        locSamples = []
        renderLocation()
      }
    }
  }

  /* ------------------------------------------------------------ build */

  function toggle (labelKey, key) {
    var btn = h('button', {
      class: 'swe-toggle',
      type: 'button',
      'aria-pressed': 'false',
      text: t(labelKey),
      onclick: function () {
        var cur = state && state.layers ? state.layers[key] : null
        runCommand({ type: 'set_layer', layer: key, visible: !cur })
      }
    })
    btn.dataset.layer = key
    btn.dataset.i18n = labelKey
    return btn
  }

  function section (titleKey, children) {
    return h('section', { class: 'swe-sec' }, [tx('h3', titleKey)].concat(children))
  }

  function buildPanel () {
    var ui = readJson(PANEL_KEY, {}) || {}
    collapsed = !!ui.collapsed

    el.status = h('div', { class: 'swe-status', text: t('status.connecting') })
    el.selBox = h('div', { class: 'swe-sel' })

    /* --- explanation --- */
    el.explainBox = h('div', { class: 'swe-explain' })

    /* --- current-time recommendation (0.14.0) --- */
    el.recBox = h('div', { class: 'swe-rec', 'data-swe-rec': 'box' })

    /* --- natural language input --- */
    el.askInput = h('input', {
      type: 'text',
      class: 'swe-input swe-ask',
      'data-i18n-ph': 'input.placeholder',
      placeholder: t('input.placeholder'),
      autocomplete: 'off'
    })
    el.askBtn = h('button', {
      class: 'swe-btn swe-primary',
      type: 'button',
      'data-swe-action': 'ask',
      text: t('input.send'),
      onclick: askAssistant
    })
    el.askStatus = h('div', { class: 'swe-note', 'data-swe-ask-status': 'true' })
    el.proposalBox = h('div', { class: 'swe-proposal', 'data-swe-proposal': 'true' })
    el.askInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); askAssistant() }
    })

    /* --- layers --- */
    el.layersBox = h('div', { class: 'swe-toggles' }, [
      toggle('layer.atmosphere', 'atmosphere'),
      toggle('layer.constellation_lines', 'constellation_lines'),
      toggle('layer.constellation_labels', 'constellation_labels'),
      toggle('layer.landscape', 'landscape'),
      toggle('layer.milkyway', 'milkyway'),
      toggle('layer.equatorial_grid', 'equatorial_grid'),
      toggle('layer.azimuthal_grid', 'azimuthal_grid')
    ])

    /* --- time --- */
    el.timeInput = h('input', { type: 'datetime-local', class: 'swe-input', step: '60' })
    el.timeText = h('div', { class: 'swe-note' })
    el.tzSelect = h('select', { class: 'swe-input swe-tz' }, TIME_ZONES.map(function (z) {
      return h('option', { value: z, text: z })
    }))
    el.tzSelect.value = prefs.tz
    el.tzSelect.addEventListener('change', function () {
      prefs.tz = el.tzSelect.value
      savePrefs()
      renderTime()
      lastExplainKey = null
      renderExplain()
    })
    var applyTime = function () {
      if (!el.timeInput.value) return
      var d = zonedToUtc(el.timeInput.value, prefs.tz)
      if (!d || isNaN(d.getTime())) { flash(t('time.bad')); return }
      timeDirty = false
      runCommand({ type: 'set_time', utc: d.toISOString() })
    }
    el.timeInput.addEventListener('input', function () { timeDirty = true })

    // Remembered so pause/resume returns to whatever the teacher had chosen
    // rather than silently resetting to 1x.
    var lastSpeed = 1
    var setSpeed = function (f) {
      if (f !== 0) lastSpeed = f
      runCommand({ type: 'set_time_speed', factor: f })
    }
    var togglePlay = function () {
      var cur = state && state.time && typeof state.time.speed === 'number' ? state.time.speed : 0
      setSpeed(cur === 0 ? (lastSpeed || 1) : 0)
    }
    var runCustomSpeed = function () {
      var f = parseFloat(el.speedCustom.value)
      if (!isFinite(f) || Math.abs(f) > 86400 || (f !== 0 && Math.abs(f) < 0.0001)) {
        flash(t('time.speedBad'))
        return
      }
      var cmd = { type: 'set_time_speed', factor: f }
      var hours = parseFloat(el.speedHours.value)
      // Blank means "keep running until someone stops it"; a number means
      // "stop by itself after that many simulated hours".
      if (f !== 0 && isFinite(hours) && hours > 0) cmd.simHours = hours
      runCommand(cmd)
    }

    /* --- site --- */
    el.locLat = h('input', { type: 'text', class: 'swe-input swe-lat', inputmode: 'decimal' })
    el.locLng = h('input', { type: 'text', class: 'swe-input swe-lng', inputmode: 'decimal' })
    el.locText = h('div', { class: 'swe-note' })
    // Once the teacher starts typing, the poll stops writing into these two
    // fields until the site is applied (or reset).
    el.locLat.addEventListener('input', function () { locDirty = true })
    el.locLng.addEventListener('input', function () { locDirty = true })
    var applySite = function () {
      var lat = parseFloat(el.locLat.value)
      var lng = parseFloat(el.locLng.value)
      if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        flash(t('loc.bad'))
        return
      }
      pendingLoc = { lat: lat, lng: lng }
      prefs.location = { lat: lat, lng: lng, elevation: 0, tz: prefs.tz, userSet: true }
      locDirty = false
      savePrefs()
      runCommand({ type: 'set_location', lat: lat, lng: lng, elevation: 0 }).then(function () {
        lastAppliedLoc = { lat: lat, lng: lng }
        pendingLoc = null
        locDirty = false
        renderLocation()
      })
    }
    var resetSite = function () {
      pendingLoc = { lat: DEFAULT_SITE.lat, lng: DEFAULT_SITE.lng }
      prefs.location = { lat: DEFAULT_SITE.lat, lng: DEFAULT_SITE.lng, elevation: DEFAULT_SITE.elevation, tz: DEFAULT_SITE.tz, userSet: false }
      prefs.tz = DEFAULT_SITE.tz
      el.tzSelect.value = prefs.tz
      locDirty = false
      savePrefs()
      runCommand({ type: 'set_location', lat: DEFAULT_SITE.lat, lng: DEFAULT_SITE.lng, elevation: DEFAULT_SITE.elevation })
        .then(function () {
          lastAppliedLoc = { lat: DEFAULT_SITE.lat, lng: DEFAULT_SITE.lng }
          pendingLoc = null
          renderLocation()
          renderTime()
        })
    }

    /* --- time rate -----------------------------------------------------
     * The host's own date picker only has play/pause; the engine underneath
     * accepts any rate. This block is the missing control, and it speaks the
     * same command the model does (set_time_speed), so a teacher who taps
     * "1000x" and a teacher who types "run a day at 1000x" end up in exactly
     * the same state. */
    el.speedNow = h('div', { class: 'swe-note swe-speed-now', 'data-swe-speed-now': 'true' })
    el.speedPlayBtn = h('button', {
      class: 'swe-btn swe-speed-play',
      type: 'button',
      'data-swe-action': 'time-play',
      text: t('time.pause'),
      onclick: function () { togglePlay() }
    })
    el.speedPresetBtns = []
    var SPEED_PRESETS = [1, 60, 3600, 86400]
    el.speedPresets = h('div', { class: 'swe-row-btns swe-speed-presets' }, SPEED_PRESETS.map(function (f) {
      var b = h('button', {
        class: 'swe-btn swe-speed-preset',
        type: 'button',
        'data-swe-speed': String(f),
        title: f + '× · ' + t('time.p' + f),
        text: f + '×',
        onclick: function () { setSpeed(f) }
      })
      el.speedPresetBtns.push(b)
      return b
    }))
    el.speedCustom = h('input', {
      type: 'number', class: 'swe-input swe-speed-factor',
      min: '0.0001', max: '86400', step: 'any', value: '1000',
      'aria-label': t('time.custom')
    })
    el.speedHours = h('input', {
      type: 'number', class: 'swe-input swe-speed-hours',
      min: '0', step: 'any', placeholder: '24',
      'aria-label': t('time.hours')
    })
    el.speedRunBtn = h('button', {
      class: 'swe-btn swe-primary swe-speed-run',
      type: 'button',
      'data-swe-action': 'time-run',
      text: t('time.run'),
      onclick: function () { runCustomSpeed() }
    })

    /* --- fov --- */
    el.viewText = h('div', { class: 'swe-note' })
    var fovRow = h('div', { class: 'swe-row-btns' }, [30, 20, 10, 5].map(function (d) {
      return h('button', {
        class: 'swe-btn', type: 'button', text: d + '°',
        onclick: function () { runCommand({ type: 'set_fov', deg: d }) }
      })
    }))

    /* --- AI settings --- */
    el.aiCustomRadio = h('input', { type: 'radio', name: 'swe-ai-source', value: 'custom' })
    el.aiServerRadio = h('input', { type: 'radio', name: 'swe-ai-source', value: 'server' })
    el.aiBaseUrl = h('input', {
      type: 'text', class: 'swe-input swe-ai-url',
      'data-i18n-ph': 'ai.baseUrlPh', placeholder: t('ai.baseUrlPh'),
      autocomplete: 'off', spellcheck: 'false'
    })
    el.aiModel = h('input', {
      type: 'text', class: 'swe-input swe-ai-model',
      'data-i18n-ph': 'ai.modelPh', placeholder: t('ai.modelPh'),
      autocomplete: 'off', spellcheck: 'false'
    })
    el.aiKey = h('input', {
      type: 'password', class: 'swe-input swe-ai-key',
      'data-i18n-ph': 'ai.apiKeyPh', placeholder: t('ai.apiKeyPh'),
      autocomplete: 'new-password', spellcheck: 'false'
    })
    el.aiRemember = h('input', { type: 'checkbox', class: 'swe-ai-remember' })
    el.aiEndpoint = h('div', { class: 'swe-note swe-ai-endpoint' })
    el.aiStoreHint = h('div', { class: 'swe-note' })
    el.aiServerHint = h('div', { class: 'swe-note swe-ai-server-hint' })
    el.aiServerState = h('div', { class: 'swe-note swe-ai-server-state', 'data-swe-server-state': 'true' })
    el.aiTestOut = h('div', { class: 'swe-note swe-ai-test' })
    el.aiTestBtn = h('button', {
      class: 'swe-btn', type: 'button', 'data-swe-action': 'ai-test',
      text: t('ai.test'), onclick: testConnection
    })

    // Classroom passphrase for the server route. A separate box from the custom
    // API key on purpose: they are different secrets with different owners, and
    // confusing them is how a vendor key ends up pasted into a school form.
    el.aiPassInput = h('input', {
      type: 'password', class: 'swe-input swe-ai-pass',
      'data-i18n-ph': 'ai.passPh', placeholder: t('ai.passPh'),
      autocomplete: 'current-password', spellcheck: 'false'
    })
    el.aiLoginBtn = h('button', {
      class: 'swe-btn swe-primary', type: 'button', 'data-swe-action': 'ai-login',
      text: t('ai.signIn'), onclick: serverLogin
    })
    el.aiLogoutBtn = h('button', {
      class: 'swe-btn', type: 'button', 'data-swe-action': 'ai-logout',
      text: t('ai.signOut'), onclick: serverLogout
    })
    el.aiPassRow = h('div', { class: 'swe-field' }, [
      h('span', { class: 'swe-field-label', 'data-i18n': 'ai.pass', text: t('ai.pass') }),
      el.aiPassInput,
      h('div', { class: 'swe-row-btns' }, [el.aiLoginBtn])
    ])
    el.aiSessionRow = h('div', { class: 'swe-row-btns' }, [el.aiLogoutBtn])

    // Enter in the passphrase box is the obvious gesture; without it the field
    // looks like it did nothing.
    el.aiPassInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return
      e.preventDefault()
      serverLogin()
    })

    el.aiBaseUrl.value = ai.baseUrl
    el.aiModel.value = ai.model
    el.aiKey.value = ai.apiKey
    el.aiRemember.checked = ai.remember

    var syncAi = function () {
      var before = [ai.baseUrl, ai.model, ai.apiKey].join('\u0000')
      ai.baseUrl = el.aiBaseUrl.value.trim()
      ai.model = el.aiModel.value.trim()
      ai.apiKey = el.aiKey.value
      ai.remember = el.aiRemember.checked
      // Editing the custom fields does not silently move the selection back to
      // custom: the radio is the only thing that chooses a source.
      // Editing the endpoint is not just a form change: anything still in
      // flight was addressed to the previous endpoint.
      if ([ai.baseUrl, ai.model, ai.apiKey].join('\u0000') !== before) noteConfigChanged()
      persistAiIfAsked()
      renderAiState()
    }
    ;[el.aiBaseUrl, el.aiModel, el.aiKey].forEach(function (n) {
      n.addEventListener('input', syncAi)
      n.addEventListener('change', syncAi)
    })
    el.aiRemember.addEventListener('change', syncAi)
    el.aiKey.addEventListener('input', function () {
      // Keep the value out of the DOM attribute space; only the property holds it.
      el.aiKey.removeAttribute('value')
    })

    // Switching source is a configuration change: an answer in flight belongs to
    // the source that asked for it, and a proposal written for one endpoint must
    // not be confirmed against the other.
    var setSource = function (src) {
      var next = src === 'server' ? 'server' : 'custom'
      if (next === ai.source) { renderAiState(); return }
      ai.source = next
      noteConfigChanged()
      if (proposal && !proposalBusy) {
        proposalSeq += 1
        proposal = null
        if (el.askStatus) el.askStatus.textContent = ''
        renderProposal()
      }
      persistAiIfAsked()
      renderAiState()
      setAiTest('', 'warn')
      if (next === 'server') refreshServerStatus()
    }
    el.aiCustomRadio.addEventListener('change', function () { if (el.aiCustomRadio.checked) setSource('custom') })
    el.aiServerRadio.addEventListener('change', function () { if (el.aiServerRadio.checked) setSource('server') })
    setSourceRef = setSource

    var clearAi = function () {
      ai.baseUrl = ''
      ai.model = ''
      ai.apiKey = ''
      ai.remember = false
      el.aiBaseUrl.value = ''
      el.aiModel.value = ''
      el.aiKey.value = ''
      el.aiRemember.checked = false
      removeKey(AI_KEY)
      // Clearing the settings is a configuration change like any other: an
      // answer still on its way would arrive with nothing left to belong to.
      // It also invalidates a proposal that has not run yet - the teacher is
      // clearly starting over.
      noteConfigChanged()
      if (proposal && !proposalBusy) {
        proposalSeq += 1
        proposal = null
        if (el.askStatus) el.askStatus.textContent = ''
        renderProposal()
      }
      renderAiState()
      setAiTest(t('ai.cleared'), 'ok')
    }

    // The custom client's fields, kept together so the whole group can be hidden
    // when the server route is selected without touching any of its values.
    el.aiCustomFields = h('div', { class: 'swe-ai-custom', 'data-swe-ai-custom': 'true' }, [
      h('div', { class: 'swe-field' }, [
        h('span', { class: 'swe-field-label', 'data-i18n': 'ai.baseUrl', text: t('ai.baseUrl') }),
        el.aiBaseUrl
      ]),
      h('div', { class: 'swe-field' }, [
        h('span', { class: 'swe-field-label', 'data-i18n': 'ai.model', text: t('ai.model') }),
        el.aiModel
      ]),
      h('div', { class: 'swe-field' }, [
        h('span', { class: 'swe-field-label', 'data-i18n': 'ai.apiKey', text: t('ai.apiKey') }),
        el.aiKey
      ]),
      h('label', { class: 'swe-check' }, [el.aiRemember, tx('span', 'ai.remember')]),
      h('p', { class: 'swe-placeholder', 'data-i18n': 'ai.rememberWarn', text: t('ai.rememberWarn') }),
      h('p', { class: 'swe-note', 'data-i18n': 'ai.keyNeverSent', text: t('ai.keyNeverSent') }),
      el.aiEndpoint,
      el.aiStoreHint
    ])

    el.aiServerBox = h('div', { class: 'swe-ai-server', 'data-swe-ai-server': 'true' }, [
      el.aiServerState,
      el.aiPassRow,
      el.aiSessionRow,
      h('p', { class: 'swe-note', 'data-i18n': 'ai.serverPrivacy', text: t('ai.serverPrivacy') })
    ])

    // Was a <details> at the bottom of a long column. It is now the whole AI
    // pane: the sidebar had seven sections before this one, and the settings
    // were the least frequently opened part of all of them.
    var aiSection = h('div', { class: 'swe-ai' }, [
      h('div', { class: 'swe-field' }, [
        h('span', { class: 'swe-field-label', 'data-i18n': 'ai.source', text: t('ai.source') }),
        h('label', { class: 'swe-radio' }, [el.aiCustomRadio, tx('span', 'ai.custom')]),
        el.aiServerLabel = h('label', { class: 'swe-radio swe-disabled' }, [
          el.aiServerRadio,
          tx('span', 'ai.server')
        ])
      ]),
      el.aiServerHint,
      el.aiCustomFields,
      el.aiServerBox,
      h('div', { class: 'swe-row-btns' }, [
        el.aiTestBtn,
        h('button', { class: 'swe-btn', type: 'button', 'data-swe-action': 'ai-clear', text: t('ai.clear'), onclick: clearAi })
      ]),
      el.aiTestOut
    ])

    var body = h('div', { class: 'swe-body' }, [
      h('div', { class: 'swe-view', 'data-swe-view': 'sky' }, [
        el.status,
        section('sec.object', [el.selBox]),
        section('sec.explain', [el.explainBox]),
        section('sec.recommend', [
          h('div', { class: 'swe-row-btns' }, [
            h('button', {
              class: 'swe-btn', type: 'button', 'data-swe-action': 'recommend',
              text: t('rec.run'), onclick: requestRecommendation
            }),
            h('button', {
              class: 'swe-btn', type: 'button', 'data-swe-action': 'chat-ask',
              'data-swe-chat-ask': 'true',
              text: t('chat.askSky'),
              onclick: function () { openChat('ask') }
            })
          ]),
          el.recBox
        ]),
        section('sec.input', [el.askInput, h('div', { class: 'swe-row-btns' }, [el.askBtn]), el.askStatus, el.proposalBox])
      ]),
      h('div', { class: 'swe-view', 'data-swe-view': 'view' }, [
        section('sec.layers', [el.layersBox]),
        section('sec.fov', [fovRow, el.viewText]),
        section('sec.location', [
          h('div', { class: 'swe-field swe-field-2' }, [
            tx('span', 'loc.lat', { class: 'swe-field-label' }), el.locLat,
            tx('span', 'loc.lng', { class: 'swe-field-label' }), el.locLng
          ]),
          h('div', { class: 'swe-row-btns' }, [
            h('button', { class: 'swe-btn', type: 'button', 'data-i18n': 'loc.apply', text: t('loc.apply'), onclick: applySite }),
            h('button', { class: 'swe-btn', type: 'button', 'data-i18n': 'loc.reset', text: t('loc.reset'), onclick: resetSite })
          ]),
          el.locText
        ])
      ]),
      h('div', { class: 'swe-view', 'data-swe-view': 'time' }, [
        section('sec.time', [
          el.timeInput,
          h('div', { class: 'swe-field' }, [tx('span', 'time.zone', { class: 'swe-field-label' }), el.tzSelect]),
          h('div', { class: 'swe-row-btns' }, [
            h('button', { class: 'swe-btn', type: 'button', 'data-i18n': 'time.apply', text: t('time.apply'), onclick: applyTime }),
            h('button', {
              class: 'swe-btn', type: 'button', 'data-i18n': 'time.now', text: t('time.now'),
              onclick: function () { timeDirty = false; runCommand({ type: 'set_time', utc: new Date().toISOString() }) }
            })
          ]),
          el.timeText,
          h('div', { class: 'swe-note', 'data-i18n': 'time.note', text: t('time.note', { tz: prefs.tz }) }),
          h('div', { class: 'swe-sep' }),
          h('div', { class: 'swe-field' }, [
            tx('span', 'time.speed', { class: 'swe-field-label' }),
            el.speedNow
          ]),
          h('div', { class: 'swe-row-btns' }, [el.speedPlayBtn]),
          el.speedPresets,
          h('div', { class: 'swe-field swe-field-2' }, [
            tx('span', 'time.custom', { class: 'swe-field-label' }), el.speedCustom,
            tx('span', 'time.hours', { class: 'swe-field-label' }), el.speedHours
          ]),
          h('div', { class: 'swe-row-btns' }, [el.speedRunBtn]),
          h('div', { class: 'swe-note', text: t('time.speedNote') })
        ])
      ]),
      h('div', { class: 'swe-view', 'data-swe-view': 'ai' }, [aiSection])
    ])

    var collapseBtn = h('button', {
      class: 'swe-icon-btn',
      type: 'button',
      'data-i18n-title': 'app.collapse',
      title: t('app.collapse'),
      text: collapsed ? '+' : '–',
      onclick: function (e) {
        e.stopPropagation()
        collapsed = !collapsed
        el.panel.classList.toggle('swe-collapsed', collapsed)
        collapseBtn.textContent = collapsed ? '+' : '–'
        savePanelPrefs()
      }
    })

    el.langBtn = h('button', {
      class: 'swe-lang',
      type: 'button',
      'data-swe-action': 'lang',
      text: t('lang.switch'),
      onclick: function () {
        lang = lang === 'zh' ? 'en' : 'zh'
        prefs.language = lang
        savePrefs()
        // A request in flight was asked in the previous language. Its answer
        // would arrive in that language and be rendered under the new one, so
        // it is treated like any other configuration change: cancelled, and any
        // unconfirmed proposal is dropped rather than executed under a prompt
        // nobody can read any more.
        noteConfigChanged()
        applyLanguage()
      }
    })

    /* --- tabs ----------------------------------------------------------
     * One job per tab. The last tab is the AI form that used to sit at the
     * bottom of the column; it is opened far less often than the ask box, so
     * it should not push the ask box out of view. */
    var TAB_LIST = ['sky', 'view', 'time', 'ai']
    var tabBtns = {}
    var viewNodes = {}
    for (var vt = 0; vt < TAB_LIST.length; vt++) {
      viewNodes[TAB_LIST[vt]] = body.querySelector('[data-swe-view="' + TAB_LIST[vt] + '"]')
    }
    activeTab = (ui.tab && viewNodes[ui.tab]) ? ui.tab : 'sky'

    function showTab (k) {
      if (!viewNodes[k]) return
      activeTab = k
      for (var i = 0; i < TAB_LIST.length; i++) {
        var n = TAB_LIST[i]
        viewNodes[n].classList.toggle('swe-view-active', n === k)
        if (tabBtns[n]) {
          tabBtns[n].classList.toggle('swe-tab-active', n === k)
          tabBtns[n].setAttribute('aria-selected', n === k ? 'true' : 'false')
        }
      }
      ui.tab = k
      savePanelPrefs()
    }
    showTabRef = showTab

    var tabs = h('nav', { class: 'swe-tabs', role: 'tablist' }, TAB_LIST.map(function (k) {
      var b = h('button', {
        class: 'swe-tab',
        type: 'button',
        role: 'tab',
        'data-swe-tab': k,
        'data-i18n': 'tab.' + k,
        title: t('tab.hint.' + k),
        text: t('tab.' + k),
        onclick: function () { showTab(k) }
      })
      tabBtns[k] = b
      return b
    }))

    var header = h('header', { class: 'swe-head' }, [
      tx('span', 'app.title', { class: 'swe-title' }),
      h('span', { class: 'swe-ver', text: 'v' + VERSION }),
      h('span', { class: 'swe-spacer' }),
      el.langBtn,
      collapseBtn
    ])

    el.panel = h('aside', {
      class: 'swe-panel' + (collapsed ? ' swe-collapsed' : ''),
      role: 'complementary',
      'aria-label': 'Stellarium teaching assistant',
      'data-swe-assistant': 'panel',
      lang: lang === 'zh' ? 'zh-CN' : 'en'
    }, [header, tabs, body])

    if (typeof ui.left === 'number' && typeof ui.top === 'number') {
      el.panel.style.left = ui.left + 'px'
      el.panel.style.top = ui.top + 'px'
      el.panel.style.right = 'auto'
      el.panel.style.bottom = 'auto'
    }
    if (typeof ui.width === 'number') {
      el.panel.style.width = Math.max(280, Math.min(560, ui.width)) + 'px'
    }

    el.panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        collapsed = true
        el.panel.classList.add('swe-collapsed')
        collapseBtn.textContent = '+'
        savePanelPrefs()
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
        return
      }
      e.stopPropagation()
    })
    el.panel.addEventListener('keyup', function (e) { e.stopPropagation() })

    makeDraggable(el.panel, header)
    document.body.appendChild(el.panel)
    showTab(activeTab)
    renderAiState()
  }

  function savePanelPrefs () {
    try {
      var rect = el.panel.getBoundingClientRect()
      writeJson(PANEL_KEY, {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        collapsed: collapsed,
        tab: activeTab
      })
    } catch (e) {}
  }

  function makeDraggable (panel, handle) {
    var drag = null
    handle.addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) return
      var rect = panel.getBoundingClientRect()
      drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
      e.preventDefault()
    })
    window.addEventListener('mousemove', function (e) {
      if (!drag) return
      var left = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.dx))
      var top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy))
      panel.style.left = left + 'px'
      panel.style.top = top + 'px'
      panel.style.right = 'auto'
      panel.style.bottom = 'auto'
    })
    window.addEventListener('mouseup', function () {
      if (drag) { drag = null; savePanelPrefs() }
    })
  }

  function buildUnavailable (msg) {
    el.panel = h('aside', { class: 'swe-panel swe-collapsed', 'data-swe-assistant': 'panel' }, [
      h('header', { class: 'swe-head' }, [h('span', { class: 'swe-title', text: t('app.title') })]),
      h('div', { class: 'swe-body' }, [h('p', { class: 'swe-empty', text: msg })])
    ])
    document.body.appendChild(el.panel)
  }

  /* ------------------------------------------------------- default site */

  function applyDefaultSite () {
    prefs.location = {
      lat: DEFAULT_SITE.lat,
      lng: DEFAULT_SITE.lng,
      elevation: DEFAULT_SITE.elevation,
      tz: DEFAULT_SITE.tz,
      userSet: false
    }
    prefs.tz = DEFAULT_SITE.tz
    savePrefs()
    pendingLoc = { lat: DEFAULT_SITE.lat, lng: DEFAULT_SITE.lng }
    return runCommand({
      type: 'set_location',
      lat: DEFAULT_SITE.lat,
      lng: DEFAULT_SITE.lng,
      elevation: DEFAULT_SITE.elevation
    }).then(function () {
      lastAppliedLoc = { lat: DEFAULT_SITE.lat, lng: DEFAULT_SITE.lng }
      pendingLoc = null
    })
  }

  function restoreSite () {
    if (!prefs.location) return applyDefaultSite()
    pendingLoc = { lat: prefs.location.lat, lng: prefs.location.lng }
    return runCommand({
      type: 'set_location',
      lat: prefs.location.lat,
      lng: prefs.location.lng,
      elevation: prefs.location.elevation || 0
    }).then(function () {
      lastAppliedLoc = { lat: prefs.location.lat, lng: prefs.location.lng }
      pendingLoc = null
    })
  }

  /* --------------------------------------------------------------- init */

  function init (b) {
    if (!b) {
      buildUnavailable(t('status.noEngine') + ' — ' + t('explain.offline', { msg: t('status.noEngine') }))
      return
    }
    if (b.protocolVersion !== PROTOCOL_EXPECTED) {
      buildUnavailable(t('status.incompatible', { bridge: b.protocolVersion, want: PROTOCOL_EXPECTED }))
      return
    }
    // Restore the AI endpoint before the panel is built: the fields are filled
    // from `ai` at construction time, so loading afterwards would leave them
    // blank even though the saved config was read.
    loadAi()
    // Same rule for the observing preferences, and it matters twice over:
    // the time-zone select and the UI language are read while the panel is
    // being built, and restoreSite() must already know the saved location -
    // otherwise it applies the Shanghai default and then SAVES it over the
    // teacher's site on every single reload.
    loadPrefs()
    buildPanel()
    // The host chrome follows the restored language from the first frame
    // instead of staying in the default until the switch is pressed.
    syncHostLanguage()
    var st = b.readState()
    if (st) applyState(st)
    b.subscribeState(function (s) { applyState(s) })
    setInterval(function () {
      var s = b.readState()
      if (s) applyState(s)
    }, 2000)
    // Default or restored site is applied once, after the panel exists so the
    // user sees the location change rather than a silent jump.
    restoreSite()
    // Ask the deployment whether it offers server AI. A site served by the
    // plain static server answers 404 here, which is a supported state, not an
    // error: the option simply stays closed.
    refreshServerStatus()
    // One quiet attempt at the optional curated-target file (0.14.0). A 404
    // or a corrupt file only means "no external provider"; the init path
    // never fails because of it.
    loadExternalTargets()
    exposeTestSurface()
  }

  function exposeTestSurface () {
    // Deliberately small and read-mostly: tests drive the UI through the DOM,
    // this only avoids re-deriving internal counters from pixels.
    window[TEST_KEY] = {
      version: VERSION,
      getLanguage: function () { return lang },
      getPrefs: function () { return JSON.parse(JSON.stringify(prefs)) },
      getAiConfig: function () { return { source: ai.source, baseUrl: ai.baseUrl, model: ai.model, hasKey: !!ai.apiKey, remember: ai.remember } },
      resolveEndpoint: resolveEndpoint,
      getProposal: function () {
        return proposal
          ? JSON.parse(JSON.stringify({
              items: proposal.items,
              say: proposal.say,
              stale: !!proposal.stale,
              staleFields: proposal.staleFields || [],
              // What the plan is bound to. The tag and the counter are
              // deliberately non-sensitive: the point is to let a test see
              // WHICH revision/session a plan claims, not to expose a secret.
              bind: proposal.bind
                ? {
                    revision: proposal.bind.revision,
                    authGen: proposal.bind.authGen,
                    role: proposal.bind.role || null,
                    sessionTag: proposal.bind.sessionTag,
                    verified: !!proposal.bind.verified
                  }
                : null
            }))
          : null
      },
      // Takes the path a click cannot take once the plan is void (the confirm
      // button is disabled), so a test can prove the guard rather than only
      // the disabled attribute.
      forceRunProposal: function () { runProposal() },
      getExplanation: function () { return explanation ? { id: explanation.id, snapshotId: explanation.snapshotId, text: explanation.text } : null },
      explainSeq: function () { return explainSeq },
      serverAiAvailable: function () { return SERVER_AI.available },
      getServerAi: function () {
        return {
          available: SERVER_AI.available,
          model: SERVER_AI.model,
          revision: SERVER_AI.revision,
          authRequired: SERVER_AI.authRequired,
          authenticated: SERVER_AI.authenticated,
          role: SERVER_AI.role,
          checked: SERVER_AI.checked,
          sessionTag: SERVER_AI.sessionTag,
          verified: SERVER_AI.verified
        }
      },
      // Selecting a source without a click, for the same reason forceRunProposal
      // exists: the guard, not the widget, is what needs proving.
      setSource: function (s) { if (setSourceRef) setSourceRef(s) },
      refreshServerStatus: function () { return refreshServerStatus() },
      // The generation deadline is a deployment property that used to live in a
      // hot-patch. Exposing it lets a test assert 180 s without waiting 180 s.
      // The status deadline (C2-b) is the probe budget unless a test shortens
      // it, so a "status endpoint that never answers" case does not wait 15 s.
      getTimeouts: function () {
        return {
          gen: GEN_TIMEOUT_MS,
          probe: PROBE_TIMEOUT_MS,
          status: (typeof window !== 'undefined' && window.__SWE_AI_STATUS_TIMEOUT_MS__) || PROBE_TIMEOUT_MS
        }
      },
      // Backdates the status cache so the next ask or confirm performs a real
      // read even though a fresh one exists (C2-a evidence path).
      expireServerStatusCache: function () { statusAt = 0 },
      getTab: function () { return activeTab },
      showTab: function (k) { if (showTabRef) showTabRef(k) },
      // 0.14.0: chat and recommendation hooks, same spirit as above - the DOM
      // path a teacher uses stays primary; these let a test prove the guards.
      chatState: function () {
        return {
          open: chat.open,
          busy: chat.busy,
          topic: chat.topic ? (chat.topic.displayName || chat.topic.designation) : null,
          hasOrigin: !!chat.origin,
          originDesignation: chat.origin && chat.origin.snapshotPayload &&
            chat.origin.snapshotPayload.object
            ? chat.origin.snapshotPayload.object.designation
            : null,
          userTurns: chat.messages.filter(function (m) { return m.role === 'user' }).length,
          assistantTurns: chat.messages.filter(function (m) { return m.role === 'assistant' }).length,
          noteCount: chat.messages.filter(function (m) { return m.role === 'note' }).length,
          truncated: chat.truncated,
          hasPendingDigest: !!chat.pendingDigest,
          digestUtc: chat.pendingDigest ? (chat.pendingDigest.computedForUtc || null) : null,
          seq: chat.seq,
          hasAbort: !!chat.abort
        }
      },
      openChat: function (mode) { openChat(mode) },
      closeChat: closeChat,
      chatSend: function (text) { chatSend(text) },
      chatStop: chatStop,
      clearChat: clearChat,
      requestRecommendation: requestRecommendation,
      // R9 (review round 3): the system-shed guard needs a digest larger than
      // any real provider could produce; a test sets it directly. Same spirit
      // as setSource - the guard is what needs proving, not the widget.
      setPendingDigest: function (d) { chat.pendingDigest = d },
      getRecommendation: function () {
        return {
          computedAt: recState.at,
          busy: recState.busy,
          result: recState.result,
          external: { loaded: externalTargets.length, source: externalSource, error: externalError }
        }
      }
    }
  }

  try {
    bridge.ready.then(init, function () { init(null) })
  } catch (e) {
    buildUnavailable('init failed: ' + (e && e.message ? e.message : 'unknown'))
  }
})()
