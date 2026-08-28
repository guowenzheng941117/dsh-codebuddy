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
持久化目录随系统自动定位（linux 还兼容 `XDG_DATA_HOME`）：

```
win32 : %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\
darwin: ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/
linux : ~/.local/share/CodeBuddyExtension/Data/Public/auth/
```

**自动发现（无需配置）**：插件扫描目录里全部 `*.info` 会话（每个宿主一个，如
`Tencent-Cloud.coding-copilot`=CLI/TUI、`workbuddy-desktop`=WorkBuddy 桌面），
按健康度自动择优——未过期优先于仅可刷新，同级取剩余有效期长者；损坏/加密文件自动跳过。
只有显式设置 `DSH_CODEBUDDY_AUTH_ID` 才锁定单一文件。换系统、换宿主、多会话并存都零配置。

CodeBuddy 官方客户端内部就是一个 axios 拦截器，给每个后端请求注入
`Authorization: Bearer <accessToken>` + `X-User-Id` 等；本插件做的是同一件事。

## 使用

1. 先用官方客户端登录一次（任意方式均可）：`codebuddy` → web auth。
2. 安装本插件到 dsh（或直接把目录放进插件目录），重启 dsh web。
3. 模型选择器里出现 `codebuddy` provider，直接选模型即可。

### 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `DSH_CODEBUDDY_AUTH_ID` | 可选：锁定单一 `<authId>.info`；**不设则自动发现最优会话** | 未设 = 自动发现 |
| `DSH_CODEBUDDY_BASE` | 上游网关 | `https://copilot.tencent.com` |
| `DSH_CODEBUDDY_ACCESS_TOKEN` | 手工注入 accessToken，绕开会话文件 | - |
| `DSH_CODEBUDDY_USER_ID` / `DSH_CODEBUDDY_DOMAIN` | 配合手工 token 使用 | - |
| `DSH_CODEBUDDY_REFRESH_TOKEN` / `DSH_CODEBUDDY_EXPIRES_AT` | 手工 token 也想自动续期时用 | - |
| `DSH_CODEBUDDY_PREFIX_PATH` | 刷新接口前缀 | `/plugin` |
| `DSH_CODEBUDDY_MODELS_REFRESH_H` | 动态模型目录刷新周期（小时，最小 1） | `6` |
| `DSH_CODEBUDDY_DISABLE_MODEL_FETCH` | 置 `1` 关闭动态拉取，只用 models.json 静态表 | 未设 = 启用 |
| `DSH_CODEBUDDY_UA_VERSION` | `/v3/config` 请求 UA 里的 CLI 版本号 | `2.137.1` |

## Token 续期策略

- 距过期 < 5 分钟才动：先**重读会话文件**（官方客户端可能已经刷新过），仍过期才自己刷：
  `POST {base}/v2/plugin/auth/token/refresh`，头带 `X-Refresh-Token` +
  `X-Auth-Refresh-Source: plugin`（与官方源码 `refreshSession()` 完全一致）。
- 刷新结果**只存内存、不回写文件**——官方 TUI/IDE/WorkBuddy 都在读写同一个文件，
  并发写会互相覆盖；官方进程下次会自行刷新落盘。
- 请求遇到 401 会自动失效缓存、重读文件重试一次（处理"别的进程刚换过 token"的竞态）。

## 模型清单（动态目录 + 静态兜底）

插件启动即向 `GET {base}/v3/config` 拉取官方实时模型目录（逆向自官方
CloudProductManager；需账号凭据 + `CLI/<ver> CodeBuddy/<ver>` UA），并取
cli agent 的模型白名单过滤出可对话模型，**内存热替换、无需重启 dsh**：

- 上下文窗口 / 最大输出以**联网核实的官方规格**为准（见下节），
  内置映射缺失的模型才回退上游数据；
- 默认每 6 小时刷新（`DSH_CODEBUDDY_MODELS_REFRESH_H`）；拉取失败沿用旧目录，
  连续失败按 30s→5min 指数退避（参照官方 ModelsProductProvider）；
  `DSH_CODEBUDDY_DISABLE_MODEL_FETCH=1` 完全关闭。

