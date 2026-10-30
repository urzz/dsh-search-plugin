import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Config } from '../lib/index.js'
import { ConfiguredSearchProvider } from '../lib/connection.js'

// Use the schema's own reference runtime to simulate Loader's validated commits.
const require = createRequire(import.meta.url)
const schemaRequire = createRequire(require.resolve('@deepseek-ai/schemastery'))
const { updateVolatile } = schemaRequire('@deepseek-ai/cosmokit')

function fixture(input = {}) {
  let raw = { ...input }
  const config = Config(raw)
  const calls = { credentials: [], settings: [], services: [] }
  const state = {
    routes: [{
      provider: 'openai', settingsNs: 'test-llm', settingsPath: ['providers', 'openai'],
      defaultBaseURL: 'https://api.example.test/v1',
      nativeAuth: { env: ['TEST_OPENAI_KEY'] },
    }],
    sections: [{ ns: 'test-llm', value: { providers: { openai: { apiKeyEnv: 'TEST_OPENAI_KEY' } } } }],
    keys: new Map([['TEST_OPENAI_KEY', 'fake-openai-key'], ['DSH_CODEX_API_KEY', 'fake-search-key']]),
  }
  const services = {
    llm: { listConfigurableProviders: () => state.routes },
    settings: { describe: options => { calls.settings.push(options); return state.sections } },
    credentials: { resolve: async ref => {
      calls.credentials.push(ref)
      const value = state.keys.get(ref)
      return value ? { value, source: 'test-memory' } : undefined
    } },
  }
  const ctx = { get: name => { calls.services.push(name); return services[name] } }
  return {
    config, state, services, calls, provider: new ConfiguredSearchProvider(ctx, config),
    profile: () => state.sections[0].value.providers.openai,
    update: patch => {
      raw = { ...raw, ...patch }
      const candidate = Config(raw)
      for (const key of Object.keys(candidate)) updateVolatile(config[key], candidate[key])
    },
  }
}

function configurationError(pattern) {
  return error => error.code === 'CODEX_CONFIGURATION_ERROR' && pattern.test(error.message)
}

test('defaults to the OpenAI provider credential reference without copying unrelated settings', async () => {
  const f = fixture()
  assert.equal(f.config.authMode.get(), 'openai')
  assert.equal(f.config.openaiProvider.get(), 'openai')
  f.profile().model = 'chat-only-model'
  const result = await f.provider.resolve()
  assert.deepEqual(result, {
    endpoint: 'https://api.example.test/v1/alpha/search', apiKey: 'fake-openai-key',
    timeoutMs: 60000, maxResponseBytes: 2000000, maxAnswerChars: 16000,
  })
  assert.deepEqual(f.calls.credentials, ['TEST_OPENAI_KEY'])
  assert.deepEqual(f.calls.settings, [{ redactSecrets: true }])
})

test('accepts an explicit same endpoint and reads changed provider profiles and live limits', async () => {
  const f = fixture({ endpoint: 'https://api.example.test/v1/alpha/search' })
  assert.equal((await f.provider.resolve()).apiKey, 'fake-openai-key')
  const endpointRef = f.config.endpoint
  f.profile().baseURL = 'https://second.example.test/custom/'
  f.profile().apiKeyEnv = 'TEST_SECOND_KEY'
  f.state.keys.set('TEST_SECOND_KEY', 'fake-second-key')
  f.update({ endpoint: '', timeoutMs: 4567, maxResponseBytes: 12345, maxAnswerChars: 321 })
  assert.equal(f.config.endpoint, endpointRef)
  assert.deepEqual(await f.provider.resolve(), {
    endpoint: 'https://second.example.test/custom/alpha/search', apiKey: 'fake-second-key',
    timeoutMs: 4567, maxResponseBytes: 12345, maxAnswerChars: 321,
  })
  assert.deepEqual(f.calls.credentials, ['TEST_OPENAI_KEY', 'TEST_SECOND_KEY'])
})

