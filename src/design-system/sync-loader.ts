/**
 * Synchronous design system loader using execFileSync.
 *
 * The problem: __unstable__loadDesignSystem is async, but oxlint's createOnce is sync.
 * The solution: spawn a child process that loads the design system, pre-computes all
 * data we need, and writes it as JSON. This runs ONCE per unique CSS entry point.
 *
 * For arbitrary values (bg-[#123]) that aren't in the class list, we use heuristics.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export interface PrecomputedData {
  /** All valid class names (candidatesToCss returned non-null) */
  validClasses: string[]
  /** className -> canonical form (only entries where canonical differs) */
  canonical: Record<string, string>
  /** className -> sort order as string (BigInt serialized) */
  order: Record<string, string>
  /** className -> CSS property names affected. Legacy cache field; new payloads omit this. */
  cssProps?: Record<string, string[]>
  /** variant name -> sort index from the design system */
  variantOrder: Record<string, number>
  /** Classes from @layer components and modifier classes referenced via [class~="..."] */
  componentClasses: string[]
  /** arbitraryForm -> namedClass for unnecessary arbitrary value detection */
  arbitraryEquivalents: Record<string, string>
}

function resolveImport(specifier: string, baseDir: string): string | null {
  const { dirname, join, resolve } = require('path')
  const { existsSync, readFileSync } = require('fs')

  if (specifier.startsWith('.')) return resolve(baseDir, specifier)

  let dir = baseDir
  while (true) {
    const pkgDir = join(dir, 'node_modules', specifier)
    if (existsSync(pkgDir)) {
      try {
        const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'))
        const entry = pkg.style || pkg.main || ''
        if (entry.endsWith('.css')) return resolve(pkgDir, entry)

        const exp = pkg.exports && pkg.exports['.']
        const styleEntry = typeof exp === 'object' && exp !== null ? exp.style : null
        if (styleEntry) return resolve(pkgDir, styleEntry)
      } catch {}

      for (const fileName of ['index.css', 'dist/index.css', 'style.css', 'styles.css']) {
        const path = join(pkgDir, fileName)
        if (existsSync(path)) return path
      }

      return null
    }

    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function extractComponentClasses(cssPath: string, baseDir: string): string[] {
  const { readFileSync } = require('fs')

  let css: string
  try {
    css = readFileSync(cssPath, 'utf-8')
  } catch {
    return []
  }

  const files = [css]
  const importRe = /@import\s+['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = importRe.exec(css)) !== null) {
    const resolved = resolveImport(match[1], baseDir)
    if (!resolved) continue

    try {
      files.push(readFileSync(resolved, 'utf-8'))
    } catch {}
  }

  const result: string[] = []
  for (const content of files) {
    const layerRe = /@layer\s+(?:components|utilities)\s*\{/g
    let layerMatch: RegExpExecArray | null
    while ((layerMatch = layerRe.exec(content)) !== null) {
      let depth = 1
      let i = layerMatch.index + layerMatch[0].length
      while (i < content.length && depth > 0) {
        if (content[i] === '{') depth++
        if (content[i] === '}') depth--
        i++
      }

      const block = content.slice(layerMatch.index + layerMatch[0].length, i - 1)
      const selectorRe = /\.([\w-]+)/g
      let selectorMatch: RegExpExecArray | null
      while ((selectorMatch = selectorRe.exec(block)) !== null) result.push(selectorMatch[1])
    }

    const classSelectorRe = /\.([a-zA-Z_][\w-]*)/g
    let classMatch: RegExpExecArray | null
    while ((classMatch = classSelectorRe.exec(content)) !== null) result.push(classMatch[1])
  }

  return [...new Set(result)]
}

async function precomputeMain(): Promise<void> {
  const tailwindNodePath = process.env.TAILWIND_NODE_PATH
  const cssPath = process.env.TAILWIND_CSS_PATH
  if (!tailwindNodePath || !cssPath) throw new Error('Missing Tailwind precompute environment')

  const { __unstable__loadDesignSystem } = require(tailwindNodePath)
  const { readFileSync, writeFileSync } = require('fs')
  const { dirname } = require('path')

  const css = readFileSync(cssPath, 'utf-8')
  const base = dirname(cssPath)
  const ds = await __unstable__loadDesignSystem(css, { base })

  const entries = ds.getClassList()
  const classNames = entries.map((entry: [string]) => entry[0])
  const classNameSet = new Set(classNames)
  const batchSize = Math.max(1, Number(process.env.TAILWIND_PRECOMPUTE_BATCH_SIZE) || 512)
  const validClasses: string[] = []
  const validSet = new Set<string>()
  const componentClasses = extractComponentClasses(cssPath, base)
  const arbitraryEquivalents: Record<string, string> = {}

  function forEachCandidateCss(
    candidates: string[],
    callback: (candidate: string, cssText: string | null) => void,
  ): void {
    for (let start = 0; start < candidates.length; start += batchSize) {
      const chunk = candidates.slice(start, start + batchSize)
      const results = ds.candidatesToCss(chunk)
      for (let i = 0; i < chunk.length; i++) callback(chunk[i], results[i])
    }
  }

  function extractDeclarations(cssText: string): string {
    const openBrace = cssText.indexOf('{')
    const closeBrace = cssText.lastIndexOf('}')
    if (openBrace === -1 || closeBrace === -1) return cssText
    return cssText
      .slice(openBrace + 1, closeBrace)
      .replace(/\s+/g, ' ')
      .trim()
  }

  const arbitraryForms: string[] = []
  const arbitraryNames: string[] = []
  const arbitraryDecls: string[] = []
  function flushArbitraryCandidates(): void {
    if (arbitraryForms.length === 0) return

    const results = ds.candidatesToCss(arbitraryForms)
    for (let i = 0; i < arbitraryForms.length; i++) {
      if (!results[i]) continue
      if (extractDeclarations(results[i]) === arbitraryDecls[i]) {
        arbitraryEquivalents[arbitraryForms[i]] = arbitraryNames[i]
      }
    }

    arbitraryForms.length = 0
    arbitraryNames.length = 0
    arbitraryDecls.length = 0
  }

  function queueArbitraryCandidate(
    arbitraryForm: string,
    namedClass: string,
    namedDecl: string,
  ): void {
    arbitraryForms.push(arbitraryForm)
    arbitraryNames.push(namedClass)
    arbitraryDecls.push(namedDecl)
    if (arbitraryForms.length >= batchSize) flushArbitraryCandidates()
  }

  function maybeQueueArbitraryEquivalents(className: string, cssText: string): void {
    if (className.includes('[') || className.includes('/')) return

    const propertyValueMatch = cssText.match(/^\s+([\w-]+)\s*:\s*(.+?)\s*;?\s*$/m)
    if (!propertyValueMatch) return

    const value = propertyValueMatch[2].trim().replace(/;$/, '')
    const namedDecl = extractDeclarations(cssText)
    for (
      let dashPos = className.indexOf('-');
      dashPos > 0;
      dashPos = className.indexOf('-', dashPos + 1)
    ) {
      const prefix = className.slice(0, dashPos)
      queueArbitraryCandidate(`${prefix}-[${value}]`, className, namedDecl)
    }
  }

  // classes referenced by selectors like `[class~="not-prose"]` are valid modifiers.
  const attrClassRe = /\[class~="([^"]+)"\]/g
  forEachCandidateCss(classNames, (className, cssText) => {
    if (cssText == null) return
    validClasses.push(className)
    validSet.add(className)

    let attrMatch: RegExpExecArray | null
    attrClassRe.lastIndex = 0
    while ((attrMatch = attrClassRe.exec(cssText)) !== null) {
      componentClasses.push(attrMatch[1])
    }

    maybeQueueArbitraryEquivalents(className, cssText)
  })
  flushArbitraryCandidates()

  const knownPrefixes = new Set<string>()
  for (const className of validClasses) {
    const dash = className.lastIndexOf('-')
    if (dash > 0) knownPrefixes.add(className.slice(0, dash))
  }

  // Tailwind v4 accepts some generated utilities that are not present in getClassList().
  const extraCandidates = ['@container-size', '@container-size/main']
  for (const prefix of knownPrefixes) {
    if (!validSet.has(prefix)) extraCandidates.push(prefix)
    for (const breakpoint of ['sm', 'md', 'lg', 'xl', '2xl']) {
      const candidate = `${prefix}-screen-${breakpoint}`
      if (!validSet.has(candidate)) extraCandidates.push(candidate)
    }
  }

  forEachCandidateCss(extraCandidates, (candidate, cssText) => {
    if (cssText == null) return
    validClasses.push(candidate)
    validSet.add(candidate)
  })

  // group/peer are marker classes: they do not emit CSS but enable variants.
  const allVariants = ds.getVariants()
  for (const variant of allVariants) {
    if (variant.name === 'group' || variant.name.startsWith('group-')) {
      validClasses.push('group')
      validSet.add('group')
      break
    }
  }
  for (const variant of allVariants) {
    if (variant.name === 'peer' || variant.name.startsWith('peer-')) {
      validClasses.push('peer')
      validSet.add('peer')
      break
    }
  }

  const canonical: Record<string, string> = {}
  for (const className of classNames) {
    const result = ds.canonicalizeCandidates([className])
    if (result[0] && result[0] !== className) canonical[className] = result[0]
  }

  // Legacy v3 spellings still accepted by v4 but missing from getClassList().
  const legacyCandidates = [
    'order-none',
    'break-words',
    'overflow-ellipsis',
    'flex-grow',
    'flex-grow-0',
    'flex-grow-1',
    'flex-shrink',
    'flex-shrink-0',
    'flex-shrink-1',
    'decoration-clone',
    'decoration-slice',
    'bg-gradient-to-t',
    'bg-gradient-to-tr',
    'bg-gradient-to-r',
    'bg-gradient-to-br',
    'bg-gradient-to-b',
    'bg-gradient-to-bl',
    'bg-gradient-to-l',
    'bg-gradient-to-tl',
  ]
  for (const className of validClasses) {
    if (className.startsWith('inset-s-')) legacyCandidates.push(`start-${className.slice(8)}`)
    else if (className.startsWith('-inset-s-'))
      legacyCandidates.push(`-start-${className.slice(9)}`)
    else if (className.startsWith('inset-e-')) legacyCandidates.push(`end-${className.slice(8)}`)
    else if (className.startsWith('-inset-e-')) legacyCandidates.push(`-end-${className.slice(9)}`)
  }

  const legacyToProcess = legacyCandidates.filter((className) => !validSet.has(className))
  if (legacyToProcess.length > 0) {
    const legacyCssResults = ds.candidatesToCss(legacyToProcess)
    for (let i = 0; i < legacyToProcess.length; i++) {
      if (legacyCssResults[i] == null) continue

      const className = legacyToProcess[i]
      const result = ds.canonicalizeCandidates([className])
      if (result[0] && result[0] !== className) canonical[className] = result[0]

      validClasses.push(className)
      validSet.add(className)
    }
  }

  // This must be one call because Tailwind returns relative order for the candidate set.
  const order: Record<string, string> = {}
  const allForOrder = [...classNames]
  for (const className of validClasses) {
    if (!classNameSet.has(className)) allForOrder.push(className)
  }
  const orderResults = ds.getClassOrder(allForOrder)
  for (const [name, value] of orderResults) {
    if (value !== null) order[name] = value.toString()
  }

  const variantOrder: Record<string, number> = {}
  const variants = ds.getVariants()
  for (let i = 0; i < variants.length; i++) {
    if (!variants[i].isArbitrary) variantOrder[variants[i].name] = i
  }

  const result = JSON.stringify({
    validClasses,
    canonical,
    order,
    variantOrder,
    componentClasses: [...new Set(componentClasses)],
    arbitraryEquivalents,
  })

  if (process.env.TAILWIND_OUTPUT_PATH) {
    writeFileSync(process.env.TAILWIND_OUTPUT_PATH, result)
  } else {
    process.stdout.write(result)
  }
}

// The ESM build of this package is bundled by tsdown, which rewrites every
// `require(...)` call to `__require(...)` (a `createRequire` shim defined at
// the top of the bundle). The functions interpolated below are stringified
// from this module, so their `require` calls also become `__require`. The
// child `node -e` process has no such shim, so we alias it to the native
// `require` here. Same shim is used in `runtime-service.ts` for the worker.
const PRECOMPUTE_SCRIPT = `
var __require = require;
${resolveImport}
${extractComponentClasses}
${precomputeMain}
precomputeMain().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
`

const CACHE_DIR = join(tmpdir(), 'oxlint-tailwindcss')

// Bump this when precompute logic changes or Tailwind data changes invalidate disk cache
const CACHE_VERSION = 19

/**
 * Two-level disk cache for monorepo deduplication:
 *
 * Level 1: mtime index (.idx) maps path+mtime to content hash.
 * Level 2: content cache (.json) maps content hash to precomputed data.
 *
 * In monorepos, multiple packages with identical CSS (e.g. `@import 'tailwindcss'`) at different
 * paths share a single content cache entry, avoiding redundant child process spawns.
 */

function getMtimeIndexPath(cssPath: string, mtime: number): string {
  const hash = createHash('md5').update(`v${CACHE_VERSION}:${cssPath}:${mtime}`).digest('hex')
  return join(CACHE_DIR, `${hash}.idx`)
}

function computeContentHash(content: string): string {
  return createHash('md5').update(`v${CACHE_VERSION}:${content}`).digest('hex')
}

function getContentCachePath(contentHash: string): string {
  return join(CACHE_DIR, `${contentHash}.json`)
}

function tryReadCache(cachePath: string): PrecomputedData | null {
  try {
    return JSON.parse(readFileSync(cachePath, 'utf-8')) as PrecomputedData
  } catch {
    return null
  }
}

function uniqueTempPath(prefix: string): string {
  const hash = createHash('md5')
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest('hex')
  return join(CACHE_DIR, `${prefix}-${hash}.tmp`)
}

function writeFileAtomic(path: string, data: string): void {
  const tempPath = uniqueTempPath('write')
  writeFileSync(tempPath, data)
  renameSync(tempPath, path)
}

function writeCacheFiles(
  contentCachePath: string,
  mtimeIndexPath: string,
  contentHash: string,
  data: string,
): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileAtomic(contentCachePath, data)
    writeFileAtomic(mtimeIndexPath, contentHash)
  } catch {
    // Non-fatal: cache is optional.
  }
}

