/** The bundle owns the single entry point for both independent editors. */
import { SearchConfig, type Props } from './SearchConfig.js'
import { FetchConfig } from './FetchConfig.js'

export function BundleConfig(props: Props) {
  if (props.view === 'summary') return props.t('description')
  return <><SearchConfig {...props} /><FetchConfig {...props} /></>
}
