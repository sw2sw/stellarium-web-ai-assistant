# 安装 / 更新 / 卸载

三种操作都只碰两个位置：`dist/index.html` 里的一段标记块，和 `dist/ai-assistant/` 目录。

## 前置

- 一个已构建好的 Stellarium Web 站点目录（含 `index.html`、`js/`、`skydata/`）。构建方法见 `UPSTREAM-BUILD.md`。
- Node.js 18+（只用来跑安装脚本，不参与页面运行）。
- 站点必须通过 HTTP 提供服务，`file://` 打开不可用（WASM 与 fetch 都要求 http）。

## 安装

```bash
node install/install.mjs --host /path/to/dist          # 安装 / 修复
node install/install.mjs --host /path/to/dist --check   # 只做检查，一个字节都不写
```

脚本会：

1. **识别宿主身份**：用 `install/known-hosts.json` 里登记的 `pristineIndexSha256`（剥掉标记块后的 `index.html` 哈希）与引擎 WASM 哈希比对。三种结果：
   - `verified` —— 与登记的构建完全一致，正常安装；
   - `variant` —— 引擎和 bundle 都对、只有 `index.html` 不同，**默认拒绝**，确认差异无害后加 `--allow-variant`；
   - `unknown` —— 对不上任何登记构建，**默认拒绝**，除非显式 `--allow-unknown-host`。
2. **检查标记块**：必须是恰好一对，且内容与本安装器生成的完全一致。重复块或手改过的块**直接拒绝**（后者要 `--force`）。
3. 备份 `index.html` 到 `dist/.swe-backup/index.html.<原文件sha256前12位>.orig`（已存在则跳过）。
4. 在 `</body>` 前插入一段带标记的 `<script>`（+142 字节）。
5. 把助手资源写进临时目录 `dist/.ai-assistant.stage-*`，校验完整后再整体换名发布；中途失败不会留下半套文件。
6. 写 `dist/ai-assistant/.install.json`：schema、版本、协议版本、`assetQuery`（内容哈希）、改动前后哈希、**每个文件的 sha256**、宿主身份。

重复执行是幂等的：先剥掉旧标记块再插入，不会重复加；`index.html` 结果字节一致。

## 更新助手（不需要重建宿主）

```bash
node install/install.mjs --host /path/to/dist --update /path/to/new-assistant
```

先完整校验新包（manifest 可解析、协议匹配、**`entry` / `style` / `references` 都必须在将被发布的文件集合里，且都是包根纯文件名**），再暂存→换名发布。**校验不过就一个字节都不动**，旧版本继续可用。

> `references` 是加载器在入口之前注入的文件（目前是 `naming-reference.js`）。少一个不会让安装失败，
> 只会让面板在浏览器里"能开但查不到天体名"——所以 0.9.0 起在发布前就查。
> 0.10.0 起查的是**最终会发布的文件集合**而不只是"文件在不在"：以点开头的隐藏文件和 `.md`
> 笔记本来就不过去（`publish` 只复制顶层可见文件），旧检查会放行一个 `references: [".x.js"]`
> 的包，装完在浏览器里 404。这类名字现在直接拒绝并说明原因。
>
> 0.11.0 起 `entry` 和 `style` 走**同一套检查**——它们原来只做 `existsSync`，于是
> `entry: ".assistant.js"`、`style: "theme.md"`、`entry: "sub/a.js"`、`style: "../a.css"`
> 都能过检并在发布时被跳过，装完页面直接打不开。现在四种都拒，提示分别是
> "would not be published" 与 "invalid entry/style name"。

安装/修复/更新共用一条失败恢复边界（0.10.0 起）：

- `index.html` 通过临时文件 + 改名字写回，**不会出现写了一半的入口**；这一步和暂存目录、
  换名发布在同一个回滚边界内；
- 任何一步失败，`index.html` 恢复成**操作前读到的字节**，不是"剥掉标记块"的版本。
  区别在修复场景：宿主本来就装着助手，恢复成剥掉块的样子等于把正在用的入口删掉，
  而旧资源还在目录里——页面照样不加载。首次安装本来就没有块，两者相同；
