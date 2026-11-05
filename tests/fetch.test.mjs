import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import dns from 'node:dns/promises'
import Schema from '@deepseek-ai/schemastery'
import { Config } from '../lib/index.js'
import { syncBuiltinESMExports } from 'node:module'
import { ConfiguredFetchProvider, validateCidrs, resolveAllowedAddresses } from '../lib/fetch.js'

const defaults = { allowedCidrs: [], timeoutMs: 1000, maxResponseBytes: 10000, maxContentChars: 1000, maxRedirects: 3, userAgent: 'search-fetch-test' }
const hasCode = code => error => error.code === code
const signal = () => new AbortController().signal
const answer = address => ({ address, family: address.includes(':') ? 6 : 4 })
const resolve = (address, cidrs = [], lookup = async () => []) => resolveAllowedAddresses(address, signal(), cidrs, lookup)

async function server(t, handler) {
  const app = createServer(handler)
  await new Promise(accept => app.listen(0, '127.0.0.1', accept))
  t.after(() => new Promise(accept => { app.closeAllConnections(); app.close(accept) }))
  return `http://127.0.0.1:${app.address().port}`
}

// Every endpoint is local or every lookup is synthetic: no external networking.
test('CIDR validation survives the settings wire schema round trip', () => {
  const wire = JSON.parse(JSON.stringify(Config.dict.fetchAllowedCidrs.toJSON()))
  for (const node of Object.values(wire.refs)) delete node.meta.volatile
  const browserSchema = new Schema(wire)
  assert.deepEqual(browserSchema([]), [])
  for (const cidr of ['198.18.0.0/15', '192.168.96.0/20', '::1/128', 'fc00::/7', '2001:db8::/32', '0.0.0.0/0', '::/0']) {
    assert.deepEqual(browserSchema([cidr]), [cidr])
  }
  for (const cidr of ['10.0.0.1/8', '::/129', 'fc00::1/7', '::ffff:127.0.0.0/104', '010.0.0.0/8', 'fe80::%eth0/10']) {
    assert.throws(() => browserSchema([cidr]), undefined, cidr)
  }
})

test('CIDR validation accepts network bases for both families and refuses ambiguous rules', () => {
  assert.equal(validateCidrs([]), true)
  for (const cidr of ['198.18.0.0/15', '192.168.96.0/20', '::1/128', 'fc00::/7', '2001:db8::/32', '0.0.0.0/0', '::/0']) {
    assert.equal(validateCidrs([cidr]), true, cidr)
  }
  for (const cidr of ['', '10.0.0.0', '010.0.0.0/8', '10.1/16', '127.1/8', '10.0.0.0/-1', '10.0.0.0/33', '10.0.0.0/08', '10.0.0.1/8', '::/129', 'fc00::1/7', '[::1]/128', 'fe80::%eth0/10', '::ffff:127.0.0.0/104', '::7f00:0/104', 'example.com/24', '10.0.0.0/8/9']) {
    assert.equal(validateCidrs([cidr]), false, cidr)
  }
})

test('public unicast stays allowed; no special range is implicitly authorized', async () => {
  assert.deepEqual(await resolve('8.8.8.8'), [answer('8.8.8.8')])
  for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.96.1', '198.18.0.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1']) {
    await assert.rejects(resolve(address), hasCode('WEB_BLOCKED_URL'), address)
  }
})

test('only configured CIDRs apply, including subnet boundaries and IPv6', async () => {
  const cidrs = ['198.18.0.0/15', '192.168.96.0/20', 'fd12:3456::/32']
  for (const address of ['198.18.0.0', '198.19.255.255', '192.168.96.0', '192.168.111.255', 'fd12:3456::1']) {
    assert.deepEqual(await resolve(address, cidrs), [answer(address)])
  }
  for (const address of ['192.168.95.255', '192.168.112.0', 'fd12:3457::1']) {
    await assert.rejects(resolve(address, cidrs), hasCode('WEB_BLOCKED_URL'))
  }
})

test('mapped and compatible IPv6 cannot disguise unauthorized IPv4', async () => {
  for (const address of ['::ffff:127.0.0.1', '::7f00:1', '::ffff:c0a8:6001', '::c0a8:6001']) {
    await assert.rejects(resolve(address), hasCode('WEB_BLOCKED_URL'))
  }
  assert.deepEqual(await resolve('::ffff:c0a8:6001', ['192.168.96.0/20']), [answer('::ffff:c0a8:6001')])
  await assert.rejects(resolve('::7f00:1', ['::/0']), hasCode('WEB_BLOCKED_URL'))
})

test('mixed DNS answers fail as a whole; invalid and empty answers fail closed', async () => {
  const cidrs = ['198.18.0.0/15']
  await assert.rejects(resolve('mixed.test', cidrs, async () => [answer('198.18.1.1'), answer('127.0.0.1')]), hasCode('WEB_BLOCKED_URL'))
  await assert.rejects(resolve('empty.test', cidrs), hasCode('WEB_PROVIDER_ERROR'))
  await assert.rejects(resolve('invalid.test', cidrs, async () => [{ address: '127.0.0.1', family: 6 }]), hasCode('WEB_PROVIDER_ERROR'))
  const answers = [answer('8.8.8.8'), answer('198.18.1.1')]
  assert.deepEqual(await resolve('allowed.test', cidrs, async () => answers), answers)
})

