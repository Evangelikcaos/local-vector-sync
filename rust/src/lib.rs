//! Rust/WASM acceleration for local-vector-sync's hot path: cosine similarity
//! and top-K search over a flat corpus of vectors.
//!
//! This crate is compiled to `wasm32-unknown-unknown` and bound with
//! `wasm-bindgen` (Node.js target) to produce a CommonJS-loadable module that
//! is committed into the TypeScript package under `src/wasm/`. It is an
//! **optional accelerator**: `LocalVectorEngine` always has a pure-TypeScript
//! fallback and only calls into this module when it loads successfully.
//!
//! Behavior is intentionally kept in exact parity with the TypeScript
//! implementation in `src/core/engine.ts`, in particular:
//! - A zero-magnitude vector yields a cosine similarity of `0.0`, not `NaN`
//!   (an undefined 0/0 that would otherwise silently corrupt sort ordering).

use wasm_bindgen::prelude::*;

/// Cosine similarity between two equal-length f32 slices.
/// Returns `0.0` (never `NaN`) when either vector has zero magnitude.
fn cosine_similarity_impl(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());

    let mut dot: f32 = 0.0;
    let mut norm_a: f32 = 0.0;
    let mut norm_b: f32 = 0.0;

    for i in 0..a.len() {
        let x = a[i];
        let y = b[i];
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }

    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }

    dot / (norm_a.sqrt() * norm_b.sqrt())
}

/// Cosine similarity between two vectors of equal length.
///
/// # Panics
/// Panics (traps in WASM) if `a.len() != b.len()`. Callers on the JS side
/// are expected to validate dimensions before calling into WASM — the same
/// invariant `LocalVectorEngine` already enforces on every write path.
#[wasm_bindgen]
pub fn cosine_similarity(a: Vec<f32>, b: Vec<f32>) -> f32 {
    assert_eq!(a.len(), b.len(), "vectors must have the same length");
    cosine_similarity_impl(&a, &b)
}

/// Top-K cosine similarity search over a flat, row-major corpus of vectors.
///
/// `flat_vectors` is `corpus_size * dimension` values laid out row-major
/// (record 0's `dimension` values, then record 1's, ...). `query` must have
/// exactly `dimension` values.
///
/// Returns an interleaved flat array `[index0, score0, index1, score1, ...]`
/// of the top `top_k` matches sorted by descending score, where each index
/// is stored as an exactly-representable f32 (safe for corpora well under
/// 2^24 records, i.e. every realistic on-device corpus this targets).
#[wasm_bindgen]
pub fn top_k_cosine(query: Vec<f32>, flat_vectors: Vec<f32>, dimension: usize, top_k: usize) -> Vec<f32> {
    if dimension == 0 || top_k == 0 || flat_vectors.is_empty() {
        return Vec::new();
    }

    assert_eq!(query.len(), dimension, "query length must equal dimension");
    assert_eq!(
        flat_vectors.len() % dimension,
        0,
        "flat_vectors length must be a multiple of dimension"
    );

    let corpus_size = flat_vectors.len() / dimension;
    let mut scored: Vec<(usize, f32)> = Vec::with_capacity(corpus_size);

    for i in 0..corpus_size {
        let start = i * dimension;
        let row = &flat_vectors[start..start + dimension];
        let score = cosine_similarity_impl(&query, row);
        scored.push((i, score));
    }

    // Descending by score; ties keep original (stable) order via index comparison.
    scored.sort_by(|a, b| match b.1.partial_cmp(&a.1) {
        Some(ordering) => ordering,
        None => a.0.cmp(&b.0),
    });

    let take = top_k.min(scored.len());
    let mut result = Vec::with_capacity(take * 2);
    for &(idx, score) in &scored[..take] {
        result.push(idx as f32);
        result.push(score);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_vectors_have_similarity_one() {
        assert!((cosine_similarity_impl(&[1.0, 0.0, 0.0], &[1.0, 0.0, 0.0]) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn orthogonal_vectors_have_similarity_zero() {
        assert!(cosine_similarity_impl(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
    }

    #[test]
    fn opposite_vectors_have_similarity_negative_one() {
        assert!((cosine_similarity_impl(&[1.0, 0.0], &[-1.0, 0.0]) - (-1.0)).abs() < 1e-6);
    }

    #[test]
    fn zero_magnitude_vector_returns_zero_not_nan() {
        let result = cosine_similarity_impl(&[0.0, 0.0, 0.0], &[1.0, 2.0, 3.0]);
        assert_eq!(result, 0.0);
        assert!(!result.is_nan());

        let result2 = cosine_similarity_impl(&[0.0, 0.0], &[0.0, 0.0]);
        assert_eq!(result2, 0.0);
    }

    #[test]
    fn top_k_ranks_closest_first() {
        // 3 records of dimension 2: [1,0] (same), [0,1] (orthogonal), [-1,0] (opposite)
        let flat = vec![1.0, 0.0, 0.0, 1.0, -1.0, 0.0];
        let result = top_k_cosine(vec![1.0, 0.0], flat, 2, 3);
        // interleaved [idx, score, idx, score, idx, score]
        assert_eq!(result.len(), 6);
        assert_eq!(result[0], 0.0); // index 0 ("same") first
        assert!((result[1] - 1.0).abs() < 1e-6);
        assert_eq!(result[2], 1.0); // index 1 ("orthogonal") second
        assert_eq!(result[4], 2.0); // index 2 ("opposite") last
    }

    #[test]
    fn top_k_respects_k_smaller_than_corpus() {
        let flat = vec![1.0, 0.0, 0.9, 0.1, 0.0, 1.0];
        let result = top_k_cosine(vec![1.0, 0.0], flat, 2, 1);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0], 0.0);
    }

    #[test]
    fn top_k_handles_empty_corpus() {
        let result = top_k_cosine(vec![1.0, 0.0], vec![], 2, 5);
        assert!(result.is_empty());
    }

    #[test]
    #[should_panic]
    fn cosine_similarity_panics_on_length_mismatch() {
        cosine_similarity(vec![1.0, 0.0], vec![1.0, 0.0, 0.0]);
    }
}
