/** Browser registration; host configuration and credential values use separate write paths. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { SearchConfig } from './SearchConfig.js'
import { FetchConfig } from './FetchConfig.js'
import { Overview, type OverviewFace, type ProviderRows } from './Overview.js'
import { en, zh, type LocaleKey } from './locales.js'
import css from './style.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'searchPlugin': LocaleKey }
}

export interface CredentialSnapshot {
  ref: string
  info?: CredentialInfo
  error: boolean
}

export interface SearchFace {
  hooks: {
    credential: HostObservable<CredentialSnapshot>
    config: HostObservable<ConfigFormSnapshot<Record<string, unknown>>>
  }
  mutateConfig: ConfigForm<Record<string, unknown>>['mutate']
  describeCredential: (ref: string) => void
  storeCredential: (ref: string, value: string) => Promise<void>
  removeCredential: (ref: string) => Promise<void>
}

export interface FetchFace {
  hooks: { config: HostObservable<ConfigFormSnapshot<Record<string, unknown>>> }
  mutateConfig: ConfigForm<Record<string, unknown>>['mutate']
}

export const inject = ['slots', 'locale', 'configForms']

/** Register each component's editor and dispose observers with the client fiber. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('searchPlugin', { en, zh }))
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-search-plugin'
    style.textContent = css
    document.head.append(style)
    return () => style.remove()
  })
  ctx.inject(['remote', 'remote.credentials'], registerSearch)
  const form = ctx.configForms.get<Record<string, unknown>>('dsh-search-fetch')
  // Host settings currently drops transform callbacks on its second schema serialization.
  // Read the already validated namespace value from the public mirror; keep writes on
  // ConfigForms so server validation and revision fences remain authoritative.
  const mirror = ctx.configForms.describe()
  let previous: ReturnType<typeof mirror.getSnapshot> | undefined
  let snapshot: ConfigFormSnapshot<Record<string, unknown>>
  const getSnapshot = () => {
    const current = mirror.getSnapshot()
    if (current !== previous) {
      previous = current
      const section = current.view?.namespaces.find(section => section.ns === 'dsh-search-fetch')
      snapshot = {
        status: section ? 'ready' : current.view ? 'unavailable' : 'loading',
        value: section?.value as Record<string, unknown> | undefined,
        base: section?.base as Record<string, unknown> | undefined,
        user: section?.user as Record<string, unknown> | undefined,
        revision: section?.revision,
        writable: current.view?.writable ?? false,
      }
    }
    return snapshot
  }
  const face: FetchFace = {
    hooks: { config: { getSnapshot, subscribe: listener => mirror.subscribe(listener) } },
    mutateConfig: (ops, expectedRevision) => form.mutate(ops, expectedRevision),
  }
  ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config', key: 'dsh-search-plugin#dsh-search-fetch', locale: 'searchPlugin', inject: () => face,
  }, FetchConfig)))
  registerOverview(ctx)
}

function registerOverview(ctx: Context): void {
  const settings = ctx.configForms.describe()
  void settings.ensure()
  let state: ProviderRows = { status: 'unavailable' }
  let refreshRows = () => {}
  const listeners = new Set<() => void>()
  const publish = (next: ProviderRows) => { state = next; for (const listener of listeners) listener() }
  const face: OverviewFace = {
    hooks: {
      settings,
      providerRows: { getSnapshot: () => state, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    },
    refreshRows: () => refreshRows(),
  }
  ctx.effect(() => () => listeners.clear())
  ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config', key: 'dsh-search-plugin#dsh-search-ui', locale: 'searchPlugin', inject: () => face,
  }, Overview)))
  ctx.inject(['remote', 'remote.pluginInventory'], inner => {
    let disposed = false
    let sequence = 0
    const refresh = () => {
      const request = ++sequence
      publish({ status: 'loading' })
      void inner.remote.pluginInventory.list().then(result => {
        if (disposed || request !== sequence) return
        if (!result.ok) { publish({ status: 'error' }); return }
        const row = (id: string, moduleName: string) => result.value.entries.find(entry => entry.entryId === id && entry.moduleName === moduleName)?.enabled
        publish({ status: 'ready', search: row('dsh-search-plugin', 'dsh-search-plugin/search'), fetch: row('dsh-search-fetch', 'dsh-search-plugin/fetch') })
      }, () => { if (!disposed && request === sequence) publish({ status: 'error' }) })
    }
    refreshRows = refresh
    inner.effect(() => inner.remote.$on('plugin-manager/changed', refresh))
    inner.effect(() => () => { disposed = true; sequence++; refreshRows = () => {}; publish({ status: 'unavailable' }) })
    refresh()
  })
}

function registerSearch(ctx: Context): void {
  let state: CredentialSnapshot = { ref: '', error: false }
  let sequence = 0
  let disposed = false
  const listeners = new Set<() => void>()
  const publish = (next: CredentialSnapshot) => { state = next; for (const listener of listeners) listener() }
  const describeCredential = (ref: string) => {
    if (disposed) return
    const request = ++sequence
    publish({ ref, error: false })
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) return
    void ctx.remote.credentials.describe([ref]).then(result => {
      if (!disposed && request === sequence) {
        publish(result.ok ? { ref, info: result.value[ref], error: false } : { ref, error: true })
      }
    }, () => {
      if (!disposed && request === sequence) publish({ ref, error: true })
    })
  }
  const form = ctx.configForms.get<Record<string, unknown>>('dsh-search-plugin')
  const refresh = () => {
    const value = form.getSnapshot().value
    if (value) {
      const deepseek = value.protocol === 'deepseek-search-api'
      const ref = deepseek ? value.deepseekCredentialRef : value.credentialRef
      describeCredential(typeof ref === 'string' ? ref : deepseek ? 'DEEPSEEK_API_KEY' : 'DSH_CODEX_API_KEY')
    }
  }
  ctx.effect(() => form.subscribe(refresh))
  refresh()
  ctx.effect(() => ctx.remote.$on('credentials/reference-updated', ref => {
    if (ref === state.ref) describeCredential(ref)
  }))
  ctx.effect(() => () => { disposed = true; sequence++; listeners.clear() })
  const face: SearchFace = {
    hooks: {
      credential: { getSnapshot: () => state, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } },
      config: { getSnapshot: () => form.getSnapshot(), subscribe: listener => form.subscribe(listener) },
    },
    mutateConfig: (ops, expectedRevision) => form.mutate(ops, expectedRevision),
    describeCredential,
    storeCredential: async (ref, value) => {
      const result = await ctx.remote.credentials.set(ref, value)
      if (!result.ok) throw result.error
      describeCredential(ref)
    },
    removeCredential: async ref => {
      const result = await ctx.remote.credentials.unset(ref)
      if (!result.ok) throw result.error
      describeCredential(ref)
    },
  }
  ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config', key: 'dsh-search-plugin#dsh-search-plugin', locale: 'searchPlugin', inject: () => face,
  }, SearchConfig)))
}
