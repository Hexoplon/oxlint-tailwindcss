import { defineRule } from '@oxlint/plugins'
import { createExtractorVisitors, preserveSpaces, type ClassLocation } from '../utils/extractors'
import { rebuildClassString, splitClassesWithSeparators } from '../utils/class-splitter'
import { splitUtilityAndVariant } from '../utils/class-parser'
import { isKnownNonTailwindClass } from '../utils/non-tailwind-classes'
import { createLazyLoader } from '../design-system/loader'
import { sortClassesSync } from '../design-system/sort-service'
import { warnOnce } from '../design-system/debug'
import { safeOptions } from '../types'

interface Options {
  entryPoint?: string
  mode?: 'default' | 'strict'
}

export const enforceSortOrder = defineRule({
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Enforce consistent sort order of Tailwind CSS classes using the official class order',
    },
    fixable: 'code',
    schema: [
      {
        type: 'object',
        properties: {
          entryPoint: { type: 'string' },
          mode: { type: 'string', enum: ['default', 'strict'] },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unsorted: 'Tailwind classes are not in the recommended order.',
    },
  },
  createOnce(context) {
    const getDS = createLazyLoader(context)

    let _mode: 'default' | 'strict' | null = null
    function getMode(): 'default' | 'strict' {
      if (_mode === null) {
        const opts = safeOptions<Options>(context)
        _mode = opts?.mode ?? 'default'
      }
      return _mode
    }

    function check(locations: ClassLocation[]) {
      const ds = getDS()
      if (!ds) return
      const { cache, entryPoint } = ds
      const mode = getMode()

      function sortDefault(classes: string[]): string[] {
        const dynamic = sortClassesSync(entryPoint, classes)
        if (dynamic) return dynamic

        warnOnce(
          `sort-service-unavailable:${entryPoint}`,
          `enforce-sort-order skipped because Tailwind's official class sorter could not be loaded for "${entryPoint}".`,
        )
        return classes
      }

      function sortStrict(classes: string[]): string[] {
        const groups = new Map<string, string[]>()
        const groupOrder: string[] = []
        for (const cls of classes) {
          const { variant } = splitUtilityAndVariant(cls)
          if (!groups.has(variant)) {
            groups.set(variant, [])
            groupOrder.push(variant)
          }
          groups.get(variant)!.push(cls)
        }

        for (const [, groupClasses] of groups) {
          const ordered = cache.getClassOrder(groupClasses)
          ordered.sort((a, b) => {
            if (a[1] === null && b[1] === null) return 0
            if (a[1] === null) return -1
            if (b[1] === null) return 1
            if (a[1] < b[1]) return -1
            if (a[1] > b[1]) return 1
            return 0
          })
          groupClasses.length = 0
          for (const [name] of ordered) groupClasses.push(name)
        }

        const sortedGroupKeys = [...groups.keys()].sort((a, b) => {
          if (a === '' && b !== '') return -1
          if (a !== '' && b === '') return 1
          if (a === '' && b === '') return 0

          // For compound variant keys like "dark:hover:", use the first variant for ordering
          const variantA = a.slice(0, -1)
          const variantB = b.slice(0, -1)
          const firstA = variantA.includes(':') ? variantA.split(':')[0] : variantA
          const firstB = variantB.includes(':') ? variantB.split(':')[0] : variantB
          const prioA = cache.getVariantPriority(firstA) ?? Number.MAX_SAFE_INTEGER
          const prioB = cache.getVariantPriority(firstB) ?? Number.MAX_SAFE_INTEGER
          return prioA - prioB
        })

        const result: string[] = []
        for (const key of sortedGroupKeys) {
          result.push(...groups.get(key)!)
        }
        return result
      }
      function sortKeepingNonTailwind(classes: string[]): string[] {
        const tailwindClasses = classes.filter((cls) => !isKnownNonTailwindClass(cls))
        if (tailwindClasses.length < 2) return classes

        const sortedTailwind =
          mode === 'strict' ? sortStrict(tailwindClasses) : sortDefault(tailwindClasses)
        let next = 0
        return classes.map((cls) => {
          if (isKnownNonTailwindClass(cls)) return cls
          return sortedTailwind[next++]
        })
      }

      for (const loc of locations) {
        const split = splitClassesWithSeparators(loc.value)
        const classes = split.classes
        if (classes.length < 2) continue

        const sortedNames = sortKeepingNonTailwind(classes)

        const isSorted = classes.every((name, i) => name === sortedNames[i])
        if (isSorted) continue

        context.report({
          node: loc.node,
          messageId: 'unsorted',
          fix(fixer) {
            return fixer.replaceTextRange(
              loc.range,
              preserveSpaces(loc, rebuildClassString(split, sortedNames)),
            )
          },
        })
      }
    }

    return createExtractorVisitors(context, check)
  },
})
