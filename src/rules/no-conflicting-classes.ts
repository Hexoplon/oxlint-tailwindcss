import { defineRule } from '@oxlint/plugins'
import { createExtractorVisitors, type ClassLocation } from '../utils/extractors'
import { splitClasses } from '../utils/class-splitter'
import { extractUtility, getVariantPrefix } from '../utils/class-parser'
import { createLazyLoader } from '../design-system/loader'

// Utilities that share a CSS property but are designed to compose.
// Most composition is detected automatically via CSS custom properties
// (see isCompositionViaCssVars). These groups cover cases where the
// heuristic fails: shared intermediate vars or missing custom props.
export const COMPLEMENTARY_GROUPS: readonly RegExp[] = [
  /^(?:from|via|to)-/, // gradient stops (share --tw-gradient-stops)
  /^(?:transition|duration|ease|delay)(?:-|$)/, // transition composition (transition-all has no custom vars)
  /^-?(?:translate|scale|rotate|skew)-/, // transform axis composition (overlap not in cssProps)
  /^prose(?:-|$)/, // prose + prose-sm/lg/xl modifiers
]

// Pairs where one utility sets defaults and the other overrides a specific property.
export const COMPOSITION_PAIRS: readonly (readonly [RegExp, RegExp])[] = [
  [/^text-/, /^leading-/], // text-sm sets line-height, leading-* overrides
  [/^text-/, /^tracking-/], // text-* sets letter-spacing, tracking-* overrides
  [/^border(?:-[0-9]|$)/, /^border-(?:solid|dashed|dotted|double|hidden|none)$/], // border width + style
  [/^divide-/, /^border(?:-[trblxyse])?-/], // divide-* targets children
  [/^prose(?:-|$)/, /^max-w-/], // prose sets max-width, max-w-* overrides
]

function stripImportant(utility: string): string {
  if (utility.startsWith('!')) return utility.slice(1)
  if (utility.endsWith('!')) return utility.slice(0, -1)
  return utility
}

/**
 * Two utilities compose via CSS custom properties if both define their own
 * --tw-* properties that don't overlap — they each contribute to a shared
 * shorthand (e.g. `shadow` and `ring` both end up in `box-shadow` via
 * different intermediate vars).
 */
export function isCompositionViaCssVars(
  propsA: readonly string[],
  propsB: readonly string[],
): boolean {
  const customA = propsA.filter((p) => p.startsWith('--'))
  const customB = propsB.filter((p) => p.startsWith('--'))
  if (customA.length === 0 || customB.length === 0) return false
  return !customA.some((p) => customB.includes(p))
}

/**
 * Returns true if two classes (within the same variant) should NOT be reported
 * as conflicting despite sharing CSS properties. Pure: regex tables are passed
 * in (or default to the module-level constants).
 */
export function shouldSkipPair(
  a: string,
  b: string,
  propsA: readonly string[],
  propsB: readonly string[],
  rules: {
    complementaryGroups?: readonly RegExp[]
    compositionPairs?: readonly (readonly [RegExp, RegExp])[]
  } = {},
): boolean {
  if (isCompositionViaCssVars(propsA, propsB)) return true

  const ua = stripImportant(extractUtility(a))
  const ub = stripImportant(extractUtility(b))

  const groups = rules.complementaryGroups ?? COMPLEMENTARY_GROUPS
  for (const re of groups) {
    if (re.test(ua) && re.test(ub)) return true
  }

  const pairs = rules.compositionPairs ?? COMPOSITION_PAIRS
  for (const [reA, reB] of pairs) {
    if ((reA.test(ua) && reB.test(ub)) || (reA.test(ub) && reB.test(ua))) return true
  }
  return false
}

export const noConflictingClasses = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow Tailwind CSS classes that generate conflicting CSS properties',
    },
    schema: [
      {
        type: 'object',
        properties: {
          entryPoint: { type: 'string' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      conflict:
        '"{{classA}}" and "{{classB}}" affect {{properties}}. "{{winner}}" takes precedence (appears later).',
    },
  },
  createOnce(context) {
    const getDS = createLazyLoader(context)

    function check(locations: ClassLocation[]) {
      const ds = getDS()
      if (!ds) return
      const { cache } = ds
      for (const loc of locations) {
        const classes = splitClasses(loc.value)
        if (classes.length < 2) continue

        // Group classes by variant prefix (bracket-aware)
        const byVariant = new Map<string, string[]>()
        for (const cls of classes) {
          const variant = getVariantPrefix(cls)
          const existing = byVariant.get(variant) ?? []
          existing.push(cls)
          byVariant.set(variant, existing)
        }

        for (const [, variantClasses] of byVariant) {
          if (variantClasses.length < 2) continue

          // For each pair of classes in the same variant, compare CSS properties
          const propsMap = new Map<string, string[]>()
          for (const cls of variantClasses) {
            const props = cache.getCssProperties(stripImportant(extractUtility(cls)))
            propsMap.set(cls, props)
          }

          // Detect conflicts
          for (let i = 0; i < variantClasses.length; i++) {
            const classA = variantClasses[i]
            const propsA = propsMap.get(classA) ?? []

            for (let j = i + 1; j < variantClasses.length; j++) {
              const classB = variantClasses[j]
              const propsB = propsMap.get(classB) ?? []

              // Skip pairs that share CSS properties but target different elements/roles
              if (shouldSkipPair(classA, classB, propsA, propsB)) continue

              const overlap = propsA.filter((p) => propsB.includes(p))
              if (overlap.length > 0) {
                const propList =
                  overlap.length <= 3
                    ? `"${overlap.join('", "')}"`
                    : `${overlap.length} CSS properties`

                context.report({
                  node: loc.node,
                  messageId: 'conflict',
                  data: {
                    classA,
                    classB,
                    properties: propList,
                    winner: classB,
                  },
                })
              }
            }
          }
        }
      }
    }

    return createExtractorVisitors(context, check)
  },
})
