# 对应源码获取与范围

本仓库提供助手、桥接、可选 AI 服务、安装器、测试、构建说明及三份宿主补丁；**不包含完整上游树，不是完整对应源码交付，也不分发整站运行包**。

## 上游获取入口

- [固定提交的源码树](https://github.com/Stellarium/stellarium-web-engine/tree/1162c9ef73cc94f4762dfbfd24c637190119ea93)
- [固定提交的源码归档](https://github.com/Stellarium/stellarium-web-engine/archive/1162c9ef73cc94f4762dfbfd24c637190119ea93.tar.gz)
- [版本与补丁索引](../source/upstream/LOCK.md)
- [构建参考步骤](../source/docs/UPSTREAM-BUILD.md)

Git 获取方式：

```bash
git clone --no-checkout https://github.com/Stellarium/stellarium-web-engine.git
git -C stellarium-web-engine config core.autocrlf false
git -C stellarium-web-engine checkout --detach 1162c9ef73cc94f4762dfbfd24c637190119ea93
```

这些地址明确了上游版本，不表示源码归档已作为本项目附件提供，也不构成对下载可用性或端到端构建可复现性的保证。

## 尚需补齐的材料与验证

1. 完整上游树，包括 `apps/web-frontend`、对应 `yarn.lock`、`src`、所需根构建文件和 `apps/test-skydata` 等数据材料。
2. 完整三补丁组合的重建验证，以及构建所需依赖、镜像和数据与目标运行产物的匹配关系。
3. 面向实际网站用户、可获取匹配项目源码及宿主修改的途径。仅指向上游不包含本项目修改；私有源码仓库也不能代替所有用户均可访问的源码入口。
4. 第三方依赖许可清单、示例数据来源及必要署名，详见[第三方说明](../THIRD-PARTY.md)。

在这些材料与源码提供方式落实之前，归档清单中的 `source_scope.complete` 保持 `false`。不得仅因附上链接、许可文本或三份补丁，就将项目源码包描述成完整对应源码。

对外分发运行产物或提供网络服务前，应结合实际提供方式核对适用许可义务。本文说明材料范围，不是完整许可审计或法律意见。
