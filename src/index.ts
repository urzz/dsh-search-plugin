import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ConfiguredSearchProvider } from './connection.js'

export const name = 'dsh-search-plugin'
export const inject = ['web']

/** Live search settings. Credentials are resolved by reference for each operation. */
export interface Config {
  authMode: Volatile<'openai' | 'credential'>
  openaiProvider: Volatile<string>
  credentialRef: Volatile<string>
  endpoint: Volatile<string>
  apiKey: Volatile<string | undefined>
  model: Volatile<string>
  timeoutMs: Volatile<number>
  maxResponseBytes: Volatile<number>
  maxAnswerChars: Volatile<number>
}

export const Config = Schema.object({
  authMode: Schema.union(['openai', 'credential']).default('openai').volatile(),
  openaiProvider: Schema.string().min(1).default('openai').volatile(),
  credentialRef: Schema.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).default('DSH_CODEX_API_KEY').volatile(),
  endpoint: Schema.string().pattern(/^$|^https?:\/\/[^\s]+$/).default('').volatile(),
  apiKey: Schema.string().role('secret').volatile(),
  model: Schema.string().default('').volatile(),
  timeoutMs: Schema.number().step(1).min(1).default(60000).volatile(),
  maxResponseBytes: Schema.number().step(1).min(1).default(2000000).volatile(),
  maxAnswerChars: Schema.number().step(1).min(1).default(16000).volatile(),
})

/** Register the provider; Cordis owns its registration and optional settings policy. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new ConfiguredSearchProvider(ctx, config))
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
