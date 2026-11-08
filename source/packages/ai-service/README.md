# ai-service

站点同源的服务器 AI 网关：把"浏览器里的模型调用"换成"服务端一次受控的付费调用"。

- 浏览器只发 `{messages}`，模型名、上游地址、厂商密钥都在服务端。
- 未配置即关闭：`/api/ai/config` 报 `available:false`，面板显示"本站尚未提供"。
- 额度按**口令**记账、落盘，重启/换 cookie/重新登录都不清零。
- 上游超时、失败、中断都不重试；只有"确定没生成"才退额度。

完整说明：`source/docs/SERVER-AI.md`。配置示例：`examples/`。

```bash
# 最短路径（本机 Ollama，无 Key）
export SWE_AI_ALLOWED_HOSTS=127.0.0.1:11434
export SWE_ACCESS_TOKENS=class-demo
export SWE_ADMIN_TOKENS=admin-demo
export SWE_DATA_DIR=/tmp/swe-ai
node server.mjs
# 管理页 http://127.0.0.1:8080/admin
```

```bash
# 只用回环地址自测，不碰任何真实模型
node ../../tests/service/run.mjs
```

文件：

| 文件 | 作用 |
| --- | --- |
| `server.mjs` | 路由、鉴权、额度预留/结算、静态托管、管理页 |
| `lib/config.mjs` | 启动配置（env）、运行配置（config.json）、白名单、密钥文件 |
| `lib/auth.mjs` | 课堂/管理两类口令、cookie、身份 HMAC |
| `lib/origin.mjs` | Origin 三元组与可信反代 |
| `lib/store.mjs` | 持久额度台账（node:sqlite / JSON 双后端） |
| `lib/upstream.mjs` | 上游调用、三段超时、退款判定 |
| `lib/limits.mjs` | 内存并发限制（与持久额度是两件事） |
| `lib/session.mjs` | 会话 id，仅用于日志关联 |
| `lib/admin.mjs` | `/api/admin/*`：配置、检查连接、生成测试、额度、紧急停用 |
| `lib/static.mjs` | 同源静态托管（站点目录 + SPA 回退） |
| `lib/http.mjs` | JSON 响应、请求体读取、安全响应头 |
| `public/admin.html` | 自包含管理页（CSP `default-src 'none'`） |
