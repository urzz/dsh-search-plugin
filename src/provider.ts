import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult, type WebSearchSource } from '@deepseek-ai/dsh-web'
/** Resolved values for one Responses request; never persisted or exposed to the browser. */
export interface ResponsesConfig {
  endpoint: string
  apiKey: string
  model: string
  timeoutMs: number
  maxResponseBytes: number
  maxAnswerChars: number
}

function protocolError(message: string): never {
  throw new WebError(`Codex search: ${message}`, 'CODEX_PROTOCOL_ERROR')
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) protocolError('expected an object')
  return value as Record<string, unknown>
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) protocolError('expected an array')
  return value
}

/** Parse only structured Responses citations and completed search calls, never guessed links. */
export function parseSearchResponse(value: unknown, maxAnswerChars: number): WebSearchResult {
  const response = object(value)
  if (response.status !== 'completed') protocolError('response did not complete')
  let searched = false
  const texts: string[] = []
  const sources = new Map<string, WebSearchSource>()
  function addSource(value: unknown): void {
    const source = object(value)
    if (typeof source.url !== 'string') protocolError('source URL is missing')
    let url: URL
    try { url = new URL(source.url) } catch { protocolError('invalid source URL') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) protocolError('unsupported source URL')
    if (source.title !== undefined && typeof source.title !== 'string') protocolError('invalid source title')
    const previous = sources.get(source.url)
    sources.set(source.url, {
      url: source.url,
      ...(previous?.title !== undefined ? { title: previous.title } : typeof source.title === 'string' ? { title: source.title } : {}),
    })
  }
  for (const itemValue of array(response.output)) {
    const item = object(itemValue)
    if (item.type === 'web_search_call') {
      if (item.status !== 'completed') protocolError('search call did not complete')
      searched = true
      if (item.action !== undefined) {
        const action = object(item.action)
        if (action.sources !== undefined) for (const source of array(action.sources)) addSource(source)
      }
    } else if (item.type === 'message') {
      for (const contentValue of array(item.content)) {
        const content = object(contentValue)
        if (content.type === 'refusal') protocolError('endpoint refused the search')
        if (content.type !== 'output_text') continue
        if (typeof content.text !== 'string') protocolError('output text is missing')
        texts.push(content.text)
        if (content.annotations !== undefined) {
          for (const annotationValue of array(content.annotations)) {
            const annotation = object(annotationValue)
            if (annotation.type === 'url_citation') addSource(annotation)
          }
        }
      }
    }
  }
  if (!searched) protocolError('no completed web_search_call; endpoint must support web_search')
  const answer = texts.join('\n\n')
  let content = answer.slice(0, maxAnswerChars)
  if (content.length < answer.length && /[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1)
  return {
    ...(content ? { content } : {}),
    sources: [...sources.values()],
    // DSH reserves this flag for omitted sources, not a shortened answer.
    // This adapter preserves all sources; ctx.web applies the caller's limit.
    truncated: false,
  }
}

/** Responses-compatible search backend. No retry, redirect following, or credential forwarding. */
export class CodexSearchProvider implements WebSearchProvider {
  readonly id = 'codex'
  private readonly config: ResponsesConfig

  constructor(config: ResponsesConfig) {
    const endpoint = new URL(config.endpoint)
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error('Codex endpoint must be an HTTP(S) URL without credentials or a fragment')
    }
    if (!config.apiKey.trim() || !config.model.trim()) throw new Error('Codex apiKey and model must be non-empty')
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
          model: this.config.model, store: false, stream: false,
          input: request.query,
          tools: [{ type: 'web_search' }], tool_choice: 'required',
          include: ['web_search_call.action.sources'],
        }),
      })
      if (!response.ok) {
        await response.body?.cancel()
        // Do not include upstream bodies, which can echo credentials and prompts.
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
      catch { protocolError('expected a UTF-8 JSON response (stream:false); SSE is not supported') }
      return parseSearchResponse(value, this.config.maxAnswerChars)
    } catch (error) {
      if (error instanceof WebError) throw error
      if (signal?.aborted) throw new WebError('Codex search cancelled', 'WEB_ABORTED')
      if (timeout.aborted) throw new WebError('Codex search timed out', 'CODEX_TIMEOUT')
      // Transport messages may include URLs or secrets; expose no raw remote error text.
      throw new WebError('Codex search transport failed', 'CODEX_TRANSPORT_ERROR')
    }
  }
}
