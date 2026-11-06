/** Shared UI status uses accepted Host settings and effective Loader enablement. */
import type { InjectFace, PropsLocale, PropsRuntime, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'

export interface ProviderRows {
  status: 'loading' | 'ready' | 'error' | 'unavailable'
  search?: boolean
  fetch?: boolean
}
export interface OverviewFace {
  hooks: { settings: SettingsDescribeFace; providerRows: HostObservable<ProviderRows> }
  refreshRows: () => void
}
type Props = PropsRuntime<'plugins.row.config'> & PropsLocale<'searchPlugin'> & InjectFace<OverviewFace>

export function Overview(props: Props) {
  const { t } = props
  const settings = props.useSettings(snapshot => snapshot)
  const rows = props.useProviderRows(snapshot => snapshot)
  if (props.view === 'summary') return t('description')
  const web = settings.view?.namespaces.find(section => section.ns === 'web')?.value as { searchProvider?: string; fetchProvider?: string } | undefined
  return <section className="dsh-search-config" aria-label={t('overview')}>
    <p className="dsh-search-hint">{t('sharedHint')}</p>
    <h3>{t('overview')}</h3>
    {settings.error && <p role="status">{t('overviewSettingsError')}</p>}
    <dl className="dsh-search-overview">
      {(['search', 'fetch'] as const).map(kind => {
        const provider = web?.[`${kind}Provider`]
        const selected = provider === (kind === 'search' ? 'codex' : 'search-http')
        return <div key={kind}>
          <dt>{t(kind === 'search' ? 'effectiveSearchProvider' : 'effectiveFetchProvider')}</dt>
          <dd><code>{provider || t(!settings.view ? 'loading' : web ? 'providerUnselected' : 'unavailable')}</code></dd>
          <dt>{t(kind === 'search' ? 'searchRow' : 'fetchRow')}</dt>
          <dd>{t(rows.status === 'loading' ? 'loading' : rows.status === 'error' ? 'overviewRowsError' : rows[kind] === undefined ? 'rowUnavailable' : rows[kind] ? 'rowEnabled' : 'rowDisabled')}</dd>
          <dt>{t('routing')}</dt>
          <dd>{t(!web ? 'unavailable' : !provider ? 'providerUnselected' : selected ? 'routedHere' : 'routedElsewhere')}</dd>
        </div>
      })}
    </dl>
    <p className="dsh-search-hint">{t('routingHint')}</p>
    <div className="dsh-search-actions"><button type="button" onClick={props.refreshRows} disabled={rows.status === 'loading'}>{t('refreshOverview')}</button></div>
  </section>
}
