/** Compatibility entry for legacy direct-module configurations. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import * as search from './search-component.js'
import * as fetch from './fetch-component.js'

export const name = 'dsh-search-plugin'
export const inject = ['web']
export interface Config extends search.Config, fetch.Config { uiOnly: boolean }
export const Config = Schema.object({
  ...search.Config.dict, ...fetch.Config.dict,
  uiOnly: Schema.boolean().default(false).hidden(),
})
export const applySearch = search.apply
export const applyFetch = fetch.apply

export function apply(ctx: Context, config: Config): void {
  if (config.uiOnly) {
    ctx.inject(['settings'], child => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
    return
  }
  search.apply(ctx, config)
  fetch.apply(ctx, config)
}
