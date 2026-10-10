import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchCurrentState,
  terraformCloudConfigSchema,
  terraformCloudProvider,
} from '../src/providers/terraform-cloud.js'
import { validateModel } from '../src/model/validate.js'
import type { ProviderContext } from '../src/providers/types.js'

const stateFile = readFileSync(new URL('../examples/orders-platform.tfstate.json', import.meta.url), 'utf8')
const config = terraformCloudConfigSchema.parse({ organization: 'acme', workspace: 'prod-orders' })

interface Call {
  url: string
  auth: string | undefined
}

/**
 * A fake HCP Terraform API. Each route answers with a status and body; any URL
 * not listed is a 500, so an unexpected call fails loudly rather than quietly.
 */
type Routes = Record<string, { status?: number; body: unknown }>

function fakeApi(routes: Routes) {
  const calls: Call[] = []
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url, auth: headers['Authorization'] })
    const route = routes[url]
    if (!route) return new Response('unexpected', { status: 500, statusText: 'Unexpected' })
    const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body)
    return new Response(body, { status: route.status ?? 200 })
  }) as typeof fetch
  return { impl, calls }
}

const WS = 'https://app.terraform.io/api/v2/organizations/acme/workspaces/prod-orders'
const SV = 'https://app.terraform.io/api/v2/workspaces/ws-123/current-state-version'
const DL = 'https://app.terraform.io/_archivist/v1/object/abc'

function happyRoutes(download = DL): Routes {
  return {
    [WS]: { body: { data: { id: 'ws-123' } } },
    [SV]: {
      body: {
        data: {
          attributes: { serial: 42, 'created-at': '2026-10-01T12:00:00Z', 'hosted-state-download-url': download },
        },
      },
    },
    [download]: { body: stateFile },
  }
}

describe('terraform-cloud config', () => {
  it('rejects a config missing the workspace before any network call', () => {
    expect(terraformCloudConfigSchema.safeParse({ organization: 'acme' }).success).toBe(false)
  })

  it('defaults to HCP Terraform and $TFE_TOKEN', () => {
    expect(config.address).toBe('https://app.terraform.io')
    expect(config.tokenEnv).toBe('TFE_TOKEN')
  })
})

describe('fetchCurrentState', () => {
  it('resolves the workspace, reads its current state version and downloads the raw state', async () => {
    const { impl, calls } = fakeApi(happyRoutes())
    const fetched = await fetchCurrentState(config, 'secret', impl)
    expect(fetched.state).toBe(stateFile)
    expect(fetched.serial).toBe(42)
    expect(fetched.createdAt).toBe('2026-10-01T12:00:00Z')
    expect(calls.map((c) => c.url)).toEqual([WS, SV, DL])
    expect(calls.every((c) => c.auth === 'Bearer secret')).toBe(true)
  })

  it('never sends the token to a download host the config did not name', async () => {
    const elsewhere = 'https://archivist.example.com/object/abc?signature=x'
    const { impl, calls } = fakeApi(happyRoutes(elsewhere))
    await fetchCurrentState(config, 'secret', impl)
    expect(calls[2]).toEqual({ url: elsewhere, auth: undefined })
  })

  it('uses a Terraform Enterprise address', async () => {
    const tfe = terraformCloudConfigSchema.parse({ ...config, address: 'https://tfe.corp.example' })
    const { impl, calls } = fakeApi({})
    await expect(fetchCurrentState(tfe, 'secret', impl)).rejects.toThrow()
    expect(calls[0]!.url).toBe('https://tfe.corp.example/api/v2/organizations/acme/workspaces/prod-orders')
  })

  it('explains a 404 as either missing or invisible', async () => {
    const { impl } = fakeApi({ [WS]: { status: 404, body: {} } })
    await expect(fetchCurrentState(config, 'secret', impl)).rejects.toThrow(/not found .* cannot see it/)
  })

  it('names the env var when the token is rejected', async () => {
    const { impl } = fakeApi({ [WS]: { status: 401, body: {} } })
    await expect(fetchCurrentState(config, 'secret', impl)).rejects.toThrow(/\$TFE_TOKEN/)
  })

  it('refuses a workspace with no state rather than returning an empty model', async () => {
    const { impl } = fakeApi({ [WS]: { body: { data: { id: 'ws-123' } } }, [SV]: { status: 404, body: {} } })
    await expect(fetchCurrentState(config, 'secret', impl)).rejects.toThrow(/no state yet/)
  })

  it('points at the permission when the token can read outputs but not state', async () => {
    const routes = happyRoutes()
    routes[DL] = { status: 403, body: '' }
    const { impl } = fakeApi(routes)
    await expect(fetchCurrentState(config, 'secret', impl)).rejects.toThrow(/Read state versions/)
  })

  it('points at the permission when the state version has no download URL', async () => {
    const { impl } = fakeApi({
      [WS]: { body: { data: { id: 'ws-123' } } },
      [SV]: { body: { data: { attributes: { serial: 1 } } } },
    })
    await expect(fetchCurrentState(config, 'secret', impl)).rejects.toThrow(/Read state versions/)
  })
})

describe('terraformCloudProvider', () => {
  const ctx = (token?: string): ProviderContext => ({
    secret: () => token,
    resolvePath: (p) => p,
    log: () => {},
  })

  afterEach(() => vi.unstubAllGlobals())

  it('refuses to run without a token', async () => {
    await expect(terraformCloudProvider.observe(config, ctx())).rejects.toThrow(/Set \$TFE_TOKEN/)
  })

  it('produces the same valid model as reading the state file locally', async () => {
    vi.stubGlobal('fetch', fakeApi(happyRoutes()).impl)
    const model = await terraformCloudProvider.observe(config, ctx('secret'))
    expect(validateModel(model).ok).toBe(true)
    expect(model.entities.length).toBeGreaterThan(0)
    expect(model.entities.every((e) => e.source === 'terraform')).toBe(true)
  })
})
