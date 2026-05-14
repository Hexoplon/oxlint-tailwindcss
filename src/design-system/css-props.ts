/**
 * Extract CSS properties from only the utility's root selector.
 *
 * Plugin classes like `prose` generate CSS for both the root element and
 * descendants. Conflict detection should use only root-level declarations.
 */
export function extractRootCssProps(cssText: string, className: string): string[] {
  const atPropertyDescriptors = new Set(['syntax', 'inherits', 'initial-value'])
  const rootProps: string[] = []
  const allProps: string[] = []
  const escapedName = className.replace(/([^\w-])/g, '\\$1')
  const classSelector = `.${escapedName}`
  const rawSelector = `.${className}`
  const propRe = /^\s+([\w-]+)\s*:/gm

  function isRoot(selector: string): boolean {
    for (const root of [classSelector, rawSelector]) {
      if (selector === root) return true
      if (
        selector.length > root.length &&
        selector.startsWith(root) &&
        selector[root.length] === ':'
      ) {
        return true
      }
    }
    return false
  }

  function extractTopLevelProps(body: string): string[] {
    const props: string[] = []
    let depth = 0
    let lineStart = 0

    for (let i = 0; i <= body.length; i++) {
      if (i === body.length || body[i] === '\n') {
        if (depth === 0) {
          const line = body.slice(lineStart, i)
          const match = /^\s+([\w-]+)\s*:/.exec(line)
          if (match && !atPropertyDescriptors.has(match[1])) props.push(match[1])
        }
        lineStart = i + 1
      } else if (body[i] === '{') {
        depth++
      } else if (body[i] === '}') {
        depth--
      }
    }

    return props
  }

  function processText(text: string): void {
    let i = 0
    while (i < text.length) {
      while (i < text.length && /\s/.test(text[i])) i++
      if (i >= text.length) break

      const braceIdx = text.indexOf('{', i)
      if (braceIdx === -1) break

      const selector = text.slice(i, braceIdx).trim()
      let depth = 1
      let j = braceIdx + 1
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++
        if (text[j] === '}') depth--
        j++
      }

      const body = text.slice(braceIdx + 1, j - 1)
      if (
        selector.startsWith('@media') ||
        selector.startsWith('@supports') ||
        selector.startsWith('@layer')
      ) {
        processText(body)
      } else if (!selector.startsWith('@')) {
        propRe.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = propRe.exec(body)) !== null) {
          if (!atPropertyDescriptors.has(match[1])) allProps.push(match[1])
        }
        if (isRoot(selector)) rootProps.push(...extractTopLevelProps(body))
      }

      i = j
    }
  }

  processText(cssText)

  const result = rootProps.length > 0 ? rootProps : allProps
  return [...new Set(result)]
}
