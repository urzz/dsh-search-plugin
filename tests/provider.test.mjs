import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { CodexSearchProvider, parseSearchResponse } from '../lib/provider.js'
import { Config } from '../lib/index.js'

const result = {
  output: 'An answer',
  results: [{ url: 'https://example.com/a' }, { url: 'https://example.com/a', title: 'Example' }],
}
const defaults = { endpoint: 'https://example.com/v1/alpha/search', apiKey: 'test-secret', timeoutMs: 1000, maxResponseBytes: 2000000, maxAnswerChars: 16000 }
async function server(t, handler) {
  const app = createServer(handler)
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { app.closeAllConnections(); app.close(resolve) }))
  return `http://127.0.0.1:${app.address().port}/v1/alpha/search`
}
function hasCode(code) { return error => error.code === code }

test('live config schema permits onboarding without a model and validates field bounds', async () => {
  const valid = await Config['~standard'].validate({})
  assert.equal(valid.issues, undefined)
  assert.equal(valid.value.authMode.get(), 'openai')
  assert.equal(valid.value.endpoint.get(), '')
  assert.equal(Object.hasOwn(valid.value, 'model'), false)
  assert.equal(valid.value.timeoutMs.get(), 60000)
  assert.equal(valid.value.maxResponseBytes.get(), 2000000)
  assert.equal(valid.value.maxAnswerChars.get(), 16000)
  for (const value of [{ authMode: 'oauth' }, { credentialRef: 'bad-ref' }, { endpoint: 'file:///secret' }, { ...defaults, timeoutMs: 0 }, { ...defaults, maxResponseBytes: -1 }, { ...defaults, maxAnswerChars: 1.5 }]) {
    assert.ok((await Config['~standard'].validate(value)).issues)
  }
})
test('deduplicates structured Alpha sources in order and upgrades missing titles', () => {
  const data = { ...result, results: [...result.results, { url: 'https://example.com/b', title: 'Second' }, { url: 'https://example.com/a', title: 'Do not replace' }] }
  assert.deepEqual(parseSearchResponse(data, 16000), {
    content: 'An answer', sources: [{ url: 'https://example.com/a', title: 'Example' }, { url: 'https://example.com/b', title: 'Second' }], truncated: false,
  })
})
test('caps answer without splitting a surrogate pair or falsely marking sources truncated', () => {
  const data = { ...result, output: 'a😀z' }
  assert.equal(parseSearchResponse(data, 2).content, 'a')
  assert.equal(parseSearchResponse(data, 2).truncated, false)
  assert.equal(parseSearchResponse(data, 2).sources.length, 1)
})
test('accepts empty output and missing, null or empty results', () => {
  for (const data of [{ output: '' }, { output: '', results: null }, { output: '', results: [] }]) {
    assert.deepEqual(parseSearchResponse(data, 10), { sources: [], truncated: false })
  }
  assert.deepEqual(parseSearchResponse({ output: 'Answer without sources' }, 100), { content: 'Answer without sources', sources: [], truncated: false })
})
test('ignores opaque non-web results and unsafe URLs without inventing citations from prose', () => {
  const data = { output: 'See https://not-a-source.example', results: [null, false, 12, 'opaque', {}, { ref_id: 'turn0' }, { url: 7 }, { url: 'bad url' }, { url: 'javascript:alert(1)' }, { url: 'file:///tmp/a' }, { url: 'https://user:secret@example.com' }, { url: 'https://example.com/a', title: 5 }] }
  assert.deepEqual(parseSearchResponse(data, 100), { content: data.output, sources: [{ url: 'https://example.com/a' }], truncated: false })
})
test('removes Alpha reference markers and word limits while keeping ordinary text', () => {
  const data = { ...result, output: ' First citeturn0search0 [wordlim: 200] and second citeturn0search1turn0search2. ' }
  assert.deepEqual(parseSearchResponse(data, 100), { content: 'First  and second .', sources: [{ url: 'https://example.com/a', title: 'Example' }], truncated: false })
  assert.equal(parseSearchResponse({ output: 'citeturn0search0 [wordlim: 12]' }, 100).content, undefined)
})
test('rejects malformed Alpha envelopes and Responses output arrays', () => {
  for (const data of [null, [], {}, { output: 1 }, { output: null }, { output: [] }, { output: 'answer', results: {} }, { output: 'answer', results: 'bad' }, { status: 'completed', output: [{ type: 'web_search_call', status: 'completed' }] }]) {
    assert.throws(() => parseSearchResponse(data, 100), hasCode('CODEX_PROTOCOL_ERROR'))
  }
})
test('sends the exact Alpha command envelope with a fixed routing model, not Responses fields', async t => {
  let received
  const endpoint = await server(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    received = { url: req.url, method: req.method, authorization: req.headers.authorization, body: JSON.parse(body) }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result))
  })
  const output = await new CodexSearchProvider({ ...defaults, endpoint }).search({ query: 'current news' })
  assert.equal(output.sources.length, 1)
  assert.match(received.body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  const { id, ...body } = received.body
  assert.deepEqual({ ...received, body }, { url: '/v1/alpha/search', method: 'POST', authorization: 'Bearer test-secret', body: {
    model: 'gpt-5.6-luna',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'current news' }] }],
    commands: { search_query: [{ q: 'current news' }] },
    settings: { allowed_callers: ['direct'], external_web_access: true }, max_output_tokens: 2048,
  } })
  for (const field of ['tools', 'tool_choice', 'include', 'store', 'stream']) assert.equal(Object.hasOwn(body, field), false)
})
test('rejects redirects without contacting the target', async t => {
  let contacted = false
  const target = await server(t, (_req, res) => { contacted = true; res.end('{}') })
  const endpoint = await server(t, (_req, res) => { res.writeHead(302, { Location: target }); res.end() })
  await assert.rejects(new CodexSearchProvider({ ...defaults, endpoint }).search({ query: 'x' }), hasCode('CODEX_HTTP_ERROR'))
  assert.equal(contacted, false)
})
for (const status of [401, 429, 500]) test(`reports HTTP ${status} without echoing upstream secrets`, async t => {
  const endpoint = await server(t, (_req, res) => { res.writeHead(status); res.end('test-secret') })
  await assert.rejects(new CodexSearchProvider({ ...defaults, endpoint }).search({ query: 'x' }), error => error.code === 'CODEX_HTTP_ERROR' && !error.message.includes('test-secret') && error.message.includes(String(status)))
})
test('rejects oversized bodies and invalid JSON/SSE', async t => {
  const endpoint = await server(t, (_req, res) => res.end('x'.repeat(100)))
  await assert.rejects(new CodexSearchProvider({ ...defaults, endpoint, maxResponseBytes: 10 }).search({ query: 'x' }), hasCode('CODEX_RESPONSE_TOO_LARGE'))
  await assert.rejects(new CodexSearchProvider({ ...defaults, endpoint }).search({ query: 'x' }), hasCode('CODEX_PROTOCOL_ERROR'))
  const sse = await server(t, (_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: {"output":"answer"}\n\n') })
  await assert.rejects(new CodexSearchProvider({ ...defaults, endpoint: sse }).search({ query: 'x' }), hasCode('CODEX_PROTOCOL_ERROR'))
})
test('enforces timeout while waiting for response', async t => {
  const endpoint = await server(t, () => {})
  await assert.rejects(new CodexSearchProvider({ ...defaults, endpoint, timeoutMs: 20 }).search({ query: 'x' }), hasCode('CODEX_TIMEOUT'))
})
test('honors cancellation before and during body streaming', async t => {
  const endpoint = await server(t, (_req, res) => { res.writeHead(200); res.write('{') })
  const provider = new CodexSearchProvider({ ...defaults, endpoint })
  await assert.rejects(provider.search({ query: 'x' }, AbortSignal.abort()), hasCode('WEB_ABORTED'))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30)
  try { await assert.rejects(provider.search({ query: 'x' }, controller.signal), hasCode('WEB_ABORTED')) }
  finally { clearTimeout(timer) }
})
test('rejects invalid endpoint and empty credentials at load', () => {
  for (const config of [{ endpoint: 'file:///tmp/x' }, { endpoint: 'https://user:password@example.com' }, { endpoint: 'https://example.com/#fragment' }, { apiKey: ' ' }]) {
    assert.throws(() => new CodexSearchProvider({ ...defaults, ...config }))
  }
})
