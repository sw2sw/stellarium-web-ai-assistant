# 上游锁定清单

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/Stellarium/stellarium-web-engine |
| commit | `1162c9ef73cc94f4762dfbfd24c637190119ea93` |
| commit 日期 | 2026-10-20 |
| commit 标题 | Bump launch-editor from 2.2.1 to 2.14.2 in /apps/web-frontend |
| 许可 | AGPL-3.0（`LICENSE-AGPL-3.0.txt`），上游另提供商业许可 |
| 复用的子目录 | `apps/web-frontend`（Web 界面 + 插件生命周期），`src/`（引擎 C 源码） |
| 未使用 | `apps/simple-html`、`apps/test-skydata` 之外的示例、桌面端、`tools/` 里的文档生成 |

## 为什么是这个 commit

2026-10-30 查询时它同时是 `refs/heads/master` 与 `HEAD`，与 `体积核查.md` 记录的公开基线一致。选 HEAD 而不是更早的 tag，是因为上游没有为 Web 前端发版本号，只有 commit 可追溯。

## 依赖锁定

| 层 | 锁定方式 |
|---|---|
| C 引擎 | commit SHA + `SConstruct` |
| Emscripten | `emscripten/emsdk:1.39.17`（上游 Dockerfile 指定） |
| 前端 JS 依赖 | `apps/web-frontend/yarn.lock`（445 KB，`--frozen-lockfile` 安装） |
| Node | 20-alpine（上游写 12.10.0，已失效，见 `UPSTREAM-BUILD.md` 坑 4） |
| scons | 3.1.2（PyPI，上游写 apt 装，源已 404） |

`yarn.lock` 未做任何修改。

## 上游改动清单（三份源码补丁 + 构建环境替代）

1. `apps/web-frontend/package.json`：`"vue": "^3.0.0"` → `"^2.6.11"`（`patches/0001-web-frontend-vue2.patch`）
2. `apps/web-frontend/src/main.js` 与新增 `src/locales/zh.json`：宿主双语与语言钩子（`patches/0002-web-frontend-zh-locale.patch`）。
3. `apps/web-frontend/public/index.html`：删除 Google Fonts 外链（`patches/0003-local-fonts.patch`），使用原有本地字体；锁定模板 apply 检查成功，本次未重建。
4. 构建镜像：上游 `Dockerfile.jsbuild` 改为 `patches/Dockerfile.engine`（不改上游文件，另存一份）

除上述文件外没有新增上游修改；引擎 C/WASM 不变。运行包的字体首页覆盖与重建模板补丁分开记账。

## 许可证义务提醒

宿主为 AGPL-3.0。本项目通过注入脚本 + 独立助手资源与之组合，**不改变宿主自身的 AGPL 义务**。若要分发整合包，需同时提供宿主对应源码与上述三补丁及构建说明。commit 是获取指定位，不等于源码已交付；具体获取路线及尚未闭合项见 `../../release/SOURCE-ACCESS.md`。

助手自身代码沿用 AGPL-3.0-or-later（与宿主一致，避免混许可带来的合规判断成本）。
