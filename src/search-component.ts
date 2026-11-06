import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ConfiguredSearchProvider } from './connection.js'

export const name = 'search-enhancement'
export const inject = ['web']

/** Live search settings. Credentials are resolved by reference for each operation. */
export interface Config {
  protocol: Volatile<'codex-alpha' | 'deepseek-search-api'>
  deepseekEndpoint: Volatile<string>
  deepseekCredentialRef: Volatile<string>
  deepseekCount: Volatile<number>
  authMode: Volatile<'openai' | 'credential'>
  openaiProvider: Volatile<string>
  credentialRef: Volatile<string>
  endpoint: Volatile<string>
  apiKey: Volatile<string | undefined>
  timeoutMs: Volatile<number>
  maxResponseBytes: Volatile<number>
  maxAnswerChars: Volatile<number>
}

export const Config = Schema.object({
  protocol: Schema.union(['codex-alpha', 'deepseek-search-api']).default('codex-alpha').volatile(),
  deepseekEndpoint: Schema.string().pattern(/^https?:\/\/[^\s]+$/).default('https://api.deepseek.com/v1/tools').volatile(),
  deepseekCredentialRef: Schema.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).default('DEEPSEEK_API_KEY').volatile(),
  deepseekCount: Schema.number().step(1).min(1).max(50).default(10).volatile(),
  authMode: Schema.union(['openai', 'credential']).default('openai').volatile(),
  openaiProvider: Schema.string().min(1).default('openai').volatile(),
  credentialRef: Schema.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).default('DSH_CODEX_API_KEY').volatile(),
  endpoint: Schema.string().pattern(/^$|^https?:\/\/[^\s]+$/).default('').volatile(),
  apiKey: Schema.string().role('secret').volatile(),
  timeoutMs: Schema.number().step(1).min(1).default(60000).volatile(),
  maxResponseBytes: Schema.number().step(1).min(1).default(2000000).volatile(),
  maxAnswerChars: Schema.number().step(1).min(1).default(16000).volatile(),
})

export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new ConfiguredSearchProvider(ctx, config))
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
