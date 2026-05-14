import type { DesignSystemCache } from '../design-system/cache'
import { sortClassesSync } from '../design-system/sort-service'
import { splitUtilityAndVariant } from './class-parser'
import { isKnownNonTailwindClass } from './non-tailwind-classes'

type SortMode = 'default' | 'strict'

interface SourceCodeContext {
  readonly sourceCode?: unknown
}

interface ActiveSortRule {
  sourceCode: unknown
  mode: SortMode
}

interface SortOptions {
  cache: DesignSystemCache
  entryPoint: string
  mode: SortMode
  onDefaultSortUnavailable?: () => void
}

let activeSortRule: ActiveSortRule | null = null

function safeSourceCode(context: SourceCodeContext): unknown | null {
  try {
    return context.sourceCode ?? null
  } catch {
    return null
  }
}

export function markSortRuleAutofixEnabled(context: SourceCodeContext, mode: SortMode): void {
  const sourceCode = safeSourceCode(context)
  if (sourceCode) activeSortRule = { sourceCode, mode }
}

function getActiveSortMode(context: SourceCodeContext): SortMode | null {
  const sourceCode = safeSourceCode(context)
  if (!sourceCode || activeSortRule?.sourceCode !== sourceCode) return null
  return activeSortRule.mode
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

function sortStrict(classes: string[], cache: DesignSystemCache): string[] {
  const groups = new Map<string, string[]>()
  for (const cls of classes) {
    const { variant } = splitUtilityAndVariant(cls)
    if (!groups.has(variant)) {
      groups.set(variant, [])
    }
    groups.get(variant)!.push(cls)
  }

  for (const groupClasses of groups.values()) {
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

    const variantA = a.slice(0, -1)
    const variantB = b.slice(0, -1)
    const firstA = variantA.includes(':') ? variantA.split(':')[0] : variantA
    const firstB = variantB.includes(':') ? variantB.split(':')[0] : variantB
    const prioA = cache.getVariantPriority(firstA) ?? Number.MAX_SAFE_INTEGER
    const prioB = cache.getVariantPriority(firstB) ?? Number.MAX_SAFE_INTEGER
    return prioA - prioB
  })

  const result: string[] = []
  for (const key of sortedGroupKeys) result.push(...groups.get(key)!)
  return result
}

function sortDefault(classes: string[], entryPoint: string, onUnavailable?: () => void): string[] {
  const dynamic = sortClassesSync(entryPoint, classes)
  if (dynamic) return dynamic
  onUnavailable?.()
  return classes
}

export function sortClassNamesKeepingNonTailwind(
  classes: string[],
  options: SortOptions,
): string[] {
  const tailwindClasses = classes.filter((cls) => !isKnownNonTailwindClass(cls))
  if (tailwindClasses.length < 2) return classes

  const sortedTailwind =
    options.mode === 'strict'
      ? sortStrict(tailwindClasses, options.cache)
      : sortDefault(tailwindClasses, options.entryPoint, options.onDefaultSortUnavailable)

  let next = 0
  return classes.map((cls) => {
    if (isKnownNonTailwindClass(cls)) return cls
    return sortedTailwind[next++]
  })
}

export function preserveSortedClassOrder(
  context: SourceCodeContext,
  cache: DesignSystemCache,
  entryPoint: string,
  beforeClasses: string[],
  afterClasses: string[],
): string[] {
  const mode = getActiveSortMode(context)
  if (!mode || beforeClasses.length < 2 || afterClasses.length < 2) return afterClasses

  const options = { cache, entryPoint, mode }
  const sortedBefore = sortClassNamesKeepingNonTailwind(beforeClasses, options)
  if (!arraysEqual(beforeClasses, sortedBefore)) return afterClasses

  return sortClassNamesKeepingNonTailwind(afterClasses, options)
}
