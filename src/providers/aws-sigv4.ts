import { createHash, createHmac } from 'node:crypto'

/**
 * AWS Signature Version 4, for the one request driftwood makes to S3: a GET.
 *
 * Hand-written rather than taken from `@aws-sdk/client-s3`, because the SDK
 * would bring dozens of packages to sign a single read, and the signing
 * algorithm is small, fixed, and published with test vectors (see
 * `test/s3.test.ts`, which checks against the example in the S3 docs).
 */

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export interface SignInput {
  method: string
  url: URL
  region: string
  service: string
  credentials: AwsCredentials
  /** Extra headers to sign and send. */
  headers?: Record<string, string>
  now?: Date
}

/** SHA-256 of the empty body every GET sends. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const hmac = (key: Buffer | string, s: string) => createHmac('sha256', key).update(s, 'utf8').digest()

/**
 * RFC 3986 encoding as SigV4 requires it. `encodeURIComponent` leaves
 * `!'()*` alone, which AWS does not, and the mismatch fails the signature.
 */
export function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** Returns the headers to send, `Authorization` included. */
export function signRequest(input: SignInput): Record<string, string> {
  const now = input.now ?? new Date()
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const day = amzDate.slice(0, 8)

  const headers: Record<string, string> = {
    host: input.url.host,
    'x-amz-content-sha256': EMPTY_SHA256,
    'x-amz-date': amzDate,
    ...(input.credentials.sessionToken ? { 'x-amz-security-token': input.credentials.sessionToken } : {}),
  }
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v

  const names = Object.keys(headers).sort()
  const signedHeaders = names.join(';')
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim()}\n`).join('')
  // GetObject needs no query string, so none is supported: signing one
  // correctly needs code-point sorting that nothing here would exercise.
  if (input.url.search) throw new Error(`signRequest does not sign query strings (${input.url.search})`)

  const canonicalRequest = [
    input.method,
    // The path is used as already encoded: S3 signs each key segment encoded once.
    input.url.pathname,
    '',
    canonicalHeaders,
    signedHeaders,
    EMPTY_SHA256,
  ].join('\n')

  const scope = `${day}/${input.region}/${input.service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')

  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, day)
  const kSigning = hmac(hmac(hmac(kDate, input.region), input.service), 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  // `host` is set by fetch itself from the URL; sending it explicitly is refused.
  const { host: _host, ...send } = headers
  return {
    ...send,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}
