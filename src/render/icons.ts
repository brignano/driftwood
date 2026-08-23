/**
 * Icons for rendered diagrams.
 *
 * Two constraints shape this module, and they rule out the obvious answers:
 *
 *   1. **No native dependencies and no downloads.** Vendor icon sets (the AWS
 *      Architecture Icons, Azure's, GCP's) are large binary asset packs with
 *      their own trademark terms, so they are not something this tool can
 *      quietly vendor. These icons are therefore drawn here, by category —
 *      "database", "queue", "load balancer" — not by vendor. A category set
 *      also survives contact with a multi-cloud estate: an on-prem Postgres,
 *      an RDS instance and a Cloud SQL instance all want the same glyph.
 *   2. **Engine parity.** The picture must be identical whether Graphviz ran
 *      as a native binary or as the bundled WASM build. Graphviz's own
 *      `image=` attribute is not viable for that: the native binary resolves
 *      it as a filesystem path, so a `data:` URI works in one tier and fails
 *      in the other.
 *
 * So the icon is not handed to Graphviz at all. `renderDot` reserves a
 * fixed-size cell in the node's HTML-like label containing a 1pt marker token,
 * Graphviz lays out the graph knowing exactly how much room the icon needs,
 * and `injectIcons` swaps each marker for inline SVG afterwards. Both tiers
 * emit the same SVG structure, so both get the same picture, and the result
 * stays a self-contained SVG with no external references and no base64 bloat.
 */

/**
 * The visual family an entity belongs to. Icons carry the specific meaning;
 * families carry the colour, so a diagram reads as a handful of zones rather
 * than thirty unrelated hues.
 */
export type Family = 'edge' | 'compute' | 'data' | 'messaging' | 'security' | 'observability' | 'other'

export interface FamilyStyle {
  /** Border and icon colour. */
  accent: string
  /** Node fill — a wash of the accent, light enough for 9pt text on top. */
  tint: string
}

export const PALETTE: Record<Family, FamilyStyle> = {
  edge: { accent: '#0284c7', tint: '#f0f9ff' },
  compute: { accent: '#d97706', tint: '#fffbeb' },
  data: { accent: '#059669', tint: '#ecfdf5' },
  messaging: { accent: '#7c3aed', tint: '#f5f3ff' },
  security: { accent: '#e11d48', tint: '#fff1f2' },
  observability: { accent: '#475569', tint: '#f8fafc' },
  other: { accent: '#64748b', tint: '#f8fafc' },
}

export type IconKey =
  | 'dns'
  | 'cdn'
  | 'api'
  | 'loadbalancer'
  | 'network'
  | 'firewall'
  | 'certificate'
  | 'identity'
  | 'secret'
  | 'compute'
  | 'function'
  | 'container'
  | 'cluster'
  | 'service'
  | 'database'
  | 'storage'
  | 'cache'
  | 'queue'
  | 'topic'
  | 'events'
  | 'email'
  | 'monitoring'
  | 'user'
  | 'generic'

interface Icon {
  family: Family
  /** SVG shapes on a 24x24 canvas. Stroke and fill are set by the wrapper. */
  body: string
}

/**
 * Drawn on a 24x24 grid, stroked rather than filled so a single accent colour
 * carries the whole glyph and one wrapper `<g>` can restyle it.
 */