test('resolves credentials every operation, does not cache keys or mutate prior snapshots', async () => {
  const f = fixture()
  const first = await f.provider.resolve()
  f.state.keys.set('TEST_OPENAI_KEY', 'rotated-fake-key')
  assert.equal((await f.provider.resolve()).apiKey, 'rotated-fake-key')
  assert.equal(first.apiKey, 'fake-openai-key')
  f.state.keys.delete('TEST_OPENAI_KEY')
  await assert.rejects(f.provider.resolve(), configurationError(/API key is unavailable/))
  assert.deepEqual(f.calls.credentials, ['TEST_OPENAI_KEY', 'TEST_OPENAI_KEY', 'TEST_OPENAI_KEY'])
})

test('ignores independent endpoint and literal rather than forwarding reused OpenAI credentials there', async () => {
  const f = fixture({ endpoint: 'https://unrelated.example.test/alpha/search', apiKey: 'unused-literal' })
  const resolved = await f.provider.resolve()
  assert.equal(resolved.endpoint, 'https://api.example.test/v1/alpha/search')
  assert.equal(resolved.apiKey, 'fake-openai-key')
  assert.deepEqual(f.calls.credentials, ['TEST_OPENAI_KEY'])
})

test('does not reuse a stale endpoint after the selected OpenAI profile changes', async () => {
  const f = fixture({ endpoint: 'https://api.example.test/v1/alpha/search' })
  await f.provider.resolve()
  f.profile().baseURL = 'https://new.example.test/v1'
  f.calls.credentials.length = 0
  const resolved = await f.provider.resolve()
  assert.equal(resolved.endpoint, 'https://new.example.test/v1/alpha/search')
  assert.equal(resolved.apiKey, 'fake-openai-key')
  assert.deepEqual(f.calls.credentials, ['TEST_OPENAI_KEY'])
})

test('selects the requested configurable provider rather than the first route', async () => {
  const f = fixture({ openaiProvider: 'openai-work' })
  f.state.routes.push({ ...f.state.routes[0], provider: 'openai-work', settingsPath: ['providers', 'work'] })
  f.state.sections[0].value.providers.work = { baseURL: 'https://work.example.test/v1', apiKeyEnv: 'TEST_WORK_KEY' }
  f.state.keys.set('TEST_WORK_KEY', 'fake-work-key')
  const result = await f.provider.resolve()
  assert.equal(result.endpoint, 'https://work.example.test/v1/alpha/search')
  assert.equal(result.apiKey, 'fake-work-key')
  assert.deepEqual(f.calls.credentials, ['TEST_WORK_KEY'])
})

test('search works without configuring or inheriting any model', async () => {
  const f = fixture()
  f.profile().model = 'chat-model'
  const result = await f.provider.resolve()
  assert.equal(Object.hasOwn(f.config, 'model'), false)
  assert.equal(Object.hasOwn(result, 'model'), false)
  assert.equal(result.endpoint, 'https://api.example.test/v1/alpha/search')
  assert.deepEqual(f.calls.credentials, ['TEST_OPENAI_KEY'])
})

test('reports unavailable API keys and does not fall back to legacy literals in OpenAI mode', async () => {
  const f = fixture({ apiKey: 'must-not-fallback' })
  f.state.keys.clear()
  await assert.rejects(f.provider.resolve(), configurationError(/API key is unavailable.*OAuth reuse is not supported/))
  assert.deepEqual(f.calls.credentials, ['TEST_OPENAI_KEY'])
})

test('reports OAuth-only authentication explicitly instead of inventing a bearer key', async () => {
  const f = fixture()
  delete f.profile().apiKeyEnv
  // Ambient env may exist alongside a stored OAuth/API-key record. Do not bypass that record.
  f.state.routes[0].nativeAuth = { env: ['TEST_OPENAI_KEY'], oauth: true }
  await assert.rejects(f.provider.resolve(), configurationError(/authentication cannot be reused.*dedicated credential/))
  assert.deepEqual(f.calls.credentials, [])
})

