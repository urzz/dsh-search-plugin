/** Fetch edits share the host revision fence but never write search settings. */
import { useState } from 'react'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { Props } from './SearchConfig.js'
import type { LocaleKey } from './locales.js'

const defaults = { fetchAllowedCidrs: '', fetchTimeoutMs: '30000', fetchMaxResponseBytes: '5000000', fetchMaxContentChars: '100000' }
type Field = keyof typeof defaults
type Values = Record<Field, string>
const fields = Object.keys(defaults) as Field[]
const limits: Field[] = ['fetchTimeoutMs', 'fetchMaxResponseBytes', 'fetchMaxContentChars']
function valuesOf(value: Record<string, unknown>): Values {
  return Object.fromEntries(fields.map(field => [field, field === 'fetchAllowedCidrs' ? (value[field] as string[] | undefined)?.join('\n') ?? '' : String(value[field] ?? defaults[field])])) as Values
}

export function FetchConfig(props: Props) {
  const { t } = props
  const state = props.useConfig(snapshot => snapshot)
  const [draft, setDraft] = useState<{ values: Values; revision: number | undefined } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<LocaleKey | null>(null)
  if (props.view === 'summary') return t('fetchSettings')
  if (state.status !== 'ready' || !state.value) return <p role="status">{t(state.status === 'loading' ? 'loading' : 'unavailable')}</p>
  const accepted = valuesOf(state.value)
  const values = draft?.values ?? accepted
  const conflict = draft !== null && draft.revision !== state.revision
  const disabled = !state.writable || busy
  const edit = (field: Field, value: string) => {
    setDraft({ values: { ...values, [field]: value }, revision: draft ? draft.revision : state.revision })
    setMessage(null)
  }
  const save = async (reset: boolean) => {
    if (conflict) { setMessage('conflict'); return }
    if (!reset && !limits.every(field => Number.isSafeInteger(Number(values[field])) && Number(values[field]) > 0)) {
      setMessage('fetchInvalid'); return
    }
    const ops: SettingsPathOpView[] = reset
      ? fields.map(field => ({ op: 'unset', path: [field] }))
      : fields.filter(field => values[field] !== accepted[field]).map(field => ({ op: 'set', path: [field], value: field === 'fetchAllowedCidrs' ? values[field].split(/\r?\n/).map(line => line.trim()).filter(Boolean) : Number(values[field]) }))
    setBusy(true); setMessage(null)
    try {
      if (await props.mutateConfig(ops, draft ? draft.revision : state.revision)) { setDraft(null); setMessage('saved') }
      else setMessage('failed')
    } catch { setMessage('failed') } finally { setBusy(false) }
  }
  return <div className="dsh-search-config">
    <form aria-label={t('fetchSettings')} onSubmit={event => { event.preventDefault(); void save(false) }}>
      <fieldset disabled={disabled}>
        <legend>{t('fetchSettings')}</legend>
        <label className="dsh-search-wide"><span>{t('fetchAllowedCidrs')}</span><textarea name="fetchAllowedCidrs" rows={4} value={values.fetchAllowedCidrs} onChange={event => edit('fetchAllowedCidrs', event.target.value)} aria-describedby="dsh-search-cidr-hint" /></label>
        <p id="dsh-search-cidr-hint" className="dsh-search-hint dsh-search-wide">{t('cidrHint')}</p>
        {limits.map(field => <label key={field}><span>{t(field)}</span><input name={field} type="number" min={1} step={1} value={values[field]} onChange={event => edit(field, event.target.value)} /></label>)}
      </fieldset>
      {!state.writable && <p role="status">{t('readOnly')}</p>}
      {conflict && <p role="alert">{t('conflict')}</p>}
      {message && <p role="status">{t(message)}</p>}
      <div className="dsh-search-actions">
        <button type="submit" disabled={disabled || conflict || !draft}>{t(busy ? 'saving' : 'save')}</button>
        <button type="button" disabled={disabled || conflict} onClick={() => { void save(true) }}>{t('reset')}</button>
        <button type="button" disabled={busy || !draft} onClick={() => { setDraft(null); setMessage(null) }}>{t('discard')}</button>
      </div>
    </form>
  </div>
}
