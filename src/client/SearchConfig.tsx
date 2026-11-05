/** Configuration editor. Secret inputs never enter the configuration draft. */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SearchFace } from './index.js'
import type { LocaleKey } from './locales.js'

export type Props = PropsRuntime<'plugins.bundle.config'> & PropsLocale<'searchPlugin'> & InjectFace<SearchFace>
const defaults = { protocol: 'codex-alpha', authMode: 'openai', openaiProvider: 'openai', credentialRef: 'DSH_CODEX_API_KEY', endpoint: '', timeoutMs: '60000', maxResponseBytes: '2000000', maxAnswerChars: '16000', deepseekEndpoint: 'https://api.deepseek.com/v1/tools', deepseekCredentialRef: 'DEEPSEEK_API_KEY', deepseekCount: '10' }
type Field = keyof typeof defaults
type Values = Record<Field, string>
const fields = Object.keys(defaults) as Field[]
const alphaLimits: Field[] = ['timeoutMs', 'maxResponseBytes', 'maxAnswerChars']
const numeric = new Set<Field>([...alphaLimits, 'deepseekCount'])
function valuesOf(value: Record<string, unknown>): Values {
  return Object.fromEntries(fields.map(field => [field, String(value[field] ?? defaults[field])])) as Values
}
function validEndpoint(value: string) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash } catch { return false }
}

