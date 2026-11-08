# 阶段 A 可行性报告

> **读数说明（2026-10-31 候选入库时加）**：本报告记录的是阶段 A 当时的状态，里面的用例数
> （如安装器 51 项、客户端 57/69 项）是**当时**的数字，不要当成当前数。当前口径看
> `README.md` 与本目录 `INSTALL.md`：客户端 138 项、安装器 Windows 143 项通过 + 1 行 SKIP
> （POSIX 预计 147 项）、热替换 33 项。历史叙述不改写。

**日期**：2026-10-30
**结论**：任务书 §9 阶段 A 的五项要求**全部达成**，主架构（首次适配、之后助手免重建更新）成立。有三处需要用户决策的事项，见 §7。

---

## 1. 结论先行

| 阶段 A 要求 | 结果 | 证据 |
|---|---|---|
| 核验上游源码、许可、构建环境，编译并运行独立原版 Web | **达成** | `evidence/logs/engine-build.log`、`frontend-build.log`；Chrome 实测无控制台错误 |
| 复用上游钩子获取唯一引擎实例，读选择并控制开关/时间/定位 | **达成** | `tests/e2e/smoke.mjs` **36 项**全过 |
| 最小 loader/bridge + 独立助手资源；替换资源仅刷新即生效 | **达成** | `tests/e2e/hotswap.mjs` 全过，宿主 `js/*` 哈希不变 |
| 禁用/加载失败不破坏原版；记录首次改动大小 | **达成** | 损坏 manifest / 缺失 bundle 两种故障、4 项断言全过；宿主补丁 **+142 字节** |
| 提交 FEASIBILITY / SHA / 构建日志 / 最小演示 / 能力表 / 任务表 | **本文件** | 见各节 |

**关键数字**

- 宿主源码改动：`package.json` 一行（`vue ^3.0.0` → `^2.6.11`）
- 宿主产物改动：`dist/index.html` **+142 字节**，1 个 `<script>` 标签
- 引擎编译产物：JS 104,014 B + WASM 1,199,284 B
- 助手包（未压缩，v0.2.0）：`loader.js` 29,738 B + `assistant.js` 17,348 B + `assistant.css` 4,317 B + `manifest.json` 247 B，合计 **51,650 B**（v0.1.0 为 38,571 B，增量几乎全在读回校验与状态监听）
- 助手更新方式：替换 4 个文件 + 刷新页面，**不重编前端、不重编 WASM**

---

## 2. 上游锁定

```
repo    https://github.com/Stellarium/stellarium-web-engine
commit  1162c9ef73cc94f4762dfbfd24c637190119ea93
date    2026-10-20
licence AGPL-3.0
```

详见 `upstream/LOCK.md`。该 commit 同时是 `master` 与 `HEAD`，与 `体积核查.md` 记录的公开基线一致。

**没有**使用官网部署产物、没有使用任何预编译 WASM。所有产物均由上述源码在本地容器内编译得到。

---

## 3. 架构：实际做出来的形态

```
Stellarium Web 宿主（锁定 commit，已构建的静态站点）
  └─ dist/index.html 里 1 个 <script>（+142 B）        ← 唯一宿主改动
       └─ dist/ai-assistant/loader.js                 ← 桥接 + 模块加载器
            ├─ 通过 #app.__vue__.$stel 拿到引擎（同页，唯一实例）
            ├─ 读 manifest.json（no-store）
            └─ 按版本号加载 assistant.js / assistant.css  ← 可独立替换
```

与任务书 §3.1 的推荐形态一致：**首次加一个很小的加载入口，之后助手更新只换资源、刷新生效**。

**为什么不是 webpack 插件**：上游 `main.js` 用 `require.context('./plugins/')` 在**构建时**枚举插件，把文件拷进已编译的站点不会生效。要免重建更新，只能走运行时加载，因此选择了"注入一个 script + 运行时取引擎"的路径。

**为什么能从页面外拿到引擎**：Vue 2 在 `_update` 里无条件写 `vm.$el.__vue__ = vm`，而 `$stel` 挂在 `Vue.prototype` 上（`sw_helpers.js:47`）。所以 `document.getElementById('app').__vue__.$stel` 稳定可取，且**不需要改上游源码**。这是本次最关键的技术发现。

**没有做的事**（明确记录，避免误读）：

- 没有创建第二个引擎实例，没有重复加载 WASM/星表
- 没有 monkey patch、没有压缩变量名猜测
- 没有改任何 `.vue` / `.c` / `.h` / `SConstruct` / `Makefile`

---