- 失败时暂存目录、本次的入口临时文件一并清掉，不留残骸。**只清本次创建的路径**（0.12.0
  起）：原来失败路径还会按 `index.html.swe-tmp` 和 `index.html.*.swe-tmp` 扫一遍目录，
  把别人放在那里的同名文件、或另一个安装进程正在用的临时文件一起删掉——一次失败的安装
  没有权利删它没创建的文件；
- 恢复也失败时如实说"`index.html` 没能恢复"，并指向 `dist/.swe-backup/`，不谎称已还原。

> **入口临时文件的名字是随机的，并且用排他创建（`wx`）**（0.11.0 起）。原来固定叫
> `index.html.swe-tmp`：那个名字可以被别人预先放一个符号链接，`writeFileSync` 会**跟随**
> 链接，把宿主目录外的文件截断，后面的改名也撤销不了这次外部写入。现在名字不可预测、
> 且目标已存在就创建失败，没有可跟随的东西。旧的固定名不再被自动清理（0.12.0 起）：
> 留着它最多多一个残留文件，删错一次却是别人的数据。

**入口文件的权限跟着原文件走**（0.12.0 起）：临时文件是私有的（`0600`），而改名会把
临时文件的权限带到 `index.html` 上——Linux 上原本 `0644` 的公开页面会被更新成
"只有安装用户能读"，静态服务换成别的用户（独立 Nginx、非 root 的容器）之后开始 403。
现在写之前先记下原入口的权限位，写完 `fchmod` 成同一个值再改名；原入口不存在时用
`0644`。失败后的还原走同一个函数，所以还原也不会改权限。Windows 与 FAT 这类没有
POSIX 权限位的文件系统上这一步是空操作（测试在 POSIX 上断言 `0644` 与"其他用户可读"）。

> **部署验收**：用静态服务的**实际运行用户**读一次入口，例如
> `sudo -u www-data test -r /srv/<host>/index.html`，容器里用 `docker exec -u nobody ...`。
> Windows 上跑测试看不出这件事——只有换成另一个用户读，才算把这一条验过。

**提交之后的事情不算失败**（0.11.0 起）：清理旧版本目录（把用户自己放进 `ai-assistant/`
的文件搬过来、删掉我们登记过且内容未变的文件、删空目录）发生在**新目录就位、`.install.json`
已写好之后**。这一步抛错只打一条 `WARNING`（"the previous version is still in
`.ai-assistant.old-xxxx/`"），命令仍以成功退出——因为它确实成功安装了。原来它挂在
`publish()` 里，抛错会被外层当成"更新失败"，于是回执说"旧版本和 index.html 都没动"
（假的，新版本已经生效），repair 场景还会把 `index.html` 恢复成旧的，造成入口指向旧块、
资源却是新目录。

**回滚失败也要照实说**（0.11.0 起）：`publish()` 现在用返回/抛出的 `publish.restored`
告诉调用方"上一个版本到底放回去了没有"。换名失败、状态文件写失败这两条路径里，
如果复位旧目录也失败，回执会写 "the previous version could NOT be put back (...)"，
并指向 `ai-assistant/` 与 `.ai-assistant.old-*/` 让人去看，而不是固定输出
"back to their previous state"。

**首装失败时"已还原"也要有证据**（0.12.0 起）：没有旧版本时，`restored` 原来直接取
`!movedOld`，于是"状态文件写失败 + 新目录也没能挪走"这一对故障下，回执仍然说宿主回到
了原样——而 `ai-assistant/` 明明还在那里，且没有任何 `.install.json` 描述它。现在
`restored` 要求新文件**确实已经移出** live 位置才算数；移不走就写
"the new assistant files could NOT be removed from ai-assistant/"，并指向目录让人去看。

发布本身的两条回滚线（0.9.0 起，0.10.0 起并入上面的统一边界）：

