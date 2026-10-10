import { z } from 'zod'
import { type AwsCredentials, signRequest, uriEncode } from './aws-sigv4.js'
import { importTerraformState, parseTerraformState } from './terraform.js'
import { defineProvider } from './types.js'

/**
 * Terraform state stored by the `s3` backend, fetched by bucket and key.
 *
 * The same pull model as `terraform-cloud`, for teams whose state lives in a
 * bucket: a scheduled job in the model's repository reads the state directly,
 * with credentials that need only `s3:GetObject` on one object.
 *
 * Credentials come from environment variables only, read through
 * `ctx.secret`. That covers the cases a scheduled job actually runs in —
 * GitHub's OIDC role action, Jenkins and Harness credential bindings, and
 * `aws configure export-credentials --format env` anywhere else — without a
 * credential-chain implementation (profiles, SSO, instance metadata) that
 * would be most of an SDK.
 *
 * No `maxAgeMinutes`, for the reason `terraform-cloud` has none: the object is
 * read live, and its age is the last apply, not the staleness of the answer.
 */

export const terraformS3ConfigSchema = z.object({
  bucket: z.string().min(1),
  /** The backend's `key`, e.g. `prod/orders.tfstate`. */
  key: z.string().min(1),
  region: z.string().min(1),
  /**
   * A non-default Terraform workspace. The backend stores it at
   * `<workspaceKeyPrefix>/<workspace>/<key>`, not at `key`.
   */
  workspace: z.string().min(1).optional(),
  /** The backend's `workspace_key_prefix`. */
  workspaceKeyPrefix: z.string().default('env:'),
  /** An S3-compatible endpoint (MinIO, R2, a VPC endpoint). Uses path-style URLs. */
  endpoint: z.string().url().optional(),
  /** Names of the env vars holding credentials. Never the credentials themselves. */
  accessKeyIdEnv: z.string().default('AWS_ACCESS_KEY_ID'),
  secretAccessKeyEnv: z.string().default('AWS_SECRET_ACCESS_KEY'),
  sessionTokenEnv: z.string().default('AWS_SESSION_TOKEN'),
  includeDataSources: z.boolean().default(false),
})

export type TerraformS3Config = z.infer<typeof terraformS3ConfigSchema>

/** Where the backend keeps the state for this config's workspace. */
export function objectKey(config: TerraformS3Config): string {
  return config.workspace ? `${config.workspaceKeyPrefix}/${config.workspace}/${config.key}` : config.key
}

/**
 * Virtual-hosted URLs by default, as AWS recommends. Path-style for a custom
 * endpoint, and for a bucket name with dots, which breaks the wildcard TLS
 * certificate on the virtual-hosted name.
 */
export function objectUrl(config: TerraformS3Config): URL {
  const path = objectKey(config).split('/').map(uriEncode).join('/')
  if (config.endpoint) {
    const base = config.endpoint.replace(/\/+$/, '')
    return new URL(`${base}/${uriEncode(config.bucket)}/${path}`)
  }
  if (config.bucket.includes('.')) {
    return new URL(`https://s3.${config.region}.amazonaws.com/${config.bucket}/${path}`)
  }
  return new URL(`https://${config.bucket}.s3.${config.region}.amazonaws.com/${path}`)
}

/** S3 errors are XML; the `<Code>` element is the useful part. */
function errorCode(body: string): string | undefined {
  return body.match(/<Code>([^<]+)<\/Code>/)?.[1]
}

export interface FetchedObject {
  state: string
  lastModified: string | undefined
}

/**
 * Fetches the state object. `fetchImpl` and `now` exist for tests; nothing
 * else should pass them.
 */
export async function fetchStateObject(
  config: TerraformS3Config,
  credentials: AwsCredentials,
  fetchImpl: typeof fetch = fetch,
  now?: Date,
): Promise<FetchedObject> {
  const url = objectUrl(config)
  const where = `s3://${config.bucket}/${objectKey(config)}`
  const headers = signRequest({ method: 'GET', url, region: config.region, service: 's3', credentials, now })

  const res = await fetchImpl(url, { headers, redirect: 'manual' })
  if (res.ok) return { state: await res.text(), lastModified: res.headers.get('last-modified') ?? undefined }

  const code = errorCode(await res.text())
  // Each of these is a message about the config, not about S3, because that
  // is where the fix is.
  if (code === 'NoSuchKey') {
    throw new Error(
      `${where} does not exist.` +
        (config.workspace
          ? ` Check the workspace name and the backend's workspace_key_prefix (here '${config.workspaceKeyPrefix}').`
          : ' If the backend uses a non-default workspace, set `workspace`.'),
    )
  }
  if (code === 'NoSuchBucket') throw new Error(`Bucket ${config.bucket} does not exist in ${config.region}.`)
  if (code === 'PermanentRedirect' || code === 'AuthorizationHeaderMalformed' || res.status === 301) {
    throw new Error(`Bucket ${config.bucket} is not in ${config.region}. Set \`region\` to the bucket's region.`)
  }
  if (res.status === 403) {
    throw new Error(
      `Reading ${where} was refused (${code ?? '403'}). The credentials in $${config.accessKeyIdEnv} need ` +
        `s3:GetObject on that object, and kms:Decrypt if the bucket encrypts with a customer-managed key.`,
    )
  }
  throw new Error(`Reading ${where} failed: ${res.status} ${res.statusText}${code ? ` (${code})` : ''}`)
}

export const terraformS3Provider = defineProvider({
  name: 'terraform-s3',
  description: 'Terraform state in an S3 (or S3-compatible) backend, fetched by bucket and key (read-only)',
  kind: 'declarative',
  platforms: ['*'],
  configSchema: terraformS3ConfigSchema,
  async observe(config, ctx) {
    const accessKeyId = ctx.secret(config.accessKeyIdEnv)
    const secretAccessKey = ctx.secret(config.secretAccessKeyEnv)
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        `AWS credentials not found. Set $${config.accessKeyIdEnv} and $${config.secretAccessKeyEnv} ` +
          `(and $${config.sessionTokenEnv} for temporary credentials). With a profile or SSO, ` +
          '`eval "$(aws configure export-credentials --format env)"` exports them.',
      )
    }
    const sessionToken = ctx.secret(config.sessionTokenEnv)
    const fetched = await fetchStateObject(config, { accessKeyId, secretAccessKey, sessionToken })
    const where = `s3://${config.bucket}/${objectKey(config)}`
    ctx.log(`terraform-s3: ${where}${fetched.lastModified ? `, written ${fetched.lastModified}` : ''}`)

    let state
    try {
      state = parseTerraformState(fetched.state)
    } catch (err) {
      throw new Error(`${where} is not readable Terraform state: ${(err as Error).message}`)
    }
    return importTerraformState(state, { includeDataSources: config.includeDataSources })
  },
})
