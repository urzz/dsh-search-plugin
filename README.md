# 联网增强

面向 **DSH 0.2.1-rc.4** 的 TypeScript ESM 插件。复用官方 `web_search`、`web_fetch` 工具，通过实时配置选择搜索协议，增强本机 HTTP 抓取的地址授权。设计参考 [dsh-tool-web-enhanced](https://github.com/Yurzi/dsh-tool-web-enhanced)，本仓库实现仅覆盖 Alpha Search、DeepSeek Search API 与本机抓取。

```text
web_search → ctx.web → codex（稳定路由）→ protocol factory → Alpha / DeepSeek Search API
web_fetch  → ctx.web → search-http → 官方 HttpFetchProvider + CIDR resolver
```

## 构建与安装

```sh
pnpm install
pnpm check
dsh plugin --profile <name> add dsh-search-plugin
```

通过 npm 发布版本安装和更新；修复不直接覆盖本机已安装插件。更新已经安装的包后需要重启 DSH profile，再刷新网页。仅构建本仓库不会更新已经运行的 GUI。bundle 选择 `searchProvider: codex`、`fetchProvider: search-http`，标准 base 需已有 web 服务与工具消费者；旧 `http` provider 保留，其配置不被修改，但默认路由改由本插件接管。

## 发布

除首次发布需要本地初始化外，后续版本均通过 GitHub Actions 发布。更新包版本、完成 `pnpm check` 后，提交并推送对应的 `v<版本号>` 标签，触发 `.github/workflows/publish.yml`。工作流校验标签与包版本一致，再通过 npm Trusted Publishing 发布；不要在本地执行 `npm publish` 或为后续发布要求本地 npm 登录。

## 配置 UI

进入 **插件 → 联网增强 → 组件**，分别打开 **搜索增强** 或 **Fetch增强** 的配置。外层插件包不再展示表单，每个组件只展示自己的配置。

`dsh-search-ui` 是独立的界面加载组件，只负责加载两个配置页面，不注册 Provider、不展示配置表单；请保持启用。DSH 仅从包根入口发现浏览器模块，因此它不随搜索或 Fetch 中任一组件的停用而卸载。

两个增强组件各自注册 Provider、持有配置 schema 和 ConfigForms revision，仅依赖官方 `web` 服务，互不提供或消费运行服务。可以单独启用、停用、配置与重置，关闭搜索增强后 Fetch增强仍可抓取，反之亦然。关闭某组件后，该能力的已配置路由会报 Provider 缺失，不会静默切换到其他实现。

| 组件 | 配置 entry ID | Provider | 配置范围 |
| --- | --- | --- | --- |
| 搜索增强 | `dsh-search-plugin` | `codex` | 搜索协议、端点、凭据引用、搜索限制 |
| Fetch增强 | `dsh-search-fetch` | `search-http` | CIDR 授权、抓取超时、响应与正文限制 |

### 从 0.2.3 及之前版本升级

搜索配置 ID 不变。旧版保存在 `dsh-search-plugin.config` 下的四个 `fetch*` 字段，需要移至 `dsh-search-fetch.config`；也可先记录原值，升级后在 Fetch增强页面重新保存。未迁移时 Fetch 使用默认值（CIDR 默认为空，旧授权不会自动生效）。请在升级前保留原配置；插件不自动改写 profile，也不在运行时读取另一组件的配置。

```yaml
- id: dsh-search-fetch
  config:
    fetchAllowedCidrs: [198.18.0.0/15]
    fetchTimeoutMs: 30000
    fetchMaxResponseBytes: 5000000
    fetchMaxContentChars: 100000
```

直接在 YAML 中引用旧根模块 `dsh-search-plugin` 的兼容入口仍支持原来的合并配置及两种能力，但其生命周期也是合并的。需要独立启停时，改为 bundle 使用的 `dsh-search-plugin/search` 和 `dsh-search-plugin/fetch` 两个入口，并按上表分配配置。

- 搜索协议选择器动态显示对应协议字段；切换协议保留各自配置，保存后下一次操作生效。
- Alpha 可复用 OpenAI provider，或使用独立端点与凭据。仅 Alpha 显示超时、响应和答案上限。
- DeepSeek 显示 API 基础地址、独立凭据引用和结果数量；使用官方 Search API 实现和传输限制。
- 搜索与网页抓取使用独立表单，各自管理草稿、校验、保存、放弃编辑和重置覆盖；操作只修改所属字段。
- 网页抓取配置包含 CIDR 多行授权、超时与正文限制。按实际网络环境手动填写 CIDR，不提供预设网段按钮。
- 保存使用官方 ConfigForms 与 revision 冲突检查，支持只读与失败提示。
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
