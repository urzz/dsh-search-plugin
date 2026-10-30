/** Configuration editor. Secret inputs never enter the configuration draft. */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SearchFace } from './index.js'
import type { LocaleKey } from './locales.js'

type Props = PropsRuntime<'plugins.bundle.config' | 'plugins.row.config'> & PropsLocale<'searchPlugin'> & InjectFace<SearchFace>
const fields = ['authMode', 'openaiProvider', 'credentialRef', 'endpoint', 'model', 'timeoutMs', 'maxResponseBytes', 'maxAnswerChars'] as const
type Field = typeof fields[number]
type Values = Record<Field, string>
const defaults: Values = { authMode: 'openai', openaiProvider: 'openai', credentialRef: 'DSH_CODEX_API_KEY', endpoint: '', model: '', timeoutMs: '60000', maxResponseBytes: '2000000', maxAnswerChars: '16000' }
const numeric = new Set<Field>(['timeoutMs', 'maxResponseBytes', 'maxAnswerChars'])
function valuesOf(value: Record<string, unknown>): Values {
  return Object.fromEntries(fields.map(field => [field, String(value[field] ?? defaults[field])])) as Values
}

/** Render the owner-supplied form with a revision-fenced, local draft. */
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
  const keyText = key?.ref === values.credentialRef ? key.text : ''
  const conflict = draft !== null && draft.revision !== state.revision
  const disabled = !state.writable || busy
  const validRef = /^[A-Za-z_][A-Za-z0-9_]*$/.test(values.credentialRef)
  const credentialCurrent = credential.ref === values.credentialRef
  const info = credentialCurrent ? credential.info : undefined
  const credentialWritable = info?.writable === true && !keyBusy
  const edit = (field: Field, value: string) => {
    setDraft({ values: { ...values, [field]: value }, revision: draft ? draft.revision : state.revision })
    setMessage(null)
    if (field === 'authMode') { setKey(null); setKeyMessage(null) }
    if (field === 'credentialRef') {
      setKey(null); setKeyMessage(null); props.describeCredential(value)
    }
  }
  const save = async (reset: boolean) => {
    if (conflict) { setMessage('conflict'); return }
    if (!reset) {
      let valid = fields.filter(field => numeric.has(field)).every(field => Number.isSafeInteger(Number(values[field])) && Number(values[field]) > 0)
      if (values.endpoint) {
        try { valid &&= ['http:', 'https:'].includes(new URL(values.endpoint).protocol) } catch { valid = false }
      }
      if (!valid || !validRef || !values.openaiProvider.trim() || !values.model.trim() || (values.authMode === 'credential' && !values.endpoint)) { setMessage('invalid'); return }
    }
    const ops: SettingsPathOpView[] = reset
      ? fields.map(field => ({ op: 'unset', path: [field] }))
      : fields.filter(field => values[field] !== accepted[field]).map(field => ({ op: 'set', path: [field], value: numeric.has(field) ? Number(values[field]) : values[field] }))
    setBusy(true); setMessage(null)
    try {
      if (await props.mutateConfig(ops, draft ? draft.revision : state.revision)) { setDraft(null); setMessage('saved') }
      else setMessage('failed')
    } catch { setMessage('failed') } finally { setBusy(false) }
  }
  const writeKey = async (remove: boolean) => {
    const ref = values.credentialRef
    setKeyBusy(true); setKeyMessage(null)
    try {
      if (remove) await props.removeCredential(ref)
      else await props.storeCredential(ref, keyText)
      setKey(null); setKeyMessage('keySaved')
    } catch { setKeyMessage('keyFailed') } finally { setKeyBusy(false) }
  }
  return <div className="dsh-search-config">
    <p className="dsh-search-hint">{t('inherit')}</p>
    <p className="dsh-search-hint">{t('trust')}</p>
    <form onSubmit={event => { event.preventDefault(); void save(false) }}>
      <fieldset disabled={disabled}>
        <label><span>{t('authMode')}</span><select value={values.authMode} onChange={event => edit('authMode', event.target.value)}>
          <option value="openai">{t('openai')}</option><option value="credential">{t('credential')}</option>
        </select></label>
        {fields.filter(field => field !== 'authMode').map(field => <label key={field}>
          <span>{t(field)}</span><input type={numeric.has(field) ? 'number' : 'text'} min={numeric.has(field) ? 1 : undefined} step={numeric.has(field) ? 1 : undefined}
            value={values[field]} onChange={event => edit(field, event.target.value)} disabled={field === 'credentialRef' && keyBusy} />
        </label>)}
      </fieldset>
      {!state.writable && <p role="status">{t('readOnly')}</p>}
      {conflict && <p role="alert">{t('conflict')}</p>}
      {message && <p role="status">{t(message)}</p>}
      <div className="dsh-search-actions">
        <button type="submit" disabled={disabled || conflict || !draft}>{t(busy ? 'saving' : 'save')}</button>
        <button type="button" disabled={disabled || conflict} onClick={() => { void save(true) }}>{t('reset')}</button>
        <button type="button" disabled={busy || !draft} onClick={() => { setDraft(null); setMessage(null); setKey(null); props.describeCredential(accepted.credentialRef) }}>{t('discard')}</button>
      </div>
    </form>
    {values.authMode === 'credential' && <section className="dsh-search-secret">
      <label><span>{t('key')}</span><input type="password" autoComplete="new-password" value={keyText} disabled={!credentialWritable}
        onChange={event => { setKey({ ref: values.credentialRef, text: event.target.value }); setKeyMessage(null) }} /></label>
      <p className="dsh-search-hint">{t('keyHint')}</p>
      <p role="status">{t(!validRef ? 'invalidRef' : credentialCurrent && credential.error ? 'keyFailed' : !info ? 'keyLoading' : info.configured ? 'keySet' : 'keyUnset')}</p>
      {info && !info.writable && <p>{t('keyReadOnly')}</p>}
      {keyMessage && <p role="status">{t(keyMessage)}</p>}
      <div className="dsh-search-actions">
        <button type="button" disabled={!credentialWritable || !keyText.trim()} onClick={() => { void writeKey(false) }}>{t('keySave')}</button>
        <button type="button" disabled={!credentialWritable || !info?.configured} onClick={() => { void writeKey(true) }}>{t('keyRemove')}</button>
        <button type="button" disabled={!validRef || keyBusy} onClick={() => props.describeCredential(values.credentialRef)}>{t('keyRefresh')}</button>
      </div>
    </section>}
  </div>
}
