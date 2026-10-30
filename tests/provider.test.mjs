import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { CodexSearchProvider, parseSearchResponse } from '../lib/provider.js'
import { Config } from '../lib/index.js'

const result = {
  status: 'completed', output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: 'https://example.com/a' }] } },
    { type: 'message', content: [{ type: 'output_text', text: 'An answer', annotations: [{ type: 'url_citation', url: 'https://example.com/a', title: 'Example' }] }] },
  ],
}
const defaults = { endpoint: 'https://example.com/responses', apiKey: 'test-secret', model: 'test-model', timeoutMs: 1000, maxResponseBytes: 2000000, maxAnswerChars: 16000 }
async function server(t, handler) {
  const app = createServer(handler)
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { app.closeAllConnections(); app.close(resolve) }))
  return `http://127.0.0.1:${app.address().port}/responses`
}
function hasCode(code) { return error => error.code === code }

test('live config schema permits onboarding and validates field bounds', async () => {
  const valid = await Config['~standard'].validate({})
  assert.equal(valid.issues, undefined)
  assert.equal(valid.value.authMode.get(), 'openai')
  assert.equal(valid.value.endpoint.get(), '')
  assert.equal(valid.value.timeoutMs.get(), 60000)
  assert.equal(valid.value.maxResponseBytes.get(), 2000000)
  assert.equal(valid.value.maxAnswerChars.get(), 16000)
  for (const value of [{ authMode: 'oauth' }, { credentialRef: 'bad-ref' }, { endpoint: 'file:///secret' }, { ...defaults, timeoutMs: 0 }, { ...defaults, maxResponseBytes: -1 }, { ...defaults, maxAnswerChars: 1.5 }]) {
    assert.ok((await Config['~standard'].validate(value)).issues)
  }
})
test('normalizes structured citations, preserves order and upgrades duplicate titles', () => {
  assert.deepEqual(parseSearchResponse(result, 16000), {
    content: 'An answer', sources: [{ url: 'https://example.com/a', title: 'Example' }], truncated: false,
  })
})
test('caps answer without splitting a surrogate pair or falsely marking sources truncated', () => {
  const data = structuredClone(result)
  data.output[1].content[0].text = 'a😀z'
  assert.equal(parseSearchResponse(data, 2).content, 'a')
  assert.equal(parseSearchResponse(data, 2).truncated, false)
  assert.equal(parseSearchResponse(data, 2).sources.length, 1)
})
test('accepts a completed search with no sources as a genuine empty result', () => {
  assert.deepEqual(parseSearchResponse({ status: 'completed', output: [{ type: 'web_search_call', status: 'completed' }] }, 10), { sources: [], truncated: false })
})
test('rejects incomplete responses, missing searches, bad fields, unsafe citations and refusals', () => {
  const variants = [null, {}, { status: 'incomplete', output: [] }, { status: 'completed', output: [] }]
  for (const modify of [
    x => { x.output[0].status = 'failed' },
    x => { x.output[0].action.sources[0].url = 'javascript:alert(1)' },
    x => { x.output[0].action.sources[0].url = 'bad url' },
    x => { x.output[1].content[0].text = 1 },
    x => { x.output[1].content[0].type = 'refusal' },
  ]) { const data = structuredClone(result); modify(data); variants.push(data) }
  for (const data of variants) assert.throws(() => parseSearchResponse(data, 100), hasCode('CODEX_PROTOCOL_ERROR'))
})
test('sends only the query and explicit Responses search fields', async t => {
  let received
  const endpoint = await server(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    received = { authorization: req.headers.authorization, body: JSON.parse(body) }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result))
  })
  const output = await new CodexSearchProvider({ ...defaults, endpoint }).search({ query: 'current news' })
  assert.equal(output.sources.length, 1)
  assert.deepEqual(received, { authorization: 'Bearer test-secret', body: {
    model: 'test-model', store: false, stream: false, input: 'current news',
    tools: [{ type: 'web_search' }], tool_choice: 'required', include: ['web_search_call.action.sources'],
  } })
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
  for (const config of [{ endpoint: 'file:///tmp/x' }, { endpoint: 'https://user:password@example.com' }, { apiKey: ' ' }, { model: '' }]) {
    assert.throws(() => new CodexSearchProvider({ ...defaults, ...config }))
  }
})
