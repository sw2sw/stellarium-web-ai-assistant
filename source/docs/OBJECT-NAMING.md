# 天体名称的正确写法（实测）

本文回答一个问题：**在 `select_object` 里，`name` 到底该写什么。**

所有结论都在本机 Chrome + 交付的 `dist/` 上实测过，不是从文档推断的。复现方法见文末。

---

## 1. 一句话结论

引擎**没有**名称解析层。`getObj(q)` 就是 `core_search(q)`，它把 `q` 和每个天体的每一条
designation 做 `strcasecmp`，返回第一个**完全相等**的。因此：

- **大小写无关**（`m 42` = `M 42`）
- **空格一个都不能少**（`M42`、`M  42`、`M 42 ` 全部查不到）
- 没有模糊匹配、没有前缀匹配、没有中文表、没有候选列表

而且**不同类天体的 designation 形态不同**，这是最容易踩的坑：

| 天体 | 正确写法 | 错误写法（实测查不到） |
|---|---|---|
| 行星 / 太阳 / 月球 | `NAME Jupiter`、`NAME Moon`、`NAME Sun` | `Jupiter`、`Moon`、`Sun` |
| 恒星 | `Sirius`、`Vega`、`* alf Ori`、`* 58 Ori` | `NAME Sirius`（加了前缀反而查不到） |
| 深空天体 | `M 31`、`M 42`、`NGC 7000`、`NAME Pleiades` | `M31`、`M42`、`NGC7000` |
| 星座 | `CON western Ori` | `Ori`、`Orion`、`CON western Orion`、`猎户座` |

**为什么行星要 `NAME `、恒星不要**：这是数据本身的差异，不是语法规则。行星对象的
designation 字面就是 `NAME Jupiter`；而恒星（来自星表）的 designation 是裸名 `Sirius`。
所以同一个前缀在两类天体上恰好相反 —— 这正是模型最容易猜错的地方。

**为什么星座是 `CON western`**：星座对象来自 skyculture 数据，
`skydata/skycultures/western/index.json` 里 88 个星座的 `id` 字面就是 `CON western Aql`。
`western` 是 skyculture 名，换了 skyculture 前缀就变（本包只装了 `western`）。

两个容易误判的细节（实测确认过）：

- 星座对象查回来以后，`obj.id` 是 `NAME Ori`，不是 `CON western Ori`。**可搜索串和对象 id
  不是同一个字段**，断言命中要拿 `designations()` 或桥接的 `readback.resolvedAs` 比对。
- 引擎里两个缩写是首字母大写的形式：`CON western Cvn`、`CON western Tra`（不是 `CVn`/`TrA`）。
  因为大小写无关，写 `CVn` 仍然命中，读回的是引擎的写法。

---

## 2. 实测矩阵

在本交付的宿主上直接调 `getObj()`：

| 输入 | 结果 |
|---|---|
| `Jupiter` `Moon` `Sun` `Mars` …（10 个裸名） | 全部 miss |
| `NAME Jupiter` `NAME Moon` … `NAME Pluto`（10 个） | 全部命中；`NAME Earth` miss（地球不是可观测对象） |
| `Sirius` `Vega` `Polaris` `Betelgeuse` `Rigel` `Arcturus` `Antares` `Altair` `Deneb` `Aldebaran` | 全部命中 |
| `NAME Sirius` `NAME Vega` `NAME Polaris` `NAME Betelgeuse` | 全部 miss |
| `* alf Ori` `* alf CMa` `* bet Ori` … | 命中（Bayer 编号带 `* ` 前缀） |
| `Alp Ori` `Alpha Ori` `HIP 32349` `HD 48915` | 全部 miss |
| `M 31` `M 42` `M 45` `NGC 7000` | 命中 |
| `M31` `M  31` `NGC7000` `C 41` | 全部 miss |
| `CON western Ori` `CON western UMa` `CON western Sco` … | 命中 |
| `Ori` `UMa` `Sco` `Cyg`（裸缩写） | 全部 miss |
| `CON western Orion` `CON iau Ori` `CON modern Ori` | 全部 miss |
| `木星` `月球` `猎户座` `北极星` `仙女座星系` | 全部 miss（引擎不认中文） |
| `m 42` `name sun` `CON WESTERN ORI` `* ALF ORI` | 命中（大小写无关） |

---

## 3. 桥接做了什么

因为直接让模型写对不可靠，`loader.js` 的 `resolveTarget()` 在 `select_object` 前面做一层
**只在本地发生的**归一化。引擎和宿主都没有被修改。

按顺序尝试，第一个命中就采用：

1. 规范化：所有空白（含全角空格 `\u3000`、不换行空格 `\u00a0`）折叠成一个半角空格，去首尾
2. 别名表精确查（见 §4）
3. 原样
4. `NAME ` + 原样（覆盖行星、深空俗名）
5. `CON western ` + 原样（覆盖直接写三字母缩写）
6. 去掉 `NAME ` / `CON <skyculture> ` 前缀再试（覆盖多写了前缀）
7. 目录号补空格：`M42` → `M 42`、`NGC7000` → `NGC 7000`、`IC405` → `IC 405`、`C20` → `C 20`