## 4. 构建实测

完整步骤见 `UPSTREAM-BUILD.md`。要点：

| 环节 | 工具 | 结果 |
|---|---|---|
| 引擎 WASM | `emscripten/emsdk:1.39.17` + scons 3.1.2 | 成功，约 30 秒（32 核） |
| 前端依赖 | `node:20-alpine` + `yarn --frozen-lockfile` | 成功，约 6 分钟 |
| 前端构建 | `node:20-alpine` + `NODE_OPTIONS=--openssl-legacy-provider` | 成功，约 7.5 分钟，2 条体积警告 |
| 站点运行 | `tools/serve.mjs` + Chrome 141 | 星图正常渲染，控制台 0 错误 |

**上游的三处真实问题**（都不是本机环境问题）：

1. `Dockerfile.jsbuild` 的 Debian buster apt 源已 404，镜像构建不出来 → 用 PyPI scons 替代（`patches/Dockerfile.engine`）
2. `package.json` 声明 `vue ^3.0.0`，与 Vuetify 2 全家桶冲突 → 改为 `^2.6.11`（命中 lock 已有版本，`yarn.lock` 零改动）
3. 上游 `Dockerfile` 的 `node:12.10.0` 已跑不动现在的依赖树（`node-releases` 要求 ≥18）→ 用 Node 20
4. （Windows 特有）Git 默认 `core.autocrlf=true` 会让 `tools/make-assets.py` 的 shebang 带上 `\r`，构建报"文件不存在" → 必须 `core.autocrlf=false`

---

## 5. 最小演示做了什么

一个可运行的助手面板（`packages/assistant-web/`），**不调用任何模型**：

- 顶部状态：桥接版本、view ID、revision（证明会话/版本概念已落地）
- 当前天体卡：名称、类型、星等、赤经赤纬、方位角、高度角——**全部来自引擎读回**，并明确标注"以上为星图引擎读回的真实数值"
- 图层开关 7 个：大气 / 星座线 / 星座名 / 地景 / 银河 / 赤道网格 / 地平网格
- 观测时间：`datetime-local` + 应用 + "现在"
- 视场：30° / 20° / 10° / 5°
- 讲解区：阶段 A 占位，**显示将要发给模型的观测快照 JSON**（体现 §6"发送前说明发送内容"），并注明"不含精确地点，除非你允许"

交互约束：暗色低眩光、可折叠、可拖动、宽度可拖拽、位置存 `localStorage`、Esc 折叠、面板内按键不冒泡到星图。

### 5.1 验证过程中发现并修掉的缺陷（3 个，都是真实缺陷）

写进报告是因为它们说明了"验证"到底验到了什么，也提醒后续阶段别再踩。

| # | 缺陷 | 表现 | 怎么被抓到 | 修法 |
|---|---|---|---|---|
| 1 | **MJD 历元偏 12 小时** | 设成北京时间 22:30，画面上是白天（太阳高度 **+32.3°**） | 写读自洽测试一直通过；是生成交付截图时发现"夜空"是亮的，再用**物理断言**（北京 22:30 太阳必须在地平线下）定位 | `+40587.5` → `+40587.0`；`smoke.mjs` 加 `sunAlt < -20` 断言（修正后 −57.6°） |
| 2 | **安装器备份被污染** | 重复安装时，`.swe-backup/index.html.29ce0515…orig` 存的是**已注入**的版本；`.install.json` 的 `hostIndexSha256Before` 记成了注入后哈希，看起来"零差异" | 审查 `.install.json` 发现 before == after，与"+142 字节"矛盾 | 备份与 before 哈希一律取 `stripBlock()` 后的纯净内容；`uninstall` 同样只备份纯净版 |
| 3 | **安装器多发文件** | `packages/assistant/README.md` 被拷进对外目录 `dist/ai-assistant/`；`files` 列表里 `loader.js` 重复 | 检查部署目录清单 | 跳过 `.md` 与点文件；降级时清理上一版遗留文件；`files` 去重 |

缺陷 1 的普适教训：**凡"写进去再读回来"的测试，对换算错误是盲的**——同一个错常数在两端会互相抵消。必须配一条不依赖该常数的外部断言（这里是天文事实）。阶段 B/C 涉及时间、坐标、时区时同样适用。

---

## 6. 验收对照（阶段 A 相关项）

