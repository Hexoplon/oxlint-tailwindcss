/**
 * Shared persistent design-system service using worker_threads + SharedArrayBuffer.
 *
 * Tailwind's design system is async to load, but oxlint rule visitors are sync.
 * This worker caches design systems by entry point, then serves synchronous
 * sort and canonicalization requests via Atomics.wait(). Keeping both
 * operations in one worker avoids loading the same DS twice when both rules are
 * enabled, and avoids worker churn when monorepo files alternate entry points.
 */

import { Worker } from 'node:worker_threads'
import { extractRootCssProps } from './css-props'

const BUFFER_SIZE = 4 * 1024 * 1024 // 4 MB
const HEADER_INTS = 4
const DATA_OFFSET = HEADER_INTS * 4 + 4 // 20 bytes
const INIT_TIMEOUT = 30_000
const REQUEST_TIMEOUT = 30_000

// The ESM build is bundled by tsdown, which rewrites `require(...)` to
// `__require(...)` (a `createRequire` shim at the bundle top). This script
// runs in a Worker with `eval: true`, where the bundle's shim is unavailable
// but Node's native `require` is. Alias one to the other so the rewritten
// calls below resolve. Mirrors the shim in `sync-loader.ts`.
const WORKER_SCRIPT = `
var __require = require;
const { workerData } = require('worker_threads');

${extractRootCssProps}

async function main() {
  const { sharedBuffer } = workerData;
  const control = new Int32Array(sharedBuffer, 0, ${HEADER_INTS});
  const lengthView = new DataView(sharedBuffer, ${HEADER_INTS * 4}, 4);
  const dataArea = new Uint8Array(sharedBuffer, ${DATA_OFFSET});
  const maxDesignSystems = Math.max(1, Number(process.env.OXLINT_TAILWINDCSS_RUNTIME_DS_CACHE_SIZE) || 4);
  const dsCache = new Map();
  const failedCssPaths = new Set();

  let loadDesignSystem;
  let readFileSync;
  let dirname;
  try {
    loadDesignSystem = require(workerData.tailwindNodePath).__unstable__loadDesignSystem;
    readFileSync = require('fs').readFileSync;
    dirname = require('path').dirname;
  } catch {
    Atomics.store(control, 2, -1);
    Atomics.notify(control, 2);
    return;
  }

  async function getDesignSystem(cssPath) {
    const cached = dsCache.get(cssPath);
    if (cached) {
      dsCache.delete(cssPath);
      dsCache.set(cssPath, cached);
      return cached;
    }
    if (failedCssPaths.has(cssPath)) return null;

    try {
      const css = readFileSync(cssPath, 'utf-8');
      const ds = await loadDesignSystem(css, { base: dirname(cssPath) });
      if (dsCache.size >= maxDesignSystems) {
        const oldest = dsCache.keys().next().value;
        if (oldest !== undefined) dsCache.delete(oldest);
      }
      dsCache.set(cssPath, ds);
      return ds;
    } catch {
      failedCssPaths.add(cssPath);
      return null;
    }
  }

  Atomics.store(control, 2, 1);
  Atomics.notify(control, 2);

  while (true) {
    Atomics.wait(control, 0, 0);

    const len = lengthView.getUint32(0);
    const requestStr = Buffer.from(dataArea.slice(0, len)).toString('utf-8');
    Atomics.store(control, 0, 0);

    let response;
    try {
      const request = JSON.parse(requestStr);
      let result;
      const ds = await getDesignSystem(request.cssPath);

      if (!ds) {
        result = null;
      } else if (request.type === 'sort') {
        const ordered = ds.getClassOrder(request.classes);
        result = [...ordered]
          .sort((a, b) => {
            if (a[1] === null && b[1] === null) return 0;
            if (a[1] === null) return -1;
            if (b[1] === null) return 1;
            return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
          })
          .map(([name]) => name);
      } else if (request.type === 'canonicalize') {
        const options = request.rem ? { rem: request.rem } : undefined;
        // canonicalizeCandidates deduplicates input, so call it one class at a
        // time to preserve request length/order.
        result = request.classes.map((cls) => {
          const r = ds.canonicalizeCandidates([cls], options);
          return r[0] ?? cls;
        });
      } else if (request.type === 'cssProps') {
        const cssResults = ds.candidatesToCss(request.classes);
        result = {};
        for (let i = 0; i < request.classes.length; i++) {
          const cssText = cssResults[i];
          if (!cssText) continue;
          result[request.classes[i]] = extractRootCssProps(cssText, request.classes[i]);
        }
      } else {
        result = null;
      }

      response = Buffer.from(JSON.stringify(result), 'utf-8');
    } catch {
      response = Buffer.from('null', 'utf-8');
    }

    dataArea.set(response, 0);
    lengthView.setUint32(0, response.length);

    Atomics.store(control, 1, 1);
    Atomics.notify(control, 1);
  }
}
main();
`

