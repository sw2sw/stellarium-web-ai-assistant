# 从锁定源码重建 Stellarium Web 宿主

前两份补丁与构建步骤来自作者既有 Windows 验证记录；内部原始日志不随当前树发布。第三份字体补丁仅对锁定模板做过 apply 检查，当前运行首页使用等价覆盖；本次没有重建或验证构建可复现。

## 0. 锁定版本

```
repo   https://github.com/Stellarium/stellarium-web-engine
commit 1162c9ef73cc94f4762dfbfd24c637190119ea93
date   2026-10-20
licence AGPL-3.0 (根目录 LICENSE-AGPL-3.0.txt)；另有商业许可可选
```

选它的理由：这是 2026-10-30 时 `master` 的 HEAD，与 `体积核查.md` 记录的公开发布基线一致，可追溯、可复核。

## 0.1 目录约定（每一步都写清当前目录）

本文的命令从空目录开始按顺序执行。先设两个变量，后面所有命令都只引用它们：

```bash
# $SRC  = 本交付包里的 source/ 目录（补丁、工具、文档都在这里）
# $WORK = 一个空目录，用来放上游克隆和构建产物
SRC=/path/to/delivery/source
WORK=/path/to/empty-workdir
mkdir -p "$WORK"
```

| 步骤 | 当前目录 | 产物落在 |
|---|---|---|
| 1 克隆 | `$WORK` | `$WORK/swe` |
| 2 打补丁 | `$WORK/swe` | 同上 |
| 3 编引擎 | `$WORK/swe` | `$WORK/swe/apps/web-frontend/src/assets/js/` |
| 4 装依赖 | 任意 | `$WORK/swe/apps/web-frontend/node_modules` |
| 5 构建前端 | 任意 | `$WORK/swe/apps/web-frontend/dist` |
| 6 本地运行 | 任意 | —（`$SRC/tools/serve.mjs` 提供服务） |

## 1. 克隆（必须关掉 CRLF 转换）

```bash
cd "$WORK"
git clone --no-checkout https://github.com/Stellarium/stellarium-web-engine.git swe
cd "$WORK/swe"
git config core.autocrlf false          # ← 关键，见下方"坑 1"
git checkout 1162c9ef73cc94f4762dfbfd24c637190119ea93
```

## 2. 应用前端补丁（上游源码的全部改动）

补丁在交付包里，不在克隆里，所以用绝对路径引用：

```bash
cd "$WORK/swe"
git apply "$SRC/upstream/patches/0001-web-frontend-vue2.patch"
git apply "$SRC/upstream/patches/0002-web-frontend-zh-locale.patch"
git apply "$SRC/upstream/patches/0003-local-fonts.patch"
git diff --stat        # package.json、main.js、public/index.html；新增 zh.json 用 git status 查看
```

- `0001`：`apps/web-frontend/package.json` 里 `"vue": "^3.0.0"` → `"^2.6.11"`，一行。
- `0002`：宿主中文化。新增 `apps/web-frontend/src/locales/zh.json`（56 条 GUI 文案，
  与 `en.json` 同键），并把 `main.js` 里写死的 `const loc = 'en'` 换成：

  1. `resolveLocale()`：先看 `?lang=`，再看 `localStorage['swe.uiLang']`，否则 `zh`。
     **刻意不读 `navigator.language`／系统语言**——同一个教学站点在每台机器上都该长一样。
  2. `window.__SWE_SET_LANG__(lang)`：助手面板的语言按钮通过它切宿主界面，不刷新、
     不重置时间/地点/选中/AI 配置；非法语言返回 `false`，不静默回退。

  星图上的天体名**不在**这 56 条里：那是引擎从星表/skyculture 数据里读的原名，
  切 UI 语言不会变（见 `FEASIBILITY.md` §13）。

- `0003`：删除 `apps/web-frontend/public/index.html` 的 Google Fonts 外链，使用已有本地字体。该补丁在锁定模板 apply 检查成功，SHA256 为 `238aae07c9f3579133b552b56f6f5bb4b8c39757beaae7835174d1f71e931e65`。

三份补丁均不修改 `.vue`、`.c`、`.h`。0003 重建会改变首页；现有 runtime 是等价字体覆盖，不声称整包由三补丁重新构建。


## 3. 编译引擎 WASM

上游 `apps/web-frontend/Dockerfile.jsbuild` 已经**不能直接构建**（见"坑 2"）。用等价的修补版，构建上下文是 `$SRC/upstream/patches`：

```bash
cd "$WORK/swe"
docker build -f "$SRC/upstream/patches/Dockerfile.engine" -t swe-engine:1.39.17 \
  "$SRC/upstream/patches"
docker run --rm -v "$WORK/swe:/app" swe-engine:1.39.17 /bin/bash -c \
  ". /emsdk/emsdk_env.sh && cd /app && make js-es6"
cp "$WORK/swe/build/stellarium-web-engine.js" \
   "$WORK/swe/build/stellarium-web-engine.wasm" \
   "$WORK/swe/apps/web-frontend/src/assets/js/"
```

产物：`stellarium-web-engine.js` 104,014 B + `stellarium-web-engine.wasm` 1,199,284 B。

## 4. 安装前端依赖

```bash
docker run --rm -v "$WORK/swe/apps/web-frontend:/app" node:20-alpine \
  sh -c "cd /app && yarn install --frozen-lockfile"
```

## 5. 构建静态站点

```bash
docker run --rm \
  -v "$WORK/swe/apps/web-frontend:/app" \
  -v "$WORK/swe/apps/test-skydata:/skydata" \
  -e NODE_OPTIONS=--openssl-legacy-provider \
  node:20-alpine sh -c "cd /app && yarn build"
```

