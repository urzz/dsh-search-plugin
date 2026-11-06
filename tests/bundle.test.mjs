import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { createServer } from 'node:http'
import * as searchComponent from '../lib/search-component.js'
import * as fetchComponent from '../lib/fetch-component.js'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { bundlePatchPaths, composeEntries, loadOverlayPatches, readPluginMeta } from '@deepseek-ai/dsh-app-boot'

const require = createRequire(import.meta.url)
const packageURL = new URL('../', import.meta.url)
const basePatchURL = new URL('./fixtures/bundle-base.patch.yml', import.meta.url)

test('official metadata resolver reads exported titles and descriptions without executing the plugin', () => {
  const meta = readPluginMeta('dsh-search-plugin', import.meta.url)
  assert.equal(meta.title.zh, '联网增强界面')
  assert.equal(meta.title.en, 'Shared web enhancement UI')
  for (const [component, title] of [['search', '搜索增强'], ['fetch', 'Fetch增强']]) {
    const metadata = readPluginMeta(`dsh-search-plugin/${component}`, import.meta.url)
    assert.equal(metadata.title.zh, title)
    assert.equal(metadata.error, undefined)
  }
  assert.equal(meta.description.zh, '搜索增强与 Fetch 增强的共享配置和状态界面。')
  assert.equal(meta.description.en, 'Shared configuration and status for web search and fetch providers.')
})

function assertEvaluated(value) {
  if (value === null || typeof value !== 'object') return
  if (typeof value.get === 'function') return assertEvaluated(value.get())
  assert.equal(Object.hasOwn(value, '__jsExpr'), false, 'Loader must evaluate YAML expressions before activation')
  for (const child of Object.values(value)) assertEvaluated(child)
}

