# 服务器 AI：配置、额度与部署边界

本文介绍可选同源 AI 服务（`packages/ai-service`）及助手的 server 模式，覆盖认证、配置、提供商密钥、额度存储和部署检查。

功能入口与已知限制见[项目说明](../../README.md)。实际部署应使用独立配置与数据目录；真实模型验证会产生调用和费用，应预先设置预算。

---

## 1. 拓扑与信任边界

```
浏览器（同源页面）
   │  ① POST /api/ai/chat  { messages }      ← 只带 messages，不带 model / url / key
   ▼
ai-service（Node，与站点同源，同端口）
   │  ② 校验 Origin / 令牌 / 额度，读出 config.json + keys/rev-<n>.key
   │  ③ POST {baseUrl}/chat/completions      ← 在这一跳才加上 model 与 Authorization
   ▼
上游（Ollama / Spark / 任何 OpenAI 兼容端点）
```

服务遵循以下边界：

- **浏览器不持有厂商密钥。** server 模式下页面只有 `{source, baseUrl, model, hasKey}`，
  `hasKey` 是布尔值。密钥只在服务进程里、只在发往上游的那一跳出现。
- **普通客户端不能指定上游。** `/api/ai/chat` 只读 `messages`；出现 `model`、`url`、
  `tools`、`tool_calls` 等任何额外字段一律 400 `unexpected_fields`，而不是"忽略"。
  忽略会让探测者看起来像正常用户，拒绝才会在日志里留下痕迹。
- **未配置即关闭。** `config.live()` 是唯一闸门：`enabled && baseUrl && model &&
  (authMode === 'none' || key)`。任一不满足，`/api/ai/config` 报 `available:false`，
  `/api/ai/chat` 直接 503，前端把该选项显示为"本站尚未提供"。

## 2. 认证：两类口令，两个面

| 面 | 路径 | 需要 | 用途 |
| --- | --- | --- | --- |
| 课堂 | `/api/ai/chat`、`/api/auth/*` | `SWE_ACCESS_TOKENS`（classroom） | 老师/学生发起一次生成 |
| 管理 | `/api/admin/*`、`/admin` | `SWE_ADMIN_TOKENS`（admin） | 改配置、看额度、紧急停用 |

- 两类口令都可以用环境变量（逗号分隔）或文件（`SWE_ACCESS_TOKENS_FILE` /
  `SWE_ADMIN_TOKENS_FILE`，一行一个，`#` 开头为注释）提供。文件按 mtime 重读，
  所以**撤权不需要重启**：从文件里删掉一行，下一次请求就是 401。
- 登录成功后下发两个 cookie：`swe_access`（口令本身，`HttpOnly`）与 `swe_sid`
  （会话 id，仅用于日志关联）。`POST /api/auth/logout` 会**同时**清掉两个；
  只清 `swe_sid` 是上一版的实际缺陷——下一个请求带着 `swe_access` 又通过了。
- `swe_sid` 不是额度主体。它是可再生的，用它记账等于没有额度（见 §4）。

## 3. Origin 与反向代理

`originAllowed()` 检查完整的 `(scheme, host, port)` 三元组，而不是只比 host：

- `Origin` 缺失 → 放行（脚本客户端；此时仍然要过令牌）。
- `Sec-Fetch-Site: cross-site` → 拒绝。
- `Origin` 与 `SWE_PUBLIC_ORIGIN` 相同 → 放行。
- 否则与本次请求自身的 origin 比较；端口不同就是不同 origin（`127.0.0.1:9999`
  访问 `127.0.0.1:8900` 会被 403，测试里有这一条）。
- `X-Forwarded-Proto/Host` **只在 socket 对端地址属于 `SWE_TRUSTED_PROXY` 时才相信**。
  否则任何客户端都能用这个头伪造"我就是本站"。

部署在 nginx 后面时：