- 换名失败 → 旧目录放回原处；
- 新目录已就位但 `.install.json` 写不进去 → 整个发布撤销、旧版本放回，不留"文件在、状态不在"的宿主。

更新同样要过**安装时的那套预检**（v0.8.0 起，审查 R4）：

1. 宿主身份（`unknown` / `variant` 默认拒绝，与安装同一套开关）；
2. 标记块（重复、手改默认拒绝）；
3. `ai-assistant/` 目录必须还在，且入口块必须还在 `index.html` 里——
   状态说"已安装"但块没了，说明宿主被换过，直接拒绝；
4. **引擎 wasm 与 pristine `index.html` 必须与安装时登记的一致**。
   宿主重建过就会在这里被拦住，而不是把新资源发进一个不认识的宿主。

拒绝时的提示会说明"这台宿主和装的时候不一样"，并建议 `--uninstall` 后重装，
让登记值与字节重新对齐。

`index.html` 和 `js/*` 一个字节不动，刷新浏览器即生效。

验证方法（实测用过）：

```bash
sha256sum dist/js/*.js dist/js/*.wasm dist/index.html   # 更新前后应完全一致
```

**缓存**：`loader.js` 每次加载带 `?t=<时间戳>` 取 `manifest.json`；资源 URL 上的 `?v=` 用的是 **`assetQuery`（内容哈希）而不是版本号**。所以"版本号没变但内容变了"也会换 URL，不会被缓存住。示例服务 `tools/serve.mjs` 另外对 `ai-assistant/` 发 `Cache-Control: no-store`，但正确性不依赖这一点。

## 卸载

```bash
node install/install.mjs --host /path/to/dist --uninstall
```

移除标记块，然后**只删除 `.install.json` 里登记过、且当前哈希仍与登记值一致的文件**：

- 用户自己放进 `ai-assistant/` 的文件 → 保留，并提示；
- 被用户改过的助手资源 → 保留，并提示（改过就证明不了是"我们写的"了）；
- 目录因此非空 → 保留目录，不递归删。

实测卸载后 `index.html` 的 sha256 与安装前**完全一致**（`4e4f836b8304…`），原版星图照常工作。

## 查看状态

```bash
node install/install.mjs --host /path/to/dist --status
```

## 拒绝清单（都会拒绝，且不留副作用）

`tests/installer/safety.mjs` 逐条验证。作者实测口径是 **Windows：143 项通过、1 行 SKIP**（那一组是
入口权限，本平台没有 POSIX 权限位，整组只记一行跳过）；POSIX 上预计执行 **147 项**（143 + 该组 4 项）。
**Linux 上尚未实际运行**，待目标环境验证之后再写"全过"：

| 情况 | 行为 |
|---|---|
| 普通 Vue 站点 / 没有锁定引擎 WASM 的站点 | 拒绝（`unknown`） |
| `index.html` 与登记构建不一致 | 拒绝（`variant`），需 `--allow-variant` |
| `ai-assistant/` 已存在但不是本工具装的 | 拒绝，原样保留 |
| `.install.json` 损坏或缺字段 | 拒绝安装、更新、卸载 |
| `.install.json` 的 `files` 里有 `../x` 之类条目 | 拒绝，且不会先改 `index.html` |
| 标记块重复 / 被手改 | 拒绝（后者需 `--force`） |
| `ai-assistant/` 是符号链接 | 拒绝，不跟随 |
| 新包缺 entry/style、协议不符、manifest 坏 | 拒绝更新，旧版本继续可用 |
| `references` 指向隐藏文件或 `.md`（存在但不会发布） | 拒绝更新，旧版本继续可用 |
| `entry` / `style` 指向隐藏文件或 `.md`（存在但不会发布） | 拒绝更新，旧版本继续可用 |
| `entry` / `style` 带目录或 `..`（不在发布的顶层） | 拒绝更新，旧版本继续可用 |
| 同名版本但内容变了 | 允许更新，`assetQuery` 变化，缓存失效 |

