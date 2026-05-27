import { defineRule } from '@oxlint/plugins'
import { createExtractorVisitors, preserveSpaces, type ClassLocation } from '../utils/extractors'
import { rebuildClassString, splitClassesWithSeparators } from '../utils/class-splitter'
import {
  extractVariants,
  splitUtilityAndVariant,
  utilityHasDynamicValue,
} from '../utils/class-parser'
import type { DesignSystemCache } from '../design-system/cache'
import { createLazyLoader, rootFontSizeFromSettings } from '../design-system/loader'
import { canonicalizeClassesSync } from '../design-system/canonicalize-service'
import { safeSettings } from '../types'
import { preserveSortedClassOrder } from '../utils/sort-preservation'

function needsRuntimeCanonicalization(cls: string): boolean {
  if (utilityHasDynamicValue(cls)) return true
  return extractVariants(cls).some((variant) => variant.startsWith('[&:has('))
}

function stripImportant(utility: string): string {
  if (utility.startsWith('!')) return utility.slice(1)
  if (utility.endsWith('!')) return utility.slice(0, -1)
  return utility
}

function canonicalizeVarFunctionSyntax(className: string): string | null {
  const { utility, variant } = splitUtilityAndVariant(className)
  const hasImportantPrefix = utility.startsWith('!')
  const hasImportantSuffix = !hasImportantPrefix && utility.endsWith('!')
  const bareUtility = hasImportantPrefix
    ? utility.slice(1)
    : hasImportantSuffix
      ? utility.slice(0, -1)
      : utility
  const match = /^(.+)-\[var\((--[\w-]+)\)\](\/.*)?$/.exec(bareUtility)
  if (!match) return null
  if (match[2].slice(2).includes('-')) return null

  const canonicalUtility = `${match[1]}-(${match[2]})${match[3] ?? ''}`
  return (
    variant + (hasImportantPrefix ? '!' : '') + canonicalUtility + (hasImportantSuffix ? '!' : '')
  )
}

function getThemeTokenEquivalent(cache: DesignSystemCache, className: string): string | null {
  const replacement = cache.getNamedEquivalentClass(className)
  if (!replacement) return null

  const { utility } = splitUtilityAndVariant(className)
  const bareUtility = stripImportant(utility)
  const match = /^(.+)-\[var\(--(.+)\)\]$/.exec(bareUtility)
  if (!match) return null

  const tokenNamespaceEnd = match[2].indexOf('-')
  if (tokenNamespaceEnd <= 0) return null

  const tokenValue = match[2].slice(tokenNamespaceEnd + 1)
  const replacementUtility = stripImportant(splitUtilityAndVariant(replacement).utility)
  return replacementUtility === `${match[1]}-${tokenValue}` ||
    replacementUtility.endsWith(`-${tokenValue}`)
    ? replacement
    : null
}

/**
 * Preserve the user's ! position after canonicalization.
 * canonicalizeCandidates always normalizes ! to suffix, but
 * enforce-consistent-important-position handles that separately.
 */
function preserveImportantPosition(original: string, canonicalized: string): string {
  const origHasPrefix = original.startsWith('!') || /^[a-z0-9[\]*@-]*:!/.test(original)
  const origHasSuffix = original.endsWith('!') && !origHasPrefix

  if (!origHasPrefix && !origHasSuffix) {
    // Original has no ! — strip any ! the canonicalizer added
    return canonicalized.replace(/!/g, '')
  }

  // Strip ! from canonicalized, then re-add in original position
  const bare = canonicalized.replace(/!/g, '')
  if (origHasPrefix) {
    // Re-add ! after variant prefix (e.g. "hover:!p-0.5")
    const variantPrefix = bare.slice(0, bare.length - bare.replace(/^[a-z0-9[\]*@-]*:/g, '').length)
    return variantPrefix + '!' + bare.slice(variantPrefix.length)
  }
  // Suffix
  return bare + '!'
}

