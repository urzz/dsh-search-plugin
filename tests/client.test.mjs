import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)
const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const tick = async () => { await Promise.resolve(); await Promise.resolve() }

function harness(overrides = {}, interactive = false) {
  const states = []
  let cursor = 0
  let mutationResult = true
  let registration
  const styles = []
  const cleanups = []
  const calls = []
  let face
  let Component
  const registrations = []
  let config = { status: 'ready', value: { authMode: 'credential', credentialRef: 'DSH_CODEX_API_KEY', endpoint: 'https://search.example.test/v1/alpha/search' }, revision: 7, writable: true }
  const formListeners = new Set()
  let onCredential
  let onForm
  const document = {
    createElement: () => ({ dataset: {}, textContent: '', remove() { styles.splice(styles.indexOf(this), 1) } }),
    head: { append: style => styles.push(style) },
  }
  vm.runInNewContext(code, { window: { __ModuleLoader__: { load: value => { registration = value } } }, document, URL })
  assert.equal(registration.id, 'dsh-search-plugin')
  assert.equal(styles.length, 0, 'registration does not execute side effects')
  // Drive the actual component handlers with persistent hook state, without a DOM dependency.
  const plugin = registration.factory(id => id === 'react' && interactive ? {
    ...require(id),
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = initial
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
    },
  } : require(id))
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
      return {
        getSnapshot: () => config,
        subscribe: fn => { formListeners.add(fn); onForm = fn; return () => { formListeners.delete(fn); onForm = undefined } },
        mutate: async (ops, revision) => { calls.push(['mutate', ops, revision]); return mutationResult },
      }
    } },
    remote: { credentials, $on: (event, fn) => {
      assert.equal(event, 'credentials/reference-updated'); onCredential = fn; return () => { onCredential = undefined }
    } },
    slots: {
      inject: (slot, fn) => { assert.equal(slot, 'plugins.bundle.config'); return fn() },
      register: (options, registeredComponent) => {
        assert.equal(options.key, 'dsh-search-plugin')
        registrations.push(options.name)
        assert.equal(typeof registeredComponent, 'function')
        Component = registeredComponent
        face = options.inject()
        return () => calls.push(['slot-disposed'])
      },
    },
  })
  assert.deepEqual(registrations, ['plugins.bundle.config'])
  const props = () => ({
    view: 'page', // rc.4 bundle owner supplies no `form` prop.
    t: key => key,
    ...face,
    useConfig: select => select(face.hooks.config.getSnapshot()),
    useCredential: select => select(face.hooks.credential.getSnapshot()),
  })
  const expand = node => {
    if (Array.isArray(node)) return node.map((child, index) => {
      const expanded = expand(child)
      return expanded && typeof expanded === 'object' && !Array.isArray(expanded) ? { ...expanded, key: expanded.key ?? String(index) } : expanded
    })
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(node.type(node.props))
    return { ...node, props: { ...node.props, children: expand(node.props?.children) } }
  }
  const tree = () => { cursor = 0; return expand(Component(props())) }
  const render = () => renderToStaticMarkup(interactive ? tree() : createElement(Component, props()))
  const nodes = (section) => {
    const result = []
    const visit = node => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) { node.forEach(visit); return }
      result.push(node)
      visit(node.props?.children)
    }
    visit(tree())
    if (!section) return result
    const form = result.find(node => node.type === 'form' && node.props['aria-label'] === section)
    result.length = 0
    visit(form)
    return result
  }
  const field = name => nodes().find(node => node.props?.name === name)
  const button = (label, section = 'searchSettings') => (label.startsWith('key') ? nodes() : nodes(section)).find(node => node.type === 'button' && node.props.children === label)
  const change = (name, value) => field(name).props.onChange({ target: { value } })
  const submit = async (section = 'searchSettings') => { nodes(section).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await tick() }
  return { face, calls, styles, render, field, button, change, submit, refuse: () => { mutationResult = false },  setConfig: value => { config = value; for (const fn of formListeners) fn() }, notify: ref => onCredential?.(ref), formChanged: () => onForm?.(), dispose: () => { for (const cleanup of cleanups.reverse()) cleanup() } }
}

test('bundle page without owner form renders live configuration and preserves write revision', async () => {
  const app = harness()
  assert.match(app.render(), /value="https:\/\/search\.example\.test\/v1\/alpha\/search"/)
  assert.doesNotMatch(app.render(), /unavailable/)
  let changes = 0
  const off = app.face.hooks.config.subscribe(() => changes++)
  app.setConfig({ status: 'ready', value: { authMode: 'credential', endpoint: 'https://rotated.example.test/v1/alpha/search' }, revision: 8, writable: false })
  assert.equal(changes, 1)
  assert.match(app.render(), /value="https:\/\/rotated\.example\.test\/v1\/alpha\/search"/)
  assert.match(app.render(), /readOnly/)
  const ops = [{ op: 'set', path: ['endpoint'], value: 'https://next.example.test/v1/alpha/search' }]
  assert.equal(await app.face.mutateConfig(ops, 8), true)
  assert.deepEqual(app.calls.find(call => call[0] === 'mutate'), ['mutate', ops, 8])
  off()
  app.setConfig({ status: 'loading' })
  assert.match(app.render(), /loading/)
  app.setConfig({ status: 'unavailable' })
  assert.match(app.render(), /unavailable/)
  app.dispose()
})

