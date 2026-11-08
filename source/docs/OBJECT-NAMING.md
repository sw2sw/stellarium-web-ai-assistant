# 天体名称与查询语法

`select_object` 的 `name` 需要能解析为星图数据中的天体 designation。直接查询引擎与调用助手桥接的名称转换是不同路径；更换宿主或星图数据后，应重新核对名称是否存在。

## 直接引擎查询

锁定宿主的 `getObj()` 按完整 designation 查找，不提供任意名称的模糊搜索。大小写通常不影响匹配，但前缀和空格有意义。

| 类别 | 名称示例 |
|---|---|
| 行星、太阳和月球 | `NAME Jupiter`、`NAME Moon`、`NAME Sun` |
| 恒星 | `Sirius`、`Vega`、`* alf Ori` |
| 深空天体 | `M 31`、`M 42`、`NGC 7000`、`NAME Pleiades` |
| 西方星座文化对象 | `CON western Ori`、`CON western UMa` |

`M42` 不能作为直接引擎查询中 `M 42` 的等价写法。行星的 `NAME ` 前缀也不能机械地套到所有恒星上；星座的 `western` 前缀取决于所加载的星座文化数据。

designation、显示名称和对象 `id` 不一定相同。确认命中应检查对象的 designation 或桥接的解析读回，而不是只比较显示文本。

## 桥接的名称归一化

`packages/host-adapter/loader.js` 中的名称处理会折叠空白、处理内置中文和英文别名、尝试标准前缀，并为部分目录编号补空格。例如，`木星` 可对应 `NAME Jupiter`，`M42` 可规范化为 `M 42`。

内置别名覆盖常用星座、日月行星、部分亮星和深空目标，不是通用天体知识库或完备消歧服务。任意中文俗名、方言名称或未加载的数据目标都可能无法解析。

成功时检查 `readback.resolvedAs`。失败时应保留 `object_not_found` 及查询诊断，不把模型猜测当成成功命中。

## 随包提供的名称参考

`packages/assistant-web/naming-reference.js` 与助手一起安装，提供名称语法、别名表、常见纠正和提示参考。它可用于构造请求和本地检查，但语法形态正确仍不保证相应目标存在于当前数据中。

```js
// 已安装助手的页面中，参考资源可能尚未加载，先检查是否存在。
const ref = window.SWE_NAMING_REFERENCE
if (ref) {
  console.log(ref.toPrompt('zh', { level: 'compact' }))
  console.log(ref.toJSON())
  console.log(ref.toMarkdown('zh'))
}

// 桥接可提供纯数据形式；参考资源不可用时可能返回 null。
const data = window.__SWE_AI_BRIDGE__?.namingReference()
```

提示参考支持 `compact` 和 `full` 档位。应根据实际模型和上下文预算选择，不能承诺某个档位让模型零错误。

## 在自己的站点核对

在已安装助手的测试站点中，先通过[能力参考](API-CAPABILITIES.md)检查桥接就绪状态。直接读取引擎可用于比较名称形态；需要执行 `select_object` 时，应先预检并获得用户确认，因为该命令会改变当前选中对象及可能的视图。

只读批量查询可使用支持该功能的 `bridge.queryBodies()`，并检查单项的 `found`、`query` 和实际读数。不要因为对象 `id` 与查询串不同就丢弃有效结果，也不要用外置标签覆盖引擎身份。

相关回归入口为 `tests/reference/consistency.mjs` 和 `tests/e2e/client.mjs`。浏览器套件需要独立宿主副本与实际浏览器依赖；参数见[源码导航](../README.md)和对应脚本说明。