```nginx
proxy_set_header X-Forwarded-Proto $scheme;
# $http_host 而不是 $host：$host 会丢掉非默认端口，于是
# "http://example.org:8102" 被当成 "http://example.org"，origin 三元组对不上，
# 浏览器里的每一次登录和生成都会 403。$http_host 原样保留 Host 头（含端口）。
proxy_set_header X-Forwarded-Host  $http_host;
proxy_read_timeout 190s;   # 大于服务端 180s 总超时，让服务先超时并给出可读错误
```

`SWE_TRUSTED_PROXY=127.0.0.1`（或反代的实际地址）。不设置时 `X-Forwarded-*` 一律忽略，
页面直连也能工作，只是经过反代后 origin 判断会退化为"对端地址"。

如果反代改写了端口或协议（例如 `listen 80` 反代到 `https://` 之外的内部端口），
把对外地址显式写进 `SWE_PUBLIC_ORIGIN=https://example.org:8102`：它优先于
`X-Forwarded-*`，是"本站对外是什么样"的唯一权威说法。此时允许的 `Origin` 就是它，
反代头只需要传 `Proto`。

## 4. 额度：持久、按身份、不可重置

### 4.1 主体

额度主体是 `HMAC-SHA256(identity.key, 口令)` 的前 32 个十六进制字符，**不是**会话 cookie。

- 换浏览器、清 cookie、开无痕窗口、重新登录 → 同一个口令 → 同一个主体 → 额度不重置。
- 换一个口令（第二位老师）→ 新主体 → 自己的额度。测试里用第二个课堂口令验证了
  "新身份的第一发是允许的"。
- `identity.key` 在数据目录里生成一次（32 字节随机，0600），所以**删掉它等于把所有人
  的额度清零**。这是运维动作，不是用户动作。

### 4.2 状态机

每个 `(日, 主体)` 有四个计数：

| 状态 | 含义 | 计入已用 |
| --- | --- | --- |
| `reserved` | 已授权、正在（或曾经）在途 | 是 |
| `completed` | 上游答完并已返回给客户端 | 是 |
| `unknown` | 无法判断上游是否计费（超时、中断、5xx） | 是 |
| `refunded` | 确定没有生成（401/403/404/4xx/429） | 否 |

`已用 = reserved + completed + unknown`。只有 `refunded` 会把预算还回去，而它只在
**可证明没有产出**时使用（`upstream_auth` / `upstream_notfound` / `upstream_rate` /
`upstream_rejected`）。超时和客户端中断记为 `unknown`，不退、不重试——重试一个可能
已经计费的请求，是花两次钱买一次失败。

预留（`reserve`）在**打开上游连接之前**完成，且两个上限（全站/单身份）的检查与自增
在同一个事务里，所以并发请求不会都看到"最后一个空位"。

### 4.3 日界

`dayKey()` 用 `Intl.DateTimeFormat('en-CA', { timeZone: dayTz })` 取日历日，默认
`Asia/Shanghai`。20:00–22:00 的一节课不会跨两个额度日。`dayTz` 可在管理页改。

### 4.4 重启

额度在磁盘上，重启不清零。测试覆盖：同一进程内重启服务后，配额仍然拒绝。
保留 40 天（`keepDays`），每小时最多清理一次，清理失败不影响请求。

## 5. Node 与存储（Node and storage）

选型前在本机核对过：

```
$ node -v
v24.21.0
$ node -e "const {DatabaseSync}=require('node:sqlite'); new DatabaseSync(':memory:').exec('create table t(a)'); console.log('ok')"
ok
```

因此：

- **首选 `node:sqlite`**（`DatabaseSync`，Node ≥ 22.5 提供）。真事务
  （`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`）、WAL、`synchronous = FULL`，
  单文件 `quota.db`。
- **回退 JSON 日志**（`quota.json`）。任何 Node 都能跑：一份文档、原子替换 + fsync、
  损坏文件改名为 `.corrupt-<时间戳>` 而不是静默从零开始。
