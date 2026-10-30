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

export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

/** Register the bundle's form and dispose styles and credential observers with its fiber. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('searchPlugin', { en, zh }))
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-search-plugin'
    style.textContent = css
    document.head.append(style)
    return () => style.remove()
  })
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
    if (value) describeCredential(typeof value.credentialRef === 'string' ? value.credentialRef : 'DSH_CODEX_API_KEY')
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
  ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: 'dsh-search-plugin', locale: 'searchPlugin', inject: () => face,
  }, SearchConfig)))
  ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config', key: 'dsh-search-plugin#dsh-search-plugin', locale: 'searchPlugin', inject: () => face,
  }, SearchConfig)))
}