interface SortRequest {
  type: 'sort'
  cssPath: string
  classes: string[]
}

interface CanonicalizeRequest {
  type: 'canonicalize'
  cssPath: string
  classes: string[]
  rem?: number
}

interface CssPropsRequest {
  type: 'cssProps'
  cssPath: string
  classes: string[]
}

type RuntimeRequestInput =
  | Omit<SortRequest, 'cssPath'>
  | Omit<CanonicalizeRequest, 'cssPath'>
  | Omit<CssPropsRequest, 'cssPath'>

let worker: Worker | null = null
let controlArray: Int32Array | null = null
let lengthView: DataView | null = null
let dataArea: Uint8Array | null = null
let initialized = false
let available = true
let workerStartCount = 0

// Process-wide cache of canonicalized classes.
// Key: `${cssPath}\0${rem}\0${className}` — isolates monorepos (multiple DSs)
// and different rem settings. Value: canonicalized class string.
const canonCache = new Map<string, string>()

// Process-wide cache of lazily computed CSS properties.
// Key: `${cssPath}\0${className}` — isolates monorepos (multiple DSs).
const cssPropsCache = new Map<string, string[]>()

function ensureService(): boolean {
  if (initialized) return available

  initialized = true

  try {
    // Resolve @tailwindcss/node from the parent thread where the plugin's
    // dependencies are available, then pass the resolved path to the worker.
    // This avoids module resolution issues in VS Code's extension host.
    const tailwindNodePath = require.resolve('@tailwindcss/node')

    const sharedBuffer = new SharedArrayBuffer(BUFFER_SIZE)
    controlArray = new Int32Array(sharedBuffer, 0, HEADER_INTS)
    lengthView = new DataView(sharedBuffer, HEADER_INTS * 4, 4)
    dataArea = new Uint8Array(sharedBuffer, DATA_OFFSET)

    worker = new Worker(WORKER_SCRIPT, {
      eval: true,
      workerData: { sharedBuffer, tailwindNodePath },
    })
    workerStartCount++

    const currentWorker = worker
    currentWorker.unref()

    currentWorker.on('error', () => {
      available = false
      if (worker === currentWorker) worker = null
    })
    currentWorker.on('exit', () => {
      if (worker === currentWorker) worker = null
    })

    const result = Atomics.wait(controlArray, 2, 0, INIT_TIMEOUT)
    if (result === 'timed-out' || controlArray[2] === -1) {
      available = false
      cleanup()
      return false
    }

    // `worker.unref()` handles process exit; no exit listener (see exit-listeners.test.ts).
    return true
  } catch {
    available = false
    cleanup()
    return false
  }
}

function cleanup(): void {
  if (worker) {
    try {
      worker.terminate()
    } catch {}
    worker = null
  }
}

function resetRuntimeWorker(): void {
  cleanup()
  initialized = false
  available = true
  controlArray = null
  lengthView = null
  dataArea = null
  workerStartCount = 0
}

function callWorker<T>(cssPath: string, requestData: RuntimeRequestInput): T | null {
  if (!ensureService()) return null
  if (!controlArray || !dataArea || !lengthView) return null

  try {
    const request = Buffer.from(JSON.stringify({ ...requestData, cssPath }), 'utf-8')
    if (request.length > BUFFER_SIZE - DATA_OFFSET) return null

    dataArea.set(request, 0)
    lengthView.setUint32(0, request.length)

    Atomics.store(controlArray, 0, 1)
    Atomics.notify(controlArray, 0)

    const result = Atomics.wait(controlArray, 1, 0, REQUEST_TIMEOUT)
    if (result === 'timed-out') {
      resetRuntimeWorker()
      return null
    }

    const responseLen = lengthView.getUint32(0)
    const responseStr = Buffer.from(dataArea.slice(0, responseLen)).toString('utf-8')
    Atomics.store(controlArray, 1, 0)

    return JSON.parse(responseStr)
  } catch {
    resetRuntimeWorker()
    return null
  }
}