- 两者实现同一个 `openStore()` 契约，`SWE_STORE_BACKEND=auto|sqlite|json` 选择；
  `auto` 在 `node:sqlite` 不可用时**打一条 warn 然后回退**，不会退化成内存计数。
- 启动时 `/healthz` 与 `/api/admin/config` 都会报出实际后端（`backend` 字段），
  所以"到底用的哪个"不需要猜。

部署前请在目标机上跑上面两行。若目标机是 Node 18/20，`auto` 会走 JSON 后端：
功能等价，并发量大时不如 SQLite，但仍满足"重启不重置"。

## 6. 数据目录

`SWE_DATA_DIR`（默认 `./ai-service-data`），目录权限 0700，文件 0600：

| 文件 | 内容 | 备注 |
| --- | --- | --- |
| `config.json` | 上游 baseUrl、模型、authMode、开关、额度与超时、`revision`、`upstream.keyRef` | **不含密钥**，只存指针 |
| `keys/rev-<n>.key` | 厂商密钥，明文单行，按 revision 命名 | 0600；只有 `hasKey` 会出现在 API 里 |
| `identity.key` | 额度主体 HMAC 的密钥 | 生成一次；删掉=清零所有人额度 |
| `quota.db` / `quota.json` | 额度台账 | 保留 40 天 |

写入一律"临时文件 + fsync + rename + fsync 目录"，所以断电不会留下半个配置。
`config.json` 每次保存 `revision + 1`；`revision` 单调递增，前端据此丢弃过期答案。

**密钥与配置是一个原子快照**：一次保存先写 `keys/rev-<n>.key`，再用**一次 rename** 发布
`config.json`（其中 `upstream.keyRef = "rev-<n>"`）。不存在"新 Key 已生效、配置还指向旧上游"
的窗口——那正是把 A 的 Key 发给 B 的路径。保存失败时旧 Key 仍然是唯一有效的那份。
旧版本 Key 在发布成功后立即删除：轮换通常是因为泄露，"换掉了"必须意味着字节没了，
所以回滚到旧 `config.json` 需要重新输入 Key（见 §13）。

早期版本把 Key 放在 `upstream.key`（固定文件名）。这个位置仍然**只读兼容**：`keyRef`
缺失时会回退去读它，但新保存一律写 `keys/`。

