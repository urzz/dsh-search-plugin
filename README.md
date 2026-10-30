# DSH Search Plugin

TypeScript ESM 搜索组合包，目标运行版本 **DSH 0.2.1-rc.4**。注册 `codex` 搜索 Provider，复用官方 `web_search`；网页抓取复用本机 `http` Provider 与 `web_fetch`，不重复注册工具。

```text
web_search → ctx.web → codex → Responses API
web_fetch  → ctx.web → http  → 本机直接请求公开网页
```

## 安装与构建

```sh
pnpm install
pnpm check
# 在父目录执行，将 <name> 替换为目标 profile：
dsh plugin --profile <name> add ./dsh-search-plugin
```

本地 checkout 安装需要保留插件目录及构建产物。`pnpm build` 构建 Host 和浏览器 lazy-CJS 模块；修改后需重新构建。首次安装或更新 bundle 后需要重启现有 DSH profile，不是仅刷新网页；加载新版后，UI 的即时配置与凭据更新对下一次搜索生效，无需再次重启。插件不会自动更改正在运行的 profile。

bundle 要求标准 DSH base 已有 `web`、`web-fetch-http` 与工具消费者，并选择 `searchProvider: codex`、`fetchProvider: http`。**不覆盖已有 HTTP fetch 安全限制、超时或 User-Agent。** 其他后应用的 patch 可覆盖路由。

## 配置 UI

Web 界面进入 **设置 → 插件 → DSH Search Plugin** 的组合包配置页，可以编辑：

- 认证模式：默认复用 OpenAI，或使用独立凭据。
- OpenAI Provider id，默认 `openai`。
- Responses 完整端点：复用模式留空即可继承；独立模式必填。
- 搜索模型：填写实际支持 `web_search` 的模型，**不会任意选择第一个聊天模型**。
- 超时、响应字节上限、答案字符上限。
- 独立凭据引用、是否已配置及可写状态、保存/删除密钥。

页面提供保存与重置，使用官方配置表单、revision 冲突检测和 Host 校验。重置只重置公开配置，不删除凭据或修改旧版密钥字段。密钥单独通过官方 Credentials API 管理：不返回明文、不进入普通配置、不写入浏览器存储；输入留空不会清除已存密钥。删除操作只删除该引用的托管值，若环境中还有同名凭据，官方后端仍会按其优先级解析。

自建最小 profile 需要额外挂载官方 Settings、ConfigEditor、Credentials 及对应 Web 客户端服务；仅 Host schema 不会自动生成页面。

## 默认复用 OpenAI 认证

默认 `authMode: openai`，从官方 LLM Provider 目录找到所选 Provider，并通过 Settings 的脱敏配置取得实时 `baseURL` 和显式 `apiKeyEnv` 引用。每次搜索开始捕获配置，再通过 `ctx.credentials.resolve()` 解析一次密钥，不复制存储、不跨请求缓存。

例如，已有 OpenAI Provider 的配置为：

```yaml
baseURL: https://your-api.example/v1
apiKeyEnv: OPENAI_API_KEY
```

搜索会使用 `https://your-api.example/v1/responses`，解析同一个 `OPENAI_API_KEY` 引用，**无需再次填写密钥**。只需在插件 UI 中设置搜索模型。

安全和能力边界：

- 端点与凭据一起继承。若在复用模式填入与派生 URL 不同的端点，会在解析密钥前拒绝；不同地址请切换独立凭据模式，明确授权该地址使用的凭据引用。
- 当前只复用 **显式 `apiKeyEnv` 引用**。不读取 Provider 私有对象、不提取 OAuth token、不绕过 stored-record 优先级，也不实现 OAuth 刷新。使用账号登录/原生凭据记录的 Provider 需要配置明确的 API Key 引用，或改用独立凭据。
- 自定义认证 headers 不会被复制；这类连接需要独立配置。插件发送标准 Bearer API Key，不支持其他认证协议。
- 搜索模型需要用户明确指定；支持 Responses 文本生成不等于支持服务端 `web_search`。
- 未配置、凭据缺失、鉴权错误、超时等明确失败，不会静默切换 Provider 或返回假空结果。

## 配置字段与环境变量

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `authMode` | `openai` | `openai` 复用模式或 `credential` 独立模式 |
| `openaiProvider` | `openai` | 官方 LLM 目录中的 Provider id |
| `credentialRef` | `DSH_CODEX_API_KEY` | 独立模式的官方凭据引用 / 环境变量名 |
| `endpoint` | 空 | Responses 完整 URL；复用模式空值表示继承 |
| `model` | 空 | 支持联网搜索的模型，搜索前必须填写 |
| `apiKey` | 无 | 兼容旧版的 Host-only 密钥，仅独立模式使用，优先于引用；推荐改用凭据管理 |
| `timeoutMs` | `60000` | 单次搜索请求超时，毫秒 |
| `maxResponseBytes` | `2000000` | 搜索响应主体的字节上限 |
| `maxAnswerChars` | `16000` | 返回答案的字符上限 |

