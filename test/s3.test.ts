import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { signRequest, uriEncode } from '../src/providers/aws-sigv4.js'
import {
  fetchStateObject,
  objectKey,
  objectUrl,
  terraformS3ConfigSchema,
  terraformS3Provider,
} from '../src/providers/terraform-s3.js'
import { validateModel } from '../src/model/validate.js'
import type { ProviderContext } from '../src/providers/types.js'

const stateFile = readFileSync(new URL('../examples/orders-platform.tfstate.json', import.meta.url), 'utf8')
const config = terraformS3ConfigSchema.parse({ bucket: 'acme-tfstate', key: 'prod/orders.tfstate', region: 'eu-west-1' })
const creds = { accessKeyId: 'AKID', secretAccessKey: 'SECRET' }

describe('signRequest', () => {
  // The worked GetObject example from the S3 SigV4 documentation
  // ("Example: GET Object"). If this passes, the canonical request, the key
  // derivation and the header formatting all agree with AWS.
  it('matches the S3 documentation example', () => {
    const headers = signRequest({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      region: 'us-east-1',
      service: 's3',
      credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
      headers: { Range: 'bytes=0-9' },
      now: new Date('2013-05-24T00:00:00Z'),
    })
    expect(headers['Authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
    expect(headers['x-amz-date']).toBe('20130524T000000Z')
    expect(headers).not.toHaveProperty('host')
  })

  it('signs a session token when there is one', () => {
    const headers = signRequest({
      method: 'GET',
      url: new URL('https://b.s3.amazonaws.com/k'),
      region: 'us-east-1',
      service: 's3',
      credentials: { ...creds, sessionToken: 'TOKEN' },
    })
    expect(headers['x-amz-security-token']).toBe('TOKEN')
    expect(headers['Authorization']).toContain('x-amz-security-token')
  })

  it('refuses a query string rather than signing it wrongly', () => {
    expect(() =>
      signRequest({ method: 'GET', url: new URL('https://b/k?x=1'), region: 'r', service: 's3', credentials: creds }),
    ).toThrow(/query/)
  })

  it('encodes the characters encodeURIComponent leaves alone', () => {
    expect(uriEncode("env:/a b!'()*")).toBe('env%3A%2Fa%20b%21%27%28%29%2A')
  })
})

describe('object location', () => {
  it('uses a virtual-hosted URL by default', () => {
    expect(String(objectUrl(config))).toBe('https://acme-tfstate.s3.eu-west-1.amazonaws.com/prod/orders.tfstate')
  })

  it('finds a non-default workspace where the backend puts it', () => {
    const ws = terraformS3ConfigSchema.parse({ ...config, workspace: 'staging' })
    expect(objectKey(ws)).toBe('env:/staging/prod/orders.tfstate')
    expect(objectUrl(ws).pathname).toBe('/env%3A/staging/prod/orders.tfstate')
  })

  it('uses path-style for a dotted bucket, whose virtual-hosted name fails TLS', () => {
    const dotted = terraformS3ConfigSchema.parse({ ...config, bucket: 'acme.tfstate' })
    expect(String(objectUrl(dotted))).toBe('https://s3.eu-west-1.amazonaws.com/acme.tfstate/prod/orders.tfstate')
  })

  it('uses path-style against a custom endpoint', () => {
    const minio = terraformS3ConfigSchema.parse({ ...config, endpoint: 'https://minio.corp.example/' })
    expect(String(objectUrl(minio))).toBe('https://minio.corp.example/acme-tfstate/prod/orders.tfstate')
  })

  it('rejects a config missing the region before any network call', () => {
    expect(terraformS3ConfigSchema.safeParse({ bucket: 'b', key: 'k' }).success).toBe(false)
  })
})

/** A fake S3 that answers one request; S3 errors are XML bodies. */
function fakeS3(status: number, body: string, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const impl = (async (input: URL | string, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> })
    return new Response(body, { status, headers })
  }) as typeof fetch
  return { impl, calls }
}

const s3Error = (code: string) => `<?xml version="1.0"?><Error><Code>${code}</Code><Message>x</Message></Error>`

describe('fetchStateObject', () => {
  it('sends a signed GET and returns the object', async () => {
    const { impl, calls } = fakeS3(200, stateFile, { 'last-modified': 'Thu, 01 Oct 2026 12:00:00 GMT' })
    const fetched = await fetchStateObject(config, creds, impl)
    expect(fetched.state).toBe(stateFile)
    expect(fetched.lastModified).toBe('Thu, 01 Oct 2026 12:00:00 GMT')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers['Authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/eu-west-1\/s3\//)
  })

  it('suggests `workspace` when the key does not exist', async () => {
    const { impl } = fakeS3(404, s3Error('NoSuchKey'))
    await expect(fetchStateObject(config, creds, impl)).rejects.toThrow(/does not exist.*set `workspace`/)
  })

  it('points at the region when the bucket lives elsewhere', async () => {
    const { impl } = fakeS3(301, s3Error('PermanentRedirect'))
    await expect(fetchStateObject(config, creds, impl)).rejects.toThrow(/not in eu-west-1/)
  })

  it('names the permissions when access is denied', async () => {
    const { impl } = fakeS3(403, s3Error('AccessDenied'))
    await expect(fetchStateObject(config, creds, impl)).rejects.toThrow(/s3:GetObject.*kms:Decrypt/)
  })

  it('reports a missing bucket as such', async () => {
    const { impl } = fakeS3(404, s3Error('NoSuchBucket'))
    await expect(fetchStateObject(config, creds, impl)).rejects.toThrow(/Bucket acme-tfstate does not exist/)
  })
})

describe('terraformS3Provider', () => {
  const ctx = (env: Record<string, string> = {}): ProviderContext => ({
    secret: (name) => env[name],
    resolvePath: (p) => p,
    log: () => {},
  })
  const env = { AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 'SECRET' }

  afterEach(() => vi.unstubAllGlobals())

  it('refuses to run without credentials, and says how to get them', async () => {
    await expect(terraformS3Provider.observe(config, ctx())).rejects.toThrow(/export-credentials/)
  })

  it('produces the same valid model as reading the state file locally', async () => {
    vi.stubGlobal('fetch', fakeS3(200, stateFile).impl)
    const model = await terraformS3Provider.observe(config, ctx(env))
    expect(validateModel(model).ok).toBe(true)
    expect(model.entities.length).toBeGreaterThan(0)
  })

  it('says which object was unreadable when it is not state', async () => {
    vi.stubGlobal('fetch', fakeS3(200, 'encrypted-blob').impl)
    await expect(terraformS3Provider.observe(config, ctx(env))).rejects.toThrow(
      /s3:\/\/acme-tfstate\/prod\/orders.tfstate is not readable Terraform state/,
    )
  })
})
