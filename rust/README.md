# local-vector-sync-core (Rust/WASM accelerator)

This crate implements the search hot path (cosine similarity + top-K ranking)
for [`local-vector-sync`](../README.md) in Rust, compiled to
`wasm32-unknown-unknown` and bound with `wasm-bindgen` for Node.js.

It is **not** a required dependency of the npm package. `LocalVectorEngine`
always has a complete, independently-tested pure-TypeScript implementation
(`src/core/engine.ts`); when the generated bindings in `../src/wasm/` load
successfully, searches over larger corpora (see `WASM_ACCEL_MIN_CORPUS_SIZE`
in `engine.ts`) use this instead, purely for speed. Behavior is identical —
in particular, a zero-magnitude vector returns a similarity of `0.0`, never
`NaN`, matching the TypeScript implementation exactly.

## Rebuilding the generated bindings

The generated files under `../src/wasm/` (`local_vector_sync_core.js`,
`local_vector_sync_core_bg.wasm`, and the `.d.ts` files) are committed to the
repository so that consumers of the npm package never need a Rust toolchain.
Regenerate them after changing `src/lib.rs`:

```bash
rustup target add wasm32-unknown-unknown   # once per machine
cargo install wasm-bindgen-cli --version <version matching the wasm-bindgen dependency in Cargo.toml> --locked

npm run build:wasm    # from the repository root
```

## Testing

```bash
cargo test                 # native unit tests (fast, run on every PR in CI)
npm run test:rust          # same, invoked from the repo root
```

The native (non-WASM) target is used for `cargo test` because it can run
directly without a JS host; the logic under test (`cosine_similarity_impl`,
`top_k_cosine`) is identical to what gets compiled to WASM.
