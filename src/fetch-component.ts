import type { Context } from '@deepseek-ai/cordis'
import { applyFetch } from './index.js'

export const name = 'fetch-enhancement'
export const inject = ['web', 'networkEnhancementConfig']

export function apply(ctx: Context): void {
  applyFetch(ctx, ctx.networkEnhancementConfig)
}
