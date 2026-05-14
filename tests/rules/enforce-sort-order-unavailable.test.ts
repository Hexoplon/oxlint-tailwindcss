import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, vi } from 'vitest'
import { RuleTester } from 'oxlint/plugins-dev'
import { enforceSortOrder } from '../../src/rules/enforce-sort-order'
import { resetDesignSystem } from '../../src/design-system/loader'

vi.mock('../../src/design-system/sort-service', () => ({
  sortClassesSync: vi.fn(() => null),
}))

const ENTRY_POINT = resolve(__dirname, '../fixtures/default.css')

describe('enforce-sort-order unavailable sort service', () => {
  let spy: ReturnType<typeof vi.spyOn>

  beforeAll(() => {
    resetDesignSystem()
    spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterAll(() => {
    const warnings = spy.mock.calls.filter((call) =>
      String(call[0]).includes('enforce-sort-order skipped'),
    )
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0][0])).toContain("Tailwind's official class sorter could not be loaded")
    spy.mockRestore()
  })

  new RuleTester().run('enforce-sort-order unavailable', enforceSortOrder, {
    valid: [
      {
        code: '<div className="text-red-500 flex" />',
        filename: 'test.tsx',
        options: [{ entryPoint: ENTRY_POINT }],
      },
      {
        code: '<div className="p-4 flex" />',
        filename: 'test.tsx',
        options: [{ entryPoint: ENTRY_POINT }],
      },
    ],
    invalid: [],
  })
})
