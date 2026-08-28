# dsh-codebuddy

CodeBuddy（腾讯云账号）provider for DeepSeek Harness —— 复用本机 CodeBuddy 客户端
**web auth 一次授权**产生的账号会话，让 CodeBuddy 订阅内的模型（混元 / DeepSeek /
Kimi / GLM / MiniMax）出现在 DSH 模型选择器里。

本项目结构对标 [dsh-opencode-zen](https://github.com/guowenzheng941117/dsh-opencode-zen)：
同样是 `ctx.llm.registerAdapter` 注册的流式 LLM provider，区别在认证——
zen 用 API key，本插件用**账号会话 JWT**。

## 认证原理（逆向自 `@tencent-ai/codebuddy-code` 2.137.1）

你日常 `codebuddy`（TUI）只需授权一次，是因为登录拿到的是 Keycloak JWT
（`iss=https://www.codebuddy.cn/auth/realms/copilot`，60 天有效、90 天刷新窗口），
持久化在：

```
win32 : %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\<authId>.info
darwin: ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/<authId>.info
linux : ~/.local/share/CodeBuddyExtension/Data/Public/auth/<authId>.info
```

默认 `<authId> = Tencent-Cloud.coding-copilot`（CLI/TUI 会话）；
WorkBuddy 桌面宿主对应 `workbuddy-desktop`。

CodeBuddy 官方客户端内部就是一个 axios 拦截器，给每个后端请求注入
`Authorization: Bearer <accessToken>` + `X-User-Id` 等；本插件做的是同一件事。

## 使用

1. 先用官方客户端登录一次（任意方式均可）：`codebuddy` → web auth。
2. 安装本插件到 dsh（或直接把目录放进插件目录），重启 dsh web。
3. 模型选择器里出现 `codebuddy` provider，直接选模型即可。

### 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `DSH_CODEBUDDY_AUTH_ID` | 会话文件 `<authId>.info` 的 id | `Tencent-Cloud.coding-copilot` |
| `DSH_CODEBUDDY_BASE` | 上游网关 | `https://copilot.tencent.com` |
| `DSH_CODEBUDDY_ACCESS_TOKEN` | 手工注入 accessToken，绕开会话文件 | - |
| `DSH_CODEBUDDY_USER_ID` / `DSH_CODEBUDDY_DOMAIN` | 配合手工 token 使用 | - |
| `DSH_CODEBUDDY_REFRESH_TOKEN` / `DSH_CODEBUDDY_EXPIRES_AT` | 手工 token 也想自动续期时用 | - |
| `DSH_CODEBUDDY_PREFIX_PATH` | 刷新接口前缀 | `/plugin` |

## Token 续期策略

- 距过期 < 5 分钟才动：先**重读会话文件**（官方客户端可能已经刷新过），仍过期才自己刷：
  `POST {base}/v2/plugin/auth/token/refresh`，头带 `X-Refresh-Token` +
  `X-Auth-Refresh-Source: plugin`（与官方源码 `refreshSession()` 完全一致）。
- 刷新结果**只存内存、不回写文件**——官方 TUI/IDE/WorkBuddy 都在读写同一个文件，
  并发写会互相覆盖；官方进程下次会自行刷新落盘。
- 请求遇到 401 会自动失效缓存、重读文件重试一次（处理"别的进程刚换过 token"的竞态）。

## 模型清单

`models.json` 外置可编辑（格式与 zen 一致）：`id` / `name` / `contextWindow` /
`reasoningEfforts`（null = 不发该字段）/ `input`（含 `"image"` 且模型支持视觉时
走原生多模态 `image_url`）。上下文窗口为估值，按你的订阅实际能力修改。

默认收录（来自 CodeBuddy CLI 的模型目录）：
`hy3`、`deepseek-v4-pro`、`deepseek-v4-flash`、`kimi-k3-1`、`kimi-k2.7`、`kimi-k2.6`、
`glm-5.3`、`glm-5.2`、`glm-5.1`、`glm-5v-turbo`（视觉）、`minimax-m3`、`minimax-m2.7`。

## 稳定性

沿用 dsh-opencode-zen 的恢复矩阵（参数按付费网关放宽）：流空闲看门狗 60s、
429/5xx 指数退避、空流重试、半截断流自动续跑、工具参数残缺隔离。

日志：`<tmpdir>/dsh-codebuddy.log`。

## 已知限制与注意事项

1. **会话文件是当前明文**：官方存在 at-rest 加密机制（32 字节对称密钥，宿主注入），
   未注入时降级明文。一旦官方启用，本插件读取会报可读错误——届时改用
   `DSH_CODEBUDDY_ACCESS_TOKEN` 手工注入，或改走 `codebuddy --serve` 网关。
2. **账号级凭据**：accessToken 等价用户完整权限，勿外传、勿提交仓库。
3. **多进程共享**：不要手动编辑会话文件；本插件只读不写。
4. 请确保你的使用方式符合 CodeBuddy 服务条款。

## 实测记录（2026-08-28）

- `GET /v2/plugin/accounts` 带 Bearer → 200（无凭据 401）
- `POST /v2/chat/completions`（hy3，stream）→ 200，OpenAI 兼容 SSE
  （`delta.content` / `reasoning_content` / `tool_calls` / `[DONE]`）
- `stream_options` / `tools` / `reasoning_effort` 字段网关均接受
