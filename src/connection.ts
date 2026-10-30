import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult } from '@deepseek-ai/dsh-web'
import type { Config } from './index.js'
import { CodexSearchProvider, type ResponsesConfig } from './provider.js'

function fail(message: string): never {
  throw new WebError(`Web search: ${message}`, 'CODEX_CONFIGURATION_ERROR')
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('OpenAI provider configuration is unavailable')
  return value as Record<string, unknown>
}

/** Resolve configuration and credentials for each search, without retaining secrets between operations. */
export class ConfiguredSearchProvider implements WebSearchProvider {
  readonly id = 'codex'
  constructor(private readonly ctx: Context, private readonly config: Config) {}

  available(): boolean { return true }

  /** Capture endpoint, model, limits and the selected credential as one request configuration. */
  async resolve(): Promise<ResponsesConfig> {
    const config = this.config
    let endpoint = config.endpoint.get()
    let model = config.model.get()
    let ref = config.credentialRef.get()
    const literal = config.apiKey.get()
    const limits = {
      timeoutMs: config.timeoutMs.get(), maxResponseBytes: config.maxResponseBytes.get(),
      maxAnswerChars: config.maxAnswerChars.get(),
    }
    if (config.authMode.get() === 'openai') {
      const provider = config.openaiProvider.get()
      const llm = this.ctx.get('llm')
      const settings = this.ctx.get('settings')
      if (!llm || !settings) fail('OpenAI authentication reuse requires the LLM and Settings services')
      const route = llm.listConfigurableProviders().find(entry => entry.provider === provider)
      if (!route) fail('selected OpenAI provider is not configured')
      if (route.error) fail('repair the selected OpenAI provider in model settings')
      const section = settings.describe({ redactSecrets: true }).find(entry => entry.ns === route.settingsNs)
      if (!section) fail('selected OpenAI provider settings are unavailable')
      let value: unknown = section.value
      for (const key of route.settingsPath) value = record(value)[key]
      const profile = record(value)
      if (profile.headers !== undefined && Object.keys(record(profile.headers)).length) {
        fail('custom OpenAI headers cannot be reused; configure a dedicated credential')
      }
      let base = typeof profile.baseURL === 'string' && profile.baseURL ? profile.baseURL : undefined
      if (!base) for (const name of route.baseURLEnv ?? []) {
        if (process.env[name]) { base = process.env[name]; break }
      }
      base ??= route.defaultBaseURL
      if (!base) fail('selected OpenAI provider has no endpoint')
      const expected = new URL(`${base.replace(/\/+$/, '')}/responses`)
      if (endpoint && new URL(endpoint).href !== expected.href) {
        fail('a different search endpoint requires dedicated credential mode; OpenAI credentials were not forwarded')
      }
      endpoint = expected.href
      if (!model) fail('搜索模型未配置。请打开「插件 → 联网搜索 → 配置」，填写支持 web_search 的模型并保存')
      ref = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : ''
      if (!ref) fail('this provider authentication cannot be reused; configure a dedicated credential')
    }
    if (!endpoint || !model) fail('请打开「插件 → 联网搜索 → 配置」，填写 Responses 端点和支持 web_search 的模型并保存')
    const credentials = this.ctx.get('credentials')
    const key = config.authMode.get() === 'credential' && literal
      ? literal : ref && credentials ? (await credentials.resolve(credentialRef(ref)))?.value : undefined
    if (!key) fail('API key is unavailable; configure the selected credential (OAuth reuse is not supported)')
    return { endpoint, model, apiKey: key, ...limits }
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    signal?.throwIfAborted()
    const resolved = await this.resolve()
    signal?.throwIfAborted()
    return new CodexSearchProvider(resolved).search(request, signal)
  }
}
