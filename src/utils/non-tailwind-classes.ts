/**
 * Known third-party CSS classes that commonly appear beside Tailwind classes.
 * These should be left in place, but Tailwind-specific rules must not validate,
 * sort, or count them as Tailwind utilities.
 */
export function isKnownNonTailwindClass(className: string): boolean {
  const bare = stripImportant(className)
  return bare === 'rdg' || bare.startsWith('rdg-')
}

function stripImportant(className: string): string {
  if (className.startsWith('!')) return className.slice(1)
  if (className.endsWith('!')) return className.slice(0, -1)
  return className
}
