/**
 * A tiny name -> implementation registry, shared by providers and renderers.
 *
 * Extension points are the whole point of this file: adding a provider or a
 * renderer must never require editing core code. Built-ins register themselves
 * at startup; third parties call `register()` with the same API, so a plugin
 * is not a second-class citizen.
 */
export class Registry<T extends { name: string }> {
  private readonly items = new Map<string, T>()

  constructor(private readonly label: string) {}

  register(item: T): this {
    if (this.items.has(item.name)) {
      throw new Error(`${this.label} '${item.name}' is already registered`)
    }
    this.items.set(item.name, item)
    return this
  }

  /** Replaces an existing entry. Used by tests and by deliberate overrides. */
  override(item: T): this {
    this.items.set(item.name, item)
    return this
  }

  get(name: string): T {
    const item = this.items.get(name)
    if (!item) {
      throw new Error(`unknown ${this.label} '${name}' (available: ${this.names().join(', ') || 'none'})`)
    }
    return item
  }

  has(name: string): boolean {
    return this.items.has(name)
  }

  names(): string[] {
    return [...this.items.keys()].sort()
  }

  all(): T[] {
    return this.names().map((n) => this.items.get(n)!)
  }
}
