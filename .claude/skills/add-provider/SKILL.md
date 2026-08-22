---
name: add-provider
description: Add a new observation provider to driftwood (Splunk, AWS API, GCP, Kubernetes, OpenTelemetry, ServiceNow, etc.). Use when the user wants driftwood to read topology from a new system or platform.
---

# Adding a provider

A provider answers exactly one question: **"what is actually out there right now?"** It returns a `Model`. It never reads the committed model, never writes files, and never mutates infrastructure.

## Steps

### 1. Write the pure mapping function first

Separate the data transformation from the I/O, and export it. This is what gets unit-tested without a network.

```ts
export function toModel(raw: SomePayload[], platform: string): Model {
  const model = emptyModel('myprovider')
  // ... map to entities, then to edges
  return model
}
```

**Edges must never dangle.** Build a `Set` of the ids you actually emitted and skip any relationship whose endpoint isn't in it. `validateModel` rejects dangling edges, and rightly so.

### 2. Define the config schema

```ts
export const myConfigSchema = z.object({
  url: z.string().url(),
  tokenEnv: z.string().default('MY_API_TOKEN'),  // the env var NAME
  platform: z.string().default('onprem'),
})
```

**Never put a secret in config.** Config carries the *name* of an environment variable; `ctx.secret(name)` reads it. Never touch `process.env` directly in a provider.

### 3. Define the provider

```ts
export const myProvider = defineProvider({
  name: 'myprovider',
  description: 'one line, shown by `driftwood providers`',
  kind: 'runtime',           // or 'declarative'
  platforms: ['onprem'],     // or ['*'] if platform-agnostic
  configSchema: myConfigSchema,
  async observe(config, ctx) {
    const token = ctx.secret(config.tokenEnv)
    if (!token) throw new Error(`Set $${config.tokenEnv} to a token with read scope.`)
    return toModel(await fetchStuff(config, token), config.platform)
  },
})
```

Choosing `kind` matters — it sets merge precedence:

- `declarative` — describes *intent*: Terraform, CloudFormation, Helm, Pulumi. Wins on naming and grouping, because IaC names beat monitoring display names.
- `runtime` — describes *reality*: Dynatrace, Splunk, OTel, cloud APIs. Establishes what is actually live.

### 4. Register it

In `src/providers/index.ts`:

```ts
providers.register(myProvider as unknown as Provider)
```

### 5. Test it

Add to `test/` — cover the failure modes, not just the happy path:

- entities with a missing id are skipped
- relationships pointing outside the selection don't produce dangling edges
- output passes `validateModel`
- `source` and `platform` are stamped on every entity
- config validation rejects bad input *before* any network call

### 6. Document it

Add a commented block to `examples/driftwood.config.yaml` and a row to the README's provider table.

## Identity: do not guess

Your provider's ids will not match other providers' ids. **That is fine and expected.** Emit your native ids. Cross-source joins happen only through the explicit `aliases` map in the committed model.

Do not add fuzzy matching (name similarity, tag heuristics) without a very deliberate decision — a wrongly merged node silently corrupts the graph, while a duplicated node is visible and fixable.
