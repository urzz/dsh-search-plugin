import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import { ConfiguredFetchProvider } from './fetch.js'
import { validateCidr } from './cidr.js'

export const name = 'fetch-enhancement'
export const inject = ['web']

export interface Config {
  fetchAllowedCidrs: Volatile<string[]>
  fetchTimeoutMs: Volatile<number>
  fetchMaxResponseBytes: Volatile<number>
  fetchMaxContentChars: Volatile<number>
}

export const Config = Schema.object({
  fetchAllowedCidrs: Schema.array(Schema.transform(Schema.string(), validateCidr, true)).default([]).volatile(),
  fetchTimeoutMs: Schema.number().step(1).min(1).default(30000).volatile(),
  fetchMaxResponseBytes: Schema.number().step(1).min(1).default(5000000).volatile(),
  fetchMaxContentChars: Schema.number().step(1).min(1).default(100000).volatile(),
})

export function apply(ctx: Context, config: Config): void {
  ctx.web.registerFetchProvider(new ConfiguredFetchProvider(() => ({
    allowedCidrs: [...config.fetchAllowedCidrs.get()], timeoutMs: config.fetchTimeoutMs.get(),
    maxResponseBytes: config.fetchMaxResponseBytes.get(), maxContentChars: config.fetchMaxContentChars.get(),
    maxRedirects: 5, userAgent: 'dsh-search-plugin',
  })))
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
