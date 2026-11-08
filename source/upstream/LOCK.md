# 上游版本与构建材料

| 项目 | 固定值或范围 |
|---|---|
| 上游仓库 | https://github.com/Stellarium/stellarium-web-engine |
| 源码提交 | `1162c9ef73cc94f4762dfbfd24c637190119ea93` |
| 上游许可 | AGPL-3.0；上游另提供商业许可 |
| 宿主前端 | `apps/web-frontend` |
| 引擎源码 | `src/` 及所需根构建文件 |
| 示例数据 | `apps/test-skydata` |
| Emscripten | `emscripten/emsdk:1.39.17` |
| SCons | `3.1.2`，见 `patches/Dockerfile.engine` |
| 前端构建环境 | 参考命令使用 `node:20-alpine` |

固定提交用于明确适配目标，不表示它是上游最新版本。镜像标签不是不可变摘要，也不是对完整构建环境的锁定。

## 本仓库包含的宿主修改

1. `patches/0001-web-frontend-vue2.patch`：调整 `package.json` 的 Vue 版本范围为 `^2.6.11`。
2. `patches/0002-web-frontend-zh-locale.patch`：添加中文界面与语言切换钩子。
3. `patches/0003-local-fonts.patch`：移除首页 Google Fonts 外链，使用已有本地字体。
4. `patches/Dockerfile.engine`：引擎构建镜像配方，通过 PyPI 提供 SCons。

三份源码补丁不修改引擎 C 源码。字体补丁改变首页模板；仅成功应用补丁不等于已验证整个站点的重建结果。

## 构建材料范围

本仓库未包含完整上游树、对应前端 `yarn.lock` 和完整星图数据。取得源码提交后，仍需确认依赖锁、数据和构建工具与目标宿主匹配；不能把新解析的依赖视作已登记构建的等价依赖。

构建参考命令见[UPSTREAM-BUILD.md](../docs/UPSTREAM-BUILD.md)。目前不承诺完整三补丁组合的端到端可复现构建，也不以此文件代替完整对应源码交付。

## 许可与源码提供

本项目源码采用 AGPL-3.0-or-later，保留宿主自身的许可义务。网络提供服务或分发整合运行包时，应评估适用的对应源码提供要求；私有仓库权限本身不能保证所有网站用户可获得匹配源码。

已有材料与尚缺材料见[对应源码范围](../../release/SOURCE-ACCESS.md)，第三方组件与数据边界见[THIRD-PARTY.md](../../THIRD-PARTY.md)。
