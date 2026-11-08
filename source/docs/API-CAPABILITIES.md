# Stellarium Web 引擎能力表（实测）

被测宿主：`Stellarium/stellarium-web-engine` @ `1162c9ef73cc94f4762dfbfd24c637190119ea93`
本地构建产物，Chrome 141（Playwright 驱动），2026-10-30。
桥接协议 **v2**（`loader.js` 0.2.0）；v1 的同步命令接口已废弃。

标记含义：

- **实测**：由 `tests/e2e/smoke.mjs`、`tests/e2e/hotswap.mjs`、`tools/probe.mjs` 在真实浏览器里执行并读回校验。
- **静态核实**：只读了源码，未运行。
- **不可用**：确认为缺口。

每次运行的日志开头会打印服务端实际发出的 `index.html` / `loader.js` / `assistant.js` 的 sha256 与 `assetQuery`，日志只对那组字节有效。

---

## 1. 引擎实例接入

| 能力 | 结论 | 依据 |
|---|---|---|
| 从页面外拿到引擎对象 | **可用** | `document.getElementById('app').__vue__.$stel`。Vue 2 在 `_update` 中无条件写 `vm.$el.__vue__ = vm`（`vue.runtime.common.dev.js`），`$stel` 挂在 `Vue.prototype` 上（`sw_helpers.js:47`） |
| 是否只有一个引擎实例 | **是** | `App.vue` 的 `mounted` 里 `swh.initStelWebEngine(...)` 只调用一次，`#stel-canvas` 唯一 |
| 引擎就绪信号 | **无事件** | 只能轮询 `$stel` 是否出现；桥接层用 100ms 轮询，60s 超时后停用助手 |
| 是否需要改宿主源码 | **不需要** | 宿主补丁只是 `dist/index.html` 里加 1 个 `<script>` |
| 是否能拿到引擎版本号 | **不可用** | 构建产物无版本常量；只能用上游 commit SHA 标识 |

## 2. 选中天体

| 能力 | 结论 | 调用方式 |
|---|---|---|
| 读取当前选中 | **实测** | `$stel.core.selection` → SweObj 或 `null` |
| 写入选中 | **实测** | `$stel.core.selection = obj`（宿主自身也这么做：`sw_helpers.js:365`） |
| 清除选中 | **不可用** | `$stel.core.selection = null` 不生效，读回仍是原对象。想"取消选中"只能换成另一个目标，或由宿主 UI 触发 |
| 选中变化事件 | **实测** | `$stel.onValueChanged(cb)`，`path === 'selection'`（注意：前缀 `core.` 已被剥掉） |
| 点选星图选中天体 | **不可用** | 前端没有注册 `$stel.on('click')`，也没有导出 `core_get_obj_at`。点击画布不会改变 `core.selection`（已实测：点击前后均为 `null`） |
| 选中后自动转向 | **实测** | `$stel.pointAndLock(obj, 0.8)` |

## 3. 天体信息读取

| 字段 | 结论 | 说明 |
|---|---|---|
| 名称列表 | **实测** | `obj.designations()`，例：`["NAME Andromeda Nebula","M 31","NAME Andromeda Galaxy",...]` |
| 类型 | **实测（需绕行）** | `obj.otype` 是 `undefined`；类型码在 `obj.jsonData.types[0]`（如 `"G"`），再用 `$stel.otypeToStr(code)` 转英文名（`"G"`→Galaxy，`"Pla"`→Planet，`"*"`→Star） |
| 星等 | **实测** | `obj.getInfo('vmag')`，M31 得 3.4375 |
| 赤经赤纬 | **实测（需换算）** | `obj.getInfo('radec')` 返回的是 **4 维笛卡尔单位向量**，不是角度；需 `$stel.c2s(v)` → `[ra, dec]`（弧度） |
| 地平高度/方位 | **实测（需换算）** | `$stel.convertFrame(obs,'ICRF','OBSERVED',radec)` 再 `c2s()` → `[az, alt]` |
| 距离 | **部分** | 恒星/太阳有（天狼星 27035540 AU、太阳 0.993 AU），深空天体为 `null` |
| 角半径 | **部分** | 深空天体为 `null` |
| 物理参数（质量、光谱型等） | **不可用** | 引擎不提供；只有 `jsonData` 原始记录 |

## 4. 图层开关（全部实测可写可读回）

