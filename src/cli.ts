#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { Command } from 'commander'
import { dumpModel, loadModel } from './model/validate.js'
import { importTerraformState, parseTerraformState } from './providers/terraform.js'
import { providers } from './providers/index.js'
import { render, renderers, resolveRenderer } from './render/index.js'
import { formatDrift, reconcile } from './reconcile/index.js'
import { applyDrift, formatApplySummary } from './model/apply.js'
import { formatConflicts } from './model/merge.js'
import { loadConfig, observeAll } from './config.js'
import type { Model } from './model/schema.js'
import { loadHealthMap, unknownHealthIds } from './health.js'

const program = new Command()
program
  .name('driftwood')
  .description('Architecture as code, reconciled with live infrastructure.')
  .version('0.0.1')

/**
 * The source text comes back alongside the parsed model because `--write-model`
 * edits the YAML document rather than re-serializing it, to keep comments and
 * formatting intact.
 */
function requireModelSource(path: string): { model: Model; source: string } {
  const source = readFileSync(path, 'utf8')
  const result = loadModel(source)
  for (const issue of result.issues) console.error(`${issue.severity}: ${issue.message}`)
  if (!result.ok || !result.model) {
    console.error(`\n${path} is not a valid model.`)
    process.exit(1)
  }
  return { model: result.model, source }
}

function requireModel(path: string): Model {
  return requireModelSource(path).model
}

program
  .command('validate')
  .description('Check a model for schema and referential-integrity errors')
  .argument('<model>', 'path to architecture.yaml')
  .action((path: string) => {
    const model = requireModel(path)
    console.log(`ok — ${model.entities.length} entities, ${model.edges.length} edges, ${model.views.length} views`)
  })

program
  .command('render')
  .description('Render a model with the best available engine')
  .argument('<model>', 'path to architecture.yaml')
  .option('--view <id>', 'render a single named view')
  .option('--engine <name>', 'auto | mermaid | dot | graphviz', 'auto')
  .option('--direction <dir>', 'LR or TD', 'LR')
  .option('--health <file>', 'JSON file mapping entity ids to healthy, degraded, or down')
  .option('--no-icons', 'draw plain boxes instead of category icons')
  .option('-o, --out <file>', 'write to a file instead of stdout')
  .action(
    async (
      path: string,
      opts: {
        view?: string
        engine: string
        direction: string
        health?: string
        icons: boolean
        out?: string
      },
    ) => {
      const model = requireModel(path)
      const direction = opts.direction === 'TD' ? 'TD' : 'LR'
      const health = opts.health ? loadHealthMap(opts.health) : undefined
      if (health) {
        const unknown = unknownHealthIds(health, model)
        if (unknown.length > 0) {
          console.error(`note: health file contains ${unknown.length} unknown entity id(s): ${unknown.join(', ')}`)
        }
      }
      const result = await render(model, { view: opts.view, direction, health, icons: opts.icons }, opts.engine)
      if (result.fellBackFrom) {
        console.error(`note: ${result.fellBackFrom} unavailable, using ${result.renderer.name} (${result.via})`)
      }
      if (opts.out) {
        writeFileSync(opts.out, result.output)
        console.error(`wrote ${opts.out} via ${result.renderer.name} (${result.via})`)
      } else {
        process.stdout.write(result.output)
      }
    },
  )

program
  .command('engines')
  .description('Show which render engines are usable in this environment')
  .action(async () => {
    for (const renderer of [...renderers.all()].sort((a, b) => b.priority - a.priority)) {
      const probe = await renderer.probe()
      const mark = probe.available ? 'available' : 'unavailable'
      const detail = probe.available ? probe.via : probe.reason
      console.log(`${renderer.name.padEnd(10)} ${mark.padEnd(12)} ${detail ?? ''}`)
    }
    const chosen = await resolveRenderer('auto')
    console.log(`\nauto would use: ${chosen.renderer.name} (${chosen.via})`)
  })

