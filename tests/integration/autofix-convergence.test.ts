import { describe, expect, it, beforeAll } from 'vitest'
import { resolve } from 'node:path'
import { getLoadedDesignSystem, resetDesignSystem } from '../../src/design-system/loader'
import { resetCanonicalizeService } from '../../src/design-system/canonicalize-service'
import { resetSortService } from '../../src/design-system/sort-service'
import {
  preserveSortedClassOrder,
  markSortRuleAutofixEnabled,
} from '../../src/utils/sort-preservation'
import type { DesignSystemCache } from '../../src/design-system/cache'

const ENTRY_POINT = resolve(__dirname, '../fixtures/default.css')

function context(sourceCode: unknown) {
  return { sourceCode }
}

describe('autofix convergence between class transforms and sorting', () => {
  let cache: DesignSystemCache

  beforeAll(() => {
    resetDesignSystem()
    resetCanonicalizeService()
    resetSortService()
    cache = getLoadedDesignSystem(ENTRY_POINT)!.cache
  })

  it('keeps transform-only output when enforce-sort-order is not enabled', () => {
    const before = ['aria-expanded:block', '[&:has(input)]:bg-red-500']
    const after = ['aria-expanded:block', 'has-[input]:bg-red-500']

    expect(preserveSortedClassOrder(context({}), cache, ENTRY_POINT, before, after)).toEqual(after)
  })

  it('sorts transformed classes when enforce-sort-order is enabled for the same file', () => {
    const sourceCode = {}
    markSortRuleAutofixEnabled(context(sourceCode), 'default')

    expect(
      preserveSortedClassOrder(
        context(sourceCode),
        cache,
        ENTRY_POINT,
        ['aria-expanded:block', '[&:has(input)]:bg-red-500'],
        ['aria-expanded:block', 'has-[input]:bg-red-500'],
      ),
    ).toEqual(['has-[input]:bg-red-500', 'aria-expanded:block'])
  })

  it('does not sort transformed classes if the original list was unsorted', () => {
    const sourceCode = {}
    markSortRuleAutofixEnabled(context(sourceCode), 'default')

    expect(
      preserveSortedClassOrder(
        context(sourceCode),
        cache,
        ENTRY_POINT,
        ['[&:has(input)]:bg-red-500', 'flex'],
        ['has-[input]:bg-red-500', 'flex'],
      ),
    ).toEqual(['has-[input]:bg-red-500', 'flex'])
  })

  it('ignores stale enablement from a different source file', () => {
    markSortRuleAutofixEnabled(context({}), 'default')

    expect(
      preserveSortedClassOrder(
        context({}),
        cache,
        ENTRY_POINT,
        ['aria-expanded:block', '[&:has(input)]:bg-red-500'],
        ['aria-expanded:block', 'has-[input]:bg-red-500'],
      ),
    ).toEqual(['aria-expanded:block', 'has-[input]:bg-red-500'])
  })
})
