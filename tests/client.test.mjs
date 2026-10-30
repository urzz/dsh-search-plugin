import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const tick = async () => { await Promise.resolve(); await Promise.resolve() }

function harness(overrides = {}) {
  let registration
  const styles = []
  const cleanups = []
  const calls = []
  let face
  let onCredential
  let onForm
  const document = {
    createElement: () => ({ dataset: {}, textContent: '', remove() { styles.splice(styles.indexOf(this), 1) } }),
    head: { append: style => styles.push(style) },
  }
  vm.runInNewContext(code, { window: { __ModuleLoader__: { load: value => { registration = value } } }, document })
  assert.equal(registration.id, 'dsh-search-plugin')
  assert.equal(styles.length, 0, 'registration does not execute side effects')
  const plugin = registration.factory(require)
  assert.equal(styles.length, 0, 'materialization does not execute apply side effects')
  const credentials = {
    describe: async refs => { calls.push(['describe', ...refs]); return { ok: true, value: Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])) } },
    set: async (ref, value) => { calls.push(['set', ref, value]); return { ok: true, value: undefined } },
    unset: async ref => { calls.push(['unset', ref]); return { ok: true, value: undefined } },
    ...overrides,
  }
  plugin.apply({
    effect: factory => { const cleanup = factory(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    locale: { register: () => () => calls.push(['locale-disposed']) },
    configForms: { get: entry => {
      assert.equal(entry, 'dsh-search-plugin')
      return { getSnapshot: () => ({ value: { credentialRef: 'DSH_CODEX_API_KEY' } }), subscribe: fn => { onForm = fn; return () => { onForm = undefined } } }
    } },
    remote: { credentials, $on: (event, fn) => {
      assert.equal(event, 'credentials/reference-updated'); onCredential = fn; return () => { onCredential = undefined }
    } },
    slots: {
      inject: (slot, fn) => { assert.equal(slot, 'plugins.bundle.config'); return fn() },
      register: (options, Component) => {
        assert.equal(options.key, 'dsh-search-plugin'); assert.equal(typeof Component, 'function')
        face = options.inject()
        return () => calls.push(['slot-disposed'])
      },
    },
  })
  return { face, calls, styles, notify: ref => onCredential?.(ref), formChanged: () => onForm?.(), dispose: () => { for (const cleanup of cleanups.reverse()) cleanup() } }
}

test('credential writes use the credentials namespace, never return plaintext, and refresh status', async () => {
  const app = harness()
  await tick()
  const source = app.face.hooks.credential
  assert.equal(source.getSnapshot().ref, 'DSH_CODEX_API_KEY')
  assert.equal(source.getSnapshot().info.writable, true)
  await app.face.storeCredential('MY_SEARCH_KEY', 'private-value')
  await tick()
  assert.ok(app.calls.some(call => call[0] === 'set' && call[1] === 'MY_SEARCH_KEY' && call[2] === 'private-value'))
  assert.equal(JSON.stringify(source.getSnapshot()).includes('private-value'), false)
  await app.face.removeCredential('MY_SEARCH_KEY')
  await tick()
  assert.ok(app.calls.some(call => call[0] === 'unset' && call[1] === 'MY_SEARCH_KEY'))
  const count = app.calls.length
  app.notify('OTHER_KEY')
  assert.equal(app.calls.length, count, 'irrelevant credential events do not reload the active reference')
  app.notify('MY_SEARCH_KEY')
  assert.equal(app.calls.length, count + 1)
  app.dispose()
  assert.equal(app.styles.length, 0)
  assert.ok(app.calls.some(call => call[0] === 'slot-disposed'))
})

test('rc.4 RemoteResult failures are visible and secret write failure does not become success', async () => {
  const failure = new Error('permission denied')
  const app = harness({
    describe: async () => ({ ok: false, error: failure }),
    set: async () => ({ ok: false, error: failure }),
    unset: async () => ({ ok: false, error: failure }),
  })
  await tick()
  assert.equal(app.face.hooks.credential.getSnapshot().error, true)
  await assert.rejects(app.face.storeCredential('MY_KEY', 'secret'), /permission denied/)
  await assert.rejects(app.face.removeCredential('MY_KEY'), /permission denied/)
  app.dispose()
})

test('credential source fences stale requests and late answers after disposal', async () => {
  const pending = []
  const app = harness({ describe: refs => new Promise(resolve => pending.push({ ref: refs[0], resolve })) })
  const source = app.face.hooks.credential
  app.face.describeCredential('NEW_KEY')
  pending[1].resolve({ ok: true, value: { NEW_KEY: { configured: true, writable: false, source: 'env' } } })
  await tick()
  pending[0].resolve({ ok: true, value: { DSH_CODEX_API_KEY: { configured: false, writable: true } } })
  await tick()
  assert.equal(source.getSnapshot().ref, 'NEW_KEY')
  assert.equal(source.getSnapshot().info.configured, true)
  assert.equal(source.getSnapshot().info.writable, false)
  let updates = 0
  source.subscribe(() => updates++)
  app.face.describeCredential('LAST_KEY')
  assert.equal(updates, 1)
  const before = source.getSnapshot()
  app.dispose()
  pending[2].resolve({ ok: true, value: { LAST_KEY: { configured: true, writable: true } } })
  await tick()
  assert.equal(source.getSnapshot(), before)
  assert.equal(updates, 1)
  app.face.describeCredential('AFTER_DISPOSAL')
  assert.equal(pending.length, 3)
})