test('authentication mode shows only its relevant configuration and never a model field', () => {
  const app = harness()
  const independent = app.render()
  assert.match(independent, /<span>endpoint<\/span>/)
  assert.match(independent, /<span>credentialRef<\/span>/)
  assert.doesNotMatch(independent, /<span>openaiProvider<\/span>|<span>model<\/span>/)
  app.setConfig({ status: 'ready', value: { authMode: 'openai', openaiProvider: 'openai-work' }, revision: 8, writable: true })
  const reused = app.render()
  assert.match(reused, /value="openai-work"/)
  assert.doesNotMatch(reused, /<span>endpoint<\/span>|<span>credentialRef<\/span>|<span>model<\/span>|type="password"/)
  app.dispose()
})

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

test('protocol switching preserves both drafts and saves them atomically without clearing hidden values', async () => {
  const app = harness({}, true)
  app.change('endpoint', 'https://alpha.test/search')
  app.change('protocol', 'deepseek-search-api')
  assert.equal(app.field('endpoint'), undefined)
  assert.equal(app.field('timeoutMs'), undefined, 'Alpha limits are not advertised for the official DeepSeek adapter')
  assert.equal(app.field('deepseekEndpoint').props.value, 'https://api.deepseek.com/v1/tools')
  assert.equal(app.field('deepseekCount').props.max, 50)
  app.change('deepseekEndpoint', 'https://deepseek.test/v1/tools')
  app.change('deepseekCount', '25')
  app.change('protocol', 'codex-alpha')
  assert.equal(app.field('endpoint').props.value, 'https://alpha.test/search')
  app.change('protocol', 'deepseek-search-api')
  assert.equal(app.field('deepseekCount').props.value, '25')
  await app.submit()
  const write = app.calls.find(call => call[0] === 'mutate')
  assert.equal(write[2], 7)
  const values = Object.fromEntries(write[1].map(op => [op.path[0], op.value]))
  assert.deepEqual(values, { protocol: 'deepseek-search-api', endpoint: 'https://alpha.test/search', deepseekEndpoint: 'https://deepseek.test/v1/tools', deepseekCount: 25 })
  app.dispose()
})

test('fetch saves only its four fields and has no CIDR preset', async () => {
  const app = harness({}, true)
  app.change('endpoint', 'invalid-search-draft')
  app.change('fetchAllowedCidrs', ' 10.0.0.0/8\n\n198.18.0.0/15 ')
  assert.equal(app.button('cidrPreset', 'fetchSettings'), undefined)
  app.change('fetchTimeoutMs', '45000')
  await app.submit('fetchSettings')
  const ops = app.calls.find(call => call[0] === 'mutate')[1]
  assert.deepEqual(JSON.parse(JSON.stringify(ops)), [
    { op: 'set', path: ['fetchAllowedCidrs'], value: ['10.0.0.0/8', '198.18.0.0/15'] },
    { op: 'set', path: ['fetchTimeoutMs'], value: 45000 },
  ])
  assert.equal(app.field('endpoint').props.value, 'invalid-search-draft')
  app.dispose()
})

test('selected protocol credential uses official credential writes and clears plaintext on switching', async () => {
  const app = harness({}, true)
  await tick()
  app.change('key', 'alpha-secret')
  app.change('protocol', 'deepseek-search-api')
  await tick()
  assert.equal(app.face.hooks.credential.getSnapshot().ref, 'DEEPSEEK_API_KEY')
  assert.equal(app.field('key').props.value, '')
  app.change('deepseekCredentialRef', 'DEEPSEEK_CUSTOM')
  await tick()
  app.change('key', 'deepseek-secret')
  await app.button('keySave').props.onClick()
  await tick()
  assert.ok(app.calls.some(call => call[0] === 'set' && call[1] === 'DEEPSEEK_CUSTOM' && call[2] === 'deepseek-secret'))
  assert.equal(app.field('key').props.value, '')
  app.change('protocol', 'codex-alpha')
  assert.equal(app.field('key').props.value, '')
  assert.equal(app.calls.some(call => call[0] === 'mutate'), false)
  app.dispose()
})

