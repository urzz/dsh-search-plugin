import { randomUUID } from 'node:crypto'
import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult, type WebSearchSource } from '@deepseek-ai/dsh-web'

/** Resolved values for one Alpha Search request; never persisted or exposed to the browser. */
export interface AlphaSearchConfig {
  endpoint: string
  apiKey: string
  timeoutMs: number
  maxResponseBytes: number
  maxAnswerChars: number
}

// Alpha Search's routing model, not the user's chat/Responses model.
export const ALPHA_SEARCH_MODEL = 'gpt-5.6-luna'

function protocolError(message: string): never {
  throw new WebError(`Codex search: ${message}`, 'CODEX_PROTOCOL_ERROR')
}

/** Decode Alpha's output/results, never Responses output items or guessed links. */
export function parseSearchResponse(value: unknown, maxAnswerChars: number): WebSearchResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) protocolError('expected an object')
  const response = value as Record<string, unknown>
  if (typeof response.output !== 'string') protocolError('output text is missing')
  if (response.results != null && !Array.isArray(response.results)) protocolError('expected results to be an array')
  const sources = new Map<string, WebSearchSource>()
  // Alpha results are opaque, extensible DTOs; only web URLs are citeable sources.
  for (const item of response.results ?? []) {
    if (typeof item !== 'object' || item === null || typeof item.url !== 'string') continue
    let url: URL
    try { url = new URL(item.url) } catch { continue }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue
    const previous = sources.get(item.url)
    sources.set(item.url, {
      url: item.url,
      ...(previous?.title !== undefined ? { title: previous.title } : typeof item.title === 'string' ? { title: item.title } : {}),
    })
  }
  // Alpha ref_ids have no meaning in DSH; structured sources are returned separately.
  const answer = response.output.replace(/\uE200cite\uE202[^\uE201]*\uE201(?:\s*\[wordlim:\s*\d+\])?/gu, '').trim()
  let content = answer.slice(0, maxAnswerChars)
  if (content.length < answer.length && /[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1)
  return { ...(content ? { content } : {}), sources: [...sources.values()], truncated: false }
}

/** Alpha Search only. No retry, redirect following, or protocol fallback. */
export class CodexSearchProvider implements WebSearchProvider {
  readonly id = 'codex'
  private readonly config: AlphaSearchConfig

  constructor(config: AlphaSearchConfig) {
    const endpoint = new URL(config.endpoint)
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error('Codex endpoint must be an HTTP(S) URL without credentials or a fragment')
    }
    if (!config.apiKey.trim()) throw new Error('Codex apiKey must be non-empty')
    this.config = { ...config }
  }

  available(): boolean { return true }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const response = await fetch(this.config.endpoint, {
        method: 'POST', redirect: 'manual', signal: combined,
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          id: randomUUID(), model: ALPHA_SEARCH_MODEL,
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: request.query }] }],
          commands: { search_query: [{ q: request.query }] },
          settings: { allowed_callers: ['direct'], external_web_access: true },
          max_output_tokens: 2048,
        }),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new WebError(`Codex search HTTP ${response.status}`, 'CODEX_HTTP_ERROR')
      }
      if (!response.body) protocolError('empty response body')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > this.config.maxResponseBytes) {
            await reader.cancel()
            throw new WebError('Codex search response exceeds maxResponseBytes', 'CODEX_RESPONSE_TOO_LARGE')
          }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const buffer = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length }
      let value: unknown
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) }
      catch { protocolError('expected a UTF-8 JSON response; SSE is not supported') }
      return parseSearchResponse(value, this.config.maxAnswerChars)
    } catch (error) {
      if (error instanceof WebError) throw error
      if (signal?.aborted) throw new WebError('Codex search cancelled', 'WEB_ABORTED')
      if (timeout.aborted) throw new WebError('Codex search timed out', 'CODEX_TIMEOUT')
      throw new WebError('Codex search transport failed', 'CODEX_TRANSPORT_ERROR')
    }
  }
}