### 上下文 / 输出 / 思考档位：联网核实，不信 CodeBuddy 默认

CodeBuddy `/v3/config` 给出的数值普遍偏保守甚至错误，本插件按各厂商
官方文档逐一核实后内置（`BUILTIN_CAPABILITIES`，2026-08-28）：

| 模型 | 上游声称 | 核实值（官方规格） |
| --- | --- | --- |
| `hy3` / `hy3-x` | 192K / 64K | **256K 上下文 / 128K 输出** |
| `hy4-preview(-x)` | 1M / 64K | 1M 上下文（770B 参数，输出维持 64K） |
| `deepseek-v4-pro` / `-flash` | 1M / 50K | **1M 上下文 / 384K 输出** |
| `glm-5.3` / `-flash` / `glm-5.2` | 1M / 48K（flash 32K） | **1M 上下文 / 128K 输出**，档位 low/high/max |
| `glm-5.1` | 200K / 48K | **202745 上下文 / 128K 输出** |
| `glm-5v-turbo` | 200K / 64K | 200K 上下文 / **128K 输出** |
| `kimi-k3-1` | 1M | 1M 上下文，档位 low/high/max（默认 max） |
| `kimi-k2.7` / `-k2.6` | 256K | 256K 上下文（k2.7 思考常开，k2.6 可关） |
| `minimax-m3` | 512K / 128K | **1M 上下文**（稀疏注意力） |
| `minimax-m2.7` | 200K / 48K | 204800 上下文 |

优先级：`models.json` 显式声明 > 内置核实值 > 上游 `maxInputTokens` /
`maxOutputTokens`。白名单外的新模型无内置值时仍自动回退上游数据。

### 能力位全自动（思考档位 / 识图，无需手工配置）

**思考档位**优先级：`models.json` 显式声明 > 内置能力映射 >
上游 `reasoning.supportedEfforts` > 推理模型默认全档。内置映射
（`BUILTIN_CAPABILITIES`）按网关实测 + 各模型族的最大思考程度内置，
主流推理模型普遍给到 `low/high/max`——**不完全按 CodeBuddy 的保守声明**：
实测上游声明仅 `high` 的 `hy4-preview` 对 `low/max` 均返回 200 并真实
产出思考内容，各家族模型 `max` 档全部通过。

**识图**：动态目录直接读上游 `supportsImages` 标识（含
`disabledMultimodal` 否决）；静态条目由内置映射自动补齐——
`models.json` 里不再需要手写 `"input": ["text", "image"]`。

### models.json（静态兜底 + 覆盖层）

目录拉不到（无会话/断网/关闭拉取）时用它；与上游同名的条目其
`description` 等声明优先。能力位（`reasoningEfforts` / `input`）与
`contextWindow` / `maxTokens` 不写即自动按内置核实值补齐；显式写出
（含 `"reasoningEfforts": null` = 关闭）则作为人工覆盖生效。

默认收录（来自 CodeBuddy CLI 的模型目录）：
`hy3`、`deepseek-v4-pro`、`deepseek-v4-flash`、`kimi-k3-1`、`kimi-k2.7`、`kimi-k2.6`、
`glm-5.3`、`glm-5.2`、`glm-5.1`、`glm-5v-turbo`（视觉）、`minimax-m3`、`minimax-m2.7`；
动态目录启用后实际清单以 `/v3/config` 白名单为准（当前含
`hy4-preview(-x)`、`hy3-x`、`glm-5.3-flash` 等 16 个）。

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
- `GET /v3/config` 带 Bearer + CLI UA → 200：28 个模型、1 个 cli agent 白名单
  16 个可对话模型；各模型 `maxInputTokens` / `maxOutputTokens` /
  `supportsImages` / `reasoning.supportedEfforts` 能力位齐全
- `reasoning_effort` 接受度实测（stream 模式）：`hy4-preview`（上游仅声明
  high）的 `low` / `max`、以及 `glm-5.3` / `deepseek-v4-flash` / `kimi-k3-1` /
  `minimax-m3` / `glm-5v-turbo` 的 `max` 全部 200 且真实产出思考内容
  ——网关接受度宽于上游声明（注意：非流式 `stream:false` 一律 11101 拒绝）
