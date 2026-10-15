import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AddressIndex,
  configAddress,
  moduleOf,
  modulePath,
  parseAddress,
} from '../src/model/terraform-address.js'
import { importTerraformState, parseTerraformState, stateFromValues } from '../src/providers/terraform.js'
import { validateModel } from '../src/model/validate.js'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

describe('parseAddress', () => {
  it('splits the module path from the resource', () => {
    expect(parseAddress('module.a[0].module.b["k"].aws_vpc.main')).toEqual({
      modules: [
        { name: 'a', key: '[0]' },
        { name: 'b', key: '["k"]' },
      ],
      local: 'aws_vpc.main',
    })
    expect(parseAddress('aws_vpc.main')).toEqual({ modules: [], local: 'aws_vpc.main' })
  })

  it('keeps a quoted key whole when it holds dots, brackets or quotes', () => {
    const tricky = 'module.zone["eu.west]\\"1"].aws_vpc.main'
    expect(parseAddress(tricky).modules).toEqual([{ name: 'zone', key: '["eu.west]\\"1"]' }])
    expect(configAddress(tricky)).toBe('module.zone.aws_vpc.main')
    expect(moduleOf(tricky)).toBe('module.zone["eu.west]\\"1"]')
  })

  it('names every enclosing module, outermost first', () => {
    expect(modulePath('module.a[0].module.b.aws_vpc.main')).toEqual(['module.a[0]', 'module.a[0].module.b'])
    expect(moduleOf('aws_vpc.main')).toBeUndefined()
  })
})

describe('AddressIndex', () => {
  const index = new AddressIndex([
    'aws_sns_topic.alerts',
    'module.net.aws_vpc.main',
    'module.svc["api"].aws_ecs_service.this',
    'module.svc["api"].aws_security_group.this',
    'module.svc["worker"].aws_ecs_service.this',
    'module.svc["worker"].aws_security_group.this',
  ])

  it('finds an address that is already exact', () => {
    expect(index.resolve('module.net.aws_vpc.main', 'aws_sns_topic.alerts')).toEqual(['module.net.aws_vpc.main'])
  })

  it('resolves a dependency inside a module to the same instance of it', () => {
    expect(index.resolve('module.svc.aws_security_group.this', 'module.svc["api"].aws_ecs_service.this')).toEqual([
      'module.svc["api"].aws_security_group.this',
    ])
  })

  it('resolves a dependency from outside the module to every instance, which is all Terraform recorded', () => {
    expect(index.resolve('module.svc.aws_ecs_service.this', 'aws_sns_topic.alerts')).toEqual([
      'module.svc["api"].aws_ecs_service.this',
      'module.svc["worker"].aws_ecs_service.this',
    ])
  })

  it('honours a key the address does state', () => {
    expect(index.resolve('module.svc["worker"].aws_ecs_service.this', 'aws_sns_topic.alerts')).toEqual([
      'module.svc["worker"].aws_ecs_service.this',
    ])
  })

  it('resolves an unknown address to nothing rather than to a dangling edge', () => {
    expect(index.resolve('module.svc.aws_iam_role.gone', 'aws_sns_topic.alerts')).toEqual([])
  })
})

describe('state from modules called with count and for_each', () => {
  // Real Terraform 1.9.5 output: module.svc uses for_each, module.single uses
  // count, and both record their dependencies without the key.
  const model = importTerraformState(parseTerraformState(fixture('modules.tfstate.json')))
  const edge = (from: string, to: string) => model.edges.some((e) => e.from === from && e.to === to)

  it('keeps the arrows into and inside keyed modules', () => {
    expect(edge('module.svc["api"].terraform_data.service', 'module.svc["api"].terraform_data.sg')).toBe(true)
    expect(edge('module.single[0].terraform_data.sg', 'module.net.terraform_data.vpc')).toBe(true)
    expect(edge('terraform_data.dash', 'module.single[0].terraform_data.service')).toBe(true)
  })

  it('never crosses from one instance of a module into another', () => {
    expect(edge('module.svc["api"].terraform_data.service', 'module.svc["worker"].terraform_data.sg')).toBe(false)
  })

  it('produces a valid model', () => {
    expect(validateModel(model).ok).toBe(true)
  })

  it('agrees with the values representation of the same state', () => {
    const plan = JSON.parse(fixture('modules.plan.json'))
    const fromValues = importTerraformState(stateFromValues(plan.prior_state.values))
    expect(fromValues.entities.map((e) => e.id)).toEqual(model.entities.map((e) => e.id))
    expect(fromValues.edges).toEqual(model.edges)
  })
})
