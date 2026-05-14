/**
 * Snapshot tests for precomputed design system data.
 *
 * These tests capture key metrics and known values from the precomputed
 * output to detect regressions when optimizing the PRECOMPUTE_SCRIPT.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { resolve } from 'node:path'
import { loadDesignSystemSync, type PrecomputedData } from '../../src/design-system/sync-loader'

const ENTRY_POINT = resolve(__dirname, '../fixtures/default.css')

let data: PrecomputedData

beforeAll(() => {
  const result = loadDesignSystemSync(ENTRY_POINT)
  expect(result).not.toBeNull()
  data = result!
})

describe('Precomputed Data Snapshot', () => {
  describe('validClasses', () => {
    it('has more than 22000 classes', () => {
      expect(data.validClasses.length).toBeGreaterThan(22000)
    })

    it('contains core utility classes', () => {
      const coreClasses = [
        'flex',
        'block',
        'hidden',
        'grid',
        'inline',
        'p-4',
        'p-0',
        'm-4',
        'm-0',
        'w-full',
        'h-full',
        'text-center',
        'font-bold',
        'bg-blue-500',
        'text-red-500',
        'border',
        'rounded',
        'shadow',
        'items-center',
        'justify-center',
        'gap-4',
        'absolute',
        'relative',
        'sticky',
        'overflow-hidden',
      ]
      for (const cls of coreClasses) {
        expect(data.validClasses).toContain(cls)
      }
    })

    it('contains marker classes', () => {
      expect(data.validClasses).toContain('group')
      expect(data.validClasses).toContain('peer')
    })

    it('contains expanded bare utilities', () => {
      expect(data.validClasses).toContain('rounded')
      expect(data.validClasses).toContain('shadow')
    })

    it('contains Tailwind v4.2 utility additions', () => {
      const classes = [
        'bg-mauve-500',
        'text-olive-500',
        'border-mist-500',
        'ring-taupe-500',
        'pbs-4',
        'pbe-4',
        'mbs-4',
        'mbe-4',
        'scroll-pbs-4',
        'scroll-mbe-4',
        'border-bs-2',
        'border-be',
        'inline-4',
        'min-inline-0',
        'max-inline-lg',
        'block-64',
        'min-block-24',
        'max-block-screen',
        'inset-s-0',
        'inset-e-4',
        'inset-bs-2',
        'inset-be-8',
      ]
      for (const cls of classes) {
        expect(data.validClasses).toContain(cls)
      }
    })

    it('contains Tailwind v4.3 utility additions', () => {
      const classes = [
        '@container-size',
        '@container-size/main',
        'scrollbar-auto',
        'scrollbar-thin',
        'scrollbar-none',
        'scrollbar-thumb-red-500',
        'scrollbar-track-blue-500',
        'scrollbar-gutter-auto',
        'scrollbar-gutter-stable',
        'scrollbar-gutter-both',
        'zoom-75',
        'zoom-100',
        'tab-4',
      ]
      for (const cls of classes) {
        expect(data.validClasses).toContain(cls)
      }
    })
  })

  describe('canonical', () => {
    it('has known canonical mappings', () => {
      // Negative zero → positive zero
      expect(data.canonical['-m-0']).toBe('m-0')
    })

    it('has Tailwind v4.2 deprecated inset canonical mappings', () => {
      expect(data.canonical['start-4']).toBe('inset-s-4')
      expect(data.canonical['-start-4']).toBe('-inset-s-4')
      expect(data.canonical['end-full']).toBe('inset-e-full')
    })

    it('has a reasonable number of diffs (not all classes)', () => {
      const diffCount = Object.keys(data.canonical).length
      expect(diffCount).toBeGreaterThan(0)
      // Should be a small fraction of total classes
      expect(diffCount).toBeLessThan(data.validClasses.length / 10)
    })
  })

  describe('order', () => {
    it('has entries for core classes', () => {
      expect(data.order['flex']).toBeDefined()
      expect(data.order['p-4']).toBeDefined()
      expect(data.order['bg-blue-500']).toBeDefined()
      expect(data.order['items-center']).toBeDefined()
    })

    it('has more than 20000 entries', () => {
      expect(Object.keys(data.order).length).toBeGreaterThan(20000)
    })

    it('order values are serialized BigInts (string numbers)', () => {
      const val = data.order['flex']
      expect(typeof val).toBe('string')
      expect(() => BigInt(val)).not.toThrow()
    })
  })

  describe('cssProps', () => {
    it('maps padding classes correctly', () => {
      expect(data.cssProps['p-4']).toContain('padding')
    })

    it('maps display classes correctly', () => {
      expect(data.cssProps['flex']).toContain('display')
    })

    it('maps background classes correctly', () => {
      expect(data.cssProps['bg-blue-500']).toContain('background-color')
    })

    it('maps alignment classes correctly', () => {
      expect(data.cssProps['items-center']).toContain('align-items')
    })

    it('has more than 5000 entries', () => {
      expect(Object.keys(data.cssProps).length).toBeGreaterThan(5000)
    })
  })

  describe('variantOrder', () => {
    it('contains core variants', () => {
      const coreVariants = ['hover', 'focus', 'active', 'dark', 'sm', 'md', 'lg', 'xl', '2xl']
      for (const v of coreVariants) {
        expect(data.variantOrder[v]).toBeDefined()
      }
    })

    it('has variant indices as numbers', () => {
      expect(typeof data.variantOrder['hover']).toBe('number')
    })

    it('has more than 30 variants', () => {
      expect(Object.keys(data.variantOrder).length).toBeGreaterThan(30)
    })
  })

  describe('arbitraryEquivalents', () => {
    it('has more than 3000 equivalents', () => {
      expect(Object.keys(data.arbitraryEquivalents).length).toBeGreaterThan(3000)
    })

    it('keys are arbitrary form, values are named classes', () => {
      const entries = Object.entries(data.arbitraryEquivalents)
      // Arbitrary forms contain brackets
      const sample = entries.slice(0, 20)
      for (const [arb, named] of sample) {
        expect(arb).toContain('[')
        expect(arb).toContain(']')
        expect(named).not.toContain('[')
      }
    })
  })

  describe('componentClasses', () => {
    it('is an array', () => {
      expect(Array.isArray(data.componentClasses)).toBe(true)
    })
  })
})
