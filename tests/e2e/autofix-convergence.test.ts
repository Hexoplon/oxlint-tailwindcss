import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const DIST_CJS = resolve(ROOT, 'dist/index.cjs')
const OXLINT = resolve(ROOT, 'node_modules/.bin/oxlint')
const ENTRY_POINT = resolve(ROOT, 'tests/fixtures/default.css')
const E2E_DIR = resolve(__dirname, 'tmp-autofix-convergence')

function writeConfig(configPath: string, rules: Record<string, string>) {
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        jsPlugins: [DIST_CJS],
        settings: {
          tailwindcss: {
            entryPoint: ENTRY_POINT,
          },
        },
        rules,
      },
      null,
      2,
    ),
  )
}

function runOxlint(args: string[]) {
  return execFileSync(OXLINT, args, {
    encoding: 'utf-8',
    cwd: E2E_DIR,
    timeout: 30_000,
  })
}

describe('E2E: autofix convergence', () => {
  const withSortConfig = resolve(E2E_DIR, 'with-sort.json')
  const withoutSortConfig = resolve(E2E_DIR, 'without-sort.json')
  const withSortFile = resolve(E2E_DIR, 'with-sort.tsx')
  const withoutSortFile = resolve(E2E_DIR, 'without-sort.tsx')

  beforeAll(() => {
    if (!existsSync(DIST_CJS)) {
      throw new Error('dist/index.cjs not found. Run `pnpm build` first.')
    }

    mkdirSync(E2E_DIR, { recursive: true })

    writeConfig(withSortConfig, {
      'tailwindcss/enforce-canonical': 'error',
      'tailwindcss/enforce-sort-order': 'error',
    })
    writeConfig(withoutSortConfig, {
      'tailwindcss/enforce-canonical': 'error',
    })
  })

  afterAll(() => {
    rmSync(E2E_DIR, { recursive: true, force: true })
  })

  it('converges canonicalization and sorting in one real oxlint --fix pass', () => {
    writeFileSync(
      withSortFile,
      'export const x = <div className="aria-expanded:block [&:has(input)]:bg-red-500" />\n',
    )

    runOxlint(['-c', withSortConfig, '--fix', withSortFile])

    expect(readFileSync(withSortFile, 'utf-8')).toBe(
      'export const x = <div className="has-[input]:bg-red-500 aria-expanded:block" />\n',
    )
    expect(runOxlint(['-c', withSortConfig, withSortFile])).not.toContain('tailwindcss(')
  })

  it('does not sort canonicalized output when enforce-sort-order is not enabled', () => {
    writeFileSync(
      withoutSortFile,
      'export const x = <div className="aria-expanded:block [&:has(input)]:bg-red-500" />\n',
    )

    runOxlint(['-c', withoutSortConfig, '--fix', withoutSortFile])

    expect(readFileSync(withoutSortFile, 'utf-8')).toBe(
      'export const x = <div className="aria-expanded:block has-[input]:bg-red-500" />\n',
    )
  })
})