## 7. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SWE_BIND` | `127.0.0.1` | 监听地址 |
| `SWE_PORT` | `8080` | 监听端口（整数 1–65535） |
| `SWE_STATIC_DIR` | `../packages/integrated-web/dist` | 站点目录，用于同源托管 |
| `SWE_DATA_DIR` | `./ai-service-data` | 配置与台账目录 |
| `SWE_PUBLIC_ORIGIN` | 空 | 对外 origin，如 `https://sky.example.edu.cn` |
| `SWE_TRUSTED_PROXY` | 空 | 可信反代地址，逗号分隔；只有它们发的 `X-Forwarded-*` 被采信 |
| `SWE_AI_ALLOWED_HOSTS` | 空 | 上游主机白名单；**空 = 谁都不能配** |
| `SWE_ACCESS_TOKENS` | 空 | 课堂口令，逗号分隔 |
| `SWE_ACCESS_TOKENS_FILE` | 空 | 课堂口令文件（可热更新） |
| `SWE_ADMIN_TOKENS` | 空 | 管理口令，逗号分隔 |
| `SWE_ADMIN_TOKENS_FILE` | 空 | 管理口令文件（可热更新） |
| `SWE_REQUIRE_AUTH` | `1` | `0` 时允许匿名（仅内网演示用） |
| `SWE_STORE_BACKEND` | `auto` | `auto` / `sqlite` / `json` |
| `SWE_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

`SWE_AI_ALLOWED_HOSTS` 的匹配规则只有三种：精确 host、`host:port`、一级 `*.example.com`
通配（`*.example.com` 不匹配裸 `example.com`）。云元数据地址（`169.254.169.254`、
`100.100.100.200`、`fd00:ec2::254`、`metadata.google.internal` 等）即使被写进白名单
也一律拒绝。白名单为空时，管理页保存会报 `allowlist_not_configured`——**失败关闭**，
而不是让管理员随手粘贴任意 URL。

## 8. 管理页语义

`GET /admin`（同源，自带 CSP `default-src 'none'; connect-src 'self'`）。三个按钮
的语义严格分开：

| 按钮 | 是否调用模型 | 是否占额度 | 说明 |
| --- | --- | --- | --- |
| 保存（不调用模型） | 否 | 否 | 只写配置，`revision + 1` |
| 检查连接（不生成） | 否（`GET {base}/models`） | 否 | 只证明可达与鉴权通过；上游不支持 `/models` 时返回"可达但无法验证" |
| 生成测试（会占用一次额度） | 是 | 是 | 显式、单独一次，用于验证真能生成；**走与课堂相同的并发闸门** |

管理页显示：掩码后的配置、`revision`、最后修改时间与操作者、当日用量、各状态计数。
密钥输入框**永远为空**（不回显）；留空表示"不修改已保存的密钥"，要清除必须点
"清除已保存的 Key"——空输入不会误删。

**每次保存都带 `expectedRevision`（compare-and-set）**：页面渲染时看到的是哪一版，
就写回哪一版。对不上时服务端返回 **409 `revision_conflict`**（缺失则 400
`revision_required`），页面刷新表单并说明"已被其他人改动，你刚才的修改没有保存"，
**不会**带着新版本号自动重试——那等于用旧表单覆盖新配置，只是晚了一步。

这条规则存在的理由是一个真实场景：管理页开着没关，另一个标签页（或另一个人）刚做完
紧急停用，过期表单点保存会把 `enabled: true` 写回去，停用就白做了。`revision` 参与
compare-and-set 之后，它只会收到 409。

**紧急停用本身不要求 `revision`**：让一个过期表单能阻止停用，比两个人互相覆盖更危险。
停不下来才是事故。

`upstream.allowed` 会显示"是否仍在 `SWE_AI_ALLOWED_HOSTS` 内"——白名单缩小后重启，
已保存的上游不会发出任何请求，管理页要说清楚是哪一项不满足，而不是让运维对着
一个"不可用"猜。

## 9. 上游超时与失败码

三个计时器，三种错误，互不混淆：

| 计时器 | 触发条件 | 返回 |
| --- | --- | --- |
| `connectTimeoutMs`（默认 10s） | **TCP 连接**没建立起来 | 502 `upstream_unreachable`（退回额度） |
| `idleTimeoutMs`（默认 60s） | 已收到头，但正文停滞 | 504 `upstream_stalled` |
| `timeoutMs`（默认 180s） | 总时长超限（含等待首字节） | 504 `upstream_timeout` |

`connectTimeoutMs` 是**真的连接**：`net.connect` 到 `host:port`，连上即销毁，不发 TLS、
不发请求。它只回答"这台机器此刻能不能被连上"。

它**不**管首字节。非流式上游要把整个答案生成完才写第一个字节，把这段等待算成"连接超时"
正是上一版把 180 秒砍成 10 秒的原因：一个健康的 20 秒答案会被报成"不可达"。首字节只受
`timeoutMs` 约束。

正文读取上限 1 MiB；`redirect: 'error'`（不跟随跳转，避免被引到白名单外）；
**任何情况下都不重试**。401/403/404/429/5xx 各自映射到固定错误码，前端有对应中文文案。
非 2xx 的正文也走同一个 idle 预算读取后丢弃：状态码才是要报的东西，不能为一个可能永远
不结束的错误体把连接一直挂着。

## 10. 前端：两种来源，各自独立

- `ai.source` 只能是 `server` 或 `custom`，两套配置分别保存，互不覆盖；
  从 server 切回 custom，自定义地址、模型、Key 都还在（测试有这一条）。
- server 模式：`POST /api/ai/chat`，body 只有 `{messages}`，`credentials: 'same-origin'`，
  读 `{content}`。
- custom 模式：直接打 `{baseUrl}/chat/completions`，body 是标准 choices 格式，
  `credentials: 'omit'`（跨域时不带本站 cookie）。
- **没有回退。** server 失败不会偷偷用本地 Key 再发一次；这是"一次点击花两次钱"的
  典型来源。
- 模型只负责提议。执行仍然是本地校验 → 预览 → 确认 → 读回校验；确认前天空不动。
- 切换来源 / 改模型 / 改语言 / 改观测对象，都会让在途请求与未确认的提案作废。
- 答案带 `revision`。服务端在写回响应时发现 `revision` 已经变了（管理员刚保存了新配置），
  返回 **409 `config_changed`**；前端丢弃这条答案并刷新状态。额度照常扣——上游确实被
  调用过。
- 反过来的一种情况要区别对待：响应里的 `revision` **比本标签页缓存的新**，说明管理员是在
  这次请求发出**之前**保存的，答案属于**现在**这份配置——它是有效的，落后的是缓存。
  前端接受答案并把缓存同步到新 revision，否则管理员一保存，之后每一个回答都会被误判成
  过期丢掉，老师重问一次就再花一次额度。
- 服务器来源的提案绑定 `{revision, 会话代次, 登录态, 角色}`。确认前会强制刷新一次状态
  （一次 GET，不占额度），任一不一致就拒绝执行并说明原因；登出会**先**本地失效、再发请求，
  同时掐掉还没发出的后续批次。

## 11. 配置示例

见 `packages/ai-service/examples/`：

- `env.ollama.example` —— 本机 Ollama，**无 Key**（`authMode=none`，不发 Authorization）。
- `env.spark.example` —— 讯飞 Spark 兼容端点，**有 Key**（`authMode=auto`，有 Key 就发 Bearer）。
- `tokens.example` —— 口令文件格式。

最短可用路径（Ollama）：

```bash
export SWE_AI_ALLOWED_HOSTS=127.0.0.1:11434
export SWE_ACCESS_TOKENS=class-demo
export SWE_ADMIN_TOKENS=admin-demo
export SWE_DATA_DIR=/var/lib/swe-ai
node packages/ai-service/server.mjs
# 打开 http://127.0.0.1:8080/admin，用 admin-demo 登录，
# Base URL 填 http://127.0.0.1:11434/v1，模型填 qwen2.5:7b，鉴权方式选"无"，
# 点"检查连接"→"保存"。
```

## 12. 升级

1. **先停服务，再备份。** 运行中的 `quota.db` 处于 WAL 模式，直接 `cp` 目录会漏掉
   `quota.db-wal` 里还没 checkpoint 的事务，也可能拷到一个"一半旧一半新"的库；
   `cp` 一个正在写的目录不是一致备份。停服务后 WAL 会被 checkpoint，此时复制才是自洽的：
   ```bash
   systemctl stop swe-ai          # 或 Ctrl-C 前台进程
   cp -a "$SWE_DATA_DIR" "$SWE_DATA_DIR.bak-$(date +%F)"
   ```
   备份里必须有：`config.json`、`keys/`（当前有效的上游 Key，文件名 `rev-<n>.key`）、
   `identity.key`、`quota.db`（或 `quota.json`）。`config.json` 只存 Key 的**指针**
   （`upstream.keyRef`），只拷 `config.json` 而不拷 `keys/` 等于把 Key 弄丢了。
   如果不能停机，用 SQLite 自己的备份命令，它会在运行中取一致快照：
   ```bash
   sqlite3 "$SWE_DATA_DIR/quota.db" ".backup '$SWE_DATA_DIR.bak-$(date +%F)/quota.db'"
   ```
2. 替换 `packages/ai-service`（整个目录）与 `packages/assistant-web`。
3. 装前端到站点目录：
   ```bash
   node install/install.mjs --host <dist> --update packages/assistant-web
   ```
   预期输出 `assistant updated to v0.13.0 (5 files, assetQuery …)`。
   安装器会先核对宿主指纹（`stellarium-web-engine@1162c9ef-web-frontend-zh`），
   不匹配就拒绝写入。
4. 起服务，验证：
   ```bash
   curl -s localhost:8080/healthz            # {"ok":true,"version":"0.2.0",...}
   curl -s localhost:8080/api/ai/config      # available 与 model 是否符合预期
   ```
   `/healthz` 里 `store` 不能是 `unavailable`，`fault` 必须是 `null`，
   `authFiles` 里两个口令来源都要是 `true`——这三项是"数据目录没坏"的最低证明。
5. 管理页点一次"检查连接"（不占额度），再让一位老师点一次真实提问。

数据兼容：`config.json` 的 `schema` 为 1；升级前应备份配置、身份密钥和完整额度数据库。
从 0.1.0 升级时，旧的 `config.json` 会被补上缺省字段，不需要手工迁移。

## 13. 回滚

1. 停服务。
2. 恢复上一版 `packages/ai-service`（或直接恢复备份的数据目录 + 上一版代码）。
3. 前端回滚：`node install/install.mjs --host <dist> --update <上一版 assistant-web 目录>`，
   或 `node install/install.mjs --host <dist> --uninstall` 彻底移除助手（宿主 `index.html`
   会还原，星图本身不受影响）。
4. 起服务，验收要三项都过，`/healthz` 通只是第一项：
   ```bash
   curl -s localhost:8080/healthz
   ```
   - `ok: true` 且 `store` 不是 `unavailable`、`fault` 为 `null`：数据目录能用。
   - `authFiles` 两项都是 `true`：口令来源可读（`false` 表示文件被删或不可读，
     此时所有人都会被拒，属于故障而不是撤权）。
   - `revision` 与回滚前一致：`config.json` 用的是同一份配置，而不是退回默认。
   再打开 `/admin` 确认"Key 已设置"、Base URL 与模型正确，并看一次额度页——
   当日已用数必须还是回滚前的数字。**只有 `/healthz` 返回 200 不足以说明回滚成功**：
   一个空账本、一个丢了 `identity.key` 的目录、一个指向不存在 Key 的配置，
   都会让 `/healthz` 照样返回 200，却把当天的额度或凭据悄悄改掉。

回滚**不要**删数据目录：`identity.key` 一旦丢失，所有人的当日额度都会归零；
`quota.db` 丢失等于把当天的账清空。若确实要清零，那是运维决定，请显式执行并记录。

## 14. 测试入口

从 `source/` 目录执行不需要宿主站点的服务端测试：

```bash
node tests/service/run.mjs
```

浏览器套件 `tests/e2e/server-ai.mjs` 需要自行准备实际浏览器、依赖和独立可写的宿主副本。按脚本参数设置 `DIST_DIR`；该运行目录不随源码仓库提供。套件使用临时服务、临时数据与假上游，不应指向生产配置或真实额度目录。

其他测试入口见[源码导航](../README.md)。测试结果取决于实际执行环境；假上游测试不代表真实提供商的兼容性或内容质量。

## 15. 已知边界

- 额度是"次数"，不是"金额"。`maxOutputTokens` 与总超时限制了单次开销的上界，
  但没有按 token 计费的能力，也不声称能给出精确费用上限。
- 服务器 AI 与自定义 AI 的用量互不相干：自定义模式用的是老师自己的 Key，服务端不管。
- 中文名称、语音接口及平台兼容范围以当前版本说明为准。真实模型调用应在有明确预算的独立批次中进行。
