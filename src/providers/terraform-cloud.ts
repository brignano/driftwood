import { z } from 'zod'
import { importTerraformState, parseTerraformState } from './terraform.js'
import { defineProvider } from './types.js'

/**
 * A Terraform Cloud / HCP Terraform (or Terraform Enterprise) workspace's
 * current state, fetched by name.
 *
 * The pull half of reconciliation. The `observation` provider waits for a
 * pipeline to push an artifact; this one goes and gets the state itself, so a
 * scheduled job in the model's repository needs nothing but a read-only token.
 *
 * Three read-only calls: resolve the workspace, read its current state version,
 * download that version's raw state. The raw (v4) state is used rather than the
 * `terraform show -json` rendering because the existing importer reads v4 and
 * the JSON rendering is produced asynchronously — it can be absent on a state
 * version that is otherwise complete.
 *
 * Unlike the `observation` provider there is no `maxAgeMinutes`. The current
 * state version is read live, so it is as fresh as the call; its age only says
 * when someone last applied, and a stable workspace that nobody has touched in
 * a month is still describing what exists.
 */

export const terraformCloudConfigSchema = z.object({
  organization: z.string().min(1),
  workspace: z.string().min(1),
  /** Terraform Enterprise installs set their own hostname. */
  address: z.string().url().default('https://app.terraform.io'),
  /**
   * Name of the env var holding the API token. Never the token itself. A team
   * token with "Read state versions" is enough; "Read outputs" is not.
   */
  tokenEnv: z.string().default('TFE_TOKEN'),
  includeDataSources: z.boolean().default(false),
})

export type TerraformCloudConfig = z.infer<typeof terraformCloudConfigSchema>

export interface FetchedState {
  /** Raw state file contents (format v4). */
  state: string
  serial: number | undefined
  createdAt: string | undefined
}

interface JsonApi<T> {
  data?: { id?: string; attributes?: T }
}

interface StateVersionAttributes {
  serial?: number
  'created-at'?: string
  'hosted-state-download-url'?: string
}

/**
 * Fetches the workspace's current state. `fetchImpl` exists for tests; nothing
 * else should pass it.
 */
export async function fetchCurrentState(
  config: TerraformCloudConfig,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedState> {
  const api = new URL(config.address)
  const where = `${config.organization}/${config.workspace}`
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.api+json' }

  const wsUrl = new URL(
    `/api/v2/organizations/${encodeURIComponent(config.organization)}/workspaces/${encodeURIComponent(config.workspace)}`,
    api,
  )
  const ws = await fetchImpl(wsUrl, { headers })
  if (ws.status === 401) {
    throw new Error(`${config.address} rejected the token in $${config.tokenEnv} (401). Check that it has not expired.`)
  }
  // The API answers 404 both for a workspace that does not exist and for one
  // the token may not see, so the message has to cover both.
  if (ws.status === 404) {
    throw new Error(
      `Workspace ${where} not found at ${config.address}, or the token in $${config.tokenEnv} cannot see it.`,
    )
  }
  if (!ws.ok) throw new Error(`${config.address} answered ${ws.status} ${ws.statusText} for workspace ${where}`)
  const wsId = ((await ws.json()) as JsonApi<unknown>).data?.id
  if (!wsId) throw new Error(`${config.address} returned no id for workspace ${where}`)

  const svUrl = new URL(`/api/v2/workspaces/${encodeURIComponent(wsId)}/current-state-version`, api)
  const sv = await fetchImpl(svUrl, { headers })
  if (sv.status === 404) {
    throw new Error(`Workspace ${where} has no state yet — nothing has been applied to it.`)
  }
  if (!sv.ok) throw new Error(`${config.address} answered ${sv.status} ${sv.statusText} for the state of ${where}`)
  const attrs = ((await sv.json()) as JsonApi<StateVersionAttributes>).data?.attributes ?? {}

  const download = attrs['hosted-state-download-url']
  if (!download) {
    throw new Error(
      `The current state version of ${where} has no download URL. ` +
        `The token in $${config.tokenEnv} likely has "Read outputs" rather than "Read state versions".`,
    )
  }

  // The download URL is chosen by the server. Send the token only if it points
  // back at the same origin; a URL elsewhere is expected to be pre-signed, and
  // a bearer token must not travel to a host the config did not name.
  const downloadUrl = new URL(download, api)
  const res = await fetchImpl(downloadUrl, downloadUrl.origin === api.origin ? { headers } : {})
  if (res.status === 403) {
    throw new Error(
      `Downloading the state of ${where} was refused (403). ` +
        `The token in $${config.tokenEnv} needs "Read state versions", not just "Read outputs".`,
    )
  }
  if (!res.ok) throw new Error(`Downloading the state of ${where} failed: ${res.status} ${res.statusText}`)

  return { state: await res.text(), serial: attrs.serial, createdAt: attrs['created-at'] }
}

export const terraformCloudProvider = defineProvider({
  name: 'terraform-cloud',
  description: 'A Terraform Cloud / HCP Terraform / Enterprise workspace, fetched by name (read-only)',
  kind: 'declarative',
  platforms: ['*'],
  configSchema: terraformCloudConfigSchema,
  async observe(config, ctx) {
    const token = ctx.secret(config.tokenEnv)
    if (!token) {
      throw new Error(
        `Terraform Cloud token not found. Set $${config.tokenEnv} to a team token with "Read state versions".`,
      )
    }
    const fetched = await fetchCurrentState(config, token)
    ctx.log(
      `terraform-cloud: ${config.organization}/${config.workspace} state serial ${fetched.serial ?? '?'}` +
        (fetched.createdAt ? `, written ${fetched.createdAt}` : ''),
    )
    return importTerraformState(parseTerraformState(fetched.state), {
      includeDataSources: config.includeDataSources,
    })
  },
})
