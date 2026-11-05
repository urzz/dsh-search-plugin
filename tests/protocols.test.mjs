import test from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../lib/index.js'
import { ConfiguredSearchProvider } from '../lib/connection.js'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { updateVolatile } = createRequire(require.resolve('@deepseek-ai/schemastery'))('@deepseek-ai/cosmokit')

test('protocol selection changes live, keeps credential domains separate and uses official DeepSeek request', async t => {
  const config = Config({ protocol: 'deepseek-search-api', deepseekEndpoint: 'https://search.example.test/v1/tools', deepseekCount: 8 })
  const refs = []
  const ctx = { get: name => {
    if (name !== 'credentials') return undefined
    return { resolve: async ref => { refs.push(ref); return { value: 'test-deepseek-key' } } }
  } }
  const network = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), 'https://search.example.test/v1/tools/search')
    assert.deepEqual(JSON.parse(init.body), { query: 'query', count: 3, need_content: false })
    return new Response(JSON.stringify({ results: [{ url: 'https://example.com', title: 'Example', snippet: 'text', date: null }] }))
  })
  const provider = new ConfiguredSearchProvider(ctx, config)
  const result = await provider.search({ query: 'query', maxResults: 3 })
  assert.deepEqual(result.sources, [{ url: 'https://example.com', title: 'Example', snippet: 'text' }])
  assert.deepEqual(refs, ['DEEPSEEK_API_KEY'])
  updateVolatile(config.protocol, Config({ protocol: 'codex-alpha' }).protocol)
  await assert.rejects(provider.search({ query: 'unused' }), /OpenAI authentication reuse/)
  assert.equal(network.mock.callCount(), 1)
})

test('schema rejects unknown protocols, invalid count and malformed address allowlists', () => {
  assert.throws(() => Config({ protocol: 'guess' }))
  assert.throws(() => Config({ deepseekCount: 51 }))
  assert.throws(() => Config({ fetchAllowedCidrs: ['198.18.0.1/15'] }))
  assert.deepEqual(Config({}).fetchAllowedCidrs.get(), [])
  assert.deepEqual(Config({ fetchAllowedCidrs: ['198.18.0.0/15', '192.168.96.0/20'] }).fetchAllowedCidrs.get(), ['198.18.0.0/15', '192.168.96.0/20'])
})