/**
 * Sort classes using the official Tailwind CSS sort order via worker thread.
 * Returns the sorted class array, or null if the service is unavailable.
 */
export function sortClassesSync(cssPath: string, classes: string[]): string[] | null {
  return callWorker<string[]>(cssPath, { type: 'sort', classes })
}

/**
 * Canonicalize classes using the Tailwind CSS design system via worker thread.
 * Returns the canonicalized class array (same length/order as input), or null
 * if the service is unavailable.
 *
 * Uses a process-wide per-class cache: the worker is invoked only for classes
 * not already seen with this (cssPath, rem) combination.
 */
export function canonicalizeClassesSync(
  cssPath: string,
  classes: string[],
  rem?: number,
): string[] | null {
  const out: string[] = Array.from({ length: classes.length })
  const missingIdx: number[] = []
  const missing: string[] = []
  const cachePrefix = `${cssPath}\0${rem ?? ''}\0`

  for (let i = 0; i < classes.length; i++) {
    const key = cachePrefix + classes[i]
    const hit = canonCache.get(key)
    if (hit !== undefined) {
      out[i] = hit
    } else {
      missingIdx.push(i)
      missing.push(classes[i])
    }
  }

  if (missing.length === 0) return out

  // Deduplicate the worker request: if a location repeats a class, we don't
  // need to canonicalize it twice. The per-class cache serves repeats in
  // subsequent calls, but within a single call the cache is still cold.
  const uniqueMissing = [...new Set(missing)]
  const fresh = callWorker<string[]>(cssPath, {
    type: 'canonicalize',
    classes: uniqueMissing,
    rem,
  })
  if (!fresh || fresh.length !== uniqueMissing.length) return null

  const freshByClass = new Map<string, string>()
  for (let k = 0; k < uniqueMissing.length; k++) {
    freshByClass.set(uniqueMissing[k], fresh[k])
  }

  for (let j = 0; j < missing.length; j++) {
    const cls = missing[j]
    const value = freshByClass.get(cls) ?? cls
    canonCache.set(cachePrefix + cls, value)
    out[missingIdx[j]] = value
  }

  return out
}

/**
 * Compute CSS properties for the requested utilities through the Tailwind CSS
 * design system. Returns a map for all requested classes, or null if the
 * service is unavailable.
 */
export function getCssPropertiesSync(
  cssPath: string,
  classes: string[],
): Map<string, string[]> | null {
  const out = new Map<string, string[]>()
  const missing: string[] = []
  const cachePrefix = `${cssPath}\0`

  for (const className of classes) {
    const key = cachePrefix + className
    const hit = cssPropsCache.get(key)
    if (hit !== undefined) {
      out.set(className, hit)
    } else {
      missing.push(className)
    }
  }

  if (missing.length === 0) return out

  const uniqueMissing = [...new Set(missing)]
  const fresh = callWorker<Record<string, string[]>>(cssPath, {
    type: 'cssProps',
    classes: uniqueMissing,
  })
  if (!fresh) return null

  for (const className of uniqueMissing) {
    const value = fresh[className] ?? []
    cssPropsCache.set(cachePrefix + className, value)
    out.set(className, value)
  }

  return out
}

/**
 * Reset the shared runtime worker (for sort-service tests).
 */
export function resetSortRuntimeService(): void {
  resetRuntimeWorker()
}

/**
 * Reset the shared runtime worker and canonicalization cache (for tests).
 */
export function resetCanonicalizeRuntimeService(): void {
  resetRuntimeWorker()
  canonCache.clear()
}

/**
 * Reset the shared runtime worker and CSS property cache (for tests).
 */
export function resetCssPropsRuntimeService(): void {
  resetRuntimeWorker()
  cssPropsCache.clear()
}

export function getRuntimeServiceStats(): { workerStarts: number } {
  return { workerStarts: workerStartCount }
}
