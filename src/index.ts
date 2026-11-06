/** Compatibility entry for legacy direct-module configurations. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import * as search from './search-component.js'
import * as fetch from './fetch-component.js'

export const name = 'dsh-search-plugin'
export const inject = ['web']
export interface Config extends search.Config, fetch.Config {}
export const Config = Schema.object({ ...search.Config.dict, ...fetch.Config.dict })
export const applySearch = search.apply
export const applyFetch = fetch.apply

export function apply(ctx: Context, config: Config): void {
  search.apply(ctx, config)
  fetch.apply(ctx, config)
}
