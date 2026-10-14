import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Model } from '../src/model/schema.js'
import { loadModel } from '../src/model/validate.js'
import {
  PREVIEW_MARKER,
  formatPreviewComment,
  parseTerraformPlan,
  previewPlan,
} from '../src/preview.js'
import type { TfPlan } from '../src/preview.js'
import { importTerraformState, parseTerraformState, resourceAddress, stateFromValues } from '../src/providers/terraform.js'
import type { TfValuesResource } from '../src/providers/terraform.js'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const fixture = parseTerraformPlan(read('../examples/orders-platform.plan.json'))
const declared = loadModel(read('../examples/architecture.yaml')).model!

const AWS = 'registry.terraform.io/hashicorp/aws'
const res = (address: string, extra: Partial<TfValuesResource> = {}): TfValuesResource => {
  const local = resourceAddress(address).replace(/^(module\.[^.]+(\[[^\]]*\])?\.)+/, '')
  const isData = local.startsWith('data.')
  const [type, name] = (isData ? local.slice('data.'.length) : local).split('.')
  return { address, mode: isData ? 'data' : 'managed', type, name, provider_name: AWS, values: { name }, ...extra }
}
const plan = (
  before: TfValuesResource[],
  after: TfValuesResource[],
  changes: [string, string[]][],
  configuration?: TfPlan['configuration'],
): TfPlan => ({
  format_version: '1.2',
  prior_state: { values: { root_module: { resources: before } } },
  planned_values: { root_module: { resources: after } },
  resource_changes: changes.map(([address, actions]) => ({ address, mode: 'managed', change: { actions } })),
  configuration,
})

describe('terraform show -json', () => {
  it('imports the same model as the raw state it renders', () => {
    // The fixture's prior state is the example state in the values format.
    const raw = importTerraformState(parseTerraformState(read('../examples/orders-platform.tfstate.json')))
    const shown = importTerraformState({ format_version: '1.0', values: fixture.prior_state!.values })
    expect(shown.entities).toEqual(raw.entities)
    expect(shown.edges).toEqual(raw.edges)
  })

  it('collapses count and for_each instances into one entity', () => {
    const state = stateFromValues({
      root_module: {
        resources: [res('aws_subnet.private[0]'), res('aws_subnet.private[1]'), res('aws_subnet.named["a"]')],
      },
    })
    const model = importTerraformState(state)
    expect(model.entities.map((e) => e.id)).toEqual(['aws_subnet.named', 'aws_subnet.private'])
  })

  it('keeps a module instance key, because two module instances are two things', () => {
    expect(resourceAddress('module.zone["eu"].aws_vpc.main')).toBe('module.zone["eu"].aws_vpc.main')
    expect(resourceAddress('module.zone["eu"].aws_subnet.a[2]')).toBe('module.zone["eu"].aws_subnet.a')
  })

  it('reads resources in child modules under their module address', () => {
    const model = importTerraformState({
      format_version: '1.0',
      values: {
        root_module: {
          resources: [res('aws_vpc.main')],
          child_modules: [
            {
              address: 'module.network',
              resources: [res('module.network.aws_subnet.a', { depends_on: ['aws_vpc.main'] })],
            },
          ],
        },
      },
    })
    expect(model.entities.map((e) => e.id)).toEqual(['aws_vpc.main', 'module.network.aws_subnet.a'])
    expect(model.edges).toEqual([{ from: 'module.network.aws_subnet.a', to: 'aws_vpc.main', kind: 'depends-on' }])
  })

  it('refuses a plan by name rather than reading half of it', () => {
    expect(() => importTerraformState(fixture as never)).toThrow(/driftwood preview/)
  })
})

describe('parseTerraformPlan', () => {
  it('refuses a state, saying how to produce a plan', () => {
    expect(() => parseTerraformPlan(read('../examples/orders-platform.tfstate.json'))).toThrow(/terraform show -json tfplan/)
  })

  it('refuses a plan format it does not know', () => {
    expect(() => parseTerraformPlan('{"format_version":"2.0","resource_changes":[]}')).toThrow(/format_version 2.0/)
  })
})

