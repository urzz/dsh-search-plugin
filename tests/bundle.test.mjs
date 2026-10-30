import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { bundlePatchPaths, composeEntries, loadOverlayPatches, readPluginMeta } from '@deepseek-ai/dsh-app-boot'

const require = createRequire(import.meta.url)
const packageURL = new URL('../', import.meta.url)
const basePatchURL = new URL('./fixtures/bundle-base.patch.yml', import.meta.url)

test('official metadata resolver reads exported titles and descriptions without executing the plugin', () => {
  const meta = readPluginMeta('dsh-search-plugin', import.meta.url)
  assert.equal(meta.title.zh, '联网搜索')
  assert.equal(meta.title.en, 'Web search')
  assert.match(meta.description.zh, /\/v1\/alpha\/search/)
  assert.match(meta.description.en, /OpenAI base URL and API key/)
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
  assert.equal(web.config.fetchProvider, 'http')
  const previousHttp = composeEntries([basePatches]).find(entry => entry.id === 'web-fetch-http')
  const http = entries.find(entry => entry.id === 'web-fetch-http')
  assert.deepEqual(http.config, previousHttp.config, 'search must not replace an earlier bundle\'s HTTP policy')
  assert.equal(entries.filter(entry => entry.id === 'web-fetch-http').length, 1)
  const pluginEntries = entries.filter(entry => entry.name === manifest.name)
  assert.equal(pluginEntries.length, 1, 'the manifest bundle inserts exactly one search plugin')

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
    assertEvaluated(entry.fiber.config)
  }
  const searchConfig = loader.resolve('dsh-search-plugin').fiber.config
  assert.equal(Object.hasOwn(searchConfig, 'model'), false)
  assert.equal(searchConfig.endpoint.get(), 'https://bundle-test.invalid/v1/alpha/search')
  const httpConfig = loader.resolve('web-fetch-http').fiber.config
  assert.equal(httpConfig.userAgent, 'dsh-bundle-test-agent')
  assert.equal(httpConfig.maxRedirects, 0)
  assert.equal(httpConfig.maxResponseBytes, 23456)
  assert.equal(httpConfig.timeoutMs, 4200)
  assert.equal(httpConfig.maxBodyChars, 3456)
  assert.ok(ctx.get('web'), 'the composed web service is active')
})
