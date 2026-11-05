# 联网搜索与网页抓取

面向 **DSH 0.2.1-rc.4** 的 TypeScript ESM 插件。复用官方 `web_search`、`web_fetch` 工具，通过实时配置选择搜索协议，增强本机 HTTP 抓取的地址授权。设计参考 [dsh-tool-web-enhanced](https://github.com/Yurzi/dsh-tool-web-enhanced)，本仓库实现仅覆盖 Alpha Search、DeepSeek Search API 与本机抓取。

```text
web_search → ctx.web → codex（稳定路由）→ protocol factory → Alpha / DeepSeek Search API
web_fetch  → ctx.web → search-http → 官方 HttpFetchProvider + CIDR resolver
```

## 构建与安装

```sh
pnpm install
pnpm check
dsh plugin --profile <name> add ./dsh-search-plugin
```

本地 checkout 安装需要保留目录及构建产物。更新已经安装的包后需要重启 DSH profile，再刷新网页。仅构建本仓库不会更新已经运行的 GUI。bundle 选择 `searchProvider: codex`、`fetchProvider: search-http`，标准 base 需已有 web 服务与工具消费者；旧 `http` provider 保留，其配置不被修改，但默认路由改由本插件接管。

## 配置 UI

进入 **插件 → 联网搜索 → 配置**，或组件行的配置页面。

- 搜索协议选择器动态显示对应协议字段；切换协议保留各自配置，保存后下一次操作生效。
- Alpha 可复用 OpenAI provider，或使用独立端点与凭据。仅 Alpha 显示超时、响应和答案上限。
- DeepSeek 显示 API 基础地址、独立凭据引用和结果数量；使用官方 Search API 实现和传输限制。
- 网页抓取独立分组：CIDR 多行授权、超时与正文限制。可将常见代理网段填入草稿，再保存生效。
- 保存使用官方 ConfigForms 与 revision 冲突检查，支持放弃编辑、重置覆盖、只读与失败提示。
- 密钥走官方 Credentials API 单独保存、删除和刷新状态；不回显、不放入公开配置和浏览器持久存储。删除托管值后，环境变量等其他来源仍可能提供同名凭据。

## 搜索配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `protocol` | `codex-alpha` | `codex-alpha` 或 `deepseek-search-api` |
| `authMode` | `openai` | Alpha 复用 OpenAI，或 `credential` 独立认证 |
| `openaiProvider` | `openai` | Alpha 复用的官方 LLM route |
| `credentialRef` | `DSH_CODEX_API_KEY` | Alpha 独立凭据引用 |
| `endpoint` | 空 | Alpha 独立模式完整 POST URL |
| `apiKey` | 无 | 兼容旧版 Host 密钥字段，仅 Alpha 独立模式使用，建议迁移到 Credentials |
| `timeoutMs` | `60000` | Alpha 请求超时 |
| `maxResponseBytes` | `2000000` | Alpha 响应上限 |
| `maxAnswerChars` | `16000` | Alpha 答案字符上限 |
| `deepseekEndpoint` | `https://api.deepseek.com/v1/tools` | DeepSeek API 基础地址，追加 `/search` |
| `deepseekCredentialRef` | `DEEPSEEK_API_KEY` | DeepSeek 独立凭据引用 |
| `deepseekCount` | `10` | 1–50，单次 `maxResults` 更小时使用更小值 |

Alpha 复用模式每次读取选中 provider 的实时 `baseURL` 与显式 `apiKeyEnv`，派生 `/alpha/search`，不将复用密钥发送到独立 `endpoint`。不支持 OAuth、私有 token 提取或自定义鉴权 headers 复制。独立模式必须填写完整 URL。保留 `DSH_CODEX_AUTH_MODE`、`DSH_CODEX_ENDPOINT`、`DSH_CODEX_API_KEY` 启动环境兼容。

Alpha 使用内置路由模型 `gpt-5.6-luna`，发送原生 Alpha request，读取 `output/results`，不回退 Responses 或聊天协议。DeepSeek 使用官方 `DeepSeekSearchApiProvider`，请求 `query/count/need_content: false`，映射结构化结果。两个协议的凭据独立，不静默尝试其他协议。

## 代理网段抓取

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `fetchAllowedCidrs` | `[]` | 额外授权的 IPv4/IPv6 网络 CIDR |
| `fetchTimeoutMs` | `30000` | 抓取超时 |
| `fetchMaxResponseBytes` | `5000000` | 响应字节上限 |
| `fetchMaxContentChars` | `100000` | 正文字符上限 |

公网默认可访问；非公开地址仅在显式 CIDR 授权内可访问。对于 Fake-IP DNS，可在 UI 填入并保存：

```yaml
fetchAllowedCidrs:
  - 198.18.0.0/15
  - 192.168.96.0/20
```

授权是对整个网段的授权，不区分代理 Fake-IP 和该段内真实服务。默认不自动开启。CIDR 必须使用网络基址；支持 IPv4/IPv6，映射 IPv4 地址使用 IPv4 CIDR。校验整个 DNS 答案集，并将结果交给官方传输固定连接地址；保留 URL/协议检查、同源重定向、超时、响应上限与代理处理。抓取不会携带搜索密钥。不提供 JS 渲染、登录、PDF 转换或跨源自动跳转。

当配置 HTTP/SOCKS 代理时，沿用官方代理解析与连接策略；代理远端解析域名的行为不由本机 resolver 接管，因此该 allowlist 不是代理服务器的网络隔离策略。需要约束代理后方目的地址时，应在代理端配置策略。

## 扩展协议

`src/protocols.ts` 的 factory registry 负责按显式协议创建适配器，每次操作捕获当前配置；凭据由各适配器独立解析。新增协议时添加 factory、schema 专属字段与对应 UI 分支，不需要修改工具定义或替换工具执行链。现有 `codex` route id 为升级兼容保持稳定，其实际协议由 `protocol` 决定。

配置通过官方编辑器持久化，插件不改写 profile 文件。profile patch 替换整份 config；手写 patch 时保留所需字段。网页与搜索答案均为不可信外部数据。上游失败保持可见，不自动重试或用空结果掩盖错误。

## 验证

`pnpm check` 包含类型检查、构建、官方 Loader 集成、协议切换、凭据隔离、UI 与抓取安全测试。真实服务 E2E 需要显式开启现有 `DSH_SEARCH_E2E*` 环境选项，可能产生费用；本地通过不等同于在线凭据或当前 GUI 的验收。