### 故障注入（测试用，正常安装不涉及）

安装器的每一步失败都有一个可复现的入口：环境变量 `SWE_INSTALL_FAULT`，取值
`stage` / `index-write` / `publish-rename` / `state-write` / `retire` / `isolate`
（0.12.0 新增：让"把新目录挪走"这一步失败），以及
`restore`（让**回滚本身**失败）。可以写逗号分隔的多个值，用来构造"主动作失败、
回滚也失败"这一对——那正是不能声称"已还原"的场景。它**只会让安装更早失败**，
不改变成功路径写入的任何字节，且每个名字只触发一次（否则回滚路径会被同一故障再打一次）。

用例在 `tests/installer/safety.mjs`：
- §13：在**已安装**的宿主上跑修复并注入前四个故障，断言 `index.html` 与整个宿主
  目录树逐字节不变、入口块还在、目录里没有暂存目录或入口临时文件；另有一组断言
  首次安装失败后宿主仍是未打补丁的原样（新建的 `.swe-backup/` 保留，它是唯一一份
  原始页面，删掉它只为满足"零残留"并不划算）；
- §15：注入 `retire`，断言更新**仍然成功**、`.install.json` 写的是新版本、旧目录
  以 `WARNING` 形式点名；
- §16：注入 `publish-rename,restore`，断言回执写 "could NOT be put back"、不再出现
  "back to their previous state"，且旧版本确实还在 `.ai-assistant.old-*/` 里可人工恢复；
- §17：在旧的固定临时名上预置一个链接（Windows 无权限时退化为硬链接），断言安装
  成功、链接指向的外部文件逐字节不变；
- §18（0.12.0）：把入口设成 `0644` 后安装，断言装完仍是 `0644` 且"其他用户可读"；
  再设成 `0640` 并让发布失败，断言还原后仍是 `0640`。Windows 上跳过（没有权限位）；
- §19（0.12.0）：首装注入 `state-write,isolate`，断言退出码非 0、回执**不**说
  "nothing was installed"，写的是 "the new assistant files could NOT be removed"、
  声称留下的文件确实在、且没有 `.install.json`；同时 `index.html` 回到原字节；
- §20（0.12.0）：预置 `index.html.swe-tmp` 与一个随机名临时文件，注入 `state-write`
  让安装失败，断言两个文件的字节都没被动过。

## 故障隔离

助手出问题不影响星图。下面每一条都有实测断言（`tests/e2e/hotswap.mjs`，33 项）：

| 故障 | 现象 | 断言方式 |
|---|---|---|
| `manifest.json` 损坏 | 星图照常，助手不出现 | 采样画布像素，非均匀 |
| `assistant.js` 404 | 星图照常，助手不出现 | 同上 |
| 助手 JS 顶层抛异常 | 星图照常，助手不出现，桥接仍可驱动引擎 | 同上 + 桥接命令仍返回 `applied` |
| manifest 协议与 loader 不符 | 星图照常，助手不出现 | 同上 |
| 引擎一直不就绪 | loader 干净放弃，不建面板、不抛错 | 单独页面 + 800ms 超时 |

注意"星图照常"的证据是**采样真实像素**（80×80 缩略后亮度极差 > 10），不是"canvas 元素存在且尺寸非零"——后者证明不了还在画。

## 安全边界（当前实现）

- 宿主补丁是同源 `<script>`，**不是沙箱**。助手能访问 `$stel`，也能访问页面其余部分。这与任务书 §6"宿主模块同源并不构成安全沙箱"一致，不做虚假承诺。
- 助手当前**不发起任何网络请求**（阶段 A 无模型调用），唯一请求是取自己的 `manifest.json`。
- 安装脚本不写入任何凭证、不联网；只在本地文件系统上操作，且拒绝跟随符号链接。
- `tools/serve.mjs` 是**本地验证工具**：只绑 loopback、无认证、无 TLS。阶段 D 的对外服务必须换成经审查的静态服务器，不是把它改成对外监听。