test('shipped bundle preserves preceding HTTP limits and boots its composed entries through Loader', async t => {
  const manifest = JSON.parse(await readFile(new URL('package.json', packageURL), 'utf8'))
  const basePatches = loadOverlayPatches('bundle-test', fileURLToPath(basePatchURL))
  const bundleFiles = bundlePatchPaths(fileURLToPath(packageURL), manifest.dsh.bundle)
  assert.ok(bundleFiles.length > 0)
  const bundleLayers = bundleFiles.map(file => loadOverlayPatches('bundle-test', file))
  const warnings = []
  const entries = composeEntries([basePatches, ...bundleLayers], warning => warnings.push(warning))
  assert.deepEqual(warnings, [], 'every shipped patch must match the preceding bundle')

  const web = entries.find(entry => entry.id === 'web')
  assert.equal(web.config.searchProvider, 'codex')
  assert.equal(web.config.fetchProvider, 'search-http')
  const previousHttp = composeEntries([basePatches]).find(entry => entry.id === 'web-fetch-http')
  const http = entries.find(entry => entry.id === 'web-fetch-http')
  assert.deepEqual(http.config, previousHttp.config, 'search must not replace an earlier bundle\'s HTTP policy')
  assert.equal(entries.filter(entry => entry.id === 'web-fetch-http').length, 1)
  const uiEntry = entries.find(entry => entry.id === 'dsh-search-ui')
  assert.equal(uiEntry.name, manifest.name, 'browser discovery requires a bare-package entry')
  assert.equal(uiEntry.config.uiOnly, true, 'the browser carrier must not register providers')
  const pluginEntries = entries.filter(entry => entry.name.startsWith(`${manifest.name}/`))
  assert.deepEqual(pluginEntries.map(entry => entry.name), ['dsh-search-plugin/search', 'dsh-search-plugin/fetch'])

  // Scope !!js process.env to synthetic values, never the developer's real keys.
  // The provider is activated but never searched, so no remote request is made.
  const ctx = new Context()
  ctx.process = { env: {
    DSH_BUNDLE_TEST_USER_AGENT: 'dsh-bundle-test-agent',
    DSH_CODEX_ENDPOINT: 'https://bundle-test.invalid/v1/alpha/search',
    DSH_CODEX_API_KEY: 'bundle-test-placeholder-not-a-secret',
  } }
  const loaderFiber = await ctx.plugin(Loader, { baseUrl: packageURL.href })
  const loader = ctx.get('loader')
  t.after(async () => {
    await loader.root.update([])
    await loader.await()
    await loaderFiber.dispose()
  })
  // Normal Node resolution supplies the compiled self package and official
  // plugins; only the external package-name resolution is converted to URLs.
  const mounted = entries.map(entry => ({
    ...entry,
    name: entry.name === manifest.name
      ? new URL(manifest.main, packageURL).href
      : pathToFileURL(require.resolve(entry.name)).href,
  }))
  await loader.root.update(mounted)
  await loader.await()
  for (const entry of loader.entries()) {
    assert.equal(entry.fiber?.state, 2, `${entry.id} activates through the real Loader`)
    assertEvaluated(entry.fiber.effectiveConfig)
  }
  const searchConfig = loader.resolve('dsh-search-plugin').fiber.effectiveConfig
  assert.equal(Object.hasOwn(searchConfig, 'model'), false)
  assert.equal(searchConfig.endpoint.get(), 'https://bundle-test.invalid/v1/alpha/search')
  const httpConfig = loader.resolve('web-fetch-http').fiber.effectiveConfig
  assert.equal(httpConfig.userAgent, 'dsh-bundle-test-agent')
  assert.equal(httpConfig.maxRedirects, 0)
  assert.equal(httpConfig.maxResponseBytes, 23456)
  assert.equal(httpConfig.timeoutMs, 4200)
  assert.equal(httpConfig.maxBodyChars, 3456)
  assert.ok(ctx.get('web'), 'the composed web service is active')
  assert.deepEqual(searchComponent.inject, ['web'])
  assert.deepEqual(fetchComponent.inject, ['web'])
  assert.ok(Object.keys(searchComponent.Config.dict).every(key => !key.startsWith('fetch')))
  assert.ok(Object.keys(fetchComponent.Config.dict).every(key => key.startsWith('fetch')))

  const server = createServer((request, response) => {
    if (request.method === 'POST') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ output: 'Independent search works', results: [] }))
    } else {
      response.setHeader('Content-Type', 'text/plain')
      response.end('Independent fetch works')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const url = `http://127.0.0.1:${server.address().port}/`
  await loader.update('dsh-search-plugin', { config: { authMode: 'credential', endpoint: url, apiKey: 'test' } })
  await loader.update('dsh-search-fetch', { config: { fetchAllowedCidrs: ['127.0.0.0/8'], fetchMaxContentChars: 11 } })
  await loader.await()
  const service = ctx.get('web')
  const fetchWorks = async () => assert.equal((await service.fetch({ url })).body.content, 'Independent')
  const searchWorks = async () => assert.equal((await service.search({ query: 'test' })).content, 'Independent search works')
  await fetchWorks()
  await searchWorks()

  await loader.update('dsh-search-plugin', { disabled: true })
  await loader.await()
  assert.equal(loader.resolve('dsh-search-fetch').fiber.state, 2)
  assert.equal(loader.resolve('dsh-search-ui').fiber.state, 2, 'configuration UI survives search shutdown')
  await fetchWorks()
  await assert.rejects(service.search({ query: 'disabled' }), error => error.code === 'WEB_PROVIDER_CONFIGURED_MISSING')
  await loader.update('dsh-search-plugin', { disabled: false })
  await loader.update('dsh-search-fetch', { disabled: true })
  await loader.await()
  assert.equal(loader.resolve('dsh-search-ui').fiber.state, 2, 'configuration UI survives fetch shutdown')
  await searchWorks()
  await assert.rejects(service.fetch({ url }), error => error.code === 'WEB_PROVIDER_CONFIGURED_MISSING')
  await loader.update('dsh-search-fetch', { disabled: false })
  await loader.await()
  await fetchWorks()

})

for (const component of ['search', 'fetch']) {
  test(`${component} activates alone on a cold start`, async t => {
    const ctx = new Context()
    const fiber = await ctx.plugin(Loader, { baseUrl: packageURL.href })
    const loader = ctx.get('loader')
    t.after(async () => { await loader.root.update([]); await loader.await(); await fiber.dispose() })
    await loader.root.update([
      { id: 'web', name: pathToFileURL(require.resolve('@deepseek-ai/dsh-web')).href, config: { searchProvider: 'codex', fetchProvider: 'search-http' } },
      { id: component, name: pathToFileURL(require.resolve(`dsh-search-plugin/${component}`)).href },
    ])
    await loader.await()
    assert.equal(loader.resolve(component).fiber.state, 2)
    if (component === 'fetch') {
      await assert.rejects(ctx.get('web').fetch({ url: 'http://127.0.0.1/' }), error => error.code === 'WEB_BLOCKED_URL')
    } else {
      await assert.rejects(ctx.get('web').search({ query: 'test' }), error => error.code === 'CODEX_CONFIGURATION_ERROR')
    }
  })
}
