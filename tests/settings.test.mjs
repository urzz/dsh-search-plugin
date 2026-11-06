import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Settings from '@deepseek-ai/dsh-settings'
import { initProfile, mountRootInclude, readProfilePatches } from '@deepseek-ai/dsh-app-boot'

const require = createRequire(import.meta.url)
// ConfigEditor is a Settings dependency, not another fixture implementation.
const settingsRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-settings'))
const { default: ConfigEditor } = await import(pathToFileURL(settingsRequire.resolve('@deepseek-ai/dsh-config-editor')).href)
const answer = 'Layered settings answer'

async function host(t) {
  const root = await mkdtemp(join(tmpdir(), 'search-settings-'))
  const ctx = new Context()
  const requests = []
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization })
    request.resume()
    if (request.method === 'POST') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ output: answer, results: [] }))
    } else {
      response.setHeader('Content-Type', 'text/plain')
      response.end(answer)
    }
  })
  t.after(async () => {
    await ctx.fiber.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  const dir = join(root, 'profile')
  initProfile(dir, [])
  const profile = {
    name: 'settings-test', startedBundles: [], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(root, 'package.json'),
    cwd: root, home: root, overlays: [], telemetryDisabledEnv: undefined,
  }
  await writeFile(profile.installAnchor, JSON.stringify({ name: 'search-settings-test' }))
  await writeFile(join(dir, 'cordis.yml'), '[]')
  const entries = [
    { id: 'web', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'codex', fetchProvider: 'search-http' } },
    { id: 'search', name: 'dsh-search-plugin/search', config: {
      authMode: 'credential', endpoint: `${url}/base`, apiKey: 'base-test-key', maxAnswerChars: 15,
    } },
    { id: 'fetch', name: 'dsh-search-plugin/fetch', config: {
      fetchAllowedCidrs: ['127.0.0.0/8'], fetchMaxContentChars: 15,
    } },
  ].map(entry => ({ ...entry, name: pathToFileURL(require.resolve(entry.name)).href }))
  // Inserted configs are the inherited layer. Settings writes a separate override
  // row into this real disposable profile, as it does for a bundle-owned entry.
  await writeFile(profile.patchPath, JSON.stringify([{ insert: entries }]))
  await ctx.plugin(Loader)
  ctx.provide('profileContext', profile)
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(Settings)
  await mountRootInclude(ctx, join(dir, 'cordis.yml'), readProfilePatches('dsh', profile))
  await ctx.loader.await()
  for (const id of ['web', 'search', 'fetch']) assert.equal(ctx.loader.resolve(`include:${id}`).fiber.state, 2, `${id} activates`)
  const descriptor = id => {
    const row = ctx.settings.describe().find(row => row.ns === id)
    assert.ok(row, `${id} has a real Settings form`)
    return row
  }
  return { ctx, descriptor, requests, url, profile }
}

