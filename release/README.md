# 本地打包与源码范围

这些工具只处理本地、已核实的源码和运行副本，不联网、不重建宿主、不调用模型，也不执行部署。

## 构建独立助手包

从仓库根目录执行；输出目录必须是专用目录，工具会重建它：

```bash
node release/build-assistant-package.mjs /path/to/assistant
```

资源集合由manifest的`entry`、`style`和`references`决定，另包含桥接loader及许可说明。运行目录中的manifest会由安装器加入`assetQuery`等信息，不要求与源manifest逐字节相同；其组件版本和声明资源必须一致。

## 生成与验证附件

```bash
node release/package-assets.mjs --repo . --dist /path/to/runtime/dist --pkg /path/to/assistant --out /path/to/assets --version 0.14.0 --loader 0.11.0 --upstream 1162c9ef73cc94f4762dfbfd24c637190119ea93 --only assistant,source
node release/check-archive.mjs --assets /path/to/assets --out /path/to/checks --baseline /path/to/BASELINE.json
node release/check-exclusions.mjs --repo . --dist /path/to/runtime/dist --pkg /path/to/assistant --out /path/to/checks
```

`--git-commit`可绑定真实完整40位提交SHA；尚未提交时保持空，不填写占位SHA。`BASELINE.json`用于可选基线对比，不提供时对应检查会明确跳过。`SHA256SUMS`覆盖所生成附件及发布manifest，不包含自身。

源码归档采用明确白名单并排除凭据、依赖、运行状态和原始内部证据。启发式检查不是无泄漏保证：上传前仍须复核最终待提交树、实际附件及所发布的Git历史。

## 发布限制

- `project-source`包含本项目可编辑材料，**不是完整对应源码交付**；范围必须保持`source_scope.complete=false`，确切获取路线和缺口见[SOURCE-ACCESS.md](SOURCE-ACCESS.md)。
- 当前发布默认仅准备assistant与project-source，不上传整站runtime；只有在对应源码获取和第三方素材权利边界闭合后，才另行评估运行附件发行。
- 不把历史仓库直接镜像到新的发布仓库；新仓采用经复核的当前树，并保留许可和合法版权归属。
- 推送、合并及创建Release均应核对目标仓库、可见性和自动部署触发器；本地打包不代表已经上传或发布。