export const ICONS: Record<IconKey, Icon> = {
  dns: {
    family: 'edge',
    body:
      '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/>' +
      '<path d="M3.2 12h17.6M5 7h14M5 17h14"/>',
  },
  cdn: {
    family: 'edge',
    body:
      '<circle cx="12" cy="12" r="3.6"/>' +
      '<path d="M12 8.4V4M12 15.6V20M8.9 10.2 5.1 8M15.1 13.8l3.8 2.2M8.9 13.8 5.1 16M15.1 10.2 18.9 8"/>' +
      '<circle cx="12" cy="3" r="1.6"/><circle cx="12" cy="21" r="1.6"/>' +
      '<circle cx="3.9" cy="7.3" r="1.6"/><circle cx="20.1" cy="16.7" r="1.6"/>' +
      '<circle cx="3.9" cy="16.7" r="1.6"/><circle cx="20.1" cy="7.3" r="1.6"/>',
  },
  api: {
    family: 'edge',
    body: '<path d="M8.5 5.5 3.5 12l5 6.5M15.5 5.5 20.5 12l-5 6.5M13.6 4.2 10.4 19.8"/>',
  },
  loadbalancer: {
    family: 'edge',
    body:
      '<rect x="9" y="2.5" width="6" height="5" rx="1.5"/>' +
      '<path d="M12 7.5v3M4 13.5v-3h16v3M12 10.5v3"/>' +
      '<rect x="1.5" y="13.5" width="5" height="5" rx="1.5"/>' +
      '<rect x="9.5" y="13.5" width="5" height="5" rx="1.5"/>' +
      '<rect x="17.5" y="13.5" width="5" height="5" rx="1.5"/>',
  },
  network: {
    family: 'edge',
    body:
      '<circle cx="12" cy="4.6" r="2.6"/><circle cx="4.8" cy="18" r="2.6"/><circle cx="19.2" cy="18" r="2.6"/>' +
      '<path d="M10.7 6.9 6.1 15.7M13.3 6.9l4.6 8.8M7.4 18h9.2"/>',
  },
  firewall: {
    family: 'security',
    body: '<path d="M12 2.5 20 5.4v6.2c0 4.9-3.4 8-8 9.9-4.6-1.9-8-5-8-9.9V5.4Z"/><path d="M8.4 12.1 11 14.7l4.6-5"/>',
  },
  certificate: {
    family: 'security',
    body: '<circle cx="12" cy="9" r="6.1"/><path d="M8.4 14.2v7.3L12 19.4l3.6 2.1v-7.3"/><path d="M9.7 9l1.7 1.8 3-3.4"/>',
  },
  identity: {
    family: 'security',
    body:
      '<rect x="2.8" y="3.2" width="18.4" height="17.6" rx="3"/>' +
      '<circle cx="12" cy="10.2" r="2.9"/><path d="M7.2 17.9a4.9 4.9 0 0 1 9.6 0"/>',
  },
  secret: {
    family: 'security',
    body: '<circle cx="8.4" cy="8.4" r="4.6"/><path d="M11.7 11.7 20.4 20.4M15.6 19.2l2-2M18.1 16.7l2-2"/>',
  },
  compute: {
    family: 'compute',
    body:
      '<rect x="2.8" y="3.6" width="18.4" height="7" rx="1.8"/><rect x="2.8" y="13.4" width="18.4" height="7" rx="1.8"/>' +
      '<circle cx="6.4" cy="7.1" r=".9" fill="currentColor" stroke="none"/>' +
      '<circle cx="6.4" cy="16.9" r=".9" fill="currentColor" stroke="none"/>',
  },
  function: {
    family: 'compute',
    body: '<path d="M13.6 2.4 5.2 13.6h5.6L10.4 21.6l8.4-11.2h-5.6Z"/>',
  },
  container: {
    family: 'compute',
    body: '<path d="M12 2.6 20.6 7v10L12 21.4 3.4 17V7Z"/><path d="M3.4 7 12 11.4 20.6 7M12 11.4v10"/>',
  },
  cluster: {
    family: 'compute',
    body:
      '<path d="M12 2.6 20.6 7v10L12 21.4 3.4 17V7Z"/><circle cx="12" cy="12" r="3.2"/>' +
      '<path d="M12 8.8V4.6M14.8 13.8l3.6 2.1M9.2 13.8l-3.6 2.1"/>',
  },
  service: {
    family: 'compute',
    body: '<path d="M12 2.6 20.6 7v10L12 21.4 3.4 17V7Z"/><path d="M8.4 12h7.2M12 8.4v7.2"/>',
  },
  database: {
    family: 'data',
    body:
      '<ellipse cx="12" cy="6" rx="8" ry="3.2"/>' +
      '<path d="M4 6v12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V6"/>' +
      '<path d="M4 12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2"/>',
  },
  storage: {
    family: 'data',
    body: '<ellipse cx="12" cy="6.2" rx="8" ry="2.6"/><path d="M4 6.2 5.9 19a6.2 6.2 0 0 0 12.2 0L20 6.2"/>',
  },
  cache: {
    family: 'data',
    body:
      '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.6" y="9.6" width="4.8" height="4.8" rx="1"/>' +
      '<path d="M9.2 6V2.8M14.8 6V2.8M9.2 18v3.2M14.8 18v3.2M6 9.2H2.8M6 14.8H2.8M18 9.2h3.2M18 14.8h3.2"/>',
  },
  queue: {
    family: 'messaging',
    body: '<rect x="2.4" y="6" width="19.2" height="12" rx="2"/><path d="M8.8 6v12M15.2 6v12"/>',
  },
  topic: {
    family: 'messaging',
    body:
      '<circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/>' +
      '<path d="M8 8.2a5.4 5.4 0 0 0 0 7.6M16 8.2a5.4 5.4 0 0 1 0 7.6"/>' +
      '<path d="M5.2 5.2a9.6 9.6 0 0 0 0 13.6M18.8 5.2a9.6 9.6 0 0 1 0 13.6"/>',
  },
  events: {
    family: 'messaging',
    body: '<path d="M12 2.4 21.6 12 12 21.6 2.4 12Z"/><path d="M12.9 7.2 9.4 12.6h2.5l-.8 4.2 3.5-5.4h-2.5Z"/>',
  },
  email: {
    family: 'messaging',
    body: '<rect x="2.4" y="5" width="19.2" height="14" rx="2"/><path d="M3.2 7 12 13.4 20.8 7"/>',
  },
  monitoring: {
    family: 'observability',
    body: '<path d="M3.4 3.4v17.2h17.2"/><path d="M6.6 16.6 11 11.2l3.4 2.8 5.4-7"/>',
  },
  user: {
    family: 'other',
    body: '<circle cx="12" cy="7.6" r="4"/><path d="M4.4 20.6a7.6 7.6 0 0 1 15.2 0"/>',
  },
  generic: {
    family: 'other',
    body: '<rect x="3.4" y="3.4" width="17.2" height="17.2" rx="3.4"/><path d="M8.6 12h6.8"/>',
  },
}

