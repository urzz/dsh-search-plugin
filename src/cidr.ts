/** Schemastery serializes this function for browser forms. Keep it closure-free. */
export function validateCidr(rule: string): string {
  const [address, prefixText, ...extra] = rule.trim().split('/')
  if (!address || !prefixText || extra.length || !/^(0|[1-9]\d*)$/.test(prefixText)) {
    throw new Error(`Invalid CIDR: ${JSON.stringify(rule)}`)
  }
  let bytes: number[]
  if (address.includes(':')) {
    if (!/^[\da-f:.]+$/i.test(address)) throw new Error(`Invalid IPv6 CIDR: ${JSON.stringify(rule)}`)
    // URL uses the same IPv6 parser in Node and browsers, including embedded IPv4.
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1)
    const halves = normalized.split('::').map(part => part ? part.split(':') : [])
    const groups = halves.length === 1 ? halves[0]! : [...halves[0]!, ...Array(8 - halves[0]!.length - halves[1]!.length).fill('0'), ...halves[1]!]
    bytes = groups.flatMap(group => { const n = parseInt(group, 16); return [n >>> 8, n & 255] })
  } else {
    const parts = address.split('.')
    if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) {
      throw new Error(`Invalid IPv4 CIDR: ${JSON.stringify(rule)}`)
    }
    bytes = parts.map(Number)
  }
  const prefix = Number(prefixText)
  if (prefix > bytes.length * 8) throw new Error(`Invalid CIDR prefix: ${JSON.stringify(rule)}`)
  if (bytes.some((byte, i) => (byte & (255 >>> Math.max(0, Math.min(8, prefix - i * 8)))) !== 0)) {
    throw new Error(`CIDR must use its network base: ${JSON.stringify(rule)}`)
  }
  const embeddedV4 = bytes.length === 16 && bytes.slice(0, 10).every(b => b === 0)
    && ((bytes[10] === 255 && bytes[11] === 255) || (bytes[10] === 0 && bytes[11] === 0))
  if (embeddedV4 && bytes.some(Boolean) && !(bytes.slice(0, 15).every(b => b === 0) && bytes[15] === 1)) {
    throw new Error(`Use an IPv4 CIDR for IPv4-mapped or compatible addresses: ${JSON.stringify(rule)}`)
  }
  return rule
}