结果写进 `readback.resolvedAs`，面板和测试都能看到"这个名字最后被解析成了什么"，
避免悄悄命中一个错误对象。全部失败才返回 `object_not_found`，`readback` 里带上
`given` / `normalized` / `tried`，方便排查。

**这一层不改变引擎语义**：桥接关掉，`select_object` 立刻退回"只认精确 designation"。

---

## 4. 别名表覆盖范围

| 类别 | 条数 | 内容 |
|---|---|---|
| 星座 | 88 × 3 + 8 | 88 个 IAU 星座，每个都有中文名、英文名、三字母缩写；另加中文变体（处女座/射手座/水瓶座/山羊座/南十字/北斗七星/北斗/北极星所在星座） |
| 行星与日月 | 10 组 | 太阳日月、水星…冥王星，含"月亮""启明星""长庚星""太白""荧惑""岁星""镇星" |
| 恒星 | 17 组 | 天狼星、织女星、北极星、参宿四/七、大角星、心宿二、牛郎星、天津四、毕宿五、五车二、南河三、角宿一、轩辕十四、北落师门、北河三、老人星 |
| 深空 | 9 组 | 蟹状星云、武仙座球状星团、仙女座星系、猎户座大星云、蜂巢星团、昴星团、涡旋星系、指环星云、草帽星系 |

星座表是从 `skydata/skycultures/western/index.json` 的 88 个 `id` 反推的，不是凭记忆列的；
中文/英文名逐个跑过一遍，**176 项全部命中到预期的 `CON western <abbr>`**。
行星/恒星/深空 36 项同样全过。

实测脚本见 §6。

**没有覆盖的**：任意暗星的 Bayer 编号（`* bet CMa` 这类要写全，表不管）、
任意 NGC/IC 编号（补空格后直查，不查表）、中文俗名以外的方言叫法。
查不到会如实报 `object_not_found`，不会猜。

---

## 5. 内置的语法参考（0.6.0 起）

上面这些结论不写在提示词字符串里，而是**一个随包安装的文件**：
`ai-assistant/naming-reference.js`。理由有三个：

- **换 provider 不用改代码**：参考是纯文本，任何 OpenAI 兼容端点都能吃。
- **换模型只需换档位**：弱模型要表，强模型要规则，见 §5.3。
- **别的 agent 读同一份**：不会出现"面板教 A、外部 agent 学 B"。

### 5.1 文件里有什么

| 字段 | 内容 |
|---|---|
| `grammar` | 四类形态的正则：`^NAME [A-Za-z]+$`、`^(\* [a-z]{3} [A-Z][A-Za-z]{2}|[A-Z][A-Za-z]+)$`、`^(M|C|NGC|IC|HIP|HD) [0-9]+$`、`^CON western [A-Z][A-Za-z]{2}$` |
| `constellations` | 88 行 `[缩写, 中文, 英文]`，与 `loader.js` 的别名表逐行同源 |
| `planets` / `stars` / `deepSky` | 10 / 17 / 9 组，第一列就是引擎认的字符串 |
| `corrections` | 9 条高频错写，如 `M42 → M 42`、`Jupiter → NAME Jupiter` |
| `examples` | 6 组 few-shot（中英双语），紧凑档取前 4 组 |
| `toPrompt(lang, {level})` | 生成提示词片段；`level` 省略或 `compact` 为紧凑档，`full` 为完整档 |
| `toJSON()` | 纯数据（可 `structuredClone`），给桥接和外部 agent |
| `toMarkdown(lang)` | 人读文档，88 星座一行一个 |

`tests/reference/consistency.mjs`（42 项）保证它和 `loader.js` 不漂移：88 个缩写、
中文名、英文名、三张常用表逐行比对；每个正例必须匹配它自己公布的正则，
每个反例必须不匹配。

### 5.2 发给模型的是哪一档

默认**紧凑档**，815 字符（英文 1162）。全文：

```
name 必须整体匹配下列任一行（大小写无关、空格敏感，不匹配就是 object_not_found）：
planet        ^NAME [A-Za-z]+$   例 NAME Jupiter、NAME Moon；错 Jupiter
star          ^(\* [a-z]{3} [A-Z][A-Za-z]{2}|[A-Z][A-Za-z]+)$   例 Sirius、* alf Ori；错 NAME Sirius
deepsky       ^(M|C|NGC|IC|HIP|HD) [0-9]+$   例 M 31、NGC 7000；错 M31
constellation ^CON western [A-Z][A-Za-z]{2}$   例 CON western Ori；错 Ori、Orion、猎户座
中文名本地也会转换（木星、猎户座、天狼星、仙女座星系都能命中），但能写上面的形态就直接写；回复前把每个 name 核对一遍。

示例：
请求：看看木星
{"commands":[{"type":"select_object","name":"NAME Jupiter"}],"say":"已定位木星"}
请求：看看天狼星
{"commands":[{"type":"select_object","name":"Sirius"}],"say":"已定位天狼星"}
请求：把猎户座转到视野中央
{"commands":[{"type":"select_object","name":"CON western Ori"}],"say":"已定位猎户座"}
请求：看一下仙女座星系，视场缩到5度
{"commands":[{"type":"select_object","name":"M 31"},{"type":"set_fov","deg":5}],"say":"已定位仙女座星系，视场 5 度"}
```

