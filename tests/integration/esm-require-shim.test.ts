/**
 * Regression test for the ESM-bundle `__require` shim leak.
 *
 * tsdown bundles the ESM build (`dist/index.mjs`) and rewrites every
 * `require(...)` in source to `__require(...)`, defining the shim at the top
 * of the bundle via `createRequire(import.meta.url)`. The functions
 * interpolated into PRECOMPUTE_SCRIPT (sync-loader.ts) and WORKER_SCRIPT
 * (runtime-service.ts) are stringified via Function.prototype.toString(),
 * so their rewritten `__require` calls leak into those scripts.
 *
 * The child contexts (`node -e ...` and Worker { eval: true }) have native
 * `require` but no `__require`, so they crash with `__require is not defined`
 * and DS-dependent rules silently fall back.
 *
 * The fix prepends `var __require = require;` to both scripts. This file
 * locks the fix down with two layers:
 *
 *   1. Static — both script template literals start with the shim line.
 *   2. Functional — a stringified function calling `__require('fs')` inside
 *      a script that begins with the shim runs cleanly under both `node -e`
 *      and `Worker { eval: true }`. This reproduces the failure mode in
 *      isolation without depending on the dist.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('ESM bundle __require shim', () => {
  it('PRECOMPUTE_SCRIPT begins with the require shim', () => {
    const source = readFileSync(
      resolve(__dirname, '../../src/design-system/sync-loader.ts'),
      'utf-8',
    )
    // Shim must come before any function interpolation so that rewritten
    // `__require` calls in those functions resolve at child startup.
    expect(source).toMatch(/const PRECOMPUTE_SCRIPT = `\nvar __require = require;\n/)
  })

  it('WORKER_SCRIPT begins with the require shim', () => {
    const source = readFileSync(
      resolve(__dirname, '../../src/design-system/runtime-service.ts'),
      'utf-8',
    )
    expect(source).toMatch(/const WORKER_SCRIPT = `\nvar __require = require;\n/)
  })

  it('node -e child can run a stringified function whose `__require` calls are pre-shimmed', () => {
    // Simulates what tsdown produces: a function whose `require(...)` calls
    // were rewritten to `__require(...)`. Without the shim line, the child
    // crashes with `__require is not defined`.
    function helper() {
      // @ts-expect-error -- __require is the bundler-injected shim, not in scope here.
      const fs = __require('fs')
      process.stdout.write(typeof fs.readFileSync)
    }
    const script = `
var __require = require;
${helper}
helper();
`
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf-8' })
    expect(out).toBe('function')
  })

  it('Worker { eval: true } can run a stringified function whose `__require` calls are pre-shimmed', async () => {
    function helper() {
      // @ts-expect-error -- bundler-injected shim
      const path = __require('path')
      // @ts-expect-error -- worker_threads global
      parentPort.postMessage(typeof path.join)
    }
    const script = `
var __require = require;
const { parentPort } = require('worker_threads');
${helper}
helper();
`
    const message = await new Promise<string>((res, rej) => {
      const w = new Worker(script, { eval: true })
      w.once('message', (m) => {
        res(m)
        w.terminate()
      })
      w.once('error', rej)
    })
    expect(message).toBe('function')
  })

  it('reproduces the original failure: stringified `__require` without shim crashes', () => {
    // Negative control. Proves the shim line is what makes the positive
    // tests pass — not some ambient context.
    function helper() {
      // @ts-expect-error -- bundler-injected shim
      __require('fs')
    }
    const script = `
${helper}
helper();
`
    expect(() =>
      execFileSync(process.execPath, ['-e', script], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    ).toThrow(/__require is not defined/)
  })
})
