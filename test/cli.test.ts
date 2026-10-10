import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The only test in the suite that runs the CLI as a process.
 *
 * What it covers cannot be reached any other way: whether the top-level
 * promise is handled at all. A unit test of the handler would pass while the
 * `.catch` was missing, which is exactly the regression that matters — every
 * provider's error messages are written for whoever reads a CI log, and an
 * unhandled rejection buries them in a stack trace.
 *
 * Kept to the one case, because spawning is slow and the rest of the CLI's
 * behaviour is reachable through the modules it calls.
 */

const root = fileURLToPath(new URL('..', import.meta.url))

interface Run {
  status: number
  stderr: string
}

function runCli(args: string[]): Run {
  try {
    execFileSync(join(root, 'node_modules/.bin/tsx'), [join(root, 'src/cli.ts'), ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stderr?: string }
    return { status: e.status ?? -1, stderr: e.stderr ?? '' }
  }
}

describe('a provider failure reaching the top level', () => {
  const brokenConfig = () => {
    const dir = mkdtempSync(join(tmpdir(), 'driftwood-cli-'))
    writeFileSync(
      join(dir, 'config.yaml'),
      'providers:\n  - use: terraform\n    with:\n      statePath: ./definitely-missing.tfstate.json\n',
    )
    return join(dir, 'config.yaml')
  }

  it('prints the message and nothing else', () => {
    const run = runCli(['reconcile', 'examples/architecture.yaml', '-c', brokenConfig()])

    expect(run.stderr).toContain('no such file or directory')
    // The regression this guards: an unhandled rejection printed twenty lines
    // of stack from inside node:fs with the useful sentence in the middle.
    expect(run.stderr).not.toContain('at Object.')
    expect(run.stderr).not.toContain('node:fs')
    expect(run.stderr.trim().split('\n')).toHaveLength(1)
  })

  it('still exits non-zero — only the legibility changed', () => {
    expect(runCli(['reconcile', 'examples/architecture.yaml', '-c', brokenConfig()]).status).toBe(1)
  })

  // Commander's own argument errors must keep their own handling rather than
  // being swallowed and reprinted by the catch.
  it('leaves commander to report a bad invocation', () => {
    const run = runCli(['reconcile'])
    expect(run.status).not.toBe(0)
    expect(run.stderr).toMatch(/missing required argument|error:/i)
  })
})