| 任务书验收项 | 状态 | 说明 |
|---|---|---|
| 可从锁定公开源码重建宿主 | **通过** | 全新克隆 → 构建 → 运行，日志留档 |
| 新环境先装宿主再装助手可用 | **通过** | `install.mjs` 预检 + 备份 + 幂等安装 |
| 助手 v1→v2 仅替换资源刷新生效 | **通过** | 宿主 `js/*` 与 `index.html` 哈希不变 |
| 整合包与独立扩展共用实现 | 部分 | 当前只有一个实现（`packages/assistant-web`），整合包阶段 D 才产出 |
| 插件故障不导致宿主白屏 | **通过** | 损坏 manifest / 缺失 bundle 两种情况实测 |
| 不启动第二引擎、不重复加载 WASM | **通过** | 复用 `__vue__.$stel`，无新建 |
| 升级/卸载幂等，未知宿主安全拒绝 | **通过** | 安装器安全测试 **51 项**全过：未知宿主/外来目录/坏状态/重复标记/符号链接/`../` 条目全部拒绝且无副作用；卸载后 `index.html` 回到登记的原哈希 |
| 选中天体后面板同步 | **通过** | 引擎 change 事件 + 桥接订阅 |
| 按钮/命令实际读回与星图一致 | **通过** | 每个开关都回读引擎属性比对 |
| 核心动作：选中/定位、时间、星座线、大气 | **通过** | 见 `API-CAPABILITIES.md` |
| 非法 JSON/未知命令/超范围/注入不触发执行 | **通过** | 8 类非法命令全部拒绝并给出错误码 |
| AI 离线不影响星图 | **通过（当前无 AI）** | 阶段 C 才接模型 |
| 星图事件/输入/手势/键盘不被破坏 | **通过** | 引擎未绑定键盘；面板事件不冒泡 |

未通过/未做的项（成本、平台、容器、模型）见 §9。

---

## 7. 需要用户决策的三件事

### 7.1 是否接受修改上游 `package.json` 一行

不改的话，按 lock 安装会把 Vue 3 提升到根目录，构建直接失败。替代方案是把 `vue` 从 `dependencies` 移除、靠 workspaces 传递依赖——更脏。

**建议**：接受。改动 1 行，`yarn.lock` 零改动，已在 `patches/0001-web-frontend-vue2.patch` 留档。

### 7.2 "点选天体"需要补拾取能力，是否允许改引擎源码

任务书 §5.4 要求"点选天体后请求讲解"。实测：**原版网页点击星图不会选中任何天体**，只有搜索框会。引擎有 `core_get_obj_at(x,y,max_dist)`，但没有导出到 JS。

三条路：

| 方案 | 成本 | 代价 |
|---|---|---|
| A. 引擎源码加 `EMSCRIPTEN_KEEPALIVE` 后重编 WASM | 改 1 个函数导出 + 重编 | 偏离"不改上游"，但只是导出既有函数 |
| B. 前端用 `$stel.on('click')` + 自己按屏幕坐标找最近天体 | 中 | 需要天体投影列表，精度和性能都不如引擎内部拾取 |
| C. 首版不做点选，只做"搜索/助手定位后讲解" | 低 | 与任务书 §5.4 有出入 |

**建议**：A。只是把已有函数暴露出来，不动逻辑，可审计。等您确认后再做，不擅自改。

### 7.3 教学目标名称检索需要上层建映射表

**先前一版报告写"M 42 查不到"，这是错的，已更正。** 复查（`evidence/logs/probe-capabilities.json`）实测 36 个常见教学目标，**31 个能查到**：M 31 / M 42 / M 45 / M 13 / M 44 / M 8 / M 27 / M 57 / M 51 / M 81 / M 104 / M 1 / M 7、太阳、月球、金木水火土天海、`* alf Ori`（参宿四）、`* alf CMa`（天狼）、`* alf Lyr`（织女）、`* alf Boo`（大角）、`* alf UMi`（北极星）、四个星座。

真正查不到的 5 个，全部是**命名约定**问题，不是数据缺失：

| 输入 | 结果 | 原因 |
|---|---|---|
| `NAME Polaris` | 查不到 | 北极星要写 `* alf UMi`；恒星加 `NAME ` 前缀反而查不到 |
| `仙女座星系` | 查不到 | 引擎无中文名表 |
| `Andromeda Galaxy` | 查不到 | 不认英文俗名（但 `NAME Andromeda Galaxy` 可以，它是该对象的别名之一） |
| `orion nebula` | 查不到 | 不是任何对象的 designation（**与大小写无关**） |
| `m42` | 查不到 | **缺空格**，须写 `M 42`（**与大小写无关**：`m 42` 可以） |

