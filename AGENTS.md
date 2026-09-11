# AGENTS.md

本文件供 AI agent / 协作者阅读，记录本仓库的工作约定。

## /tmp 约定

- 本仓库中提到的 **`/tmp` 指的是当前仓库目录下的 `./tmp`**（即 `<repo>/tmp`），**不是系统全局的 `/tmp`**。
- 任务过程中产生的**中间产物、临时文件、缓存、日志、草稿**等都可以放入 `<repo>/tmp`，便于集中清理与隔离。
- **`.git` 不追踪 `<repo>/tmp`**：该目录已写入 `.gitignore`，提交时会被忽略，不会被推送到远程。

> 注意：全局 `/tmp` 属于系统，与本仓库无关；本仓库内一律以仓库根目录为基准的相对路径 `./tmp` 为准。
> 插件自身运行日志写在系统 `tmpdir()/dsh-codebuddy.log`（见 README「日志」一节），那是运行时产物、与上面的约定无关，不要混为一谈。

## 项目性质与结构约束

- 这是一个 **DSH 的 LLM provider 插件**（接入腾讯云 CodeBuddy 账号会话），结构对标 `dsh-opencode-zen`，区别在认证方式（账号会话 JWT 而非 API key）。
- **CommonJS**：入口 `lib/index.js`，`package.json` 为 `"type": "commonjs"`，**用 `require` 而非 `import`**；提交即生效，没有 `src/` → `lib/` 的编译步骤（仓库里直接维护 `lib/index.js`）。不要引入 tsc/esbuild 之类的构建流程。
- **注入契约**：`cordis.patch.yml` 通过 `inject: [llm]` 注册；`lib/index.js` 用 `ctx.llm.registerAdapter(['codebuddy'], adapter)` 挂路由。`inject` 字段与注册动作必须一一对应，改动任一方要同步另一方。
- **发布内容**：`package.json` 的 `files` 仅含 `lib` 与 `models.json`，其余（patch、README、smoke-test、AGENTS）不进 npm 包，但都进 git 仓库。

## 认证与会话（红线）

- **会话文件只读、绝不回写**：复用本机 CodeBuddy 客户端「web auth 一次」产生的 `*.info` 会话（按系统目录自动发现）。插件只读不写；**不要手动编辑或写入会话文件**。
- **token 刷新结果只存内存**：临期刷新拿到的 token 绝不写回磁盘（避免与官方 TUI/IDE/WorkBuddy 并发覆盖）。改认证相关逻辑时保持这个不变式。
- **绝不提交凭据**：`accessToken` / `refreshToken` / 会话文件 / `.env` / `.netrc` 一律不进版本库（`.gitignore` 已屏蔽部分）。远程推送用的 token 只放本地 `.git/config` 的 URL 重写，不追踪。
- 需要手工注入时走环境变量 `DSH_CODEBUDDY_ACCESS_TOKEN`（+可选 `DSH_CODEBUDDY_USER_ID`/`DSH_CODEBUDDY_DOMAIN`），不要写死进代码。

## 版本跟随（dsh 升级后必做）

**本插件的 dsh 依赖版本必须跟随宿主 dsh 的升级，一次都不能落下。** dsh 宿主升级后，
`package.json` 的 `peerDependencies` 里 `@deepseek-ai/*` 版本必须同步 bump 到宿主实际
安装的版本——不是"能兼容就行"，而是保持声明与运行实况一致。

宿主版本的唯一事实来源（读取命令）：

```sh
node -p "require('/root/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/package.json').version"
node -p "require('/root/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/package.json').version"
```

各 peer 与宿主的对应关系：

| peer 字段 | 宿主提供 | 说明 |
| --- | --- | --- |
| `@deepseek-ai/dsh-llm` | `dsh/node_modules/@deepseek-ai/dsh-llm` | 随 dsh 版本 bump（当前 `0.1.5-rc.1`） |
| `@deepseek-ai/cordis` | 同上 | 独立版本号（当前 `4.0.2`），随宿主走 |
| `@deepseek-ai/schemastery` | 同上 | 独立版本号（当前 `3.18.2`），随宿主走 |

**红线**：

- 这些包**只能出现在 `peerDependencies`，绝不能进 `dependencies`**。写进 dependencies 会让
  pnpm 在插件目录装出第二份副本，与宿主实例不是同一个模块——服务注册与类型判断会错乱。
- 用 `^` 范围（如 `^0.1.5-rc.1`），不要锁死精确版本：预发布段（alpha/rc）持续滚动，
  锁死会在 dsh 升到下一个 rc 时误报不兼容。
- dsh 升级改完 peer 后要重启 `dsh web` 并跑一次冒烟测试确认 `SMOKE PASS`。

升级检查清单：

1. 读宿主 `@deepseek-ai/dsh` 与 `dsh-llm` 的实际版本；
2. 同步 `package.json` 的 peer 版本；
3. 确认 `models.json` / `BUILTIN_CAPABILITIES` 没有因上游目录变化而缺模型；
4. `git diff` 只含预期文件，提交。

