import { defineRule } from '@oxlint/plugins'
import { createExtractorVisitors, preserveSpaces, type ClassLocation } from '../utils/extractors'
import { rebuildClassString, splitClassesWithSeparators } from '../utils/class-splitter'
import { createLazyLoader } from '../design-system/loader'
import { warnOnce } from '../design-system/debug'
import { safeOptions } from '../types'
import {
  markSortRuleAutofixEnabled,
  sortClassNamesKeepingNonTailwind,
} from '../utils/sort-preservation'

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

      for (const loc of locations) {
        const split = splitClassesWithSeparators(loc.value)
        const classes = split.classes
        if (classes.length < 2) continue

        const sortedNames = sortClassNamesKeepingNonTailwind(classes, {
          cache,
          entryPoint,
          mode,
          onDefaultSortUnavailable() {
            warnOnce(
              `sort-service-unavailable:${entryPoint}`,
              `enforce-sort-order skipped because Tailwind's official class sorter could not be loaded for "${entryPoint}".`,
            )
          },
        })

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

    return {
      before() {
        markSortRuleAutofixEnabled(context, getMode())
      },
      ...createExtractorVisitors(context, check),
    }
  },
})
