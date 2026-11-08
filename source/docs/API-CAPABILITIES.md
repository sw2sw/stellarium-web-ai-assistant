# 桥接接口与能力参考

本文面向接入助手桥接的开发者。桥接实现位于 `packages/host-adapter/loader.js`，当前协议为2；组件版本和可用功能应通过运行时接口读取，不依赖旧测试数量或构建体积。

## 获取桥接与探测能力

在已安装助手的星图页面中：

```js
const bridge = window.__SWE_AI_BRIDGE__
if (!bridge) throw new Error('助手桥接未加载')
await bridge.ready
console.log(bridge.getCapabilities())
```

`getCapabilities()` 返回协议版本、加载器版本、命令白名单、图层白名单、结果状态与功能标记。调用前还应检查 `isEngineReady()`；桥接加载完成不等于后续所有操作都能成功。

## 状态、快照与订阅

| 接口 | 用途 |
|---|---|
| `readState()` | 读取软件当前时间、地点、视场、选中天体与图层。 |
| `captureSnapshot()` | 冻结一份用于讲解和上下文绑定的状态。 |
| `isCurrentSnapshot(id)` | 检查快照计数标识是否仍是最新值。 |
| `isSnapshotCurrent(snapshot)` | 根据实际状态变化判断快照是否仍适用。 |
| `subscribeSelection(callback)` | 订阅选中变化。 |
| `subscribeState(callback)` | 订阅可观测状态变化。 |
| `queryBodies(designations)` | 有界、只读批量查询天体，不改变时间、选中或视图。 |

运行中的模拟时钟可能使严格快照编号很快变化；判断讲解是否过期应区分编号相同与状态实质未变。讲解文本不应覆盖为后来变化的读数。

`queryBodies()` 的上限从 `getCapabilities().features.bodyQueryMax` 读取。返回值含 `at`、`queried`、`returned` 和 `bodies`；单项可能未找到或缺少部分数值。不要把缺失距离、星等或相位当成零，也不要凭模型补出引擎未提供的数据。

## 命令预检与执行

```js
const command = { type: 'set_fov', deg: 5 }
const check = bridge.validateCommand(command)
// 预检不读写引擎；实际执行前仍需完成用户确认及上下文检查。
if (!check.ok) console.error(check.error)
```

支持的命令以 `getCapabilities().commands` 为准，包含读取状态、选择天体、视场、时间、地点、图层与时间倍率控制。校验器拒绝未知命令、额外字段、错误类型与超范围数值。

`executeCommand(command)` 返回异步结果。必须同时检查 `ok`、`status`、`readback` 与错误字段：

- `applied`：命令已按实现的终态判据完成读回。
- `timeout`：命令已发出，但未在等待期限内到达目标；不能报告为完成。
- `failed`：命令被拒绝或执行失败，应保留错误原因。

预检通过不保证目标存在、引擎仍可用或执行时上下文未变化；模型说“已定位”也不是执行回执。批量控制应先完成整批预检，再由用户确认执行。

时间倍率与模拟时长的语义见[时间控制](TIME-CONTROL.md)，天体 designation 和中文别名处理见[名称参考](OBJECT-NAMING.md)。

## 名称参考资源

`window.SWE_NAMING_REFERENCE` 提供名称语法、别名表及 `toPrompt()`、`toJSON()`、`toMarkdown()`。桥接的 `namingReference()` 返回其纯数据形式；参考资源未加载时可能返回 `null`。

直接调用引擎的 `getObj()` 与通过桥接解析名称不是同一接口。桥接可以规范化部分目录号与内置别名，但不提供任意名称的通用模糊搜索或完备消歧。

## 宿主语言钩子

`window.__SWE_SET_LANG__(lang)` 由宿主语言补丁添加，不是上游原生接口。语言选择顺序为 URL 的 `lang` 参数、`localStorage['swe.uiLang']`、默认中文；不按系统语言自动切换。

该钩子调整宿主界面，不代表星表、星座文化数据和天体名称全部翻译。缺少钩子的宿主不能仅凭助手语言变化认定宿主已切换。

## AI功能与引擎能力的区别

客户端支持配置 OpenAI 兼容端点，可选同源服务提供认证、管理及额度控制。具体配置见[服务器AI](SERVER-AI.md)。讲解、多轮交流和推荐的行为见[交互指南](INTERACTION.md)。

AI生成内容仅供参考，可能存在事实错误、空回复或其他提供商错误。网络请求成功不保证科学内容准确；交流不会因此获得任意控制权限。

## 适配限制

- `features.clickToSelect` 为 `false` 时，不提供点击画布拾取天体的桥接能力。
- 适配依赖锁定宿主和加载的数据；上游升级后须重新核对接口与宿主指纹。
- 深空天体的距离、半径等元数据可能缺失，目录覆盖也不等于完整天文知识库。
- 同源脚本不是安全沙箱；桥接白名单约束的是助手命令，不隔离页面内其他脚本。

构建与源码范围分别见[宿主构建](UPSTREAM-BUILD.md)和[对应源码范围](../../release/SOURCE-ACCESS.md)。