> **2026-10-30 更正**：上表最后两行原先写的"大小写敏感"是误判。实测 `m 42`、`NAME jupiter`、
> `CON WESTERN ORI`、`* ALF ORI` 全部命中；`core_search` 用的是 `strcasecmp`。真正敏感的只有
> **空格**。`docs/API-CAPABILITIES.md` §6 已同步改正，完整矩阵见 `docs/OBJECT-NAMING.md`。

**建议**：阶段 B 先建一张"教学常用目标 → 引擎 designation"的映射表（含中文名、英文俗名、常见错写），而不是去换数据源。这张表是纯数据，不需要改引擎，也不需要重建。

> **2026-10-30 已实现**：这张表现在在 `packages/host-adapter/loader.js` 的 `resolveTarget()`
> 里，覆盖 88 个星座的中英名、行星日月、17 组亮星、9 组深空，外加目录号补空格与空白折叠。
> 提示词也按实测语法改了，并带 5 条 few-shot。见 §13.5。

---

## 8. 关键风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 依赖 `__vue__` 这个 Vue 内部字段 | 上游升级 Vue 3 后失效 | 已在 loader 里做多路径探测 + 失败降级；升级上游时需重验 |
| `yarn.lock` 的依赖树会继续漂移 | 未来重装可能又坏 | 交付里保留 lock；构建用固定 Node 20 镜像 |
| 教学目标名称写法不统一 | 用户输入中文名/英文俗名查不到 | 实测 36 例中 31 例命中，缺口是命名约定；阶段 B 建映射表 |
| AGPL 组合义务 | 分发整合包时需提供对应源码 | 已记录 commit；阶段 D 前需法务确认 |
| 只在 Windows + Docker Desktop 验证过 | Linux 宿主机行为未测 | 步骤本身跨平台（都跑在 Linux 容器里），但未实测 |

---

## 9. 未验证项（明确列出，不写成已完成）

- **Linux / macOS 上的构建与运行**：未测。所有编译都在 Linux 容器里，理论一致，但没有实机证据。
- **Docker / Podman 部署**：阶段 D，未开始。
- **自托管环境**：此早期设计记录不包含当前部署验收，最新使用范围见根README。
- **真实模型调用**：未做，一行网络请求都没发。
- **AI 服务端**（鉴权、限额、会话隔离）：阶段 C，未开始。
- **浏览器兼容**：只在 Chrome 141 测过。Edge/Firefox 未测。
- **性能**：未测帧率、未测弱设备。
- **断网可用性**：未系统测试。已知宿主会请求 Google Fonts、`freegeoip.stellarium.org`、`nominatim.openstreetmap.org`，这些在断网时会失败但被 `catch` 吞掉。

---

## 10. 后续精确任务表

### 阶段 B：无 AI 助手 + 安装升级（建议 6 项）

| # | 任务 | 完成标准 |
|---|---|---|
| B1 | 建"教学常用目标 → 引擎 designation"映射表（中文名/英文俗名/大小写/常见错写） | 映射表覆盖教学清单；未命中项有明确回退提示。实测 36 例 31 例直查命中，剩余靠映射表补齐 |
| B2 | 补"点选天体"能力（按 §7.2 决策执行） | 点击画布能选中并同步面板，实测通过 |
| B3 | 把命令校验抽成 `packages/core`，浏览器与 Node 共用 | 同一份校验逻辑，两侧单测都过 |
| B4 | 名称消歧：多义名返回候选，不猜 | 输入 `NAME Ori` 等歧义名返回候选列表 |
| B5 | 面板增强：窄屏布局、位置/宽度持久化完善、无障碍 | 640px 宽下可操作 |
| B6 | 安装器支持"未知宿主版本拒绝"与版本清单校验 | 对非目标构建明确拒绝，不盲改 |

### 阶段 C：fake AI 后端 + 控制/讲解

| # | 任务 | 完成标准 |
|---|---|---|
| C1 | 本地 fake OpenAI 服务（`POST /chat/completions`） | 可模拟 200/401/429/500/超时/畸形 JSON |
| C2 | 意图→命令：受限 JSON 文本模式 + 严格解析 | 非法 JSON 提示重述，不自动重试 |
| C3 | 命令预览→用户确认→执行→读回 | 旧 revision 的响应不执行 |
| C4 | 讲解：冻结快照 + session/view/request ID 绑定 | A→B→A 不串对象（用 fake 后端断言） |
| C5 | 取消/超时/断网路径 | 迟到响应不执行、不自动重试 |
| C6 | 快照不含精确地点（可选开关） | 默认不发送坐标 |

