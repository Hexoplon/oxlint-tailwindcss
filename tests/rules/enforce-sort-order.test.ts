import { resolve } from 'node:path'
import { beforeAll, describe, it, expect } from 'vitest'
import { RuleTester } from 'oxlint/plugins-dev'
import { enforceSortOrder } from '../../src/rules/enforce-sort-order'
import { getLoadedDesignSystem, resetDesignSystem } from '../../src/design-system/loader'
import type { DesignSystemCache } from '../../src/design-system/cache'

const ENTRY_POINT = resolve(__dirname, '../fixtures/default.css')

let cache: DesignSystemCache

beforeAll(() => {
  resetDesignSystem()
  cache = getLoadedDesignSystem(ENTRY_POINT)!.cache
})

const ruleTester = new RuleTester()

ruleTester.run('enforce-sort-order', enforceSortOrder, {
  valid: [
    {
      code: '<div className="flex items-center p-4 text-red-500" />',
      filename: 'test.tsx',
    },
    // Sorts whole class tokens only; it must not normalize order-sensitive
    // stacked variants within a single class name.
    {
      code: '<div className="*:first:underline first:*:underline" />',
      filename: 'test.tsx',
    },
    {
      code: '<div className="[&>svg]:before:text-red-500 before:[&>svg]:text-red-500" />',
      filename: 'test.tsx',
    },
    { code: '<div className="flex" />', filename: 'test.tsx' },
    {
      code: '<div className="rdg rdg-cell" />',
      filename: 'test.tsx',
    },
  ],
  invalid: [
    {
      code: '<div className="text-red-500 flex" />',
      filename: 'test.tsx',
      errors: [{ messageId: 'unsorted' }],
      output: '<div className="flex text-red-500" />',
    },
    {
      code: '<div className="p-4 flex items-center" />',
      filename: 'test.tsx',
      errors: [{ messageId: 'unsorted' }],
      output: '<div className="flex items-center p-4" />',
    },
    // Important modifier preserves correct sort order
    {
      code: '<div className="!text-red-500 !flex" />',
      filename: 'test.tsx',
      errors: [{ messageId: 'unsorted' }],
      output: '<div className="!flex !text-red-500" />',
    },
    // Template literal: preserve trailing space before expression
    {
      code: '<div className={`text-red-500 flex ${x}`} />',
      filename: 'test.tsx',
      errors: [{ messageId: 'unsorted' }],
      output: '<div className={`flex text-red-500 ${x}`} />',
    },
    // Template literal: preserve leading space after expression
    {
      code: '<div className={`${base} text-red-500 flex`} />',
      filename: 'test.tsx',
      errors: [{ messageId: 'unsorted' }],
      output: '<div className={`${base} flex text-red-500`} />',
    },
    // Official Tailwind ordering for stacked variants. The tokens move, but
    // `first:*:` and `*:first:` are preserved as distinct class names.
    {
      code: '<div className="first:*:underline *:first:underline" />',
      filename: 'test.tsx',
      errors: [{ messageId: 'unsorted' }],
      output: '<div className="*:first:underline first:*:underline" />',
    },
    {
      code: '<div className="before:[&>svg]:text-red-500 [&>svg]:before:text-red-500" />',
      filename: 'test.tsx',
      errors: [{ messageId: 'unsorted' }],
      output: '<div className="[&>svg]:before:text-red-500 before:[&>svg]:text-red-500" />',
    },
    {
      code: '<div className="data-[state=open]:block aria-expanded:block block" />',
      filename: 'test.tsx',
      errors: [{ messageId: 'unsorted' }],
      output: '<div className="block aria-expanded:block data-[state=open]:block" />',
    },
    {
      code: '<div className="disabled:opacity-50 opacity-100 not-disabled:opacity-50" />',
      filename: 'test.tsx',
      errors: [{ messageId: 'unsorted' }],
      output: '<div className="opacity-100 not-disabled:opacity-50 disabled:opacity-50" />',
    },
    {
      code: '<div className="sm:max-lg:flex flex max-lg:sm:flex" />',
      filename: 'test.tsx',
      errors: [{ messageId: 'unsorted' }],
      output: '<div className="flex max-lg:sm:flex sm:max-lg:flex" />',
    },
    {
      code: '<div className="[@supports(display:grid)]:grid hover:grid grid" />',
      filename: 'test.tsx',
      errors: [{ messageId: 'unsorted' }],
      output: '<div className="grid hover:grid [@supports(display:grid)]:grid" />',
    },
    {
      code: '<div className="text-red-500 rdg-cell flex" />',
      filename: 'test.tsx',
      errors: [{ messageId: 'unsorted' }],
      output: '<div className="flex rdg-cell text-red-500" />',
    },
  ],
})

