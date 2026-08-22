import { Registry } from '../registry.js'
import type { Provider } from './types.js'
import { terraformProvider } from './terraform.js'
import { dynatraceProvider } from './dynatrace.js'

/**
 * Built-in providers. Third parties register their own against the same
 * registry — there is no separate plugin API to learn.
 */
export const providers = new Registry<Provider>('provider')
providers.register(terraformProvider as unknown as Provider)
providers.register(dynatraceProvider as unknown as Provider)

export { terraformProvider, dynatraceProvider }
export type { Provider, ProviderContext, ProviderKind } from './types.js'
export { defineProvider } from './types.js'