| 语义 | 路径 |
|---|---|
| 大气 | `core.atmosphere.visible` |
| 星座线 | `core.constellations.lines_visible` |
| 星座名 | `core.constellations.labels_visible` |
| 星座图 | `core.constellations.images_visible` |
| 地景 | `core.landscapes.visible` |
| 银河 | `core.milkyway.visible` |
| 恒星 | `core.stars.visible` |
| 深空天体 | `core.dsos.visible` |
| 赤道网格 | `core.lines.equatorial_jnow.visible` |
| 地平网格 | `core.lines.azimuthal.visible` |
| 子午线 | `core.lines.meridian.visible` |

注意：`core.constellations` **没有** `visible` 属性，必须用上面三个细分开关。

## 5. 时间 / 地点 / 视场 / 指向

| 能力 | 结论 | 说明 |
|---|---|---|
| 设置时间 | **实测精确** | `core.observer.utc = MJD`；MJD = `Date.parse(iso)/86400000 + 40587.0`（Unix 纪元 MJD）。写入 61400 读回 61400（误差 <1e-9） |
| 时间输入格式 | **强制带时区** | 只接受 ISO 8601 且结尾为 `Z` 或 `±HH:MM`。`2026-12-25T12:00:00`（无时区）→ `invalid_value`；`2026-12-25`（只有日期）→ `invalid_value`；`2026-12-25T20:00:00+08:00` 正确换算成 `2026-12-25T12:00:00Z` |
| 读取时间 | **实测** | `core.observer.utc`（MJD，UTC） |
| 时区 | **不可用** | 引擎只认 UTC/MJD，没有时区概念；"今晚八点"必须由上层按用户时区换算 |
| 设置地点 | **实测** | `core.observer.latitude/longitude`（弧度）、`.elevation`（米） |
| 读取地点 | **实测** | 同上，读回 40.000°/116.000° 与写入一致 |
| 读取视场 | **实测** | `core.fov`（弧度） |
| 设置视场 | **实测** | `$stel.zoomTo(rad, 0.5)`，有动画；写入 10° 读回 9.9999° |
| 指向任意坐标 | **可用** | `$stel.lookAt(pos, duration)`（未在本次演示中使用） |

**关于 MJD 常数的教训**：`40587.5` 是错的，正确的是 `40587.0`。因为读写用同一个错常数，纯"写入→读回"的自洽测试**抓不到**这个错误——它会一直通过，而画面上的天空整体偏 12 小时（北京 22:30 显示成白天，太阳高度 +32°）。真正抓到它的是**物理断言**：北京 22:30 太阳必须在地平线以下（实测修正后 −57.6°）。这类"自洽但错误"的换算，后续凡涉及时间/坐标都必须配一条独立物理校验，见 `tests/e2e/smoke.mjs` 中的 `sunAlt < -20` 断言。

## 5.1 命令结果语义（协议 v2）

`executeCommand` 返回 Promise。**调用不抛异常不等于成功**：每条命令都会读回引擎，只有观测值符合要求才报 `applied`。

| 字段 | 含义 |
|---|---|
| `ok` | 命令是否被接受并达到目标 |
| `status` | `applied`（已到终态）/ `timeout`（已发出但未在限时内到达）/ `failed` |
| `waitedMs` | 等待动画收敛的实际耗时 |
| `readback` | 引擎读回的实际值（时间、地点、视场、选中、图层开关） |
| `error.code` | `invalid_command` `unknown_command_type` `unexpected_field` `missing_field` `unknown_layer` `invalid_value` `out_of_range` `object_not_found` `command_failed` `engine_unavailable` |

各类命令的"完成"判定：

| 命令 | 判定方式 | 未达成时 |
|---|---|---|
| `set_layer` / `set_layer_flag` | 读回该属性 === 请求值 | `command_failed` |
| `set_time` | 读回 `observer.utc` 与目标 MJD 差 < 2e-5 天 | `command_failed` |
| `set_location` | 读回经纬度与目标差 < 1e-6° | `command_failed` |
| `select_object`（`lock:false`） | 读回 `core.selection` 的 id === 目标 | `command_failed` |
| `select_object`（默认 lock） | 等视角中心与目标方位/高度差 < 3°，限时 4s | `timeout` |
| `set_fov` | 等 `core.fov` 与目标差 ≤ max(0.01°, 1%)，限时 4s | `timeout` |
| `set_time_speed` | 读回 `core.time_speed` 与请求值差 < 1e-6 | `command_failed` |
| `read_state` | 直接返回 | — |

### 时间流速（0.7.0 新增）

引擎本来就有倍率，上游前端只暴露了播放/暂停。0.7.0 把 `core.time_speed` 提成白名单命令：