test('save validation, refusal, conflict discard and reset use real action handlers', async () => {
  const app = harness({}, true)
  app.change('protocol', 'deepseek-search-api')
  app.change('deepseekCount', '51')
  await app.submit()
  assert.match(app.render(), /invalid/)
  assert.equal(app.calls.some(call => call[0] === 'mutate'), false)
  app.change('deepseekCount', '20')
  app.refuse()
  await app.submit()
  assert.match(app.render(), /failed/)
  assert.equal(app.field('deepseekCount').props.value, '20', 'rejected save retains the draft')
  app.setConfig({ status: 'ready', value: { protocol: 'deepseek-search-api', deepseekCount: 30 }, revision: 8, writable: true })
  assert.equal(app.button('save').props.disabled, true)
  assert.equal(app.button('reset').props.disabled, true)
  const writes = app.calls.filter(call => call[0] === 'mutate').length
  await app.submit()
  assert.equal(app.calls.filter(call => call[0] === 'mutate').length, writes)
  app.button('discard').props.onClick()
  assert.equal(app.field('deepseekCount').props.value, '30')
  assert.doesNotMatch(app.render(), /role="alert"/)
  await app.button('reset').props.onClick()
  await tick()
  const reset = app.calls.filter(call => call[0] === 'mutate').at(-1)
  assert.equal(reset[2], 8)
  assert.ok(reset[1].every(op => op.op === 'unset'))
  for (const field of ['protocol', 'endpoint', 'deepseekEndpoint', 'deepseekCredentialRef', 'deepseekCount']) {
    assert.ok(reset[1].some(op => op.path[0] === field))
  }
  app.dispose()
})

test('saved protocol chooses its credential reference on host updates', async () => {
  const app = harness()
  app.setConfig({ status: 'ready', value: { protocol: 'deepseek-search-api' }, revision: 8, writable: true })
  await tick()
  assert.equal(app.face.hooks.credential.getSnapshot().ref, 'DEEPSEEK_API_KEY')
  app.setConfig({ status: 'ready', value: { protocol: 'deepseek-search-api', deepseekCredentialRef: 'CUSTOM_REF' }, revision: 9, writable: true })
  await tick()
  assert.equal(app.face.hooks.credential.getSnapshot().ref, 'CUSTOM_REF')
  app.dispose()
})


test('search save and each reset leave the other form draft untouched', async () => {
  const app = harness({}, true)
  app.change('fetchTimeoutMs', '0')
  app.change('endpoint', 'https://next.test/search')
  await app.submit()
  let write = app.calls.filter(call => call[0] === 'mutate').at(-1)
  assert.deepEqual(JSON.parse(JSON.stringify(write[1])), [{ op: 'set', path: ['endpoint'], value: 'https://next.test/search' }])
  assert.equal(app.field('fetchTimeoutMs').props.value, '0')
  await app.submit('fetchSettings')
  assert.match(app.render(), /fetchInvalid/)
  assert.equal(app.calls.filter(call => call[0] === 'mutate').length, 1)
  app.change('endpoint', 'https://unsaved.test/search')
  app.button('reset', 'fetchSettings').props.onClick()
  await tick()
  write = app.calls.filter(call => call[0] === 'mutate').at(-1)
  assert.equal(write[2], 7)
  assert.deepEqual(JSON.parse(JSON.stringify(write[1])), ['fetchAllowedCidrs', 'fetchTimeoutMs', 'fetchMaxResponseBytes', 'fetchMaxContentChars'].map(field => ({ op: 'unset', path: [field] })))
  assert.equal(app.field('endpoint').props.value, 'https://unsaved.test/search')
  app.change('fetchTimeoutMs', '42000')
  app.button('reset').props.onClick()
  await tick()
  write = app.calls.filter(call => call[0] === 'mutate').at(-1)
  assert.ok(write[1].every(op => op.op === 'unset' && !op.path[0].startsWith('fetch')))
  assert.equal(app.field('fetchTimeoutMs').props.value, '42000')
  app.change('endpoint', 'https://retained.test/search')
  app.button('discard', 'fetchSettings').props.onClick()
  assert.equal(app.field('endpoint').props.value, 'https://retained.test/search')
  app.change('fetchTimeoutMs', '43000')
  app.button('discard').props.onClick()
  assert.equal(app.field('fetchTimeoutMs').props.value, '43000')
  app.dispose()
})

test('both drafts retain the shared host revision fence', async () => {
  const app = harness({}, true)
  app.change('endpoint', 'https://draft.test/search')
  app.change('fetchTimeoutMs', '42000')
  app.setConfig({ status: 'ready', value: { fetchTimeoutMs: 31000 }, revision: 8, writable: true })
  for (const section of ['searchSettings', 'fetchSettings']) {
    assert.equal(app.button('save', section).props.disabled, true)
    assert.equal(app.button('reset', section).props.disabled, true)
    await app.submit(section)
    app.button('reset', section).props.onClick()
    await tick()
  }
  assert.equal(app.calls.some(call => call[0] === 'mutate'), false)
  app.button('discard', 'fetchSettings').props.onClick()
  assert.equal(app.field('fetchTimeoutMs').props.value, '31000')
  assert.equal(app.field('endpoint').props.value, 'https://draft.test/search')
  app.dispose()
})
