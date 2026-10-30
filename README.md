# 联网搜索（Web search）

TypeScript ESM 搜索组合包，目标运行版本 **DSH 0.2.1-rc.4**。注册 `codex` 搜索 Provider，复用官方 `web_search`；网页抓取复用本机 `http` Provider 与 `web_fetch`，不重复注册工具。

```text
web_search → ctx.web → codex → POST /v1/alpha/search
web_fetch  → ctx.web → http  → 本机直接请求公开网页
```

## 安装与构建

```sh
pnpm install
pnpm check
# 在父目录执行，将 <name> 替换为目标 profile：
dsh plugin --profile <name> add ./dsh-search-plugin
```

本地 checkout 安装需要保留插件目录及构建产物。`pnpm build` 构建 Host 和浏览器 lazy-CJS 模块；修改后需重新构建。首次安装或更新 bundle 后需要重启现有 DSH profile，再刷新网页；加载新版后，UI 的即时配置与凭据更新对下一次搜索生效。插件不会自动更改正在运行的 profile。

bundle 要求标准 DSH base 已有 `web`、`web-fetch-http` 与工具消费者，并选择 `searchProvider: codex`、`fetchProvider: http`。不覆盖已有 HTTP fetch 安全限制、超时或 User-Agent；其他后应用的 patch 可覆盖路由。

## 默认配置：无需填写端点或模型

默认 `authMode: openai`、`openaiProvider: openai`，复用所选 OpenAI Provider 的实时 `baseURL` 与显式 `apiKeyEnv` 引用。例如：

```yaml
baseURL: https://your-api.example/v1
apiKeyEnv: OPENAI_API_KEY
```

搜索自动请求 `https://your-api.example/v1/alpha/search`，通过官方 Credentials 服务解析同一个密钥引用。**不要求填写搜索模型，不调用 Responses，不做协议探测或失败回退。** 上游必须实现 Alpha 搜索接口，普通 OpenAI 兼容聊天服务不一定支持。

端点与凭据一起继承。复用模式始终使用派生地址，忽略独立模式的 `endpoint`（包括旧版残留值）；不同地址请切换独立凭据模式，明确授权该地址使用的凭据引用。每次搜索捕获当前配置并解析一次凭据，不复制存储，不跨请求缓存。

仅支持复用显式 `apiKeyEnv` 引用，不读取 Provider 私有对象、不提取 OAuth token、不绕过 stored-record 优先级、不实现 OAuth 刷新。自定义认证 headers 不会复制；这些连接请改用独立凭据。插件发送标准 Bearer API Key，不支持其他认证协议。

## 配置 UI

进入 **插件 → 联网搜索** 的组合包详情，或点击 **dsh-search-plugin 组件行 → 配置**。两处共用同一份实时配置：

- 复用模式只显示 OpenAI Provider 路由；无需填写端点、模型或密钥。
- 独立模式显示完整搜索端点 URL、凭据引用与密钥管理。
- 两种模式均可设置超时、响应字节上限、答案字符上限。

配置页使用官方 ConfigForms 服务和 revision 冲突检测，提供保存、重置与放弃编辑。重置只重置公开配置，不删除凭据或修改旧版密钥字段。密钥单独通过官方 Credentials API 管理：不返回明文、不进入普通配置、不写入浏览器存储；输入留空不会清除已有密钥。删除只删除该引用的托管值，环境变量或其他来源仍可能提供同名凭据。

组合包与组件提供中英文名称和描述；包名与 Provider id 保持不变。自建最小 profile 需要挂载官方 Settings、ConfigEditor、Credentials 及对应 Web 客户端服务；仅 Host schema 不会自动生成页面。

## 配置字段

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `authMode` | `openai` | `openai` 复用模式或 `credential` 独立模式 |
| `openaiProvider` | `openai` | 复用模式的官方 LLM Provider id |
| `credentialRef` | `DSH_CODEX_API_KEY` | 独立模式的官方凭据引用 / 环境变量名 |
| `endpoint` | 空 | 复用模式自动派生 Alpha 搜索 URL；独立模式必须填写完整 POST URL |
| `apiKey` | 无 | 兼容旧版的 Host-only 密钥，仅独立模式使用，优先于引用；推荐改用凭据管理 |
| `timeoutMs` | `60000` | 单次搜索请求超时，毫秒 |
| `maxResponseBytes` | `2000000` | 搜索响应主体的字节上限 |
| `maxAnswerChars` | `16000` | 返回答案的字符上限 |