| 项 | 值 |
|---|---|
| 命令 | `set_time_speed {factor, simHours?}` |
| 语义 | `0` 停 / `1` 实时 / `N` 每真实秒 N 模拟秒 / 负数倒放 |
| 自动停 | 给 `simHours` 就按倍率走完那么多模拟小时后停表，真实秒数由桥接换算 |
| 上限 | `\|factor\|` ≤ 86400、非零 ≥ 0.0001、`simHours` ≤ 100000、折算真实耗时 ≤ 72 小时 |
| 依据 | 引擎把这些值当裸 double 存，C 层没有任何校验，所以上限全在桥接这一层 |
| 读回 | `state.time.speed` / `state.time.running` / `state.time.jumps`；命令读回含 `realSeconds` 与 `stopAtUtc` |
| 跳时计数 | `state.time.jumps`（0.9.0 新增，0.10.0 起自身写入当场登记，单调递增）：桥接逐帧比对时钟位移与本帧倍率能解释的位移，超出的算一次跳时；经本桥接的 `set_time` 在写入处就计一次并重锚帧基线（下一帧不再数第二次）。**只说明"时钟被跳了"，不说谁跳的**——宿主自己的时间面板、快捷键、另一个页面、以及经桥接的 `set_time` 都算。调用方自己发过 `set_time` 时，按命令类型跳过那一次的判定（0.10.0 起信号就落在那条命令内） |
| 探测 | `getCapabilities().features.timeJumpSignal` 为 `true` |

完整说明、实测数据与"为什么盯引擎时钟而不是墙上时钟"，见 `docs/TIME-CONTROL.md`。

注入故障实测：把 `stel.zoomTo` / `stel.pointAndLock` 换成抛异常的函数 → `ok:false, code:'command_failed'`；把 `zoomTo` 换成空函数（动画不动）→ `ok:true, status:'timeout', waitedMs≈4030`。**两种都不会报成完成。**

## 5.2 观测快照（协议 v2）

| 能力 | 结论 | 说明 |
|---|---|---|
| `captureSnapshot()` | **实测** | 返回带 `snapshotId` 的冻结快照（时间/地点/视场/图层/选中），供讲解请求使用；0.3.0 起还带 `signature`（实质变化指纹） |
| `snapshotId` 何时变 | **实测** | 桥接每 500ms 比对一次可观测状态；时间按 10 秒量化，避免运行中的时钟每帧触发；用户通过**宿主自己的界面**改时间/地点/视场/图层同样会触发 |
| `isCurrentSnapshot(id)` | **实测** | 严格判据：只有计数器仍是最新才为真。**注意：引擎时钟一直在走，这几乎总是立刻为假**，不适合用来判断"讲解是否过时" |
| `isSnapshotCurrent(snap)` | **实测** | 0.3.0 新增的**实质判据**：对象、地点、视场、一分钟以内的模拟时间都没变才算未过期。客户端用它决定"讲解"是否标过期；桥接缺这个方法时客户端回退到严格判据（更严格但不出错） |
| 面板行为 | **实测** | 冻结后天空再变化，面板把该快照标记为"已过期"，**不重写**已冻结的内容 |

## 6. 名称检索

| 能力 | 结论 | 说明 |
|---|---|---|
| 按精确 designation 查 | **实测** | `$stel.getObj('M 31')`、`'* alf Ori'`、`'CON western Ori'`、`'NAME Sun'` 均命中 |
| 模糊/别名匹配 | **不可用** | `core_search` 只返回单个结果，没有候选列表 |
| 中文名检索 | 引擎不可用，桥接可用 | 引擎 `getObj('仙女座星系')` 返回 `null`（无中文星名表）；`select_object` 经桥接归一化后可用，覆盖 88 个星座中英名、行星日月、17 组亮星、9 组深空，见 `docs/OBJECT-NAMING.md` |
| 英文俗名检索 | **不可用** | `getObj('Andromeda Galaxy')`、`getObj('orion nebula')` 均返回 `null`，只认 designation（注意 `'NAME Andromeda Galaxy'` 可以命中，因为它是该对象的别名之一） |
| 大小写敏感 | **否** | `'m 42'`、`'NAME jupiter'`、`'con western ori'`、`'* ALF ori'` 均命中。此前本文记为"敏感"是**误判**：`m42` 失败的原因是缺空格，与大小写无关 |
| 空格敏感 | **是** | `'M42'`、`'M  42'`、`'M 42 '`、`'NGC7000'` 全部 miss。目录号必须写成"字母 + 一个空格 + 数字" |
| 多义名称消歧 | **不可用** | 需要上层维护映射或加候选逻辑 |
| 目录完整性 | **好于预期** | 实测 36 个教学目标 **31 个命中**（**直查引擎，未经桥接**）：13 个梅西耶天体、日月、八大行星、5 颗亮星、4 个星座。5 个未命中全部是命名写法问题，不是数据缺失。0.5.0 起桥接层对这类写法做归一化，见 `docs/OBJECT-NAMING.md` §3 |

