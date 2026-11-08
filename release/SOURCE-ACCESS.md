# 对应源码获取路线与确切缺口

## 已有路线（不是新建完整上游审计）

- 上游锁定网页：https://github.com/Stellarium/stellarium-web-engine/tree/1162c9ef73cc94f4762dfbfd24c637190119ea93
- 既有 git 路线：`git clone --no-checkout https://github.com/Stellarium/stellarium-web-engine.git`，关闭 autocrlf 后检出完整 SHA `1162c9ef73cc94f4762dfbfd24c637190119ea93`。
- 同 SHA 源码下载入口：https://github.com/Stellarium/stellarium-web-engine/archive/1162c9ef73cc94f4762dfbfd24c637190119ea93.tar.gz
- 本项目源码、三补丁、Dockerfile.engine、LOCK、安装与构建步骤在 project-source 包内。
- 使用 `source/docs/UPSTREAM-BUILD.md` 的锁定版本与前两补丁构建，第三补丁用于以后重建时移除外链；现有运行首页是等价覆盖，未重新构建。

这些 URL 是确切版本的已有获取路线；本轮不下载完整上游，不声称已离线校验下载件或重跑构建。

## 尚未闭合（保持 complete=false）

1. project-source 不含完整上游树，尤其 `apps/web-frontend`（含 yarn.lock）、`src`、`apps/test-skydata` 及所需根构建文件。只有下载单个 public/index.html 来验证 0003，不是完整源码包。
2. 尚未为网站实际使用者落实并读回验证可获取匹配项目源码/三补丁的入口。私有 Gitea 成员权限不等于所有网站使用者都能获取；仅指向上游也不包含本项目修改。
3. 运行附件正式提供前，应确认上述获取路径、补丁、构建材料与许可文本构成匹配且可用的对应源码提供方式；若选离线附件，需取得锁定树、校验并加入所需构建材料。不能仅因写了 URL 或附加法律措辞就把 complete 翻成 true。

既有 THIRD-PARTY.md 的依赖许可导出与示例 skydata 归属未决项保留原有公开发布边界，不扩大成本次私有源码同步的无限上游审计。此文不宣称完整许可审计或法律合规结论。