describe('previewPlan on the example plan', () => {
  const { preview, comment, diagram } = previewPlan(fixture, { declared, title: 'orders-platform · prod' })

  it("classifies every change by Terraform's verb", () => {
    expect(preview.changes.create).toEqual(['aws_sns_topic_subscription.payments', 'aws_sqs_queue.payments'])
    expect(preview.changes.update).toEqual(['aws_ecs_service.orders_api', 'aws_iam_role_policy.orders_api'])
    expect(preview.changes.replace).toEqual(['aws_db_instance.orders'])
    expect(preview.changes.destroy).toEqual(['aws_cloudwatch_metric_alarm.dlq_depth'])
  })

  it("takes a touched resource's new edges from the configuration, not the stale state", () => {
    expect(preview.changes.edges.added).toContainEqual({
      from: 'aws_iam_role_policy.orders_api',
      to: 'aws_sqs_queue.payments',
      kind: 'depends-on',
    })
  })

  it("drops a destroyed resource's edges", () => {
    expect(preview.changes.edges.removed.map((e) => e.from)).toEqual([
      'aws_cloudwatch_metric_alarm.dlq_depth',
      'aws_cloudwatch_metric_alarm.dlq_depth',
    ])
  })

  it('reports untouched resources as unchanged', () => {
    const touched = new Set(Object.values(preview.changes).flat())
    expect(touched.has('aws_vpc.main')).toBe(false)
  })

  it('names only what this plan does to the design', () => {
    expect(preview.design?.createdNotDeclared).toEqual(['aws_sns_topic_subscription.payments', 'aws_sqs_queue.payments'])
    expect(preview.design?.destroyedButDeclared).toEqual(['aws_cloudwatch_metric_alarm.dlq_depth'])
    // The example state matches its model, so nothing was already adrift.
    expect(preview.design?.beforePlan.hasDrift).toBe(false)
    expect(comment).not.toContain('already there before this plan')
  })

  it('starts with the marker a workflow finds its earlier comment by', () => {
    expect(comment.startsWith(`${PREVIEW_MARKER}\n`)).toBe(true)
  })

  it('leads with the count and the changes that lose data', () => {
    expect(comment).toContain('**This plan changes 6 resources: it creates 2, replaces 1, updates 2 and destroys 1.**')
    const warning = comment.indexOf('> [!WARNING]')
    expect(warning).toBeGreaterThan(-1)
    expect(warning).toBeLessThan(comment.indexOf('```mermaid'))
    expect(comment).toContain('`aws_db_instance.orders` is replaced')
  })

  it('draws the changed resources marked, with only the neighbours a reviewer needs', () => {
    expect(diagram).toContain('class n_aws_db_instance_orders mark_replace;')
    expect(diagram).toContain('class n_aws_cloudwatch_metric_alarm_dlq_depth mark_destroy;')
    expect(diagram).toContain('-/+ replace')
    // The other end of a relationship this plan adds, unchanged itself.
    expect(diagram).toContain('n_aws_sns_topic_order_events')
    expect(diagram).not.toContain('class n_aws_sns_topic_order_events mark_')
    // What a changed resource merely depends on is not news: the database's subnet group.
    expect(diagram).not.toContain('n_aws_db_subnet_group_orders')
    expect(diagram).not.toContain('n_aws_route53_zone_primary')
  })

  it('draws a relationship going away dashed, and a new one thick', () => {
    expect(diagram).toContain('n_aws_cloudwatch_metric_alarm_dlq_depth -.-> n_aws_sqs_queue_orders_dlq')
    expect(diagram).toContain('n_aws_sns_topic_subscription_payments ==> n_aws_sqs_queue_payments')
    // An unchanged relationship stays plain.
    expect(diagram).toContain('n_aws_db_instance_orders --> n_aws_kms_key_data')
  })

  it('never puts a hex colour right before a semicolon in a link style, which Mermaid reads as an entity', () => {
    for (const line of diagram!.split('\n').filter((l) => l.includes('linkStyle'))) {
      expect(line).not.toMatch(/#[0-9a-f]+;/i)
    }
  })

  it('lists every change in a folded table', () => {
    expect(comment).toContain('<details><summary>Every change (6)</summary>')
    expect(comment).toContain('| destroy | aws_cloudwatch_metric_alarm.dlq_depth | aws_cloudwatch_metric_alarm | shop-orders-dlq-not-empty |')
  })

  it('works without a model, and says nothing about the design', () => {
    const bare = previewPlan(fixture)
    expect(bare.preview.design).toBeUndefined()
    expect(bare.comment).not.toContain('Against the committed design')
    expect(bare.preview.changes).toEqual(preview.changes)
  })
})

describe('previewPlan edge cases', () => {
  it('calls a resource whose count grows updated, not created', () => {
    const { preview } = previewPlan(
      plan([res('aws_instance.web[0]')], [res('aws_instance.web[0]'), res('aws_instance.web[1]')], [
        ['aws_instance.web[0]', ['no-op']],
        ['aws_instance.web[1]', ['create']],
      ]),
    )
    expect(preview.changes.create).toEqual([])
    expect(preview.changes.update).toEqual(['aws_instance.web'])
  })

  it('reads create-before-destroy as a replace too', () => {
    const { preview } = previewPlan(
      plan([res('aws_lb.api')], [res('aws_lb.api')], [['aws_lb.api', ['create', 'delete']]]),
    )
    expect(preview.changes.replace).toEqual(['aws_lb.api'])
  })

  it('does not mistake a module called data for a data source', () => {
    const r = res('module.data.aws_s3_bucket.b')
    const { preview } = previewPlan(
      plan([], [r], [['module.data.aws_s3_bucket.b', ['create']]]),
    )
    expect(preview.changes.create).toEqual(['module.data.aws_s3_bucket.b'])
  })

  it('does not call a resource Terraform stops managing destroyed', () => {
    const { comment, preview } = previewPlan(plan([res('aws_s3_bucket.b')], [], [['aws_s3_bucket.b', ['forget']]]))
    expect(preview.changes.destroy).toEqual([])
    expect(comment).not.toContain('[!WARNING]')
  })

  it('skips data sources unless asked for them', () => {
    const p = plan([res('data.aws_region.current')], [res('data.aws_region.current')], [])
    p.resource_changes = [{ address: 'data.aws_region.current', mode: 'data', change: { actions: ['read'] } }]
    expect(previewPlan(p).preview.changes.update).toEqual([])
  })

  it('resolves references through data., module prefixes and indexes, and ignores variables', () => {
    const before = [res('aws_vpc.main'), res('module.net.aws_subnet.a'), res('data.aws_ami.base')]
    const after = [...before, res('module.net.aws_instance.web[0]')]
    const { preview } = previewPlan(
      plan(before, after, [['module.net.aws_instance.web[0]', ['create']]], {
        root_module: {
          module_calls: {
            net: {
              module: {
                resources: [
                  {
                    mode: 'managed',
                    type: 'aws_instance',
                    name: 'web',
                    expressions: {
                      subnet_id: { references: ['aws_subnet.a.id', 'aws_subnet.a'] },
                      ami: { references: ['data.aws_ami.base.id'] },
                      tags: { references: ['var.env', 'local.name', 'each.key'] },
                      ebs_block_device: [{ kms_key_id: { references: ['aws_kms_key.gone.arn'] } }],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
      { includeDataSources: true },
    )
    expect(preview.changes.create).toEqual(['module.net.aws_instance.web'])
    // The data source lives in the root module, so `data.aws_ami.base` inside
    // module.net names a different, unknown resource and draws no edge; the
    // missing KMS key draws none either rather than a dangling one.
    expect(preview.changes.edges.added).toEqual([
      { from: 'module.net.aws_instance.web', to: 'module.net.aws_subnet.a', kind: 'depends-on' },
    ])
  })

  it('says a plan with no changes changes nothing, and draws nothing', () => {
    const { comment, diagram } = previewPlan(plan([res('aws_vpc.main')], [res('aws_vpc.main')], [['aws_vpc.main', ['no-op']]]))
    expect(comment).toContain('This plan changes no resources.')
    expect(diagram).toBeUndefined()
    expect(comment).not.toContain('```mermaid')
    expect(comment).not.toContain('<details>')
  })

  it('uses the singular for one change', () => {
    const { comment } = previewPlan(plan([], [res('aws_vpc.main')], [['aws_vpc.main', ['create']]]))
    expect(comment).toContain('**This plan creates 1 resource.**')
  })

  it('draws whatever depends on a destroyed resource, except what the model ignores', () => {
    const db = res('aws_db_instance.main')
    const api = res('aws_ecs_service.api', { depends_on: ['aws_db_instance.main'] })
    const logs = { ...res('aws_cloudwatch_log_group.db'), depends_on: ['aws_db_instance.main'] }
    const model = Model.parse({ version: 1, name: 'x', ignore: { kinds: ['aws_cloudwatch_log_group'] } })
    const { diagram } = previewPlan(plan([db, api, logs], [api, logs], [['aws_db_instance.main', ['delete']]]), {
      declared: model,
    })
    expect(diagram).toContain('n_aws_ecs_service_api')
    expect(diagram).not.toContain('n_aws_cloudwatch_log_group_db')
  })

  it('draws only the changed resources when their neighbours would crowd the picture', () => {
    const changed = Array.from({ length: 12 }, (_, i) => res(`aws_instance.i${i}`))
    const dependants = Array.from({ length: 36 }, (_, i) =>
      res(`aws_eip.e${i}`, { depends_on: [`aws_instance.i${i % 12}`] }),
    )
    const { comment, diagram } = previewPlan(
      plan([...changed, ...dependants], dependants, changed.map((r) => [r.address!, ['delete']] as [string, string[]])),
    )
    expect(diagram).toContain('n_aws_instance_i0')
    expect(diagram).not.toContain('n_aws_eip_')
    expect(comment).toContain('Only the changed resources are drawn')
  })

  it('lists a plan too large to draw instead of drawing it', () => {
    const many = Array.from({ length: 45 }, (_, i) => res(`aws_sqs_queue.q${i}`))
    const { comment, diagram } = previewPlan(plan([], many, many.map((r) => [r.address!, ['create']])))
    expect(diagram).toBeUndefined()
    expect(comment).toContain('45 resources change, too many to draw in one picture')
    expect(comment).toContain('<details><summary>Every change (45)</summary>')
  })

  it('reports destroying a declared resource even inside a blind spot', () => {
    // Coverage says the observer may not see it. The plan is not guessing.
    const secret = res('aws_secretsmanager_secret.db')
    const model = Model.parse({
      version: 1,
      name: 'x',
      entities: [{ id: 'aws_secretsmanager_secret.db', kind: 'aws_secretsmanager_secret', name: 'db', group: 'secretsmanager', platform: 'aws', source: 'terraform' }],
      coverage: [{ scope: 'aws_secretsmanager_*', reason: 'cannot list secrets' }],
    })
    const { preview } = previewPlan(plan([secret], [], [['aws_secretsmanager_secret.db', ['delete']]]), { declared: model })
    expect(preview.design?.destroyedButDeclared).toEqual(['aws_secretsmanager_secret.db'])
  })

  it('counts drift that was already there without blaming this plan for it', () => {
    const model = Model.parse({ version: 1, name: 'x', entities: [{ id: 'aws_s3_bucket.gone', kind: 'aws_s3_bucket' }] })
    const { comment, preview } = previewPlan(plan([res('aws_vpc.main')], [res('aws_vpc.main')], [['aws_vpc.main', ['update']]]), {
      declared: model,
    })
    expect(preview.design?.createdNotDeclared).toEqual([])
    expect(comment).toContain('Nothing this plan creates or destroys departs from the model.')
    expect(comment).toMatch(/2 differences from the model were already there before this plan/)
  })
})

describe('the comment trusts nothing it shows', () => {
  it('keeps a hostile name inside its table cell', () => {
    const r = res('aws_s3_bucket.b', { values: { bucket: 'x | <img src=x onerror=alert(1)>\n| injected | row |' } })
    const { comment } = previewPlan(plan([], [r], [['aws_s3_bucket.b', ['create']]]))
    const row = comment.split('\n').find((l) => l.startsWith('| create |'))!
    expect(row).toContain('x \\| &lt;img src=x onerror=alert(1)&gt; \\| injected \\| row \\|')
    expect(comment).not.toContain('<img')
    expect(comment.split('\n').filter((l) => l.startsWith('| create |'))).toHaveLength(1)
  })

  it('keeps an address with backticks inside its code span', () => {
    const comment = formatPreviewComment({
      preview: 1,
      title: 't',
      changes: { create: [], update: [], replace: [], destroy: ['module.m["a`b"].aws_s3_bucket.x'], edges: { added: [], removed: [] } },
    })
    expect(comment).toContain('`` module.m["a`b"].aws_s3_bucket.x `` is destroyed.')
  })

  it('escapes the title, which a pipeline sets', () => {
    const { comment } = previewPlan(plan([], [], []), { title: '<script>x</script>' })
    expect(comment).toContain('### Architecture preview · &lt;script&gt;x&lt;/script&gt;')
  })
})

/**
 * Captured from Terraform 1.9.5 itself, not written by hand: a root module and
 * a child module of `terraform_data` resources, one with `count`. The state
 * records transitive dependencies (`api` depends on the VPC through the
 * database), where the plan's configuration names only direct references.
 * The plan updates `api`, adds `queue` and removes `alarm`.
 */
describe('real Terraform output', () => {
  const show = JSON.parse(read('./fixtures/real.show.json'))
  const real = parseTerraformPlan(read('./fixtures/real.plan.json'))

  it('imports `terraform show -json` with modules and count collapsed', () => {
    const model = importTerraformState(show)
    expect(model.entities.map((e) => e.id)).toEqual([
      'module.net.terraform_data.subnet',
      'module.net.terraform_data.vpc',
      'terraform_data.alarm',
      'terraform_data.api',
      'terraform_data.db',
    ])
  })

  it('previews the plan with Terraform verbs', () => {
    const { preview } = previewPlan(real)
    expect(preview.changes).toMatchObject({
      create: ['terraform_data.queue'],
      update: ['terraform_data.api'],
      replace: [],
      destroy: ['terraform_data.alarm'],
    })
  })

  it('does not report a transitive dependency of an updated resource as removed', () => {
    const { preview } = previewPlan(real)
    expect(preview.changes.edges.removed.every((e) => e.from === 'terraform_data.alarm')).toBe(true)
    expect(preview.changes.edges.added).toEqual([
      { from: 'terraform_data.queue', to: 'terraform_data.api', kind: 'depends-on' },
    ])
  })
})

describe('a plan touching modules called with count and for_each', () => {
  // Real Terraform 1.9.5 output. The plan changes the service in every
  // instance of module.svc and module.single, changes module.obs's monitor
  // (whose only reference is a `var.` its caller fills from
  // module.svc["api"]), and adds terraform_data.extra reading an output of
  // module.svc["worker"].
  const { preview, diagram } = previewPlan(parseTerraformPlan(read('./fixtures/modules.plan.json')))

  it('follows a module output to the resource behind it, in the instance named', () => {
    expect(preview.changes.create).toEqual(['terraform_data.extra'])
    expect(preview.changes.edges.added).toEqual([
      { from: 'terraform_data.extra', to: 'module.svc["worker"].terraform_data.service', kind: 'depends-on' },
    ])
  })

  it('reports no relationship going away when only a var. carried it across the module boundary', () => {
    expect(preview.changes.update).toContain('module.obs.terraform_data.monitor')
    expect(preview.changes.edges.removed).toEqual([])
  })

  it('can box the diagram by module', () => {
    const grouped = previewPlan(parseTerraformPlan(read('./fixtures/modules.plan.json')), { groupBy: 'module' }).diagram!
    expect(grouped).toContain('subgraph n_module_svc__worker__["module.svc[&quot;worker&quot;]"]')
    expect(diagram).not.toContain('module.svc[&quot;worker&quot;]"]')
  })

  it('marks a collapsed module by what the plan does inside it', () => {
    const collapsed = previewPlan(parseTerraformPlan(read('./fixtures/modules.plan.json')), { collapse: ['module.svc'] }).diagram!
    expect(collapsed).toMatch(/n_module_svc__worker__\[\["svc\[&quot;worker&quot;\]<br\/>module · 1 resource<br\/>~ update"\]\]/)
    expect(collapsed).toContain('n_terraform_data_extra ==> n_module_svc__worker__')
  })
})
