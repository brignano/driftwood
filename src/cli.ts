#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { Command } from 'commander'
import { dumpModel, loadModel } from './model/validate.js'
import { importTerraformState, parseTerraformState } from './providers/terraform.js'
import { renderMermaid } from './render/mermaid.js'
import { formatDrift, reconcile } from './reconcile/index.js'
import type { Model } from './model/schema.js'

const program = new Command()
program
  .name('driftwood')
  .description('Architecture as code, reconciled with live infrastructure.')
  .version('0.0.1')

/** Loads and validates a model, or exits non-zero with the reasons. */
function requireModel(path: string): Model {
  const result = loadModel(readFileSync(path, 'utf8'))
  for (const issue of result.issues) {
    console.error(`${issue.severity}: ${issue.message}`)
  }
  if (!result.ok || !result.model) {
    console.error(`\n${path} is not a valid model.`)
    process.exit(1)
  }
  return result.model
}

program
  .command('validate')
  .description('Check a model for schema and referential-integrity errors')
  .argument('<model>', 'path to architecture.yaml')
  .action((path: string) => {
    const model = requireModel(path)
    console.log(
      `ok — ${model.entities.length} entities, ${model.edges.length} edges, ${model.views.length} views`,
    )
  })

program
  .command('render')
  .description('Render a model to Mermaid')
  .argument('<model>', 'path to architecture.yaml')
  .option('--view <id>', 'render a single named view')
  .option('--direction <dir>', 'LR or TD', 'LR')
  .option('-o, --out <file>', 'write to a file instead of stdout')
  .action((path: string, opts: { view?: string; direction: string; out?: string }) => {
    const model = requireModel(path)
    const direction = opts.direction === 'TD' ? 'TD' : 'LR'
    const mermaid = renderMermaid(model, { view: opts.view, direction })
    if (opts.out) {
      writeFileSync(opts.out, mermaid)
      console.error(`wrote ${opts.out}`)
    } else {
      process.stdout.write(mermaid)
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
  .requiredOption('--terraform <state>', 'path to Terraform state to reconcile against')
  .option('--include-data-sources', 'include data sources as entities', false)
  .option('-o, --out <file>', 'write the markdown report to a file')
  .option('--exit-zero', 'always exit 0, even when drift is found', false)
  .action(
    (
      modelPath: string,
      opts: { terraform: string; includeDataSources: boolean; out?: string; exitZero: boolean },
    ) => {
      const declared = requireModel(modelPath)
      const state = parseTerraformState(readFileSync(opts.terraform, 'utf8'))
      const observed = importTerraformState(state, {
        modelName: declared.name,
        includeDataSources: opts.includeDataSources,
      })

      const drift = reconcile(declared, observed)
      const report = formatDrift(drift)
      if (opts.out) {
        writeFileSync(opts.out, report)
        console.error(`wrote ${opts.out}`)
      }
      console.log(report)

      // Non-zero on drift is what makes this usable as a CI gate.
      if (drift.hasDrift && !opts.exitZero) process.exit(1)
    },
  )

program.parse()
