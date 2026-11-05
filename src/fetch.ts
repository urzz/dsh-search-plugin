import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { WebError, type WebFetchProvider, type WebFetchRequest } from '@deepseek-ai/dsh-web'
import { HttpFetchProvider, type HttpFetchResolver } from '@deepseek-ai/dsh-web-fetch-http'

export interface FetchSettings {
  allowedCidrs: readonly string[]
  timeoutMs: number
  maxResponseBytes: number
  maxContentChars: number
  maxRedirects: number
  userAgent: string
}
interface Cidr { bytes: number[]; prefix: number }
const bareHost = (host: string) => host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host

function parseCidr(rule: string): Cidr {
  const [address, prefixText, ...extra] = rule.trim().split('/')
  if (!address || !prefixText || extra.length || !/^(0|[1-9]\d*)$/.test(prefixText) || !isIP(address) || address.includes('%')) {
    throw new Error(`Invalid CIDR: ${JSON.stringify(rule)}`)
  }
  const bytes = ipaddr.parse(address).toByteArray()
  const prefix = Number(prefixText)
  if (prefix > bytes.length * 8) throw new Error(`Invalid CIDR prefix: ${JSON.stringify(rule)}`)
  // Requiring the network base catches accidental overly broad operator rules.
  if (bytes.some((byte, i) => (byte & (255 >>> Math.max(0, Math.min(8, prefix - i * 8)))) !== 0)) {
    throw new Error(`CIDR must use its network base: ${JSON.stringify(rule)}`)
  }
  if (bytes.length === 16 && isEmbeddedV4(bytes) && bytes.some(Boolean) && !(bytes.slice(0, 15).every(b => b === 0) && bytes[15] === 1)) {
    throw new Error(`Use an IPv4 CIDR for IPv4-mapped or compatible addresses: ${JSON.stringify(rule)}`)
  }
  return { bytes, prefix }
}

/** Validate explicit IPv4/IPv6 network CIDRs; no implicit private ranges are added. */
export function validateCidrs(cidrs: readonly string[]): boolean {
  try { cidrs.forEach(parseCidr); return true } catch { return false }
}

function matches(bytes: number[], cidr: Cidr): boolean {
  return bytes.length === cidr.bytes.length && bytes.every((byte, i) => {
    const bits = Math.max(0, Math.min(8, cidr.prefix - i * 8))
    return (byte >>> (8 - bits)) === (cidr.bytes[i]! >>> (8 - bits))
  })
}
function isEmbeddedV4(bytes: number[]): boolean {
  return bytes.length === 16 && bytes.slice(0, 10).every(b => b === 0)
    && ((bytes[10] === 255 && bytes[11] === 255) || (bytes[10] === 0 && bytes[11] === 0))
}
function allows(address: string, cidrs: Cidr[]): boolean {
  let ip = ipaddr.parse(address)
  const bytes = ip.toByteArray()
  if (isEmbeddedV4(bytes) && ip.range() !== 'loopback' && ip.range() !== 'unspecified') {
    ip = ipaddr.parse(bytes.slice(12).join('.'))
  }
  return ip.range() === 'unicast' || cidrs.some(cidr => matches(ip.toByteArray(), cidr))
}
function blocked(): never {
  throw new WebError('Destination is outside the configured CIDR allowlist', 'WEB_BLOCKED_URL')
}

/** Stop waiting for an OS DNS lookup when the official transport deadline expires. */
function lookupAnswers(host: string, signal: AbortSignal, resolve: typeof lookup) {
  signal.throwIfAborted()
  return new Promise<Awaited<ReturnType<HttpFetchResolver>>>((accept, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    resolve(host, { all: true, order: 'verbatim' }).then(answers => {
      if (answers.some(a => (a.family !== 4 && a.family !== 6) || isIP(a.address) !== a.family)) {
        reject(new WebError('DNS returned an invalid IP address', 'WEB_PROVIDER_ERROR'))
      } else {
        accept(answers as Awaited<ReturnType<HttpFetchResolver>>)
      }
    }, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

const NAT64_LENGTHS = [32, 40, 48, 56, 64, 96]
function embeddedV4(bytes: number[], length: number): string | undefined {
  if (length === 96) return bytes.slice(12).join('.')
  if (bytes[8] !== 0) return undefined
  const start = length / 8
  return [...bytes.slice(start, 8), ...bytes.slice(9, 9 + 4 - (8 - start))].join('.')
}

/** Validate the entire DNS answer set once; the official transport pins these addresses. */
export async function resolveAllowedAddresses(
  hostname: string, signal: AbortSignal, allowedCidrs: readonly string[], resolve: typeof lookup = lookup,
): ReturnType<HttpFetchResolver> {
  signal.throwIfAborted()
  const cidrs = allowedCidrs.map(parseCidr)
  const host = bareHost(hostname)
  const family = isIP(host)
  const answers = family ? [{ address: host, family: family as 4 | 6 }] : await lookupAnswers(host, signal, resolve)
  if (!answers.length) throw new WebError('DNS returned no addresses', 'WEB_PROVIDER_ERROR')
  for (const answer of answers) if (!allows(answer.address, cidrs)) blocked()
  // RFC 7050: even a public-looking DNS64 prefix can embed a private IPv4 target.
  if (answers.some(a => a.family === 6)) {
    const discovery = await lookupAnswers('ipv4only.arpa', signal, resolve).catch((error: NodeJS.ErrnoException) => {
      // No DNS64 answer is normal on IPv4-only resolvers. Other failures stay visible.
      if (!signal.aborted && (error.code === 'ENODATA' || error.code === 'ENOTFOUND')) return []
      throw error
    })
    for (const candidate of discovery.filter(a => a.family === 6)) {
      const bytes = ipaddr.parse(candidate.address).toByteArray()
      for (const length of NAT64_LENGTHS) {
        if (!['192.0.0.170', '192.0.0.171'].includes(embeddedV4(bytes, length) ?? '')) continue
        for (const answer of answers.filter(a => a.family === 6)) {
          const target = ipaddr.parse(answer.address).toByteArray()
          if (!bytes.slice(0, length / 8).every((b, i) => b === target[i])) continue
          const translated = embeddedV4(target, length)
          if (translated !== undefined && !allows(translated, cidrs)) blocked()
        }
      }
    }
  }
  signal.throwIfAborted()
  return answers
}

/** Current settings are snapshotted once for each request, including redirect hops. */
export class ConfiguredFetchProvider implements WebFetchProvider {
  readonly id = 'search-http'
  constructor(private readonly read: () => FetchSettings) {}
  available() { return true }
  async fetch(request: WebFetchRequest, signal?: AbortSignal) {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    const current = this.read()
    const settings = { ...current, allowedCidrs: [...current.allowedCidrs] }
    const cidrs = settings.allowedCidrs.map(parseCidr)
    const url = URL.parse(request.url)
    // The official proxy path skips resolution for public literals. Check compatible
    // IPv6 too, which its classifier otherwise treats as public (e.g. ::7f00:1).
    if (url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
      const host = bareHost(url.hostname)
      if (isIP(host) && !allows(host, cidrs)) blocked()
    }
    return new HttpFetchProvider({ ...settings, maxBodyChars: settings.maxContentChars },
      (host, abort) => resolveAllowedAddresses(host, abort, settings.allowedCidrs),
    ).fetch(request, signal)
  }
}
