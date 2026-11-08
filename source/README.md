# 可编辑源码

助手0.14.0，桥接0.11.0，协议2。组件版本以各自manifest及源码常量为准，工作区package.json不是组件版本。

- `packages/assistant-web/`：无构建步骤的JS/CSS、讲解、交流与推荐。
- `packages/host-adapter/`：宿主引擎桥接。
- `packages/ai-service/`：可选的同源服务器AI、认证、管理和额度控制。
- `install/`：宿主指纹识别和安装/更新/卸载。
- `upstream/`：锁定信息、三份宿主补丁和构建配方。
- `tests/`：纯逻辑、假上游服务和浏览器回归测试。

AI生成内容仅供参考，可能存在错误。模型文本不是引擎事实；请求返回成功不表示动作已执行，动作须经确认并读取引擎状态验证。

## 测试入口

以下命令从`source/`目录运行。浏览器测试需要自行准备`playwright-core`和实际Chrome，宿主运行目录不随源码提交。

```bash
node tests/reference/consistency.mjs
node tests/interaction/run.mjs
node tests/service/run.mjs
node tests/serve/paths.mjs
node tests/installer/safety.mjs
```

需要宿主站点的测试应使用独立可写的QA副本。支持环境变量的套件可指定`DIST_DIR`与`CHROME_PATH`；各浏览器脚本的具体参数以文件开头说明为准。不要在生产数据目录或冻结交付上运行会写入截图、安装状态和测试数据的套件。

安装、构建、交互和服务端设置分别见`docs/INSTALL.md`、`docs/UPSTREAM-BUILD.md`、`docs/INTERACTION.md`及`docs/SERVER-AI.md`。源码范围与第三方许可边界见仓库根README和`release/SOURCE-ACCESS.md`。