### 阶段 D：整合运行包 + 容器

| # | 任务 |
|---|---|
| D1 | 同源码产出整合站点 + 独立扩展两份产物 |
| D2 | Dockerfile + compose.yaml，静态站点 + 轻量 AI 后端 |
| D3 | rootless Podman 单独验证（挂载/SELinux/端口/重启） |
| D4 | 双设备/双会话隔离验证 |
| D5 | 体积与断网边界实测 |

### 阶段 E：交接

`RESULT.md` 复核、许可与源码提供方式、回滚说明。

---

## 11. 证据索引

| 文件 | 内容 |
|---|---|
| `evidence/logs/clone.log` | 全新克隆与 checkout 日志 |
| `evidence/logs/pinned-sha.txt` | 锁定的 commit |
| `evidence/logs/engine-build.log` | 引擎 WASM 完整编译日志 |
| `evidence/logs/yarn-install.log` | 依赖安装日志 |
| `evidence/logs/frontend-build.log` | 前端构建日志（含体积警告） |
| `evidence/logs/smoke.log` | 功能冒烟 **36 项**（命令语义、时区、快照、像素采样） |
| `evidence/logs/hotswap.log` | 热更新 + 故障隔离 + 卸载还原 **31 项** |
| `evidence/logs/probe-capabilities.json` | 引擎能力探测原始输出（含名称检索 36 例、时间物理校验、点击拾取、图层路径） |
| `evidence/screenshots/*.png` | 面板截图、v2 热更新后截图、损坏状态截图、修正时区后的夜空截图、冻结快照过期截图 |
| `evidence/versions.md` | 版本表与体积表 |

---

## 12. 第二轮审查（A1–A11）修复对照

审查文件：`阶段A静态审查与修改意见.md`（A1–A11）、`阶段A第二轮静态复核.md`。按原编号逐条给结果，不新造要求。

