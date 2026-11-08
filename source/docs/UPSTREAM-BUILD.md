# 构建 Stellarium Web 宿主

本文介绍锁定上游版本的构建材料、补丁和参考命令。助手本身是独立的 JS/CSS 资源，不需要重新编译；安装到已有站点请直接阅读[安装指南](INSTALL.md)。

> **构建范围**：本仓库不包含完整上游树、对应前端依赖锁文件或完整星图数据，也不分发整站运行包。下面的命令不是已验证的端到端可复现构建承诺；执行前须取得匹配的依赖锁和构建数据。完整三补丁组合的重建产物尚未完成复现验证。详见[对应源码范围](../../release/SOURCE-ACCESS.md)。

## 1. 版本与前提

- 上游：https://github.com/Stellarium/stellarium-web-engine
- 固定提交：`1162c9ef73cc94f4762dfbfd24c637190119ea93`
- 版本与补丁索引：[upstream/LOCK.md](../upstream/LOCK.md)
- 工具：Git、Docker（或能够执行相同镜像与挂载命令的容器环境）、Node.js。
- 需要联网取得上游、容器镜像和构建依赖；本流程不是离线构建方案。
- 示例镜像按版本标签引用，未固定镜像摘要；仅固定源码提交不足以保证产物逐字节一致。

以下命令在 Bash 或兼容环境中执行。将两个路径替换为实际的绝对路径，工作目录应为空：

```bash
SRC=/absolute/path/to/stellarium-web-ai-assistant/source
WORK=/absolute/path/to/empty-workdir
mkdir -p "$WORK"
```

## 2. 获取固定版本

```bash
cd "$WORK"
git clone --no-checkout https://github.com/Stellarium/stellarium-web-engine.git swe
cd "$WORK/swe"
git config core.autocrlf false
git checkout --detach 1162c9ef73cc94f4762dfbfd24c637190119ea93
git rev-parse HEAD
```

关闭自动换行转换可避免 Windows 检出时把容器内脚本的 shebang 改成 CRLF。

## 3. 应用宿主补丁

按顺序检查并应用：

```bash
cd "$WORK/swe"
git apply --check "$SRC/upstream/patches/0001-web-frontend-vue2.patch"
git apply "$SRC/upstream/patches/0001-web-frontend-vue2.patch"
git apply --check "$SRC/upstream/patches/0002-web-frontend-zh-locale.patch"
git apply "$SRC/upstream/patches/0002-web-frontend-zh-locale.patch"
git apply --check "$SRC/upstream/patches/0003-local-fonts.patch"
git apply "$SRC/upstream/patches/0003-local-fonts.patch"
git status --short
```

| 补丁 | 作用 |
|---|---|
| `0001-web-frontend-vue2.patch` | 将 Vue 版本范围调整为与 Vue 2 前端组件兼容的范围。 |
| `0002-web-frontend-zh-locale.patch` | 添加中文界面与语言切换钩子，不修改引擎天体名称数据。 |
| `0003-local-fonts.patch` | 移除首页 Google Fonts 外链，使用宿主已有本地字体。 |

补丁文件位于本仓库，不在克隆出的上游目录。应用成功只说明补丁上下文匹配，不代表后续编译或运行验证已经完成。

## 4. 编译 WASM 引擎

构建配方使用 Emscripten 1.39.17，并通过 PyPI 安装 SCons 3.1.2，避免依赖旧 Debian 镜像已归档的 apt 源。

```bash
cd "$WORK/swe"
docker build -f "$SRC/upstream/patches/Dockerfile.engine"   -t swe-engine:1.39.17 "$SRC/upstream/patches"
docker run --rm -v "$WORK/swe:/app" swe-engine:1.39.17 /bin/bash -c   ". /emsdk/emsdk_env.sh && cd /app && make js-es6"
cp "$WORK/swe/build/stellarium-web-engine.js"    "$WORK/swe/build/stellarium-web-engine.wasm"    "$WORK/swe/apps/web-frontend/src/assets/js/"
```

## 5. 安装依赖并构建前端

先确认 `apps/web-frontend/yarn.lock` 存在，且对应所需的依赖版本。**本仓库没有附带用于生成已登记宿主的完整依赖锁材料，不能用新解析的依赖树冒充同一构建。**

以下命令以 Node 20 Alpine 镜像为参考环境。Vue 2 与相关组件需要使用相互兼容的版本；Webpack 4 在该环境下使用 `--openssl-legacy-provider`。

```bash
test -f "$WORK/swe/apps/web-frontend/yarn.lock"
docker run --rm -v "$WORK/swe/apps/web-frontend:/app" node:20-alpine   sh -c "cd /app && yarn install --frozen-lockfile"
docker run --rm   -v "$WORK/swe/apps/web-frontend:/app"   -v "$WORK/swe/apps/test-skydata:/skydata"   -e NODE_OPTIONS=--openssl-legacy-provider   node:20-alpine sh -c "cd /app && yarn build"
```

参考数据目录为 `apps/test-skydata`，应包含前端构建所需的资源。其完整来源和逐数据集许可仍须在分发前核对，见[第三方说明](../../THIRD-PARTY.md)。

静态站点输出目录为 `$WORK/swe/apps/web-frontend/dist/`。文件名、体积与哈希应以实际产物为准，不应套用其他构建的数值。

## 6. 本地预览

```bash
node "$SRC/tools/serve.mjs" "$WORK/swe/apps/web-frontend/dist" 8899
```

浏览器打开 `http://127.0.0.1:8899/`。该工具提供 WASM MIME 和单页路由回退，只监听本机回环地址；它没有认证和 TLS，不用于对外部署。

## 7. 安装助手与核对宿主

先执行只读检查：

```bash
node "$SRC/install/install.mjs" --host "$WORK/swe/apps/web-frontend/dist" --check
```

通过后再安装：

```bash
node "$SRC/install/install.mjs" --host "$WORK/swe/apps/web-frontend/dist"
```

安装器根据[已登记宿主指纹](../install/known-hosts.json)检查首页、引擎和资源。重新构建或应用字体补丁后，首页可能与登记值不同；收到 `variant` 时应先比对差异，确认兼容后才显式使用 `--allow-variant`。无法识别的宿主不能仅靠放宽开关认定兼容。

安装和更新的权限、备份与失败恢复规则见[安装指南](INSTALL.md)。对外提供服务或分发运行包前，还需处理[对应源码与许可义务](../../release/SOURCE-ACCESS.md)。