test('DNS64 discovery checks embedded IPv4 even in a public-looking prefix', async () => {
  const lookup = async host => [answer(host === 'ipv4only.arpa' ? '2606:4700:1234::c000:aa' : '2606:4700:1234::7f00:1')]
  await assert.rejects(resolve('dns64.test', [], lookup), hasCode('WEB_BLOCKED_URL'))
  assert.deepEqual(await resolve('dns64.test', ['127.0.0.0/8'], lookup), [answer('2606:4700:1234::7f00:1')])
  await assert.rejects(resolve('dns64.test', ['2606:4700:1234::/48'], lookup), hasCode('WEB_BLOCKED_URL'))
})

test('IPv6 works without DNS64 records while discovery failures stay visible', async () => {
  for (const code of ['ENODATA', 'ENOTFOUND']) {
    const lookup = async () => { throw Object.assign(new Error('no DNS64 records'), { code }) }
    assert.deepEqual(await resolve('2606:4700::1111', [], lookup), [answer('2606:4700::1111')])
  }
  const lookup = async () => { throw Object.assign(new Error('DNS unavailable'), { code: 'ESERVFAIL' }) }
  await assert.rejects(resolve('2606:4700::1111', [], lookup), hasCode('ESERVFAIL'))
})

test('cancellation interrupts a pending OS lookup', async () => {
  const controller = new AbortController()
  const pending = resolveAllowedAddresses('pending.test', controller.signal, [], () => new Promise(() => {}))
  controller.abort(new Error('cancel resolution'))
  await assert.rejects(pending, /cancel resolution/)
})

test('provider uses current settings once and retains official response limits and User-Agent', async t => {
  let receivedAgent
  const url = await server(t, (req, res) => { receivedAgent = req.headers['user-agent']; res.setHeader('Content-Type', 'text/plain'); res.end('abcdefghij') })
  let reads = 0
  let settings = { ...defaults }
  const provider = new ConfiguredFetchProvider(() => { reads++; return settings })
  assert.equal(provider.id, 'search-http')
  assert.equal(provider.available(), true)
  await assert.rejects(provider.fetch({ url }), hasCode('WEB_BLOCKED_URL'))
  settings = { ...defaults, allowedCidrs: ['127.0.0.0/8'], maxContentChars: 4 }
  const result = await provider.fetch({ url })
  assert.equal(reads, 2)
  assert.deepEqual(result.body, { kind: 'text', content: 'abcd' })
  assert.equal(result.truncated, true)
  assert.equal(receivedAgent, 'search-fetch-test')
  settings = { ...settings, maxResponseBytes: 2 }
  await assert.rejects(provider.fetch({ url }), hasCode('WEB_FETCH_TOO_LARGE'))
})

test('official transport pins DNS answers, preserves Host, and rechecks each redirect hop', async t => {
  let host
  const url = await server(t, (req, res) => {
    host = req.headers.host
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/final' }); res.end(); return }
    res.setHeader('Content-Type', 'text/plain'); res.end('pinned')
  })
  const target = new URL(url); target.hostname = 'pinning.invalid'
  let lookups = 0
  t.mock.method(dns, 'lookup', async () => { lookups++; return [answer('127.0.0.1')] })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const provider = new ConfiguredFetchProvider(() => ({ ...defaults, allowedCidrs: ['127.0.0.0/8'] }))
  assert.equal((await provider.fetch({ url: `${target.origin}/redirect` })).body.content, 'pinned')
  assert.equal(host, target.host)
  assert.equal(lookups, 2, 'one checked lookup per hop, none by the connector')
  lookups = 0
  dns.lookup = async () => [answer(++lookups === 1 ? '127.0.0.1' : '169.254.169.254')]
  syncBuiltinESMExports()
  await assert.rejects(provider.fetch({ url: `${target.origin}/redirect` }), hasCode('WEB_BLOCKED_URL'))
  assert.equal(lookups, 2)
})

test('official URL policy, cross-origin redirects, hop cap, timeout and cancellation remain enforced', async t => {
  const url = await server(t, (req, res) => {
    if (req.url === '/slow') return
    res.writeHead(302, { Location: req.url === '/cross' ? 'http://127.0.0.1:1/' : '/loop' }); res.end()
  })
  const provider = new ConfiguredFetchProvider(() => ({ ...defaults, allowedCidrs: ['127.0.0.0/8'], timeoutMs: 50, maxRedirects: 1 }))
  await assert.rejects(provider.fetch({ url: 'file:///etc/passwd' }), hasCode('WEB_INVALID_URL'))
  await assert.rejects(provider.fetch({ url: 'http://user:secret@127.0.0.1/' }), hasCode('WEB_BLOCKED_URL'))
  await assert.rejects(provider.fetch({ url: `${url}/cross` }), hasCode('WEB_REDIRECT_BLOCKED'))
  await assert.rejects(provider.fetch({ url: `${url}/loop` }), hasCode('WEB_REDIRECT_BLOCKED'))
  await assert.rejects(provider.fetch({ url: `${url}/slow` }), hasCode('WEB_FETCH_TIMEOUT'))
  const controller = new AbortController(); controller.abort()
  await assert.rejects(provider.fetch({ url }, controller.signal), hasCode('WEB_ABORTED'))
})
