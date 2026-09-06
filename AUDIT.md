# Security & Code Quality Audit — LocalVectorSync

**Scope:** `src/`, `rust/`, `tests/`, `.github/workflows/`, `package.json`
**Method:** Manual review of every source file, guided by the OWASP Top 10 (adapted for a library with no HTTP surface of its own) and general enterprise code-review practice — correctness, edge cases, defensive-copy/encapsulation invariants, cryptographic hygiene, cross-provider compatibility, supply-chain reproducibility, and CI coverage. Every finding below was reproduced with a runnable script before being classified as real, and every fix has a regression test that fails on the pre-fix code and passes after.
**Result:** 1 High, 2 Medium, 2 Low findings. All five fixed. Test suite grew from 47 → 53 TypeScript tests (all passing) plus 8 Rust unit tests (all passing); `typecheck` and `build` are clean.

---

## Findings

### 1. [High] `upsert()` / `upsertMany()` stored the caller's `metadata` object by reference, not by copy

**File:** `src/core/engine.ts`
**Impact:** Data integrity / encapsulation violation.

`LocalVectorEngine` documents and tests a clear invariant: mutating anything returned by `get()` or `search()` must never affect internal state. That invariant only held in one direction. On the write path, `upsert()` and `upsertMany()` stored `record.metadata` directly:

```ts
this.records.set(record.id, {
  id: record.id,
  vector: [...record.vector],     // copied
  metadata: record.metadata ?? {}, // NOT copied — same object reference as the caller's
  updatedAt: now,
});
```

Reproduction:

```ts
const meta = { title: "Original" };
engine.upsert({ id: "a", vector: [1, 0], metadata: meta });
meta.title = "MUTATED-FROM-OUTSIDE";
meta.injected = "surprise";
engine.get("a").metadata; // { title: "MUTATED-FROM-OUTSIDE", injected: "surprise" }
```

Any caller that keeps a reference to the object it passed to `upsert()` — a very ordinary pattern (e.g. reusing a template object across calls, or holding a reference for logging) — could silently corrupt the engine's stored data after the fact, including data that had already been `save()`d or `push()`ed to remote sync, and including fields later relied on by `search()`'s `filter` predicate. This is exactly the class of bug the existing `get()`/`search()` defensive copies were written to prevent, just on the missing side of it.

**Fix:** both methods now store `{ ...(record.metadata ?? {}) }`, matching the pattern already used correctly in `loadFromJSON`, `get()`, `search()`, and `toJSON()`.
**Regression tests:** `tests/engine.test.ts` — *"mutating the caller's original metadata object after upsert() does not affect internal state"* and the `upsertMany()` equivalent. Verified end-to-end against the compiled `dist/` build.

---

### 2. [Medium] `AwsS3Backend.getObject` only recognized one shape of "not found," breaking on non-AWS S3-compatible providers

**File:** `src/sync/s3.ts`
**Impact:** Correctness / cross-provider compatibility. The README explicitly advertises Cloudflare R2 and MinIO support ("R2 speaks the S3 API... pointing `endpoint` at your R2 account URL is the only difference"), so this is a real compatibility gap, not a hypothetical one.

The original check was:

```ts
if ((error as { name?: string }).name === "NoSuchKey") {
  return null;
}
```

Real AWS S3 (recent SDK versions) reports a missing object with `error.name === "NoSuchKey"`. Some S3-compatible providers and proxy setups instead report only an HTTP 404 without that exact error name. In that case, `getObject` would throw instead of returning `null`, and both `S3VectorSync.pull()` (a fresh device with no prior backup — an expected, common state) and `readManifest()` (used on every `push()`) would fail hard instead of behaving as documented.

**Fix:** introduced `isNotFoundError()`, which treats `name === "NoSuchKey"`, `Code === "NoSuchKey"`, **or** `$metadata.httpStatusCode === 404` as not-found, while still surfacing genuine failures (e.g. `403 AccessDenied`) as errors rather than silently returning `null` for those.
**Regression tests:** `tests/s3.test.ts` — three new tests covering the AWS-style name, the bare-404 case, and confirming a real access-denied error still throws (not silently swallowed).

---

### 3. [Medium] `Cargo.lock` was gitignored for a crate that ships a compiled binary artifact

**File:** `.gitignore`, `rust/`
**Impact:** Supply-chain reproducibility.

