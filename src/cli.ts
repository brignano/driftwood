#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Command, InvalidArgumentError } from 'commander'
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
import { COMMENT_FILE, PREVIEW_FILE, parseTerraformPlan, previewPlan } from './preview.js'
import { loadLatestSnapshot, loadPreviousSnapshot, takeSnapshot, writeSnapshot, writeToStore } from './snapshot.js'

function collectList(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function parseGroupBy(value: string): 'group' | 'module' {
  if (value === 'group' || value === 'module') return value
  throw new InvalidArgumentError("expected 'group' or 'module'")
}

const GROUP_BY_HELP = "box nodes by each entity's group (the default) or by Terraform module, where a view does not say"
const COLLAPSE_HELP = "draw a Terraform module as one node, repeatable ('*' for every top-level module), where a view does not say"

const program = new Command()
program
  .name('driftwood')
  .description('Architecture as code, reconciled with live infrastructure.')
  // Read from package.json, one level up from both src/ and dist/, so it cannot drift from the release.
  .version((createRequire(import.meta.url)('../package.json') as { version: string }).version)

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
  .option('--group-by <how>', GROUP_BY_HELP, parseGroupBy)
  .option('--collapse <module>', COLLAPSE_HELP, collectList, [])
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
        groupBy?: 'group' | 'module'
        collapse: string[]
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
      const result = await render(
        model,
        { view: opts.view, direction, health, icons: opts.icons, groupBy: opts.groupBy, collapse: opts.collapse },
        opts.engine,
      )
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
  .option('--app <name>', 'the app, service or repository deployed (defaults to the model name)')
  .option('--env <name>', 'the environment deployed to', 'default')
  .option('--build <id>', 'the build or pipeline run id; names the snapshot directory in a store')
  .option('--model <file>', 'committed model, for its views and aliases and to report drift against')
  .option(
    '--store <dir>',
    'write to <dir>/<app>/<env>/<build>/, move that app and environment\'s latest.json, and compare against the previous latest',
  )
  .option('--previous <path>', "the previous deploy's snapshot directory or snapshot.json, to report what changed")
  .option('--health <file>', 'JSON file mapping entity ids to healthy, degraded, or down')
  .option('--origin <key=value>', 'provenance to record, repeatable (pipeline, stage, commit, artifact)', collectOrigin, {})
  .option('--engine <name>', 'auto | mermaid | dot | graphviz', 'auto')
  .option('--direction <dir>', 'LR or TD', 'LR')
  .option('--no-icons', 'draw plain boxes instead of category icons')
  .option('--group-by <how>', GROUP_BY_HELP, parseGroupBy)
  .option('--collapse <module>', COLLAPSE_HELP, collectList, [])
  .option('-o, --out-dir <dir>', 'directory to write the snapshot into, when not using --store')
  .action(
    async (opts: {
      config?: string
      terraform?: string
      includeDataSources: boolean
      app?: string
      env: string
      build?: string
      model?: string
      store?: string
      previous?: string
      health?: string
      origin: Record<string, string>
      engine: string
      direction: string
      icons: boolean
      groupBy?: 'group' | 'module'
      collapse: string[]
      outDir?: string
    }) => {
      if (opts.store && opts.outDir) {
        console.error('use either --store <dir> or --out-dir <dir>, not both')
        process.exit(2)
      }
      if (opts.store && !opts.app) {
        // A store is shared across apps, so a snapshot filed under a guessed
        // name is one nobody will find, or worse, one compared against another app.
        console.error('--store needs --app, so the snapshot is filed under the right app')
        process.exit(2)
      }

      const declared = opts.model ? requireModel(opts.model) : undefined
      const { model, sources } = await observeForCli(opts, declared ?? emptyModel('observed'))
      const subject = { app: opts.app ?? model.name, environment: opts.env, build: opts.build }

      const previousFrom = opts.previous ?? (opts.store ? `${opts.store} (latest for ${subject.app}/${subject.environment})` : undefined)
      const previous = opts.previous
        ? loadPreviousSnapshot(opts.previous)
        : opts.store
          ? loadLatestSnapshot(opts.store, subject)
          : undefined
      if (previousFrom && !previous) {
        console.error(`note: no previous snapshot in ${previousFrom} — reporting this deploy without changes`)
      }

      const bundle = await takeSnapshot({
        subject,
        observed: model,
        sources,
        declared,
        previous,
        health: opts.health ? loadHealthMap(opts.health) : undefined,
        origin: opts.origin,
        engine: opts.engine,
        direction: opts.direction === 'TD' ? 'TD' : 'LR',
        icons: opts.icons,
        groupBy: opts.groupBy,
        collapse: opts.collapse,
      })
      if (bundle.fellBackFrom) {
        const d = bundle.snapshot.diagrams[0]
        console.error(`note: ${bundle.fellBackFrom} unavailable, using ${d?.renderer} (${d?.via})`)
      }

      const summary = formatObservation(bundle.snapshot.observation)
      if (opts.store) {
        const stored = writeToStore(opts.store, bundle)
        console.error(`wrote ${stored.written.length} files to ${stored.dir} — ${summary}`)
        if (!stored.latestUpdated) {
          console.error('note: a newer snapshot is already latest for this app and environment, so latest.json was left alone')
        }
      } else {
        const dir = opts.outDir ?? 'driftwood-snapshot'
        const written = writeSnapshot(dir, bundle)
        console.error(`wrote ${written.length} files to ${dir} — ${summary}`)
      }
      // Exit 0 even with drift: this runs after a deploy, and failing it over a
      // report would get the step removed. `reconcile` is the gate.
    },
  )

program
  .command('preview')
  .description('Before a deploy: draw what a Terraform plan will change, as a pull request comment')
  .requiredOption('--plan <file>', 'output of `terraform show -json <planfile>`')
  .option('--model <file>', 'committed model, to say whether the plan departs from the design')
  .option('--title <text>', 'what the plan is for, e.g. the workspace or environment (defaults to the model name)')
  .option('--include-data-sources', 'include data sources as entities', false)
  .option('--group-by <how>', "box nodes by each entity's group (the default) or by Terraform module", parseGroupBy)
  .option('--collapse <module>', "draw a Terraform module as one node, repeatable ('*' for every top-level module)", collectList, [])
  .option('-o, --out-dir <dir>', `write ${COMMENT_FILE} and ${PREVIEW_FILE} here instead of printing the comment`)
  .action(
    (opts: {
      plan: string
      model?: string
      title?: string
      includeDataSources: boolean
      groupBy?: 'group' | 'module'
      collapse: string[]
      outDir?: string
    }) => {
    const plan = parseTerraformPlan(readFileSync(opts.plan, 'utf8'))
    const declared = opts.model ? requireModel(opts.model) : undefined
    const { preview, comment } = previewPlan(plan, {
      declared,
      title: opts.title,
      includeDataSources: opts.includeDataSources,
      groupBy: opts.groupBy,
      collapse: opts.collapse,
    })
    if (opts.outDir) {
      mkdirSync(opts.outDir, { recursive: true })
      writeFileSync(join(opts.outDir, COMMENT_FILE), comment)
      writeFileSync(join(opts.outDir, PREVIEW_FILE), `${JSON.stringify(preview, null, 2)}\n`)
      const { create, update, replace, destroy } = preview.changes
      console.error(
        `wrote ${COMMENT_FILE} and ${PREVIEW_FILE} to ${opts.outDir} — ${create.length} create, ${update.length} update, ${replace.length} replace, ${destroy.length} destroy`,
      )
    } else {
      process.stdout.write(comment)
    }
    // Exit 0 whatever the plan does: the preview informs the review, and the
    // review decides. `reconcile` is the gate.
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