| 编号 | 问题 | 修法 | 怎么证明 |
|---|---|---|---|
| **A1** | 安装器认不出锁定宿主，标记块重复/手改也照改 | 新增 `install/known-hosts.json`：登记 `pristineIndexSha256` + 引擎 WASM 哈希 + bundle 名。安装/更新/卸载都先做身份识别，结果分 `verified` / `variant` / `unknown`；`variant` 要 `--allow-variant`，`unknown` 要 `--allow-unknown-host`。标记块必须是恰好一对且内容完全一致，重复直接拒绝，手改要 `--force` | 安装器测试 51 项：普通 Vue 站点、无引擎 WASM、重复标记、手改标记、未知宿主全部拒绝，且逐文件哈希证明**没有副作用** |
| **A2** | 目标目录非自有时会被覆盖或递归删除 | 首次安装发现 `ai-assistant/` 存在但没有本工具的合法状态 → 直接拒绝，不碰。卸载只删**状态里登记过、且当前哈希仍等于登记值**的文件；用户新增文件保留并提示；目录非空就保留目录 | 构造"外来目录""用户附加文件""被用户改过的资源"三种情况，卸载后逐文件核对 |
| **A3** | 更新无原子性；同版本新内容可能被缓存住 | 先完整校验新包（manifest 可解析、协议匹配、entry/style 存在），写进 `.ai-assistant.stage-*`，再整体换名发布；失败则旧版本原样保留。缓存参数 `?v=` 改用 **`assetQuery`（内容哈希）**，不再用版本号 | 缺 entry / 协议不符 / manifest 坏 → 拒绝且旧版本继续可用；同版本改一个字节 → `assetQuery` 从 `2a4ed3da…` 变为 `0da14439…` |
| **A4** | 写操作异常被 `safe()` 吞掉，动画没到也报成功 | 写操作不再包 `safe()`，异常直接转成 `command_failed`。每条命令写完读回比对；动画类（定位、变焦）等到收敛或 4s 超时，返回 `applied` / `timeout`。`executeCommand` 改为返回 Promise | 注入 `zoomTo`/`pointAndLock` 抛异常 → `ok:false, code:'command_failed'`；注入 `zoomTo` 空实现（动画不动）→ `ok:true, status:'timeout', waitedMs≈4030` |
| **A5** | revision 只跟桥接命令走，宿主界面改状态不会失效；讲解快照会过期 | 桥接每 500ms 比对可观测状态（时间按 10s 量化），任何来源的变化都推进 `revision`/`snapshotId`。新增 `captureSnapshot()` / `isCurrentSnapshot()`。面板按 `snapshotId` 去重，冻结的快照不再被改写，天空变了只标记"已过期" | 绕过桥接直接写 `core.observer.utc`（模拟宿主界面）→ `isCurrentSnapshot(旧id)` 变 false；面板的冻结块由 `data-swe-frozen-stale=false` 变 `true`，冻结内容不变 |
| **A6** | `Date.parse` 接受无时区时间；文档 MJD 公式与代码冲突 | 命令层用正则强制 `Z` 或 `±HH:MM`，无时区/只有日期/非法日期一律 `invalid_value`。面板明写"按设备本地时区解释，发送前换算成带 Z 的 UTC"。`API-CAPABILITIES.md` 统一为 `40587.0` | `2026-12-25T12:00:00` 被拒；`2026-12-25T20:00:00+08:00` 换算成 `12:00:00Z`；`2026-12-25` 被拒 |
| **A7** | 没有校验清单；日志没绑定具体源码 | `delivery/SHA256SUMS` 覆盖全部交付文件。测试日志开头打印服务端实际发出的 `index.html`/`loader.js`/`assistant.js` 的 sha256、`assetQuery` 和测试文件自身的 sha256 | `sha256sum -c` 全过；`smoke.log` 前 6 行就是候选绑定 |
| **A8** | 构建/运行文档路径不自洽；`npm run serve` 指向交付外 | `UPSTREAM-BUILD.md` 重写：先设 `$SRC`/`$WORK`，每一步写清当前目录，补丁与服务器脚本一律用 `$SRC` 绝对路径。`package.json` 的 serve 改为 `../packages/integrated-web/dist` | 按文档顺序执行可以跑通；serve 路径从 `delivery/source` 解析正确 |
| **A9** | 临时服务器用字符串 `startsWith` 判边界，symlink 可越界 | 改用 `path.resolve` + `path.relative` 段级判断，再对真实路径 `realpath` 复核，越界一律 403。文件头写明"本地验证工具，无认证无 TLS，只绑 loopback" | 路径测试 6 项：`../`、`%2e%2e`、同前缀兄弟目录、目录 junction 越界全部挡住；SPA 回退仍正常 |
| **A10** | 路径/状态信任边界缺失 | 对 `index.html`、`ai-assistant/`、备份目录、每个资源做 `lstat` 符号链接检查，命中即拒绝。状态里的文件名必须是纯 basename（`^[A-Za-z0-9._-]+$`），**在任何写入之前**先校验整个清单 | `files` 里塞 `../index.html` → 拒绝，且 `index.html` 未被先改；`ai-assistant/` 是 junction → 拒绝，链接目标未被触碰 |
| **A11** | "渲染正常"的断言强于证据；故障用例不全 | 新增像素采样（80×80 缩略后亮度极差 > 10）取代"canvas 存在且尺寸非零"。补两类故障：助手 JS 顶层抛异常、引擎一直不就绪（独立页面 + 800ms 超时）。pristine 基线改为读 `known-hosts.json` 的登记值，不再靠"先卸载一次" | 4 类故障下都断言像素非均匀；抛异常时桥接仍能驱动引擎；manifest 损坏时桥接仍返回 `applied`（截图右上角 FOV 70.0° 就是这条命令的效果）；引擎不就绪时 loader 干净放弃、不建面板、不抛错 |

### 仍未闭环的（明确列出，不写成已修）

| 项 | 状态 |
|---|---|
| 点击画布拾取天体 | **仍未做**。需要改引擎源码导出 `core_get_obj_at` 并重编 WASM，属"改上游"，等决策。本轮没有擅自实施 |
| 完整依赖许可清单 | **未做**。已放 `LICENSE`（AGPL-3.0 全文）、`NOTICE`、`THIRD-PARTY.md`，但逐包许可导出与 `skydata` 数据溯源仍未完成，`THIRD-PARTY.md` 里如实标注为未核实 |
| Git 历史与秘密审计 | **未做**。交付目录不是 Git 仓库，无法做历史敏感信息审计 |
| Linux / macOS 实机、容器部署 | 仍未验证，属阶段 D |

### 本轮改动的文件

