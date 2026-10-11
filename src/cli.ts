#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { Command } from 'commander'
import { dumpModel, loadModel } from './model/validate.js'
import { importTerraformState, parseTerraformState } from './providers/terraform.js'
import { providers } from './providers/index.js'
import { render, renderers, resolveRenderer } from './render/index.js'
import { formatDrift, reconcile } from './reconcile/index.js'
import { applyDrift, formatApplySummary } from './model/apply.js'
import { dumpObservation, formatObservation, toObservation } from './model/observation.js'
import { emptyModel } from './model/schema.js'
import type { SourcedModel } from './model/merge.js'
import { formatConflicts } from './model/merge.js'
import { loadConfig, observeAll } from './config.js'
import type { Model } from './model/schema.js'
import { loadHealthMap, unknownHealthIds } from './health.js'
import { loadPreviousSnapshot, takeSnapshot, writeSnapshot } from './snapshot.js'

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
    const all = providers.all()
    const width = Math.max(...all.map((p) => p.name.length)) + 1
    for (const p of all) {
      console.log(`${p.name.padEnd(width)} ${p.kind.padEnd(12)} ${p.platforms.join(',').padEnd(14)} ${p.description}`)
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

/**
 * `--origin key=value`, repeatable. Provenance is the thing a reviewer wants
 * most when a drift pull request arrives from a pipeline they do not run.
 */
function collectOrigin(pair: string, acc: Record<string, string>): Record<string, string> {
  const at = pair.indexOf('=')
  if (at < 1) {
    console.error(`--origin expects key=value, got '${pair}'`)
    process.exit(2)
  }
  acc[pair.slice(0, at)] = pair.slice(at + 1)
  return acc
}

/**
 * `--config` or `--terraform`, shared by every command that observes on the
 * deploying machine. Conflicts are printed rather than returned: a disagreement
 * is a fact about this run, and the resolution is already baked into the model.
 */
async function observeForCli(
  opts: { config?: string; terraform?: string; includeDataSources: boolean },
  aliasSource: Model,
): Promise<{ model: Model; sources: SourcedModel[] }> {
  if (opts.config) {
    const loaded = loadConfig(readFileSync(opts.config, 'utf8'), opts.config)
    const observed = await observeAll(loaded, aliasSource, (m) => console.error(m))
    const conflicts = formatConflicts(observed.conflicts)
    if (conflicts) console.error(`\n${conflicts}`)
    return { model: observed.model, sources: observed.sources }
  }
  if (opts.terraform) {
    const state = parseTerraformState(readFileSync(opts.terraform, 'utf8'))
    const model = importTerraformState(state, {
      modelName: aliasSource.name,
      includeDataSources: opts.includeDataSources,
    })
    return { model, sources: [{ provider: 'terraform', kind: 'declarative', model }] }
  }
  console.error('provide either --config <file> or --terraform <state>')
  process.exit(2)
}

program
  .command('observe')
  .description('Run providers and emit what they saw, to reconcile elsewhere')
  .option('-c, --config <file>', 'driftwood.config.yaml describing the providers to observe with')
  .option('--terraform <state>', 'shorthand for a single Terraform state file')
  .option('--include-data-sources', 'include data sources as entities', false)
  .option(
    '--model <file>',
    'committed model, read only for its `aliases` — supply it when several providers describe the same thing',
  )
  .option('--origin <key=value>', 'provenance to record, repeatable (workspace, commit, pipeline run)', collectOrigin, {})
  .option('-o, --out <file>', 'write the observation to a file instead of stdout (.json for JSON)')
  .action(
    async (opts: {
      config?: string
      terraform?: string
      includeDataSources: boolean
      model?: string
      origin: Record<string, string>
      out?: string
    }) => {
      // Aliases live in the committed model, which the machine running a deploy
      // usually does not have. Without them the merge keeps each source's
      // native ids apart, which is the safe default — never guess identity.
      const aliasSource = opts.model ? requireModel(opts.model) : emptyModel('observed')
      const { model, sources } = await observeForCli(opts, aliasSource)

      const observation = toObservation(model, sources, opts.origin)
      const serialized = dumpObservation(observation, opts.out?.endsWith('.json') ? 'json' : 'yaml')

      if (opts.out) {
        writeFileSync(opts.out, serialized)
        console.error(`wrote ${opts.out} — ${formatObservation(observation)}`)
      } else {
        process.stdout.write(serialized)
      }
    },
  )

program
  .command('snapshot')
  .description('After a deploy: observe, render diagrams, and write a bundle a build page can show')
  .option('-c, --config <file>', 'driftwood.config.yaml describing the providers to observe with')
  .option('--terraform <state>', 'shorthand for a single Terraform state file')
  .option('--include-data-sources', 'include data sources as entities', false)
  .option('--model <file>', 'committed model, for its views and aliases and to report drift against')
  .option('--previous <path>', "the previous deploy's snapshot directory or snapshot.json, to report what changed")
  .option('--health <file>', 'JSON file mapping entity ids to healthy, degraded, or down')
  .option('--origin <key=value>', 'provenance to record, repeatable (pipeline, stage, commit, artifact)', collectOrigin, {})
  .option('--engine <name>', 'auto | mermaid | dot | graphviz', 'auto')
  .option('--direction <dir>', 'LR or TD', 'LR')
  .option('--no-icons', 'draw plain boxes instead of category icons')
  .option('-o, --out-dir <dir>', 'directory to write the snapshot into', 'driftwood-snapshot')
  .action(
    async (opts: {
      config?: string
      terraform?: string
      includeDataSources: boolean
      model?: string
      previous?: string
      health?: string
      origin: Record<string, string>
      engine: string
      direction: string
      icons: boolean
      outDir: string
    }) => {
      const declared = opts.model ? requireModel(opts.model) : undefined
      const { model, sources } = await observeForCli(opts, declared ?? emptyModel('observed'))

      const previous = opts.previous ? loadPreviousSnapshot(opts.previous) : undefined
      if (opts.previous && !previous) {
        console.error(`note: no previous snapshot at ${opts.previous} — reporting this deploy without changes`)
      }

      const bundle = await takeSnapshot({
        observed: model,
        sources,
        declared,
        previous,
        health: opts.health ? loadHealthMap(opts.health) : undefined,
        origin: opts.origin,
        engine: opts.engine,
        direction: opts.direction === 'TD' ? 'TD' : 'LR',
        icons: opts.icons,
      })
      if (bundle.fellBackFrom) {
        const d = bundle.snapshot.diagrams[0]
        console.error(`note: ${bundle.fellBackFrom} unavailable, using ${d?.renderer} (${d?.via})`)
      }

      const written = writeSnapshot(opts.outDir, bundle)
      console.error(`wrote ${written.length} files to ${opts.outDir} — ${formatObservation(bundle.snapshot.observation)}`)
      // Exit 0 even with drift: this runs after a deploy, and failing it over a
      // report would get the step removed. `reconcile` is the gate.
    },
  )

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

/**
 * Every provider that cannot answer throws, and the messages are written for
 * whoever is reading a CI log — a state file that is not there, a token that is
 * not set, a config that does not parse. `parseAsync` returns a promise nothing
 * was handling, so those arrived as an unhandled rejection: twenty lines of
 * stack from inside `node:fs` or commander, with the one useful sentence
 * somewhere in the middle.
 *
 * The exit code was already non-zero and still is. What changes is whether the
 * reason is legible, which is the whole point of writing the messages carefully.
 */
program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