/**
 * `kind` is an open string by design, so this is pattern matching over
 * vocabularies rather than a lookup table — Terraform types, Kubernetes kinds,
 * Dynatrace entity types and anything a future provider invents.
 *
 * **Order is the whole trick.** More specific patterns must come first, and
 * several pairs actively collide: `aws_elasticache_cluster` is a cache, not a
 * Kubernetes cluster; `aws_db_instance` is a database, not an EC2 instance;
 * `aws_db_subnet_group` is data, not network. Those cases are pinned by tests.
 */
/**
 * Whole-token match. `\b` is no use here: `_` is a word character, so `\bses\b`
 * never matches `aws_ses_receipt_rule`, and `\bkey\b` never matches
 * `aws_kms_key`. Separators in the wild are `_`, `-`, `.` and case changes, so
 * the boundary is "anything that isn't alphanumeric".
 */
function tok(alternatives: string): string {
  return `(?:^|[^a-z0-9])(?:${alternatives})(?:[^a-z0-9]|$)`
}

function rule(source: string, key: IconKey): [RegExp, IconKey] {
  return [new RegExp(source, 'i'), key]
}

const KIND_ICONS: Array<[RegExp, IconKey]> = [
  rule(`route53|hosted_?zone|dns|record_?set|${tok('record|zone|zones')}`, 'dns'),
  rule(`cloudfront|front_?door|fastly|akamai|${tok('cdn')}`, 'cdn'),
  rule(`certificate|${tok('acm|cert|certs|tls|ssl')}`, 'certificate'),
  rule(`waf|firewall|security_?group|network_?acl|${tok('nacl|nsg|acl')}`, 'firewall'),
  rule(`load_?balanc|target_?group|ingress|${tok('lb|alb|nlb|elb')}`, 'loadbalancer'),
  rule(`api_?gateway|apigw|appsync|graphql|endpoint|${tok('api')}`, 'api'),
  rule(`elasticache|memcache|redis|${tok('cache')}`, 'cache'),
  rule(
    `rds|dynamodb|aurora|spanner|cosmos|mongo|postgres|mysql|bigtable|firestore|database|${tok('db|sql')}`,
    'database',
  ),
  rule(`bucket|blob|storage|volume|disk|file_?system|glacier|${tok('s3|efs|fs')}`, 'storage'),
  rule(
    `vpc|subnet|vnet|nat_?gateway|route_?table|peering|transit_?gateway|network_?interface|${tok('nat|cidr')}`,
    'network',
  ),
  rule('event_?bridge|event_?bus|event_?rule|event_?source|scheduler', 'events'),
  rule(`sqs|queue|kinesis|kafka|rabbit|stream|${tok('msk')}`, 'queue'),
  rule('sns|topic|pubsub|subscription|notification', 'topic'),
  rule(`smtp|email|sendgrid|${tok('ses|mail')}`, 'email'),
  rule(`task_?definition|container|docker|image|${tok('ecr|pod|pods')}`, 'container'),
  rule(`cluster|node_?group|node_?pool|${tok('eks|gke|aks')}`, 'cluster'),
  rule('lambda|function|serverless', 'function'),
  rule(
    `virtual_?machine|autoscal|compute|${tok('ec2|vm|asg|instance|instances|server|servers|host|hosts')}`,
    'compute',
  ),
  rule('service|deployment|app_?service|workload|daemonset|statefulset|replicaset', 'service'),
  rule(`iam|policy|principal|service_?account|user_?pool|cognito|${tok('role|roles|auth|rbac')}`, 'identity'),
  rule(`secret|key_?vault|parameter_?store|ssm_parameter|vault|${tok('kms|key|keys')}`, 'secret'),
  rule(
    `cloudwatch|metric|alarm|monitor|prometheus|grafana|dashboard|log_?group|telemetry|${tok('log|logs|trace|traces')}`,
    'monitoring',
  ),
  rule(`browser|customer|${tok('user|users|client|clients|actor|external')}`, 'user'),
]