```
install/install.mjs              重写（A1/A2/A3/A10）
install/known-hosts.json         新增（A1 宿主登记表）
packages/host-adapter/loader.js  重写（A3/A4/A5/A6），协议 v1 → v2
packages/assistant-web/assistant.js   改（A4/A5/A6 的 UI 侧）
packages/assistant-web/assistant.css  加冻结快照样式
packages/assistant-web/manifest.json  协议 2、版本 0.2.0
tests/fixtures/assistant-v2/*    按新接口重建，版本 0.3.0
tests/e2e/smoke.mjs              重写（36 项）
tests/e2e/hotswap.mjs            重写（31 项）
tests/installer/safety.mjs       新增（51 项）
tests/serve/paths.mjs            新增（6 项）
tests/e2e/*.mjs                  路径锚定到测试文件自身，不再依赖当前目录或构建机绝对路径
tools/serve.mjs                  路径边界与 symlink（A9）
package.json                     serve 路径、版本、测试脚本（A8）
docs/INSTALL.md                  重写（安全边界、拒绝清单）
docs/UPSTREAM-BUILD.md           路径重写（A8）
docs/API-CAPABILITIES.md         协议 v2、命令语义、快照、时区（A4/A5/A6）
LICENSE / NOTICE / THIRD-PARTY.md  新增
```

---

## 13. 客户端阶段（任务书 §4.2「实施顺序」）

任务书 2026-10-30 19:00 修订后新增"客户端优先"的实施顺序，并点名六项能力。
本轮把这六项全部实现，并按同一份源码重建了独立包与整合站点。**没有调用任何真实
模型，也没有写任何服务端代码**——fake 服务只绑回环，响应写死。

### 13.1 六项能力与证据

| 能力 | 实现 | 证据（`tests/e2e/client.mjs`，138 项） |
|---|---|---|
| 中英文切换 | 标题栏一键切换，默认中文，选择存 `localStorage`；界面/按钮/字段/错误文案随语言切换；**同时切宿主界面**（`locales/zh.json` + `main.js` 的 `__SWE_SET_LANG__` 钩子），不刷新 | 切到英文后面板标题与分区标题变化、宿主顶栏由「搜索…/观测」变 `Search.../OBSERVE`；时间/地点/选中/AI 配置逐项比对未变；切回中文宿主也回来；**英文浏览器 + 空存储时仍默认中文**（浏览器 locale 钉成 `en-US`）；**已有回答不伪装成翻译** |
| 上海默认站点 | 首次使用且未设过地点 → 设为上海 + `Asia/Shanghai`，界面标明"模拟位置"；用户改过后刷新仍保留 | 引擎读回 `31.2304 / 121.4737`；文案含"模拟位置"；时区默认值断言 |
| 互动输入 | 输入 → 模型 → JSON → **本地白名单预校验** → 预览 → 确认 → 逐条执行读回 | 提案渲染 2 条命令；确认前星图未变；确认后大气关、视场 20°（读回）；失败即停 |
| 命令预览/确认 | 同上，另加"确认时状态已变则整批作废" | 放弃后引擎不变；换选中后再确认被拒绝并给出人话提示，提案清空 |
| 主动文字讲解 | 点选只更新卡片；点「讲解」才请求；回答绑定 session/view/requestId | 讲解前 `chat==0`；讲解后 `chat` 恰好 +1；A→B→A 只显示最新回答；天空变了标记过期但**不改写原文** |
| 自定义 AI 设置 | Base URL/模型/可选 Key，默认仅内存；勾选记住才落盘并提供清除；连接测试走 `GET /models` | 裸域名自动补一个 `/v1`、已有 `/v1` 不重复、尾斜杠归一、完整路径保留；空 Key 不发 `Authorization`；填 Key 发 `Bearer`；401 显示认证错误；"只证明接口可访问"写进界面 |

### 13.2 宿主中文的范围与已知缺口

上游 `apps/web-frontend/src/locales/` 只有 `de/en/fr`，且 `main.js` 把 `loc` 写死成 `'en'`，
所以原版宿主的菜单永远是英文。`patches/0002` 补了 `zh.json`（56 条，与 `en.json` 同键）
和一个语言解析 + 运行时钩子。修完之后：

| 部分 | 现在 | 说明 |
|---|---|---|
| 宿主菜单/设置项/顶栏 | **中文** | 56 条 GUI 文案，切面板语言即切宿主，不刷新 |
| 面板（七块） | 中文 / English | 助手自带字典，与宿主互不依赖 |
| 星图天体名、星座名 | **仍是数据原名（英/拉丁）** | 引擎从星表与 skyculture 读，i18n 管不到；要中文得做数据层映射（`B1` 映射表），全量中文星名需另引数据，未做 |
| 宿主导航里的 `FOV`、品牌名 `Stellarium Web` | 英文缩写/品牌 | 模板里写死，不在 i18n 键里；未改，避免为此再动 `.vue` |
| 顶栏地点名 `UNKNOWN` | 数据值 | `store.state.currentLocation.short_name`，用户设过地点后就变成具体名称，不是漏翻 |

