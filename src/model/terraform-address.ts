/**
 * Terraform addresses, which are what a Terraform entity's id is.
 *
 * Two facts about them drive everything here. A module called with `count` or
 * `for_each` puts its key in every address inside it
 * (`module.svc["api"].aws_ecs_service.this`), so one module block in the
 * configuration is several modules in the state. And Terraform records
 * dependencies, in the state and in `depends_on`, as *configuration*
 * addresses, without those keys (`module.svc.aws_ecs_service.this`). Matching
 * the second against the first by string equality is how references into
 * counted modules used to be dropped.
 *
 * Kept free of any provider so renderers can use it as well: grouping and
 * collapsing by module is a picture of the same addresses.
 */

export interface ModuleStep {
  name: string
  /** The instance key exactly as written, brackets included: `[0]`, `["api"]`. */
  key?: string
}

export interface ParsedAddress {
  modules: ModuleStep[]
  /** Whatever follows the module path: `aws_ecs_service.this`. */
  local: string
}

// A key is a number or a quoted string, and a quoted key may hold dots,
// brackets and escaped quotes, which is why this is not a split on `.`.
const STEP = /^module\.([A-Za-z_][A-Za-z0-9_-]*)(\[(?:"(?:[^"\\]|\\.)*"|[0-9]+)\])?(?:\.|$)/

export function parseAddress(address: string): ParsedAddress {
  const modules: ModuleStep[] = []
  let rest = address
  for (let m = STEP.exec(rest); m; m = STEP.exec(rest)) {
    modules.push(m[2] ? { name: m[1]!, key: m[2] } : { name: m[1]! })
    rest = rest.slice(m[0].length)
  }
  return { modules, local: rest }
}

export function formatModules(steps: ModuleStep[]): string {
  return steps.map((s) => `module.${s.name}${s.key ?? ''}`).join('.')
}

/** `module.svc["api"].aws_ecs_service.this` is in `module.svc["api"]`; a root resource is in no module. */
export function moduleOf(address: string): string | undefined {
  const { modules } = parseAddress(address)
  return modules.length ? formatModules(modules) : undefined
}

/** Every module enclosing an address, outermost first. */
export function modulePath(address: string): string[] {
  const { modules } = parseAddress(address)
  return modules.map((_, i) => formatModules(modules.slice(0, i + 1)))
}

/** The address with every module key removed, which is how Terraform records a dependency. */
export function configAddress(address: string): string {
  const { modules, local } = parseAddress(address)
  if (!modules.length) return address
  const path = formatModules(modules.map((s) => ({ name: s.name })))
  return local ? `${path}.${local}` : path
}

/**
 * Resolves addresses that may leave module keys out against the ids that
 * exist. `module.svc.aws_security_group.this` names one security group per
 * instance of `module.svc`, and which of them is meant depends on who is
 * asking:
 *
 * - a key the address does state must match;
 * - inside `module.svc["api"]`, it is the one in `module.svc["api"]`, because
 *   a module's resources can only refer to their own instance;
 * - from outside the module, Terraform recorded the dependency on the module
 *   block as a whole, so it is every instance. That draws an arrow to each
 *   instance where the configuration may have used only one, and the state
 *   holds nothing finer to go on; dropping them all was the worse picture.
 *
 * The second and third rule are one rule: keep the candidates that share the
 * longest run of enclosing module instances with the dependent resource.
 */
export class AddressIndex {
  private readonly byConfig = new Map<string, Array<{ id: string; parsed: ParsedAddress }>>()
  private readonly ids: Set<string>

  constructor(ids: Iterable<string>) {
    this.ids = new Set(ids)
    for (const id of this.ids) {
      const key = configAddress(id)
      const list = this.byConfig.get(key) ?? []
      list.push({ id, parsed: parseAddress(id) })
      this.byConfig.set(key, list)
    }
  }

  has(id: string): boolean {
    return this.ids.has(id)
  }

  resolve(target: string, from: string): string[] {
    if (this.ids.has(target)) return [target]
    const wanted = parseAddress(target)
    const candidates = (this.byConfig.get(configAddress(target)) ?? []).filter(({ parsed }) =>
      wanted.modules.every((step, i) => step.key === undefined || parsed.modules[i]?.key === step.key),
    )
    if (candidates.length <= 1) return candidates.map((c) => c.id)
    const origin = parseAddress(from).modules
    const shared = (steps: ModuleStep[]) => {
      let n = 0
      while (n < steps.length && n < origin.length && steps[n]!.name === origin[n]!.name && steps[n]!.key === origin[n]!.key) n++
      return n
    }
    const scored = candidates.map((c) => ({ id: c.id, score: shared(c.parsed.modules) }))
    const best = Math.max(...scored.map((c) => c.score))
    return scored.filter((c) => c.score === best).map((c) => c.id)
  }
}