// Cache lookup remains useful for strict mode and other internal callers, but
// default enforce-sort-order no longer uses it as an autofix fallback.
describe('cache class order lookup', () => {
  it('cache.getOrder resolves dynamic numeric values via prefix lookup', () => {
    // underline-offset-3 is NOT in getClassList() but is a valid Tailwind class
    expect(cache.getOrder('underline-offset-3')).not.toBeNull()
    expect(cache.getOrder('gap-13')).not.toBeNull()
  })

  it('cache.getOrder resolves variant-prefixed dynamic numeric values', () => {
    expect(cache.getOrder('*:[a]:underline-offset-3')).not.toBeNull()
  })

  it('null-order classes (group/name, peer/name) sort first', () => {
    // Marker classes like group/name return null from getClassOrder.
    const classes = ['flex', 'group/sidebar', 'p-4', 'peer/input']
    const ordered = cache.getClassOrder(classes)

    // Verify group/peer have null order
    const groupOrder = ordered.find(([name]) => name === 'group/sidebar')
    const peerOrder = ordered.find(([name]) => name === 'peer/input')
    expect(groupOrder![1]).toBeNull()
    expect(peerOrder![1]).toBeNull()

    // Sort with null-first logic (same as enforce-sort-order heuristic)
    const sorted = [...ordered].sort((a, b) => {
      if (a[1] === null && b[1] === null) return 0
      if (a[1] === null) return -1
      if (b[1] === null) return 1
      if (a[1]! < b[1]!) return -1
      if (a[1]! > b[1]!) return 1
      return 0
    })
    const sortedNames = sorted.map(([name]) => name)

    // Null-order classes must come before real utilities
    expect(sortedNames.indexOf('group/sidebar')).toBeLessThan(sortedNames.indexOf('flex'))
    expect(sortedNames.indexOf('peer/input')).toBeLessThan(sortedNames.indexOf('flex'))
  })
})

// Strict mode: groups by variant, sorts within groups, then sorts groups
ruleTester.run('enforce-sort-order (strict)', enforceSortOrder, {
  valid: [
    // Already sorted: no-variant first, then hover group
    {
      code: '<div className="flex p-4 hover:bg-blue-500 hover:text-white" />',
      filename: 'test.tsx',
      options: [{ mode: 'strict' }],
    },
    // Single class
    {
      code: '<div className="flex" />',
      filename: 'test.tsx',
      options: [{ mode: 'strict' }],
    },
  ],
  invalid: [
    // Variant classes interleaved with base classes
    {
      code: '<div className="hover:text-red-500 p-4 hover:bg-blue-500 m-2" />',
      filename: 'test.tsx',
      options: [{ mode: 'strict' }],
      errors: [{ messageId: 'unsorted' }],
      output: '<div className="m-2 p-4 hover:bg-blue-500 hover:text-red-500" />',
    },
    // Multi-variant group ordering
    {
      code: '<div className="dark:hover:text-white flex dark:hover:bg-black" />',
      filename: 'test.tsx',
      options: [{ mode: 'strict' }],
      errors: [{ messageId: 'unsorted' }],
      output: '<div className="flex dark:hover:bg-black dark:hover:text-white" />',
    },
  ],
})