`document.documentElement.lang` 仍是上游 `index.html` 里写死的 `en`（我们只改
`index.html` 的一个 `<script>` 钩子，不动该属性）。中文界面下这一条对读屏软件的
语言标注不准确，属于已知小缺口。

### 13.3 顺带修掉的两个真实缺陷

1. **快照过期判定失真**。引擎时钟一直在走，`snapshotId` 每几秒就变，导致刚生成的
   讲解立刻显示"已过期"。改为 `isSnapshotCurrent()`：按对象/地点/视场/一分钟以内的
   模拟时间判断"实质变化"。桥接版本随之 0.2.0 → 0.3.0，协议号不变（纯新增方法）。
2. **状态行提示被吞**。`flash()` 写入的提示会被下一次状态刷新覆盖，用户根本来不及读。
   加了 `flashUntil` 窗口，5 秒内 `renderStatus()` 不覆盖。

### 13.4 仍然没有的（与任务书阶段划分对应）

- **服务器 AI 与管理后台**：任务书明确"客户端验收通过后才开始"。本版界面只显示
  "服务器 AI 尚未提供"，选项禁用，不误报为用户连接失败。
- **真实模型联调**：未做，也未做任何端点连通性验证（fake 服务只验证客户端链路）。
- **CORS/混合内容/私网访问**的真实场景验证：代码里做了错误映射（含 HTTPS 页面调
  HTTP 端点的专门提示），但没有真实端点可测，列为未验证。
- **命令批量上限、服务端限额、认证、跨站防护**：属于服务端阶段。
- 上一轮的点击拾取、逐包许可导出、Git 审计仍然未做。

### 13.5 天体名称语法与本地归一化（0.5.0）

用户反馈"用名称指向行星、月球、星座都不对"。根因不是数据缺失，是**写法**：
`getObj(q)` 即 `core_search(q)`，对每个对象的每条 designation 做 `strcasecmp` 全等比较。
所以大小写无关、**空格敏感**、无模糊、无中文，且四类天体的 designation 形态互不相同：

| 天体 | 正确 | 错误 |
|---|---|---|
| 行星/日月 | `NAME Jupiter` `NAME Moon` `NAME Sun` | `Jupiter` |
| 恒星 | `Sirius` `* alf Ori` `* 58 Ori` | `NAME Sirius` |
| 深空 | `M 31` `NGC 7000` | `M31` `M  31` |
| 星座 | `CON western Ori` | `Ori` `Orion` `猎户座` |

做了两件事，**引擎与宿主源码一行未改**：

1. `proposalPrompt()` 写入上述规则与 5 条 few-shot（中英各一份），让模型第一遍就写对。
2. `loader.js` 加 `resolveTarget()`：空白折叠 → 别名表 → 原样 → `NAME ` 前缀 →
   `CON western ` 前缀 → 去前缀 → 目录号补空格，首个命中即用；结果记进
   `readback.resolvedAs`。

覆盖与验证：

- 88 个星座（按 `skydata/skycultures/western/index.json` 的 id 反推）× 中英名 = **176 项**全过
- 行星日月 + 17 组亮星 + 9 组深空 = **36 项**全过
- `tests/e2e/client.mjs` §14c 新增 **8 项**，断言"提案原样送达"与"引擎选中正确对象"

已知边界：任意暗星的 Bayer 编号要写全（`* bet CMa`），任意 NGC/IC 编号只做补空格直查，
不查表；查不到如实返回 `object_not_found` 并带上 `tried` 列表，不猜测。

完整矩阵与复现步骤见 `docs/OBJECT-NAMING.md`。

### 13.6 本轮改动的文件

```
packages/host-adapter/loader.js   加 isSnapshotCurrent() + snapshotSignature()，桥接 0.3.0
                                  （0.5.0 再加 resolveTarget() 与别名表，桥接 0.4.0）
packages/assistant-web/assistant.js   重写为客户端版（双语/默认站点/AI 客户端/预览确认/讲解）
packages/assistant-web/assistant.css  加表单、提案列表、AI 块样式
packages/assistant-web/manifest.json  0.3.0
tests/e2e/client.mjs              新增（57 项；0.5.0 扩到 69 项）
tests/fake-openai/server.mjs      新增（测试专用，回环，无凭证）
tests/fixtures/assistant-v2/*     升到 0.4.0 并加 data-swe-fixture 标记（0.5.0 起为 0.6.0）
tests/e2e/hotswap.mjs             基线版本改读包 manifest，判据改用夹具标记
```