program
  .command('providers')
  .description('List registered providers')
  .action(() => {
    for (const p of providers.all()) {
      console.log(`${p.name.padEnd(12)} ${p.kind.padEnd(12)} ${p.platforms.join(',').padEnd(14)} ${p.description}`)
    }
  })

const importCmd = program.command('import').description('Build a model from a provider')

importCmd
  .command('terraform')
  .description('Import entities and edges from Terraform state (format v4)')
  .argument('<state>', 'path to terraform.tfstate or `terraform show -json` output')
  .option('--name <name>', 'model name', 'terraform')
  .option('--include-data-sources', 'include data sources as entities', false)
  .option('-o, --out <file>', 'write to a file instead of stdout')
  .action((statePath: string, opts: { name: string; includeDataSources: boolean; out?: string }) => {
    const state = parseTerraformState(readFileSync(statePath, 'utf8'))
    const model = importTerraformState(state, {
      modelName: opts.name,
      includeDataSources: opts.includeDataSources,
    })
    const yaml = dumpModel(model)
    if (opts.out) {
      writeFileSync(opts.out, yaml)
      console.error(`wrote ${opts.out} — ${model.entities.length} entities, ${model.edges.length} edges`)
    } else {
      process.stdout.write(yaml)
    }
  })

program
  .command('reconcile')
  .description('Diff the committed model against observed infrastructure')
  .argument('<model>', 'path to architecture.yaml')
  .option('-c, --config <file>', 'driftwood.config.yaml describing the providers to observe with')
  .option('--terraform <state>', 'shorthand for a single Terraform state file')
  .option('--include-data-sources', 'include data sources as entities', false)
  .option('-o, --out <file>', 'write the markdown report to a file')
  .option(
    '--write-model <file>',
    'write the reconciled model, preserving comments and hand-written blocks (pass the model\'s own path to update it in place)',
  )
  .option('--exit-zero', 'always exit 0, even when drift is found', false)
  .action(
    async (
      modelPath: string,
      opts: {
        config?: string
        terraform?: string
        includeDataSources: boolean
        out?: string
        writeModel?: string
        exitZero: boolean
      },
    ) => {
      const { model: declared, source: declaredSource } = requireModelSource(modelPath)

      let observed: Model
      let conflictReport = ''

      if (opts.config) {
        const loaded = loadConfig(readFileSync(opts.config, 'utf8'), opts.config)
        const merged = await observeAll(loaded, declared, (m) => console.error(m))
        observed = merged.model
        conflictReport = formatConflicts(merged.conflicts)
      } else if (opts.terraform) {
        const state = parseTerraformState(readFileSync(opts.terraform, 'utf8'))
        observed = importTerraformState(state, {
          modelName: declared.name,
          includeDataSources: opts.includeDataSources,
        })
      } else {
        console.error('provide either --config <file> or --terraform <state>')
        process.exit(2)
      }

      const drift = reconcile(declared, observed)
      const report = [formatDrift(drift), conflictReport].filter(Boolean).join('\n')
      if (opts.out) {
        writeFileSync(opts.out, report)
        console.error(`wrote ${opts.out}`)
      }
      console.log(report)

      if (opts.writeModel) {
        // Writing an unchanged file on every clean run would leave a scheduled
        // job touching the model's mtime forever and, where the model is its
        // own target, invite an empty commit.
        if (!drift.hasDrift) {
          console.error('no drift — model left unchanged')
        } else {
          const { yaml, summary } = applyDrift(declaredSource, drift)
          const check = loadModel(yaml)
          // A reconciled model that does not validate is a bug in this writer,
          // and committing it would break every later run. Fail instead.
          if (!check.ok) {
            console.error('\nthe reconciled model is not valid — refusing to write it:')
            for (const issue of check.issues) console.error(`  ${issue.severity}: ${issue.message}`)
            process.exit(2)
          }
          writeFileSync(opts.writeModel, yaml)
          console.error(`wrote ${opts.writeModel} — ${formatApplySummary(summary)}`)
        }
      }

      if (drift.hasDrift && !opts.exitZero) process.exit(1)
    },
  )

program.parseAsync()
