import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexSearchProvider } from '../lib/provider.js'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as httpFetch from '@deepseek-ai/dsh-web-fetch-http'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { Config } from '../lib/index.js'
import { ConfiguredSearchProvider } from '../lib/connection.js'

// Explicit opt-in: this makes real network calls and can incur search API charges.
// Uses the official credential backend read-only; no key is copied into files or environment.
test('real OpenAI credential-reference reuse and Responses search', { skip: process.env.DSH_SEARCH_E2E_OPENAI !== '1' }, async t => {
  const patch = process.env.DSH_SEARCH_E2E_PROFILE_PATCH
  const model = process.env.DSH_CODEX_MODEL
  assert.ok(patch && model, 'Set DSH_SEARCH_E2E_PROFILE_PATCH and DSH_CODEX_MODEL')
  const rows = loadOverlayPatches('search-e2e', patch)
  const profile = rows.find(row => row.config?.providers?.openai)?.config.providers.openai
  assert.ok(profile && typeof profile.baseURL === 'string' && typeof profile.apiKeyEnv === 'string', 'Profile must contain an OpenAI baseURL and credential reference')
  const ctx = new Context()
  const fibers = []
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose() })
  fibers.push(await ctx.plugin(LocalCredentialProvider, { watch: false }))
  fibers.push(await ctx.plugin(WebRuntime, { fetchProvider: 'http' }))
  fibers.push(await ctx.plugin(httpFetch, {}))
  // The directory and Settings shape mirrors the live profile; credentials are
  // resolved by the real backend, and the complete search path uses the adapter.
  const services = {
    llm: { listConfigurableProviders: () => [{ provider: 'openai', settingsNs: 'e2e-openai', settingsPath: [] }] },
    settings: { describe: () => [{ ns: 'e2e-openai', value: { baseURL: profile.baseURL, apiKeyEnv: profile.apiKeyEnv } }] },
    credentials: ctx.get('credentials'),
  }
  const provider = new ConfiguredSearchProvider({ get: name => services[name] }, Config({ model }))
  const result = await provider.search({ query: 'Find the official example.com website and cite its URL', maxResults: 3 })
  assert.ok(result.sources.length > 0, 'Real search must return structured sources')
  t.diagnostic(`Search returned ${result.sources.length} structured sources`)
  await t.test('HTTP fetch of a returned source', { skip: process.env.DSH_SEARCH_E2E_FETCH !== '1' }, async () => {
    const page = await ctx.web.fetch({ url: result.sources[0].url })
    assert.ok(page.statusCode >= 200 && page.statusCode < 300, 'A returned source must be publicly fetchable')
    assert.ok(page.body.content.length > 0)
  })
})
test('real Responses search followed by local HTTP fetch', { skip: process.env.DSH_SEARCH_E2E !== '1' }, async t => {
  const { DSH_CODEX_ENDPOINT: endpoint, DSH_CODEX_API_KEY: apiKey, DSH_CODEX_MODEL: model } = process.env
  assert.ok(endpoint && apiKey && model, 'Set DSH_CODEX_ENDPOINT, DSH_CODEX_API_KEY and DSH_CODEX_MODEL')
  const provider = new CodexSearchProvider({ endpoint, apiKey, model, timeoutMs: 60000, maxResponseBytes: 2000000, maxAnswerChars: 16000 })
  const result = await provider.search({ query: 'Find the official example.com website', maxResults: 3 })
  assert.ok(result.sources.length > 0, 'Search must return structured sources')
  const ctx = new Context()
  const fibers = []
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose() })
  fibers.push(await ctx.plugin(WebRuntime, { fetchProvider: 'http' }))
  fibers.push(await ctx.plugin(httpFetch, {}))
  const page = await ctx.web.fetch({ url: result.sources[0].url })
  assert.ok(page.statusCode >= 100 && page.statusCode <= 599)
  assert.ok(page.body.content.length > 0)
})
