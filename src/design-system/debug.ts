const PREFIX = '[oxlint-tailwindcss]'

let _enabled: boolean | null = null
const warnings = new Set<string>()

/**
 * Check if debug logging is enabled.
 * Activated by `settings.tailwindcss.debug: true` or `DEBUG=oxlint-tailwindcss` env var.
 */
export function isDebugEnabled(settings?: Readonly<Record<string, unknown>>): boolean {
  // Env var always wins — avoids needing to change config
  if (process.env.DEBUG === 'oxlint-tailwindcss') return true

  if (settings !== undefined) {
    const tw = settings?.tailwindcss
    if (tw && typeof tw === 'object' && 'debug' in tw) {
      return (tw as Record<string, unknown>).debug === true
    }
  }

  return false
}

/**
 * Enable debug mode (called once when settings become available).
 */
export function setDebugEnabled(enabled: boolean): void {
  _enabled = enabled
}

/**
 * Log a debug message if debug mode is active.
 */
export function debugLog(message: string): void {
  if (_enabled || process.env.DEBUG === 'oxlint-tailwindcss') {
    console.error(`${PREFIX} ${message}`)
  }
}

/**
 * Warn once for degraded behavior that affects rule correctness.
 */
export function warnOnce(key: string, message: string): void {
  if (warnings.has(key)) return
  warnings.add(key)
  console.error(`${PREFIX} ${message}`)
}

/**
 * Reset debug state (for tests).
 */
export function resetDebug(): void {
  _enabled = null
  warnings.clear()
}
