/**
 * Optional Rust/WASM acceleration for the search hot path.
 *
 * The generated bindings under `./wasm/` (produced by `wasm-bindgen --target
 * nodejs` from the `rust/` crate at the repo root, and committed so consumers
 * never need a Rust toolchain) are loaded lazily and defensively: if the
 * module is missing, fails to load, or doesn't export the expected shape —
 * for instance on a platform/runtime this build wasn't produced for — this
 * returns `null` and `LocalVectorEngine` falls back to the pure-TypeScript
 * implementation unconditionally. WASM acceleration is a performance
 * optimization only; it must never be required for correctness.
 */

export interface WasmAccel {
  cosineSimilarity(a: Float32Array, b: Float32Array): number;
  /**
   * Returns an interleaved `[index, score, index, score, ...]` Float32Array
   * of the top `topK` matches, sorted by descending score.
   */
  topKCosine(query: Float32Array, flatVectors: Float32Array, dimension: number, topK: number): Float32Array;
}

interface NativeWasmModule {
  cosine_similarity: (a: Float32Array, b: Float32Array) => number;
  top_k_cosine: (query: Float32Array, flatVectors: Float32Array, dimension: number, topK: number) => Float32Array;
}

// undefined = not attempted yet, null = attempted and unavailable.
let cached: WasmAccel | null | undefined;

function isNativeWasmModule(value: unknown): value is NativeWasmModule {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.cosine_similarity === "function" && typeof candidate.top_k_cosine === "function";
}

/**
 * Attempts to load the WASM accelerator, caching the result (including a
 * failed attempt) for the lifetime of the process. Never throws.
 */
export function loadWasmAccel(): WasmAccel | null {
  if (cached !== undefined) {
    return cached;
  }
  try {
    // Loaded dynamically (not statically imported) so that a missing/broken
    // build artifact — e.g. a platform this WASM wasn't published for —
    // degrades to `null` instead of a hard module-resolution failure at
    // import time for every consumer of this package.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const native: unknown = require("../wasm/local_vector_sync_core.js");
    if (!isNativeWasmModule(native)) {
      cached = null;
      return cached;
    }
    cached = {
      cosineSimilarity: (a, b) => native.cosine_similarity(a, b),
      topKCosine: (query, flatVectors, dimension, topK) => native.top_k_cosine(query, flatVectors, dimension, topK),
    };
  } catch {
    cached = null;
  }
  return cached;
}

/** Test-only: clears the cached load result so the next call re-attempts loading. */
export function __resetWasmAccelCacheForTesting(): void {
  cached = undefined;
}