The initial `.gitignore` treated `rust/` like an ordinary Rust *library* (where omitting `Cargo.lock` is the common convention, since a library's consumers pick their own dependency versions). But this crate isn't consumed as a Rust library — it's compiled once into a `.wasm` binary that gets committed to `src/wasm/` and shipped to every npm consumer. For a crate in that role, the Rust community's own guidance is the opposite: commit `Cargo.lock` so that rebuilding the accelerator (locally, in CI, or when a future contributor bumps `wasm-bindgen`) resolves the exact same transitive dependency versions that produced the currently-shipped `.wasm` — otherwise a routine rebuild could silently pull in a different (potentially vulnerable, or behaviorally different) transitive dependency version with no way to tell from the diff.

**Fix:** removed `Cargo.lock` from `.gitignore` and committed the existing lockfile. `cargo test`/`cargo build` in CI now also pass `--locked`, so CI fails loudly instead of silently drifting if the lockfile and `Cargo.toml` ever disagree.

---

### 4. [Low] No CI check that the committed WASM bindings actually match `rust/src/lib.rs`

**File:** `.github/workflows/test.yml`
**Impact:** Silent drift risk. Not a vulnerability by itself, but a real gap: a future contributor could edit `rust/src/lib.rs`, have `cargo test` pass (it only exercises the native, non-WASM build), open a PR, and merge — while `src/wasm/*` (what actually ships to npm and what `search()` calls into at runtime) silently keeps running the *old* logic. The existing test suite would keep passing throughout, because it tests against whatever happens to be committed in `src/wasm/`, not against the current Rust source.

**Fix:** added a `wasm-bindings-in-sync` CI job that rebuilds the WASM bindings from the current `rust/src/lib.rs` into a scratch directory and `diff`s the generated `.js`/`.d.ts` glue against what's committed in `src/wasm/`, failing the build on any mismatch. (The `.wasm` binary itself is intentionally excluded from the diff — it can differ byte-for-byte between toolchain patch versions even from identical source — the generated glue is what actually determines behavior.)

---

### 5. [Low] The WASM accelerator's index encoding has an undocumented-in-code, silent failure mode at extreme scale

**File:** `src/core/engine.ts`, `rust/src/lib.rs`
**Impact:** Correctness at a scale far outside this engine's stated target, but a *silent* one if ever hit.

`top_k_cosine` (Rust) returns each result's corpus position as an `f32`. `f32` stops representing every integer exactly beyond 2²⁴ (16,777,216). The Rust doc comment already noted this ("safe for corpora well under 2^24 records"), but nothing on the TypeScript side actually enforced it — a corpus that grew past that size would not error; it would silently start mapping some results to the wrong record id.

**Fix:** added `WASM_ACCEL_MAX_CORPUS_SIZE = 2**24` in `engine.ts`; `search()` now only takes the WASM path when the corpus size is strictly below that ceiling, falling back to the (unaffected, arbitrary-precision) pure-TypeScript path above it — turning a silent correctness bug at extreme scale into a documented, tested, and automatic fallback instead.
**Regression test:** pins the constant's value in `tests/wasmAccel.test.ts` (building an actual 16M-record corpus in CI isn't practical; the guard's logic itself is the same `>=`/`<` comparison already covered by the existing threshold tests).

---

## Reviewed and explicitly ruled out

- **Prototype pollution via `metadata`/JSON.parse.** Traced every place stored or remote JSON is merged into internal objects (`validateSerializedIndex`, `loadFromJSON`, `pull()`). All use object-spread (`{...obj}`), which uses `[[DefineOwnProperty]]` semantics and — unlike legacy `Object.assign` patterns some codebases still carry — does not trigger `Object.prototype.__proto__`'s setter even if an attacker-controlled key is literally `"__proto__"`. No pollution vector found.
- **AES-GCM usage.** Random IV per encryption (never reused with the same key), authenticated (tamper-evident) decryption, self-contained wire format documented and tested against both wrong-passphrase and bit-flip-tampering cases. No issues found.
- **`pull()`'s type assertion.** `S3VectorSync.pull()` casts the decrypted JSON to `SerializedIndex` without running it through `validateSerializedIndex` itself; this is safe in practice because the only in-repo caller, `restoreInto()`, immediately hands the result to `loadFromJSON()`, which does validate. Left as-is (not a fix) but flagged here for anyone calling `pull()` directly and treating its return type as validated — it isn't, until `loadFromJSON` is called.
- **Memory footprint of the WASM path at large dimension × large corpus.** `searchWithWasmAccel` allocates a `size × dimension` `Float32Array` per call. At the engine's stated target (thousands to low tens of thousands of records), this is negligible; documented as a known scaling characteristic rather than fixed, since the ANN-index roadmap item (`DONATIONS.md`) is the intended answer for corpora large enough for this to matter.

---

## Verification

```
$ npm run typecheck   # clean
$ npm test            # 53/53 passing (tests/engine.test.ts, tests/s3.test.ts, tests/wasmAccel.test.ts)
$ npm run build       # clean; dist/wasm/ populated
$ cd rust && cargo test --locked   # 8/8 passing
```

Plus a manual end-to-end reproduction of Finding 1 against the compiled `dist/index.js` output, confirming the fix holds through the real build artifact consumers actually install — not just against source.