export const enforceCanonical = defineRule({
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Enforce canonical Tailwind CSS class names using canonicalizeCandidates()',
    },
    fixable: 'code',
    schema: [
      {
        type: 'object',
        properties: {
          entryPoint: { type: 'string' },
        },
        additionalProperties: false,
      },
    ],
    hasSuggestions: true,
    messages: {
      nonCanonical: '"{{className}}" can be written as "{{canonical}}". Use the canonical form.',
      suggestReplace: 'Replace "{{className}}" with "{{replacement}}".',
    },
  },
  createOnce(context) {
    const getDS = createLazyLoader(context)

    let _rem: number | null = null
    function getRem(): number {
      if (_rem === null) {
        const settings = safeSettings(context)
        _rem = rootFontSizeFromSettings(settings)
      }
      return _rem
    }

    function check(locations: ClassLocation[]) {
      const ds = getDS()
      if (!ds) return
      const { cache, entryPoint } = ds

      for (const loc of locations) {
        const split = splitClassesWithSeparators(loc.value)
        const classes = split.classes

        // Split the location into two buckets:
        //   - named classes → precomputed `canonicalMap` is ground truth,
        //     resolved via `cache.canonicalize` (sync, sub-microsecond).
        //   - classes with arbitrary/CSS-var values in the utility
        //     (`p-[2px]`, `bg-(--c)`) → need the async DS to canonicalize,
        //     routed through the worker.
        //
        // Keeping named classes out of the worker call avoids the round-trip
        // entirely for the majority of locations, and shrinks the payload for
        // the rest. The local cache preserves `!` position, so no
        // preserveImportantPosition step is needed on that path.
        const canonicals: string[] = Array.from({ length: classes.length })
        const arbitraryIdx: number[] = []
        const arbitrary: string[] = []

        for (let i = 0; i < classes.length; i++) {
          if (needsRuntimeCanonicalization(classes[i])) {
            const namedEquivalent = getThemeTokenEquivalent(cache, classes[i])
            if (namedEquivalent) {
              canonicals[i] = namedEquivalent
            } else {
              const varSyntax = canonicalizeVarFunctionSyntax(classes[i])
              if (varSyntax) {
                canonicals[i] = varSyntax
              } else {
                arbitraryIdx.push(i)
                arbitrary.push(classes[i])
              }
            }
          } else {
            canonicals[i] = cache.canonicalize(classes[i])
          }
        }

        if (arbitrary.length > 0) {
          const rem = getRem()
          const dynamic = canonicalizeClassesSync(entryPoint, arbitrary, rem)
          if (dynamic) {
            for (let k = 0; k < arbitrary.length; k++) {
              canonicals[arbitraryIdx[k]] = preserveImportantPosition(arbitrary[k], dynamic[k])
            }
          } else {
            for (let k = 0; k < arbitrary.length; k++) {
              canonicals[arbitraryIdx[k]] = cache.canonicalize(arbitrary[k])
            }
          }
        }

        const fixedClasses = preserveSortedClassOrder(
          context,
          cache,
          entryPoint,
          classes,
          canonicals,
        )
        const fixedValue = rebuildClassString(split, fixedClasses)
        let firstNonCanonical = true

        for (let i = 0; i < classes.length; i++) {
          const cls = classes[i]
          const canonical = canonicals[i]
          if (canonical === cls) continue

          if (firstNonCanonical) {
            firstNonCanonical = false
            context.report({
              node: loc.node,
              messageId: 'nonCanonical',
              data: { className: cls, canonical },
              fix(fixer) {
                return fixer.replaceTextRange(loc.range, preserveSpaces(loc, fixedValue))
              },
            })
          } else {
            context.report({
              node: loc.node,
              messageId: 'nonCanonical',
              data: { className: cls, canonical },
              suggest: [
                {
                  messageId: 'suggestReplace',
                  data: { className: cls, replacement: canonical },
                  fix(fixer) {
                    return fixer.replaceTextRange(loc.range, preserveSpaces(loc, fixedValue))
                  },
                },
              ],
            })
          }
        }
      }
    }

    return createExtractorVisitors(context, check)
  },
})