for (const [label, mutate, message] of [
  ['missing LLM service', f => { delete f.services.llm }, /requires the LLM and Settings services/],
  ['missing Settings service', f => { delete f.services.settings }, /requires the LLM and Settings services/],
  ['missing route', f => { f.state.routes = [] }, /provider is not configured/],
  ['invalid route', f => { f.state.routes[0].error = 'invalid' }, /repair the selected OpenAI provider/],
  ['missing settings', f => { f.state.sections = [] }, /settings are unavailable/],
  ['custom headers', f => { f.profile().headers = { 'X-Custom-Auth': 'fake-private-value' } }, /custom OpenAI headers cannot be reused/],
]) test(`reports ${label} before touching credentials`, async () => {
  const f = fixture()
  mutate(f)
  await assert.rejects(f.provider.resolve(), configurationError(message))
  assert.deepEqual(f.calls.credentials, [])
})

test('dedicated mode uses its own endpoint and reference without reading OpenAI settings', async () => {
  const f = fixture({ authMode: 'credential', endpoint: 'https://search.example.test/alpha/search', credentialRef: 'TEST_DEDICATED_KEY' })
  delete f.services.llm
  delete f.services.settings
  f.state.keys.set('TEST_DEDICATED_KEY', 'fake-dedicated-key')
  assert.equal((await f.provider.resolve()).apiKey, 'fake-dedicated-key')
  assert.deepEqual(f.calls.credentials, ['TEST_DEDICATED_KEY'])
  assert.deepEqual(f.calls.services, ['credentials'])
  f.update({ credentialRef: 'DSH_CODEX_API_KEY' })
  assert.equal((await f.provider.resolve()).apiKey, 'fake-search-key')
})

test('legacy literal takes precedence only in dedicated mode; clearing it restores reference lookup', async () => {
  const f = fixture({ authMode: 'credential', endpoint: 'https://search.example.test/alpha/search', apiKey: 'fake-legacy-key' })
  assert.equal((await f.provider.resolve()).apiKey, 'fake-legacy-key')
  assert.deepEqual(f.calls.credentials, [])
  f.update({ apiKey: undefined })
  assert.equal((await f.provider.resolve()).apiKey, 'fake-search-key')
  assert.deepEqual(f.calls.credentials, ['DSH_CODEX_API_KEY'])
  f.update({ authMode: 'openai', endpoint: '', apiKey: 'unused-legacy-key' })
  assert.equal((await f.provider.resolve()).apiKey, 'fake-openai-key')
  assert.deepEqual(f.calls.credentials, ['DSH_CODEX_API_KEY', 'TEST_OPENAI_KEY'])
})

test('dedicated mode rejects a missing endpoint before resolving credentials', async () => {
  const f = fixture({ authMode: 'credential', endpoint: '' })
  await assert.rejects(f.provider.resolve(), configurationError(/Alpha Search.*端点/))
  assert.deepEqual(f.calls.credentials, [])
})

test('reports a missing credential service without exposing configuration or secrets', async () => {
  const f = fixture()
  delete f.services.credentials
  await assert.rejects(f.provider.resolve(), error => configurationError(/API key is unavailable/)(error) && !error.message.includes('fake-openai-key'))
})

test('a pre-aborted search does not resolve services or credentials', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => assert.fail('network must not be accessed'))
  const f = fixture()
  const reason = new Error('cancel before resolution')
  await assert.rejects(f.provider.search({ query: 'unused' }, AbortSignal.abort(reason)), error => error === reason)
  assert.deepEqual(f.calls.services, [])
  assert.equal(network.mock.callCount(), 0)
})

test('cancellation during credential resolution stops before any network request', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => assert.fail('network must not be accessed'))
  const f = fixture()
  let release
  let entered
  const started = new Promise(resolve => { entered = resolve })
  f.services.credentials.resolve = async ref => {
    f.calls.credentials.push(ref)
    entered()
    return new Promise(resolve => { release = resolve })
  }
  const controller = new AbortController()
  const reason = new Error('cancel during resolution')
  const pending = f.provider.search({ query: 'unused' }, controller.signal)
  await started
  controller.abort(reason)
  release({ value: 'fake-openai-key', source: 'test-memory' })
  await assert.rejects(pending, error => error === reason)
  assert.deepEqual(f.calls.credentials, ['TEST_OPENAI_KEY'])
  assert.equal(network.mock.callCount(), 0)
})