export function loadDesignSystemSync(cssPath: string, timeout?: number): PrecomputedData | null {
  const resolvedPath = resolve(cssPath)
  let outputPath: string | null = null

  try {
    const mtime = statSync(resolvedPath).mtimeMs
    const mtimeIndexPath = getMtimeIndexPath(resolvedPath, mtime)

    if (existsSync(mtimeIndexPath)) {
      try {
        const contentHash = readFileSync(mtimeIndexPath, 'utf-8').trim()
        const contentCachePath = getContentCachePath(contentHash)
        const cached = tryReadCache(contentCachePath)
        if (cached) return cached
      } catch {
        // Index corrupted, fall through.
      }
    }

    const content = readFileSync(resolvedPath, 'utf-8')
    const contentHash = computeContentHash(content)
    const contentCachePath = getContentCachePath(contentHash)

    const cached = tryReadCache(contentCachePath)
    if (cached) {
      // Content cache hit: only the path+mtime index needs refreshing.
      try {
        mkdirSync(CACHE_DIR, { recursive: true })
        writeFileAtomic(mtimeIndexPath, contentHash)
      } catch {}
      return cached
    }

    const tailwindNodePath = require.resolve('@tailwindcss/node')

    // The child writes JSON to a temp file to avoid duplicating it in stdout buffers.
    mkdirSync(CACHE_DIR, { recursive: true })
    outputPath = uniqueTempPath('precompute')
    execFileSync(process.execPath, ['-e', PRECOMPUTE_SCRIPT], {
      encoding: 'utf-8',
      timeout: timeout ?? 30_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        TAILWIND_CSS_PATH: resolvedPath,
        TAILWIND_NODE_PATH: tailwindNodePath,
        TAILWIND_OUTPUT_PATH: outputPath,
      },
      cwd: dirname(resolvedPath),
    })

    const output = readFileSync(outputPath, 'utf-8')
    unlinkSync(outputPath)
    outputPath = null

    writeCacheFiles(contentCachePath, mtimeIndexPath, contentHash, output)

    return JSON.parse(output) as PrecomputedData
  } catch (error) {
    if (outputPath) {
      try {
        rmSync(outputPath, { force: true })
      } catch {}
    }

    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("Cannot find module '@tailwindcss/node'")) {
      console.error(
        `[oxlint-tailwindcss] Could not resolve '@tailwindcss/node' for "${resolvedPath}". ` +
          `If you are using pnpm with strict hoisting, add '@tailwindcss/node' as a direct devDependency, ` +
          `or upgrade oxlint-tailwindcss to >= 0.7.0 which resolves it from the plugin's own install location. ` +
          `DS-dependent rules will be skipped for this file.`,
      )
    } else {
      console.error(
        `[oxlint-tailwindcss] Failed to load design system from "${resolvedPath}":`,
        message,
      )
    }

    return null
  }
}

// validateCandidatesSync removed: runtime child process calls were too slow.
// Unknown classes are now handled via precomputed expansion + heuristics in cache.isValid().