/** Render a revision-fenced draft, retaining both protocols when the selection changes. */
export function SearchConfig(props: Props) {
  const { t } = props
  const state = props.useConfig(snapshot => snapshot)
  const credential = props.useCredential(snapshot => snapshot)
  const [draft, setDraft] = useState<{ values: Values; revision: number | undefined } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<LocaleKey | null>(null)
  const [key, setKey] = useState<{ ref: string; text: string } | null>(null)
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyMessage, setKeyMessage] = useState<LocaleKey | null>(null)
  if (props.view === 'summary') return t('description')
  if (state.status !== 'ready' || !state.value) return <p role="status">{t(state.status === 'loading' ? 'loading' : 'unavailable')}</p>
  const accepted = valuesOf(state.value)
  const values = draft?.values ?? accepted
  const deepseek = values.protocol === 'deepseek-search-api'
  const independent = deepseek || values.authMode === 'credential'
  const refField = deepseek ? 'deepseekCredentialRef' : 'credentialRef'
  const ref = values[refField]
  const keyText = key?.ref === ref ? key.text : ''
  const conflict = draft !== null && draft.revision !== state.revision
  const disabled = !state.writable || busy
  const validRef = /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)
  const credentialCurrent = credential.ref === ref
  const info = credentialCurrent ? credential.info : undefined
  const credentialWritable = validRef && info?.writable === true && !keyBusy
  const edit = (field: Field, value: string) => {
    const next = { ...values, [field]: value }
    setDraft({ values: next, revision: draft ? draft.revision : state.revision }); setMessage(null)
    if (field === 'protocol' || field === 'authMode' || field === refField) {
      setKey(null); setKeyMessage(null)
      props.describeCredential(next.protocol === 'deepseek-search-api' ? next.deepseekCredentialRef : next.credentialRef)
    }
  }
  const save = async (reset: boolean) => {
    if (conflict) { setMessage('conflict'); return }
    if (!reset) {
      const activeNumeric = deepseek ? ['deepseekCount' as const] : alphaLimits
      let valid = activeNumeric.every(field => Number.isSafeInteger(Number(values[field])) && Number(values[field]) > 0)
      valid &&= deepseek ? Number(values.deepseekCount) <= 50 && validRef && validEndpoint(values.deepseekEndpoint) : independent ? validRef && validEndpoint(values.endpoint) : Boolean(values.openaiProvider.trim())
      if (!valid) { setMessage('invalid'); return }
    }
    // Include changed fields from both protocol drafts; hidden accepted values are never cleared.
    const ops: SettingsPathOpView[] = reset
      ? fields.map(field => ({ op: 'unset', path: [field] }))
      : fields.filter(field => values[field] !== accepted[field]).map(field => ({ op: 'set', path: [field], value: numeric.has(field) ? Number(values[field]) : values[field] }))
    setBusy(true); setMessage(null)
    try {
      if (await props.mutateConfig(ops, draft ? draft.revision : state.revision)) { setDraft(null); setMessage('saved'); setKey(null) }
      else setMessage('failed')
    } catch { setMessage('failed') } finally { setBusy(false) }
  }
  const writeKey = async (remove: boolean) => {
    setKeyBusy(true); setKeyMessage(null)
    try {
      if (remove) await props.removeCredential(ref)
      else await props.storeCredential(ref, keyText)
      setKey(null); setKeyMessage('keySaved')
    } catch { setKeyMessage('keyFailed') } finally { setKeyBusy(false) }
  }
  const input = (field: Field) => <label key={field}><span>{t(field)}</span><input name={field} type={numeric.has(field) ? 'number' : 'text'} min={numeric.has(field) ? 1 : undefined} max={field === 'deepseekCount' ? 50 : undefined} step={numeric.has(field) ? 1 : undefined} value={values[field]} onChange={event => edit(field, event.target.value)} disabled={field === refField && keyBusy} /></label>
  return <div className="dsh-search-config">
    <form aria-label={t('searchSettings')} onSubmit={event => { event.preventDefault(); void save(false) }}>
      <fieldset disabled={disabled || keyBusy}>
        <legend>{t('searchSettings')}</legend>
        <label><span>{t('protocol')}</span><select name="protocol" value={values.protocol} onChange={event => edit('protocol', event.target.value)}><option value="codex-alpha">{t('codexAlpha')}</option><option value="deepseek-search-api">{t('deepseekSearchApi')}</option></select></label>
        {!deepseek && <label><span>{t('authMode')}</span><select name="authMode" value={values.authMode} onChange={event => edit('authMode', event.target.value)}><option value="openai">{t('openai')}</option><option value="credential">{t('credential')}</option></select></label>}
        {(deepseek ? ['deepseekEndpoint', 'deepseekCredentialRef', 'deepseekCount'] as Field[] : independent ? ['endpoint', 'credentialRef'] as Field[] : ['openaiProvider'] as Field[]).map(input)}
      </fieldset>
      <p className="dsh-search-hint">{t(deepseek ? 'deepseekHint' : 'inherit')}</p>
      <p className="dsh-search-hint">{t('trust')}</p>
      {!deepseek && <fieldset disabled={disabled}><legend>{t('searchLimits')}</legend>{alphaLimits.map(input)}</fieldset>}
      {!state.writable && <p role="status">{t('readOnly')}</p>}
      {conflict && <p role="alert">{t('conflict')}</p>}
      {message && <p role="status">{t(message)}</p>}
      <div className="dsh-search-actions">
        <button type="submit" disabled={disabled || keyBusy || conflict || !draft}>{t(busy ? 'saving' : 'save')}</button>
        <button type="button" disabled={disabled || keyBusy || conflict} onClick={() => { void save(true) }}>{t('reset')}</button>
        <button type="button" disabled={busy || keyBusy || !draft} onClick={() => { setDraft(null); setMessage(null); setKey(null); setKeyMessage(null); props.describeCredential(accepted.protocol === 'deepseek-search-api' ? accepted.deepseekCredentialRef : accepted.credentialRef) }}>{t('discard')}</button>
      </div>
    </form>
    {independent && <section className="dsh-search-secret">
      <h3>{t('credentials')}</h3>
      <p className="dsh-search-hint">{t('credentialTarget')}: <code>{ref}</code></p>
      <label><span>{t('key')}</span><input name="key" type="password" autoComplete="new-password" value={keyText} disabled={!credentialWritable} onChange={event => { setKey({ ref, text: event.target.value }); setKeyMessage(null) }} /></label>
      <p className="dsh-search-hint">{t('keyHint')}</p>
      <p role="status">{t(!validRef ? 'invalidRef' : credentialCurrent && credential.error ? 'keyFailed' : !info ? 'keyLoading' : info.configured ? 'keySet' : 'keyUnset')}</p>
      {info && !info.writable && <p>{t('keyReadOnly')}</p>}
      {keyMessage && <p role="status">{t(keyMessage)}</p>}
      <div className="dsh-search-actions">
        <button type="button" disabled={!credentialWritable || !keyText.trim()} onClick={() => { void writeKey(false) }}>{t('keySave')}</button>
        <button type="button" disabled={!credentialWritable || !info?.configured} onClick={() => { void writeKey(true) }}>{t('keyRemove')}</button>
        <button type="button" disabled={!validRef || keyBusy} onClick={() => props.describeCredential(ref)}>{t('keyRefresh')}</button>
      </div>
    </section>}
  </div>
}