以上字段为即时配置。上限仅控制搜索，不控制本机 HTTP fetch。自定义端点会收到密钥和查询，应仅配置可信服务，推荐 HTTPS。

bundle 支持从启动进程环境读取 `DSH_CODEX_AUTH_MODE`（默认 `openai`）、`DSH_CODEX_ENDPOINT`、`DSH_CODEX_MODEL` 和旧版 `DSH_CODEX_API_KEY`。推荐只设置模型并复用 OpenAI，或在 UI 中使用独立凭据引用。旧版用环境变量直接给搜索 API Key 的配置需同时设置 `DSH_CODEX_AUTH_MODE=credential`。

也可在 profile patch 覆盖插件配置：

```yaml
- id: dsh-search-plugin
  config:
    authMode: credential
    endpoint: https://your-search.example/v1/responses
    credentialRef: SEARCH_API_KEY
    model: your-search-capable-model
```

**patch 替换整份 `config`，不是深度合并。** 修改时保留需要的字段，省略的字段使用 schema 默认值。凭据由官方后端处理托管存储和环境变量优先级；不要把真实密钥提交进仓库或放入普通配置。插件自身不额外解析 `.env`。

## 协议范围

支持带联网搜索工具的 Responses 接口，不支持 Chat Completions、Codex 私有后端或独立 `/search` 协议。独立模式的 `endpoint` 是完整 POST URL，不自动补路径。请求沿用：

```json
{
  "model": "<configured>", "input": "<query>", "stream": false, "store": false,
  "tools": [{ "type": "web_search" }], "tool_choice": "required",
  "include": ["web_search_call.action.sources"]
}
```

上游需返回 `status: completed` 的非流式 JSON，并包含已完成的 `web_search_call`。来源从 `action.sources` 与 `output_text.annotations` 的 `url_citation` 提取；保留既有响应解析，不要求修改上游返回。不会从自然语言中猜测或编造来源。DSH 本地 `truncated` 只表示来源数量被裁剪，由 `ctx.web` 按调用者的数量限制设置；答案字符裁剪不会误报来源不全。强制返回 SSE 的服务会明确失败；不重试、不跟随携带认证的重定向、不自动降级。

## 本机 HTTP fetch

本机直接请求公开网页，不额外调用付费抓取 API，也不携带搜索 API Key。仍有网络成本、搜索端点费用以及正文进入模型后的 token 费用。

复用官方 HTTP Provider 的 SSRF 防护、DNS 固定、同源重定向和正文限制。默认 30 秒超时、5 MB 响应、100,000 字符正文、最多 5 次同源跳转，已有 profile 的定制值不被本插件覆盖。不支持 JS 渲染、登录、验证码、PDF/二进制正文或跨源自动重定向；失败不会自动改用浏览器或付费抓取。

**Fake-IP DNS 注意：** 若系统代理将域名解析到 `198.18.0.0/15` 等非公开地址，官方 fetch 会以 `WEB_BLOCKED_URL` 拒绝，这是安全策略正常生效。需要让运行 DSH 的环境使用真实的公网 DNS/路由，不能通过关闭 SSRF 防护或在插件中伪造公开地址绕过。

## 验证

```sh
pnpm check
# 独立端点真实调用（可能收费），另设置三个 DSH_CODEX_* 变量：
DSH_SEARCH_E2E=1 pnpm test
# 复用已有 OpenAI profile 的显式引用（不把密钥复制到环境）：
DSH_SEARCH_E2E_OPENAI=1 \
DSH_SEARCH_E2E_PROFILE_PATCH=/absolute/path/to/profile/cordis.patch.yml \
DSH_CODEX_MODEL=your-search-capable-model pnpm test
```

OpenAI 联调测试用官方凭据后端只读解析现有凭据，目录/Settings 投影由测试根据 profile 构造；它不等同于正在运行的 GUI 部署验收。完整搜索→抓取联调还需设置 `DSH_SEARCH_E2E_FETCH=1`。所有真实调用默认跳过，不输出密钥或完整响应。

当前已使用现有 OpenAI 兼容端点和 `gpt-6.1-sol` 完成真实搜索，结构化来源检查通过；随后抓取返回来源时，被本机 Fake-IP DNS（`example.com → 198.18.13.86`）触发官方 SSRF 防护阻断。**不宣称本机抓取端到端成功，也未修改正在运行的 profile 或验证浏览器实页。**

网页与答案均属于不可信外部数据，不能被当作系统指令或工具授权。排错时不要打印未脱敏请求头、真实密钥或完整远端错误正文。