export function iconFor(kind: string): IconKey {
  for (const [pattern, key] of KIND_ICONS) if (pattern.test(kind)) return key
  return 'generic'
}

export function familyFor(kind: string): Family {
  return ICONS[iconFor(kind)].family
}

export function styleFor(kind: string): FamilyStyle {
  return PALETTE[familyFor(kind)]
}

/**
 * Namespaced so it cannot collide with anything a provider might legitimately
 * put in an entity name. `renderDot` additionally strips the prefix from
 * labels, so a hostile model cannot inject its own icon.
 *
 * Deliberately letters, digits, `_` and `@` only: Graphviz XML-escapes SVG
 * text, so a hyphen would come back out as `&#45;` and the marker would no
 * longer match itself.
 */
export const MARKER_PREFIX = '@@dwicon_'

export function marker(key: IconKey): string {
  return `${MARKER_PREFIX}${key}@@`
}

/** Rendered size of the icon, in points, matching the cell `renderDot` reserves. */
export const ICON_SIZE = 24

export function iconSvg(key: IconKey, x: number, y: number, color: string, size = ICON_SIZE): string {
  const icon = ICONS[key] ?? ICONS.generic
  const scale = size / 24
  const left = round(x - size / 2)
  const top = round(y - size / 2)
  return (
    `<g class="driftwood-icon" transform="translate(${left} ${top}) scale(${round(scale)})" ` +
    `fill="none" stroke="${color}" color="${color}" stroke-width="1.7" ` +
    `stroke-linecap="round" stroke-linejoin="round">${icon.body}</g>`
  )
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

const NODE_RE = /<g id="node\d+" class="node">[\s\S]*?<\/g>/g
const MARKER_TEXT_RE = new RegExp(
  `<text\\b[^>]*\\bx="(-?[\\d.]+)"[^>]*\\by="(-?[\\d.]+)"[^>]*>${escapeRe(MARKER_PREFIX)}([a-z]+)@@</text>`,
)

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Horizontal centre of a node's shape.
 *
 * The marker text's own `x` is the *start* of the run, which depends on the
 * marker's width in the current font — unusable. The node's outline is not:
 * every label this renderer emits is a single-column table, so the icon cell's
 * centre is the shape's centre.
 */
function centreX(nodeSvg: string): number | undefined {
  const ellipse = nodeSvg.match(/<ellipse[^>]*\bcx="(-?[\d.]+)"/)
  if (ellipse?.[1]) return Number(ellipse[1])

  const geometry = nodeSvg.match(/<(?:polygon|path)[^>]*\b(?:points|d)="([^"]+)"/)
  if (!geometry?.[1]) return undefined
  const numbers = geometry[1]
    .replace(/[A-Za-z]/g, ' ')
    .split(/[\s,]+/)
    .filter((t) => t !== '')
    .map(Number)
  const xs: number[] = []
  for (let i = 0; i < numbers.length; i += 2) {
    const x = numbers[i]
    if (x !== undefined && Number.isFinite(x)) xs.push(x)
  }
  if (xs.length === 0) return undefined
  return (Math.min(...xs) + Math.max(...xs)) / 2
}

/**
 * Replaces every icon marker in a Graphviz-produced SVG with inline vector
 * artwork. Anything it does not recognise is left exactly as it was, so a
 * marker-free SVG (Mermaid, or DOT rendered by someone else) passes through
 * untouched.
 */
export function injectIcons(svg: string, colorFor?: (nodeId: string) => string): string {
  return svg.replace(NODE_RE, (node) => {
    const found = MARKER_TEXT_RE.exec(node)
    if (!found) return node
    const [element, , yRaw, key] = found
    const y = Number(yRaw)
    const x = centreX(node)
    if (x === undefined || !Number.isFinite(y)) return node.replace(element!, '')

    const id = node.match(/<title>([\s\S]*?)<\/title>/)?.[1]
    const color = colorFor && id ? colorFor(unescapeXml(id)) : PALETTE.other.accent
    return node.replace(element!, iconSvg((key ?? 'generic') as IconKey, x, y, color))
  })
}

function unescapeXml(s: string): string {
  return s
    .replace(/&#45;/g, '-')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}
