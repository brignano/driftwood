import { Registry } from '../registry.js'
import type { Provider } from './types.js'
import { terraformProvider } from './terraform.js'
import { dynatraceProvider } from './dynatrace.js'
import { observationProvider } from './observation.js'
import { terraformCloudProvider } from './terraform-cloud.js'
import { terraformS3Provider } from './terraform-s3.js'

/**
 * Built-in providers. Third parties register their own against the same
 * registry — there is no separate plugin API to learn.
 */
export const providers = new Registry<Provider>('provider')
providers.register(terraformProvider as unknown as Provider)
providers.register(dynatraceProvider as unknown as Provider)
providers.register(observationProvider as unknown as Provider)
providers.register(terraformCloudProvider as unknown as Provider)
providers.register(terraformS3Provider as unknown as Provider)

export { terraformProvider, dynatraceProvider, observationProvider, terraformCloudProvider, terraformS3Provider }
export type { Provider, ProviderContext, ProviderKind } from './types.js'
export { defineProvider } from './types.js'
