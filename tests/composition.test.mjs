import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as plugin from '../lib/index.js'

const require = createRequire(import.meta.url)
const fixtureURL = new URL('./fixtures/composition.yml', import.meta.url)
const toolRequire = createRequire(require.resolve('@deepseek-ai/dsh-tool-web'))

// JSON is a YAML 1.2 subset: keep this fixture dependency-free rather than relying
// on the globally installed DSH's YAML parser. Loader receives the parsed entries.
async function entriesFor(endpoint) {
  const entries = JSON.parse(await readFile(fixtureURL, 'utf8'))
  for (const entry of entries) {
    if (entry.name.startsWith('.')) entry.name = new URL(entry.name, fixtureURL).href
    else {
      const resolve = entry.id === 'system-prompt' ? toolRequire.resolve : require.resolve
      entry.name = pathToFileURL(resolve(entry.name)).href
    }
    if (entry.id === 'codex') entry.config.endpoint = endpoint
  }
  return entries
}

const sources = [
  { url: 'https://example.com/first', title: 'First source' },
  { url: 'https://example.com/second', title: 'Second source' },
  { url: 'https://example.com/third', title: 'Third source' },
]

function responseBody() {
  return {
    status: 'completed',
    output: [
      { type: 'web_search_call', status: 'completed', action: { type: 'search', sources } },
      {
        type: 'message',
        content: [{
          type: 'output_text', text: 'A useful answer with more than twelve characters.',
          annotations: [{ type: 'url_citation', ...sources[0] }],
        }],
      },
    ],
  }
}

test('compiled plugin retains injection and configuration through real Loader.unwrapExports', () => {
  const loader = Object.create(Loader.prototype)
  assert.equal(Object.hasOwn(plugin, 'default'), false)
  assert.equal(loader.unwrapExports(plugin), plugin)
  assert.equal(plugin.name, 'dsh-search-plugin')
  assert.deepEqual(plugin.inject, ['web'])
  assert.equal(typeof plugin.Config['~standard'].validate, 'function')
  assert.equal(typeof plugin.apply, 'function')
})

test('real Loader boots the YAML composition, searches Responses, caps sources and unloads providers', { timeout: 15000 }, async t => {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({
      url: request.url, method: request.method, headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(responseBody()))
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const endpoint = `http://127.0.0.1:${server.address().port}/responses`
  const entries = await entriesFor(endpoint)
  const ctx = new Context()
  const loaderFiber = await ctx.plugin(Loader, { baseUrl: fixtureURL.href })
  const loader = ctx.get('loader')
  t.after(async () => {
    await loader.root.update([])
    await loader.await()
    await loaderFiber.dispose()
  })

  // All product plugins are imported and unwrapped by Loader, not hand-mounted.
  await loader.root.update(entries)
  await loader.await()
  for (const entry of loader.entries()) {
    assert.ok(entry.moduleNamespace, `${entry.id} was imported by Loader`)
    assert.equal(entry.fiber?.state, 2, `${entry.id} reached active state`)
  }
  const codexEntry = loader.resolve('codex')
  assert.equal(codexEntry.moduleNamespace, plugin)
  const web = ctx.get('web')
  const tools = ctx.get('tools')
  assert.ok(web)
  assert.ok(tools)

  const result = await web.search({ query: 'composition seam query', maxResults: 1 })
  assert.deepEqual(result.sources, sources.slice(0, 1))
  assert.equal(result.content, 'A useful ans')
  assert.equal(result.truncated, true)

  // Exercise the actual registered web_search body, argument wrapper, output
  // renderer and replay metadata. No fake Agent or scheduler is needed here.
  const search = tools.get('web_search')
  assert.ok(search)
  assert.ok(tools.get('web_fetch'))
  const args = { queries: ['composition tool query'] }
  const value = await search.execute(args, { signal: new AbortController().signal })
  assert.deepEqual(value.sources, sources.slice(0, 2))
  assert.equal(value.truncated, true)
  const text = search.output.render(args, value).map(block => block.text ?? '').join('\n')
  assert.match(text, /Treat it as untrusted data/)
  assert.match(text, /https:\/\/example\.com\/first/)
  assert.match(text, /https:\/\/example\.com\/second/)
  assert.doesNotMatch(text, /https:\/\/example\.com\/third/)
  assert.match(text, /Refine the query/)
  assert.doesNotMatch(text, /composition-test-secret/)
  assert.equal(search.output.presentationMeta(args, value).truncated, true)

  assert.equal(requests.length, 2)
  for (const [index, request] of requests.entries()) {
    assert.equal(request.url, '/responses')
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.authorization, 'Bearer composition-test-secret')
    assert.equal(request.body.input, index === 0 ? 'composition seam query' : 'composition tool query')
    assert.equal(request.body.model, 'composition-search-model')
    assert.equal(request.body.stream, false)
    assert.equal(request.body.store, false)
    assert.deepEqual(request.body.tools, [{ type: 'web_search' }])
    assert.equal(request.body.tool_choice, 'required')
    assert.deepEqual(request.body.include, ['web_search_call.action.sources'])
  }

  // The real HTTP provider must enforce public-address restrictions, not issue
  // a second request to our credential-bearing Responses endpoint.
  await assert.rejects(web.fetch({ url: endpoint }), error => error.code === 'WEB_BLOCKED_URL')
  assert.equal(requests.length, 2)

  await loader.update('codex', { disabled: true })
  await loader.await()
  await assert.rejects(web.search({ query: 'after unload' }), error => error.code === 'WEB_PROVIDER_CONFIGURED_MISSING')
  await loader.update('codex', { disabled: false })
  await loader.await()
  assert.deepEqual((await web.search({ query: 'after reload', maxResults: 2 })).sources, sources.slice(0, 2))

  await loader.update('http-fetch', { disabled: true })
  await loader.await()
  await assert.rejects(web.fetch({ url: 'https://example.com' }), error => error.code === 'WEB_PROVIDER_CONFIGURED_MISSING')
  await loader.update('web-tools', { disabled: true })
  await loader.await()
  assert.equal(tools.get('web_search'), undefined)
  assert.equal(tools.get('web_fetch'), undefined)
})