产物在 `$WORK/swe/apps/web-frontend/dist/`。`/skydata` 挂载对应 `vue.config.js` 里的 `from: '../skydata'`。

## 6. 本地运行

服务器脚本属于本交付包，不在上游仓库里：

```bash
node "$SRC/tools/serve.mjs" "$WORK/swe/apps/web-frontend/dist" 8899
# 浏览器打开 http://127.0.0.1:8899/
```

`tools/serve.mjs` 补了 `.wasm` 的 MIME（`application/wasm`）和 SPA 回退（路由是 history 模式）。
它是**本地验证工具**，只绑 loopback、没有认证，不要拿它对外提供服务（阶段 D 用正式静态服务）。

## 7. 装助手

```bash
node "$SRC/install/install.mjs" --host "$WORK/swe/apps/web-frontend/dist"
# 装完刷新页面即可；卸载用 --uninstall
```

安装器会先核对宿主身份（`install/known-hosts.json` 里的 `pristineIndexSha256` 与引擎 WASM 哈希）。
自己重新构建的宿主如果 `index.html` 与记录不一致，会以 `variant` 拒绝，需要显式加 `--allow-variant`。

---

## 踩到的坑（都不是"环境问题"，是上游真实状态）

### 坑 1：Windows 上 `core.autocrlf=true` 会让构建失败

Git for Windows 默认把文本文件转成 CRLF，`tools/make-assets.py` 的 shebang 变成 `#!/usr/bin/python3\r`，容器里执行时报
`FileNotFoundError: './tools/make-assets.py'`——看起来像文件不存在，实际是解释器路径带了 `\r`。
**必须在 checkout 前 `git config core.autocrlf false`**，或者在 Linux 上克隆。

### 坑 2：`Dockerfile.jsbuild` 已失效

```dockerfile
FROM emscripten/emsdk:1.39.17
RUN apt-get update && apt-get install -y wget build-essential apt-transport-https scons
```

基础镜像是 Debian 10 (buster)，其 apt 源已归档下线，`apt-get update` 返回 404：

```
E: The repository 'http://deb.debian.org/debian buster Release' does not have a Release file.
```

替代方案（`patches/Dockerfile.engine`）：不装 apt 包，改用 PyPI 的 scons 3.1.2，并补两个基础镜像的毛病：

1. pip 把包落在 `.../dist-packages/scons/SCons`，`import SCons` 找不到 → 建符号链接；
2. `scons` 启动脚本 shebang 是 `#!/usr/bin/env python`，在该镜像里指向 python2.7 → 改成 python3。

镜像本身已含 `python3 / make / gcc / g++ / git / wget / curl / emcc 1.39.17`，不需要再装别的。

### 坑 3：`package.json` 里 `"vue": "^3.0.0"` 是错的

`apps/web-frontend` 用的是 **Vue 2** 全家桶（vuetify 2.6、vue-router 3、vue-i18n 8、vue-template-compiler 2.6.12），但 `package.json` 声明 `vue ^3.0.0`（疑似 dependabot 误改）。`yarn.lock` 里同时存在：

```
vue@^2.6.11 → 2.6.12
vue@^3.0.0  → 3.0.0
```

按 lock 安装时 Vue 3 会被提升到 `node_modules/vue`，构建会报 Vue 版本不匹配。改成 `^2.6.11` 后命中 lock 里已有的 2.6.12，**`yarn.lock` 一个字节都不用改**。

### 坑 4：Node 版本不能照抄上游

上游 `Dockerfile` 用 `node:12.10.0-alpine`。实测直接失败：

```
error node-releases@2.0.54: The engine "node" is incompatible with this module. Expected version ">=18". Got "12.10.0"
```

因为 lock 里的 `browserslist@4.28.8` / `node-releases@2.0.54` 是新版本。改用 `node:20-alpine` 后安装正常，构建时需要 `NODE_OPTIONS=--openssl-legacy-provider`（webpack 4 用 md4）。

**结论：上游"锁版本"只是源码层面的，依赖树已经漂移到需要 Node 18+。** 我们用 `yarn.lock` 锁定实际依赖版本，用 Node 20 构建，两者都写进 `LOCK.md`。

---

## 关于体积（对照 `体积核查.md`）

| 对象 | 实测 |
|---|---|
| 引擎 JS + WASM | 104,014 + 1,199,284 = 1.30 MB |
| 前端 dist（含 `apps/test-skydata` 示例数据、含 sourcemap） | 16,436,491 B / 345 文件 |
| 其中 `dist/skydata` | 4.2 MB |
| 其中 `*.js.map` | 约 5 MB |
| 中文语言包对 `app.js` 的影响 | +2,518 B（164,508 → 167,026） |
| 宿主补丁增量 | `index.html` +142 字节 |

构建产物文件名会随内容变化：本版是 `js/app.a08a3202.js` + `js/chunk-vendors.626b629f.js`，
`index.html` 的 sha256 为 `4e4f836b8304a2215e8cd6b1903d5a0b7b0c6b64532703092e75c9294535d848`。
这个哈希写在 `source/install/known-hosts.json` 里；你自己重建后如果对不上，安装器会
以 `variant` 拒绝，需要显式 `--allow-variant`。

`体积核查.md` 记录的官网三文件 3.83 MB 里 WASM 是 1.92 MB，我们自建的是 1.20 MB，说明**官网产物与我们构建的源码版本并不等价**，不能互相替代——这也印证了任务书"不得拿官网产物冒充可复现构建"的要求。