可用的名称形态（实测命中）：

- 梅西耶：`M 1` `M 7` `M 8` `M 13` `M 27` `M 31` `M 42` `M 44` `M 45` `M 51` `M 57` `M 81` `M 104`
- 行星/日月：`NAME Sun` `NAME Moon` `NAME Mercury` … `NAME Neptune`
- 亮星：`* alf Ori`（参宿四）`* alf CMa`（天狼）`* alf Lyr`（织女）`* alf Boo`（大角）`* alf UMi`（北极星）
- 星座：`CON western Ori` `CON western UMa` `CON western Cas` `CON western Sco`

**完整语法、实测矩阵、以及"为什么行星要 NAME 而恒星不要"，见 `docs/OBJECT-NAMING.md`。**
0.6.0 起，这份语法以**独立文件** `ai-assistant/naming-reference.js` 随包安装，
既是面板提示词的内容来源，也能被页面里的其它 agent 直接读取（见 §6.1）。

### 6.1 名称语法参考（0.6.0 新增，可给其它 agent 用）

| 能力 | 结论 | 说明 |
|---|---|---|
| `window.SWE_NAMING_REFERENCE` | **实测** | 参考文件挂出的全局对象。`toPrompt(lang, {level})` 生成提示词片段，`toJSON()` 返回纯数据，`toMarkdown(lang)` 返回人读文档 |
| `bridge.namingReference()` | **实测** | 返回 `toJSON()` 的纯数据副本；参考脚本没加载时返回 `null`（不抛错），调用方回退到 `docs/OBJECT-NAMING.md` |
| `getCapabilities().features.namingReference` | **实测** | 恒为 `true`（0.5.0 加载器起提供），用于探测 |
| 语法本身 | **实测** | 四类形态用正则给出：`^NAME [A-Za-z]+$` / `^(\* [a-z]{3} [A-Z][A-Za-z]{2}|[A-Z][A-Za-z]+)$` / `^(M|C|NGC|IC|HIP|HD) [0-9]+$` / `^CON western [A-Z][A-Za-z]{2}$` |
| 数据规模 | **实测** | 88 星座 × (缩写/中文/英文)、10 组行星、17 组亮星、9 组深空、9 条常见错写、6 组 few-shot |
| 一致性 | **测试保证** | `tests/reference/consistency.mjs` 把 88 星座等三张表与 `loader.js` 的别名表逐行比对，任一侧改动而另一侧未跟上就失败 |
| 两档体积 | **实测** | 紧凑档 815 字符（中文，默认）、完整档 3578 字符（含 88 行表和四张对照表）；英文 1162 / 3420 |

### 6.2 命令预检（0.7.0 新增，执行前校验用）

| 能力 | 结论 | 说明 |
|---|---|---|
| `bridge.validateCommand(cmd)` | **实测** | 纯函数：不读引擎、不写引擎，可反复调用。返回 `{ok:true}` 或 `{ok:false, error:{code, message}}` |
| `getCapabilities().features.commandPrecheck` | **实测** | 恒为 `true`（0.7.0 加载器起提供），用于探测 |
| 校验范围 | **实测** | 命令类型白名单、字段白名单、必填字段、数值类型与范围（视场 0.05–180、纬度 ±90、经度 ±180、海拔 −500–10000、倍率 ±86400）、图层枚举、ISO 时间格式与时区 |
| 与执行的关系 | **测试保证** | `executeCommand()` 的第一件事就是调用同一个函数，所以"预览说没问题"和"执行会接受"不可能给出两个答案 |
| 面板怎么用 | **测试保证** | 提案在显示时就逐条预检；任一条不过，整批在**第一条发出之前**被拒，而不是先执行合法的一半 |

```js
window.__SWE_AI_BRIDGE__.validateCommand({ type: 'set_fov', deg: 999 })
// → { ok: false, status: 'failed', error: { code: 'out_of_range', message: '视场必须在 0.05 到 180 度之间' } }
```


## 7. 已确认不可用 / 缺口