## 模型元数据（单一事实来源）

模型能力来自三层，优先级严格为：

1. `models.json` 的**显式声明**（静态覆盖层 + 拉不到目录时的兜底）；
2. `lib/index.js` 里的 **`BUILTIN_CAPABILITIES`**（联网核实的各厂商官方规格 + 网关实测，2026-08-28）；
3. 上游 `/v3/config` 的声明（仅当前两者都缺失时才回退）。

约束：

- **上下文窗口 / 最大输出以核实值为准**，不要照抄 CodeBuddy `/v3/config` 的保守甚至错误数值（例：hy3 标 192K 实为 256K，deepseek-v4 输出标 50K 实为 384K，minimax-m3 标 512K 实为 1M）。
- **`vision` 能力必须实测确认，不可轻信上游 `supportsImages` 或推理模型「应该支持」**。本仓库曾批量把 hy3/glm-5.x/kimi-k2.x/minimax-m2.7 的 `vision` 由 `true` 校正为 `false`——改动 vision 前要先用真实多模态请求验证，否则保持原值。
- **思考档位 `efforts`**：网关接受度实测宽于上游声明（如 `hy4-preview` 上游仅 `high`，实测 `low/max` 均 200 且真实产出思考），故 `low/high/max` 为常态，不要因上游未声明就收窄。
- 改 `BUILTIN_CAPABILITIES` 或 `models.json` 后，同步更新 README 的「上下文 / 输出 / 思考档位」对照表，保持文档与代码一致。

## 图像预算与超限处置（与官方对齐，红线）

图像的重活（缩放 / 编码 / 缓存 / singleflight）**一律复用核心**
`ctx.attachments.readImageRequest`，**不要自己解码、缩放或重编码图片**。
预算取值与超限处置必须与官方 `@deepseek-ai/dsh-llm-deepseek` 保持一致：

- **单模型预算** `resolveRequestImagePolicy(model)`：`imagePixelBudget`（数字或
  `"low"` → `512×512`，缺省 `640000`）、`imageMaxBytes`（缺省 `1 MiB`）。
  官方**未从 `@deepseek-ai/dsh-llm` 导出**此函数，故按上游源码 1:1 复刻——
  改动前先对照上游 `dsh-llm-deepseek` 的 `resolveRequestImagePolicy`。
- **超限卸载**：优先调用核心导出的 `offloadRequestImagesWithPolicy`；仅当核心
  解析不到时退回本地复刻 `offloadImagesLocal`。参数取官方内联 base64 路径默认值：
  `maxBytes: 20MiB`、`maxImages: 600`、`byteQuantum: 10MiB`、`countQuantum: 20`、
  单图计入 `min(ref.bytes, imageMaxBytes)`。占位符用核心 `offloadedImageText`。
- **核心解析手法**：插件是 `link:` 安装，自身 `node_modules` 里**没有**核心包，
  故 `coreLlm()` 按 dsh 安装位置解析（`createRequire(<dsh>/package.json)`，
  失败再退化为绝对路径 require）。**不要**把 `@deepseek-ai/dsh-llm` 写进
  `dependencies`（见「版本跟随」红线）。
- **等价性验证**：改动这两个函数后，必须与官方实现逐用例比对（策略输出、
  offload 结果逐字节一致），并跑一次真实多模态请求确认未被破坏。
- dsh 升级后若上游调整了这些默认值或语义，**必须同步核对本插件**。

## 环境变量约定

所有可调开关走 `DSH_CODEBUDDY_*` 前缀（`DSH_CODEBUDDY_BASE` / `DSH_CODEBUDDY_AUTH_ID` / `DSH_CODEBUDDY_MODELS_REFRESH_H` / `DSH_CODEBUDDY_DISABLE_MODEL_FETCH` / `DSH_CODEBUDDY_UA_VERSION` 等，详见 README）。新增可配置项应沿用此前缀并补到 README 的环境变量表。

## 测试与改动流程

- 冒烟测试：`node smoke-test.js [modelId]`（真实调用上游、极小 token，需本机已有 CodeBuddy 登录会话）。
- 改动认证 / 流解析 / 模型目录逻辑后，至少跑一次冒烟测试确认 `SMOKE PASS`。
- **提交前确认改动范围**：中间产物放入 `<repo>/tmp`、凭据不入库；`git status --porcelain` 应只含预期文件。
- 版本号在 `package.json` 的 `version` 字段维护（当前 `0.5.0`），发布时同步 bump。

## 其他工作约定

- 远程推送使用本地 `.git/config` 内的 token URL 重写（不进版本库）；不要将 token 写入被追踪的文件。
- 请确保使用方式符合 CodeBuddy 服务条款；账号级凭据等同用户完整权限，勿外传、勿提交。
