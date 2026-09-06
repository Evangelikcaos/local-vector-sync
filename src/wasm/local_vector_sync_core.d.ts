/* tslint:disable */
/* eslint-disable */

/**
 * Cosine similarity between two vectors of equal length.
 *
 * # Panics
 * Panics (traps in WASM) if `a.len() != b.len()`. Callers on the JS side
 * are expected to validate dimensions before calling into WASM — the same
 * invariant `LocalVectorEngine` already enforces on every write path.
 */
export function cosine_similarity(a: Float32Array, b: Float32Array): number;

/**
 * Top-K cosine similarity search over a flat, row-major corpus of vectors.
 *
 * `flat_vectors` is `corpus_size * dimension` values laid out row-major
 * (record 0's `dimension` values, then record 1's, ...). `query` must have
 * exactly `dimension` values.
 *
 * Returns an interleaved flat array `[index0, score0, index1, score1, ...]`
 * of the top `top_k` matches sorted by descending score, where each index
 * is stored as an exactly-representable f32 (safe for corpora well under
 * 2^24 records, i.e. every realistic on-device corpus this targets).
 */
export function top_k_cosine(query: Float32Array, flat_vectors: Float32Array, dimension: number, top_k: number): Float32Array;