为什么敢省掉 88 行表：**写错的那一半由 §3 的本地归一化兜住**。表格只是让模型
一次写对，不是让它可能写对。省下来的体积按每次请求计费，见下。

| 档位 | 中文 | 英文 | 相对完整档 | 适用 |
|---|---|---|---|---|
| `compact`（默认） | 815 字符 ≈ 0.5k tokens | 1162 字符 ≈ 0.35k tokens | −77% | 上下文小、按量计费、模型较强 |
| `full` | 3578 字符 ≈ 2.2k tokens | 3420 字符 ≈ 2.1k tokens | — | 模型总把名字写错、或要求零兜底依赖 |

（token 数是按中英混排粗估，不同分词器会差 10–20%。）

### 5.3 换 provider / 换模型怎么办

不需要改任何东西：参考每次请求都随 system 消息发出，不依赖模型记忆、
不依赖端点特性。只有一种情况要动手 —— 换上的模型**即使有 4 条 few-shot
仍反复写错**（典型是 7B 级本地模型），这时把档位调成 `full`：

```js
// packages/assistant-web/assistant.js
var NAMING_LEVEL = 'full'   // 默认 'compact'
```

改完重新 `install.mjs`，`assetQuery` 会随内容变，浏览器缓存自动失效。

反过来说，**不需要为每个 provider 维护一份提示词**：参考里没有品牌、没有
模型名、没有 provider 特有字段，四类形态和 88 个缩写对哪家模型都一样。

### 5.4 新设备重装

参考是插件包里的普通文件，`install.mjs` 按目录整体拷贝（`readPackage` 会带上
除 `.md` 和点文件以外的所有文件），所以：

- 装完就有，不需要联网、不需要额外下载、不需要再跑一次生成脚本；
- `.install.json` 记录它的哈希，`--status` 能查出是否被改动；
- 卸载时随 `ai-assistant/` 整个目录移除，不留残渣；
- 断网时面板照常启动，只是模型调用失败（参考不涉及网络）。

### 5.5 别的 agent 怎么拿

```js
// 1) 页面里的全局对象（最直接）
SWE_NAMING_REFERENCE.toPrompt('zh')                  // 紧凑档，直接塞进 system
SWE_NAMING_REFERENCE.toJSON().grammar                // 四条正则
SWE_NAMING_REFERENCE.constellations                  // 88 行

// 2) 桥接（只读，纯数据；参考没加载时返回 null）
__SWE_AI_BRIDGE__.namingReference().prompt.zh
__SWE_AI_BRIDGE__.getCapabilities().features.namingReference   // true

// 3) Node 里（无 window 时挂到 globalThis）
await import('./packages/assistant-web/naming-reference.js')
globalThis.SWE_NAMING_REFERENCE.toMarkdown('zh')
```

给外部 agent 的建议：先用 `grammar` 校验自己产出的 `name`，不匹配就按
`corrections` 改写，再调 `select_object`。比让模型读一遍散文规则更省 token。

### 5.6 兜底仍然在

参考让模型**写对**，§3 的归一化让模型**写错也不至于失败**。两条路径都有测试：
`tests/e2e/client.mjs` §14c 的 8 项走兜底（`木星`、`M42`、`Orion` 都能到对的对象），
§14d 的 13 项验证参考确实随请求发出、且是紧凑档，并验证参考缺失时退回内置规则。

---

## 6. 不复现就别信：怎么自己验

```bash
# 1) 起站点
node tools/serve.mjs ../packages/integrated-web/dist 8911

# 2) 在浏览器控制台里直接问引擎
const stel = document.getElementById('app').__vue__.$stel
stel.getObj('NAME Jupiter')     // 有对象
stel.getObj('Jupiter')          // null
stel.getObj('CON western Ori')  // 有对象
stel.getObj('Ori')              // null

# 3) 走桥接（含归一化），看它被解析成了什么
await __SWE_AI_BRIDGE__.executeCommand({ type: 'select_object', name: '木星', lock: false })
// readback.resolvedAs === 'NAME Jupiter'
```

正式回归：`node tests/e2e/client.mjs http://127.0.0.1:8911/`，其中 §14c 那一组
就是 §2 和 §4 的自动化版本。