以上字段为即时配置。上限仅控制搜索，不控制本机 HTTP fetch。旧版 `model` 不再使用。复用模式忽略旧 `endpoint`；独立模式升级后需把原 `/responses` 端点改为实际的 Alpha 搜索 URL，插件不会自动改写独立端点。

bundle 可从启动进程环境读取 `DSH_CODEX_AUTH_MODE`（默认 `openai`）、`DSH_CODEX_ENDPOINT` 和旧版 `DSH_CODEX_API_KEY`。用环境变量直接提供搜索 API Key 时需同时设置 `DSH_CODEX_AUTH_MODE=credential`。不再需要 `DSH_CODEX_MODEL`。

独立模式的 profile patch 示例：

```yaml
- id: dsh-search-plugin
  config:
    authMode: credential
    endpoint: https://your-search.example/v1/alpha/search
    credentialRef: SEARCH_API_KEY
```

**patch 替换整份 `config`，不是深度合并。** 修改时保留需要的字段，省略的字段使用 schema 默认值。不要把真实密钥提交进仓库或放入普通配置。插件自身不额外解析 `.env`。

## 协议与安全边界

只支持 **POST `/v1/alpha/search`**，不支持 Responses、Chat Completions 或直接连接 ChatGPT 私有后端；独立模式的 `endpoint` 是完整 URL，不自动补路径。协议按 [Codex 官方 SearchRequest/SearchResponse](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/search.rs) 实现，而不是替换 Responses URL：

- 每次请求生成 `id`，发送 `commands.search_query: [{ q: 查询文本 }]`、用户 `input`、`settings: { allowed_callers: ['direct'], external_web_access: true }` 和 `max_output_tokens: 2048`，不发送 Responses `tools`、`tool_choice`、`include`、`stream` 或 `store`。
- Alpha 协议自身要求 `model`。适配器内置路由模型 `gpt-5.6-luna`（[已公开 Alpha 适配器的默认值](https://unpkg.com/@caiqy/dsh-plugin-web-search@0.1.0/lib/providers.js)），不继承聊天模型，也不要求用户填写。目标服务必须支持此路由模型。
- 响应读取文本 `output` 和可选 `results`（缺失、`null`、空数组均支持）。`results` 是可扩展的不透明条目，只提取有合法 HTTP(S) `url` 的来源及可选 `title`，不要求存在这些字段，不输出 `encrypted_output`。清理 Alpha 私有引用标记，来源去重后交给 DSH 管理数量限制。

搜索端点会收到密钥与查询，请仅配置可信服务，推荐 HTTPS。配置缺失、鉴权错误、上游协议错误、超时等明确失败，不静默切换 Provider，不返回伪造的空结果。不自动重试，不跟随携带认证的重定向。来源只取自结构化响应，不从自然语言猜测或编造链接。DSH 的 `truncated` 表示来源被裁剪，不表示答案字符裁剪。

网页与答案均属于不可信外部数据，不能作为系统指令或工具授权。排错时不要打印未脱敏请求头、真实密钥或完整远端错误正文。

## 本机 HTTP fetch

本机直接请求公开网页，不额外调用付费抓取 API，不携带搜索 API Key。仍有网络成本、搜索端点费用及正文进入模型后的 token 费用。

复用官方 HTTP Provider 的 SSRF 防护、DNS 固定、同源重定向和正文限制。默认 30 秒超时、5 MB 响应、100,000 字符正文、最多 5 次同源跳转，已有 profile 的定制值不被本插件覆盖。不支持 JS 渲染、登录、验证码、PDF/二进制正文或跨源自动重定向；失败不会自动改用浏览器或付费抓取。

若代理 Fake-IP DNS 返回 `198.18.0.0/15` 等非公开地址，官方 fetch 可能以 `WEB_BLOCKED_URL` 拒绝。应修正运行环境的 DNS/路由或按官方能力显式授权，不能关闭 SSRF 防护或伪造公开地址绕过。

## 验证

运行 `pnpm check` 完成类型检查、构建与自动测试。真实搜索与抓取可能产生费用，需要另外验证目标服务、凭据和网络环境；本地测试不等于正在运行的 GUI 部署验收。