for (const id of ['search', 'fetch']) {
  test(`${id} Settings saves retain live refs, update provider behavior, and unset restores the base`, async t => {
    const h = await host(t)
    const { ctx, descriptor, url } = h
    const entry = ctx.loader.resolve(`include:${id}`)
    const fiber = entry.fiber
    const config = fiber.effectiveConfig
    const refs = { ...config }
    const field = id === 'search' ? 'maxAnswerChars' : 'fetchMaxContentChars'
    const execute = async () => id === 'search'
      ? (await ctx.web.search({ query: 'settings integration' })).content
      : (await ctx.web.fetch({ url: `${url}/fetch` })).body.content
    assert.equal(await execute(), answer.slice(0, 15))
    const before = descriptor(id)
    assert.equal(before.autoGenerate, false)
    assert.equal(before.base[field], 15)
    assert.deepEqual(before.user, {})
    const edits = [{ op: 'set', path: [field], value: 7 }]
    if (id === 'search') edits.push(
      { op: 'set', path: ['endpoint'], value: `${url}/user` },
      { op: 'set', path: ['apiKey'], value: 'user-test-key' },
    )
    await ctx.settings.mutate(id, edits, before.revision)
    await ctx.loader.await()
    assert.equal(ctx.loader.resolve(`include:${id}`).fiber, fiber, 'save does not remount the provider')
    assert.equal(fiber.effectiveConfig, config)
    for (const [key, ref] of Object.entries(refs)) assert.equal(config[key], ref, `${key} retains its live reference`)
    assert.equal(refs[field].get(), 7)
    const saved = descriptor(id)
    assert.ok(saved.revision > before.revision)
    assert.equal(saved.base[field], 15)
    assert.equal(saved.user[field], 7)
    assert.equal(saved.value[field], 7)
    const persisted = await readFile(ctx.settings.documentPath, 'utf8')
    assert.match(persisted, new RegExp(`${field}: 7`))
    assert.equal(await execute(), answer.slice(0, 7))
    if (id === 'search') assert.deepEqual(h.requests.at(-1), { path: '/user', authorization: 'Bearer user-test-key' })
    await ctx.settings.mutate(id, edits.map(edit => ({ op: 'unset', path: edit.path })), saved.revision)
    await ctx.loader.await()
    assert.equal(ctx.loader.resolve(`include:${id}`).fiber, fiber)
    assert.equal(fiber.effectiveConfig, config)
    assert.equal(config[field], refs[field])
    assert.equal(refs[field].get(), 15)
    const restored = descriptor(id)
    assert.ok(restored.revision > saved.revision)
    assert.deepEqual(restored.user, {})
    assert.equal(restored.value[field], 15)
    assert.equal(await execute(), answer.slice(0, 15))
    if (id === 'search') assert.deepEqual(h.requests.at(-1), { path: '/base', authorization: 'Bearer base-test-key' })
  })
}

for (const [id, field, invalid] of [
  ['search', 'maxAnswerChars', 0],
  ['search', 'protocol', 'not-a-protocol'],
  ['fetch', 'fetchMaxContentChars', 0],
  ['fetch', 'fetchAllowedCidrs', ['not-a-cidr']],
]) {
  test(`${id} rejects invalid ${field} without changing persisted or effective settings`, async t => {
    const { ctx, descriptor, url } = await host(t)
    // Start with a real saved override, so rejection must preserve user data too.
    const limit = id === 'search' ? 'maxAnswerChars' : 'fetchMaxContentChars'
    await ctx.settings.mutate(id, [{ op: 'set', path: [limit], value: 9 }], descriptor(id).revision)
    const fiber = ctx.loader.resolve(`include:${id}`).fiber
    const config = fiber.effectiveConfig
    const refs = { ...config }
    const values = Object.fromEntries(Object.entries(refs).map(([key, ref]) => [key, structuredClone(ref.get())]))
    const raw = fiber.rawConfig
    const before = structuredClone(descriptor(id))
    const document = await readFile(ctx.settings.documentPath, 'utf8')
    assert.throws(() => fiber.resolveConfig({ ...raw, [field]: invalid }))
    await assert.rejects(ctx.settings.mutate(id, [{ op: 'set', path: [field], value: invalid }], before.revision))
    await ctx.loader.await()
    assert.equal(await readFile(ctx.settings.documentPath, 'utf8'), document)
    const after = descriptor(id)
    for (const key of ['revision', 'value', 'base', 'user']) assert.deepEqual(after[key], before[key], key)
    assert.equal(ctx.loader.resolve(`include:${id}`).fiber, fiber)
    assert.equal(fiber.rawConfig, raw)
    assert.equal(fiber.effectiveConfig, config)
    for (const [key, ref] of Object.entries(refs)) {
      assert.equal(config[key], ref)
      assert.deepEqual(ref.get(), values[key])
    }
    const result = id === 'search'
      ? (await ctx.web.search({ query: 'after rejected save' })).content
      : (await ctx.web.fetch({ url: `${url}/fetch` })).body.content
    assert.equal(result, answer.slice(0, 9))
  })
}