1. **点击星图拾取天体**：引擎有 C 函数 `core_get_obj_at(x, y, max_dist)`，但没有 `EMSCRIPTEN_KEEPALIVE`，也没进 `EXTRA_EXPORTED_RUNTIME_METHODS`，JS 侧调不到。要补需改引擎源码重新编译 WASM（属于"改上游"，需单独决策），或在前端用已有的 `$stel.on('click')` + 自己算最近天体（可行但精度不如引擎内部拾取）。
2. **键盘快捷键**：`core.c` 里 `core_on_key` 定义了 A/C/G/F/R/Z/E/M/N/D/S 等快捷键，但前端 `canvas.js` 从未绑定键盘事件，`core_on_key` 在 Web 版是死代码。助手面板因此不会和星图抢按键（实测：面板输入框里打字不会触发任何图层开关）。
3. **无引擎就绪事件**：只能轮询。
4. **无版本号**：只能靠 commit SHA。
5. **深空天体元数据有限**：距离/半径常为 `null`，讲解时不能编。
6. **无法程序化取消选中**：`core.selection = null` 无效，读回仍是原对象。

## 8. 对任务书的直接影响

- §5.2 要求的核心能力（选中天体、定位、时间、星座线、大气）**全部可达**，无需改上游。
- §5.4 "点选天体后请求讲解" 的**点选**部分需要补拾取能力，属于阶段 B 的明确任务，不是"已具备"。
- §5.2 的"多义名称给候选"需要上层自建，引擎不提供。

## 9. 客户端 AI 客户端（助手侧，非引擎）

本节描述 `assistant.js` 里的 OpenAI 兼容客户端，全部由 `tests/e2e/client.mjs`
对着回环 fake 服务实测；**没有任何真实端点验证过**。

| 项 | 结论 | 说明 |
|---|---|---|
| 端点拼装 | **实测** | 裸域名补一个 `/v1`；已有 `/v1`、`/v2` 或完整路径不重复叠加；尾斜杠归一。界面显示最终请求地址 |
| 鉴权头 | **实测** | API Key 为空时**不发送** `Authorization`；非空时发 `Bearer <key>`。Key 不写日志、不进 DOM 属性，只存在 `input.value` |
| 请求体 | **实测** | `{model, messages, temperature: 0, stream: false}`，参数最小化 |
| 超时/取消 | **实测** | `AbortController`，默认 45s；超时与用户取消是不同的错误码。取消后迟到响应按请求序号丢弃 |
| 重试 | **实测** | **不自动重试**。失败只提示，不追加请求 |
| 错误映射 | **实测** | 401/403→认证、404→路径、429→限频、5xx→端点错误、非 JSON→畸形、缺 `choices[0].message.content`→结构错、`TypeError`→网络/CORS；HTTPS 页面调 HTTP 端点有专门提示 |
| 语言跟随 | **实测** | 指令（system 提示）随界面语言切换；**用户输入原文透传，不翻译不改写** |
| 讲解提示 | **实测** | 只允许使用快照中的数值；高度角为负时必须说明"在地平线以下、无法观测"；禁止虚构距离/发现史/观测条件/文献链接 |
| 命令上限 | **实测** | 模型一次最多给 4 条命令，超出按畸形拒绝；每条先过助手侧白名单，再过桥接白名单 |
| 服务器 AI | **实测** | 选项禁用，文案"服务器 AI 尚未提供"；不会误报为用户连接失败 |

## 10. 宿主语言钩子（**本项目新增，不是上游 API**）

| 项 | 结论 | 说明 |
|---|---|---|
| `window.__SWE_SET_LANG__(lang)` | **实测** | `patches/0002` 加在 `main.js`。`zh`/`en`/`de`/`fr` 返回 `true` 并立即切换宿主界面与 `Moment` 语言；不支持的语言返回 `false`，不改任何状态 |
| 语言解析顺序 | **实测** | `?lang=` → `localStorage['swe.uiLang']` → 默认 `zh`。**不读** `navigator.language`／系统语言 |
| 缺钩子的宿主 | **实测** | 助手检测到 `__SWE_SET_LANG__` 不是函数就跳过，面板照常切换，宿主保持自己的语言（向上兼容旧宿主） |
| 切换是否重置状态 | **实测** | 不刷新页面；时间/地点/选中天体/视场/AI 配置逐项比对未变 |
| 覆盖范围 | **实测** | 只覆盖 `locales/*.json` 里的 56 条 GUI 文案。星图天体名/星座名来自星表与 skyculture 数据，不在其中；`FOV`、品牌名、地点名 `UNKNOWN` 也不是 i18n 键 |
