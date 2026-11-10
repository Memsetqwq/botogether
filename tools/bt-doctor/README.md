# bt-doctor

Botogether **模型服务兼容体检工具**。在把一个模型服务填进 Botogether 之前，先用它确认：
端点通不通、凭据对不对、哪些模型其实已经调不通、这套端点到底能配给哪个引擎。

零依赖，只需 Node 18+。

## 它解决什么问题

Botogether 目前的「模型服务」配置对用户是黑盒：填错了没有提示，往往要等到第一次任务失败
才知道。本工具把这三类已知问题变成可提前发现的检查项：

| 问题 | 本工具如何提前暴露 |
|---|---|
| [#1](https://github.com/DmiyDing/botogether/issues/1) Windows 上 npm 原生 exe 型 Agent 被判定为不可用 | 提示需要注册真实 exe 路径（本工具不涉及发现流程，但会指出该限制） |
| [#2](https://github.com/DmiyDing/botogether/issues/2) OpenCode 2.x 不支持 provider 注入 | 在「引擎兼容性」中直接标为**阻断**，并给出 1.x 的处理建议 |
| [#3](https://github.com/DmiyDing/botogether/issues/3) `/v1/models` 里的已下线模型被当作可用 | 逐个模型真实发一次请求，把「已下线」与「可调用」分开列出 |

配套文档：[模型服务兼容矩阵](../../docs/providers-matrix.md)。

## 用法

```bash
# 体检 OpenAI 兼容端点
node tools/bt-doctor/bt-doctor.mjs \
  --endpoint https://api.minimaxi.com/v1 \
  --protocol openai \
  --key sk-xxxx

# 体检 Anthropic 兼容端点
node tools/bt-doctor/bt-doctor.mjs \
  --endpoint https://api.minimaxi.com/anthropic \
  --protocol anthropic \
  --key sk-xxxx

# 密钥放文件里（也兼容含 api_key 字段的 JSON，如 ~/.mmx/config.json）
node tools/bt-doctor/bt-doctor.mjs --endpoint https://api.minimaxi.com/v1 --key-file ~/.mmx/config.json

# 只读模型清单，不逐个发请求（零消耗）
node tools/bt-doctor/bt-doctor.mjs --endpoint https://api.minimaxi.com/v1 --key sk-xxxx --skip-probe

# 机器可读输出
node tools/bt-doctor/bt-doctor.mjs --endpoint https://api.minimaxi.com/v1 --key sk-xxxx --json
```

### 参数

| 参数 | 说明 |
|---|---|
| `--endpoint <url>` | 服务基地址，必填。OpenAI 兼容一般到 `/v1`，Anthropic 兼容到 `/anthropic` |
| `--key <key>` / `--key-file <path>` | API 密钥。`--key-file` 兼容纯文本与含 `api_key` 的 JSON |
| `--protocol <p>` | `openai` / `anthropic` / `auto`（默认 auto） |
| `--models <a,b,c>` | 指定要探测的模型；默认取服务返回的清单 |
| `--engines <a,b,c>` | 要评估的引擎：`opencode`、`claude`、`codex` |
| `--skip-probe` | 只读清单，不逐个调用（不消耗额度） |
| `--concurrency <n>` | 并发探测数，默认 4 |
| `--timeout <ms>` | 单次请求超时，默认 45000 |
| `--json` | 输出 JSON |

### 退出码

| 码 | 含义 |
|---|---|
| 0 | 端点、凭据与所选引擎均无阻断项 |
| 1 | 存在阻断项（引擎不匹配、OpenCode 版本受阻、端点不可达等） |
| 2 | 参数错误或工具内部异常 |

## 输出示例

```
────────────────────────────────────────────────────────────────
bt-doctor · Botogether 模型服务兼容体检
────────────────────────────────────────────────────────────────
端点          https://api.minimaxi.com/v1
协议 / 认证    openai / bearer
模型清单      9 个（MiniMax-M3.1-Flash, MiniMax-M3, MiniMax-M2.7 …）
端点可达      ✓
凭据有效      ✓

【模型可调用性】
  模型                          结果                耗时
  MiniMax-M3.1-Flash            ✓ 可调用         2132ms
  MiniMax-M3                    ✓ 可调用          814ms
  MiniMax-M2.1                  ✗ 已下线           52ms
      The model "MiniMax-M2.1" is no longer available. (2069)
  → 可调用 6 · 已下线 3 · 其他失败 0

【引擎兼容性】
  opencode
    ✓ 协议匹配
        → 填 protocol=openai，targetEngine=opencode
    ✗ 引擎版本受阻
        → OpenCode 2.x 不支持 provider 注入（issue #2）。请安装并注册 opencode-ai 1.x 的真实 exe
  claude
    ✗ 协议不匹配
        → Claude Code 只接受 anthropic 协议
  codex
    ✓ Responses 可用
        → wire_api 固定为 responses，该端点已验证支持

【建议的 Botogether 模型服务配置】
  设置 → 模型与代理 → 添加模型服务
    name             <自定义名称>
    endpoint         https://api.minimaxi.com/v1
    protocol         openai
    targetEngine     codex
    credentialSource secure
    authMode         bearer
    defaultModel     MiniMax-M3.1-Flash
    models           MiniMax-M3.1-Flash, MiniMax-M3, …
    secretEnv        MINIMAX_API_KEY

【提示】
  • 以下模型在 /models 中声明但已不可调用（issue #3），Botogether 会把它们当作可用：…
────────────────────────────────────────────────────────────────
```

## 局限（请如实告知用户）

- 本工具**只做协议与模型层面的判断**，不代表 Agent 一定能跑通：Agent 侧还受引擎版本、
  登录态、权限审批影响。Botogether 自身的「verify agent」才是端到端那一步。
- `--skip-probe` 模式不会发现已下线模型（那正是 issue #3 的场景）。
- 逐模型探测会产生真实调用与**真实费用**；模型较多时建议先 `--skip-probe` 看清单。
- Anthropic 兼容端点的 `/v1/models` 并非所有服务都实现；探测失败会退回 `openai` 形态尝试。
- `secretEnv` 只是按域名给出的**建议值**，需自行确认服务商的环境变量命名。

## 与三个 issue 的关系

本工具是 [#1](https://github.com/DmiyDing/botogether/issues/1)、
[#2](https://github.com/DmiyDing/botogether/issues/2)、
[#3](https://github.com/DmiyDing/botogether/issues/3) 的配套工具：
三者都是「用户没有可自查的手段」，本工具补上这一层。
