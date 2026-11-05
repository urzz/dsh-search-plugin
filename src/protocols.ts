/** Protocol factories are the extension point; each captures one operation's settings. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { DeepSeekSearchApiProvider } from '@deepseek-ai/dsh-web-deepseek-api'
import type { WebSearchProvider } from '@deepseek-ai/dsh-web'
import type { Config } from './index.js'
import { CodexSearchProvider, type AlphaSearchConfig } from './provider.js'

export type SearchProtocol = 'codex-alpha' | 'deepseek-search-api'
type Factory = (ctx: Context, config: Config, alpha: () => Promise<AlphaSearchConfig>) => Promise<WebSearchProvider>

export const searchProtocols: Record<SearchProtocol, Factory> = {
  'codex-alpha': async (_ctx, _config, alpha) => new CodexSearchProvider(await alpha()),
  'deepseek-search-api': async (ctx, config) => {
    const baseURL = config.deepseekEndpoint.get()
    const count = config.deepseekCount.get()
    const ref = credentialRef(config.deepseekCredentialRef.get())
    return new DeepSeekSearchApiProvider(() => ({
      baseURL, count, apiKeyEnv: ref,
      resolveApiKey: async () => (await ctx.get('credentials')?.resolve(ref))?.value,
    }))
  },
}
