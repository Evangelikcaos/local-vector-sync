# 🧠 LocalVectorSync

**A local-first, privacy-native embedded vector search engine — with optional encrypted, incremental sync to S3 or Cloudflare R2 when you're online.**

[![Test LocalVectorSync](https://github.com/Evangelikcaos/local-vector-sync/actions/workflows/test.yml/badge.svg)](https://github.com/Evangelikcaos/local-vector-sync/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa?logo=githubsponsors)](https://github.com/sponsors/Evangelikcaos)
[![Open Collective](https://img.shields.io/badge/Open%20Collective-support-3385FF?logo=opencollective)](https://opencollective.com/local-vector-sync)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-FFDD00?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/evangelikcaos)
[![PayPal](https://img.shields.io/badge/PayPal-donate-00457C?logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/KN78NFJJBQFEY)

LocalVectorSync lets apps built with **Tauri, Electron, React Native, or plain Node.js** run semantic search entirely **on-device** — no external vector database, no network round-trip, no user data ever leaving the machine by default. When the device *is* online and the user opts in, an optional sync module pushes an **encrypted** copy of the index to any S3-compatible bucket (AWS S3, Cloudflare R2, MinIO) so it can be restored on another device.

```ts
import { LocalVectorEngine } from "local-vector-sync";

const engine = new LocalVectorEngine({ dimension: 384, storagePath: "./my-app.index.json" });

engine.upsert({ id: "note-1", vector: embeddingFromYourModel, metadata: { title: "Grocery list" } });

const results = engine.search(queryEmbedding, { topK: 5 });
// -> [{ id: "note-1", score: 0.87, metadata: { title: "Grocery list" } }, ...]

await engine.save(); // persists to disk, atomically
```

## Why local-first

Most "vector database" options assume a hosted service and a network connection. That's the wrong default for note-taking apps, personal knowledge bases, offline-capable mobile apps, or anything privacy-sensitive: your embeddings — which can encode surprisingly sensitive content — shouldn't have to leave the device just to find the 5 most similar notes. LocalVectorSync flips the default: **local by default, sync by choice.**

## Install

```bash
npm install local-vector-sync
```

## Core engine

`LocalVectorEngine` is a brute-force cosine-similarity vector store — deliberately simple and dependency-free rather than an approximate-nearest-neighbor index, which is the right tradeoff for the on-device corpora (thousands to low tens of thousands of vectors) this targets.

```ts
import { LocalVectorEngine } from "local-vector-sync";

// Load an existing index from disk, or start fresh if none exists yet.
const engine = await LocalVectorEngine.load("./my-app.index.json", { dimension: 384 });

engine.upsertMany([
  { id: "a", vector: [...], metadata: { source: "email" } },
  { id: "b", vector: [...], metadata: { source: "note" } },
]);

const results = engine.search(queryVector, {
  topK: 10,
  minScore: 0.3,
  filter: (metadata) => metadata.source === "note",
});

await engine.save();
```

Every write path validates vector dimension and rejects non-finite values before touching stored state, and `save()` writes through a temp file + atomic rename so a crash mid-write can never leave a corrupted index on disk.

## Search acceleration (optional, automatic)

`search()` has an optional Rust/WebAssembly-accelerated path for its hot loop (cosine similarity + top-K ranking), implemented in the [`rust/`](./rust) crate and compiled with `wasm-bindgen`. It's used automatically — no setup, no flag — once a corpus is large enough that the WASM boundary crossing pays for itself, and only when no `filter` is given (a filter predicate is arbitrary JS and can't cross into WASM). Below that threshold, with a filter, or on any platform/runtime where the compiled module fails to load for any reason, `search()` transparently falls back to the pure-TypeScript implementation — same results, just slower. This is a pure performance optimization: there is no code path where WASM being unavailable changes behavior or breaks a build.

```ts
import { loadWasmAccel } from "local-vector-sync";

console.log(loadWasmAccel() !== null ? "WASM acceleration active" : "using pure-TypeScript search");
```

## Encrypted sync (optional)

```ts
import { AwsS3Backend, S3VectorSync } from "local-vector-sync";

const backend = new AwsS3Backend({
  bucket: "my-app-backups",
  region: "auto",
  endpoint: "https://<account-id>.r2.cloudflarestorage.com", // omit for real AWS S3
  credentials: { accessKeyId: "...", secretAccessKey: "..." },
});

const sync = new S3VectorSync({ backend, passphrase: userSuppliedPassphrase, prefix: `users/${userId}/` });

await sync.push(engine);              // encrypts (AES-256-GCM) and uploads, skipping if unchanged
await sync.restoreInto(newEngine);    // downloads + decrypts + loads, on a new device
```

- **Encryption is local-only.** The passphrase never leaves the device; AES-256-GCM keys are derived with scrypt. If you lose the passphrase, the remote backup is unrecoverable by design — nobody, including whoever controls the bucket, can read it without it.
- **Incremental by content hash.** `push()` compares a sha256 of the current index against a small (unencrypted, metadata-only) remote manifest and skips the upload entirely when nothing changed.
- **Works with AWS S3 or Cloudflare R2** — R2 speaks the S3 API, so pointing `endpoint` at your R2 account URL is the only difference.

## Architecture

```
┌─────────────────────────┐        offline, always available
│   Your app (Tauri /     │◄───────────────────────────────┐
│   Electron / RN / Node) │                                 │
└───────────┬─────────────┘                                 │
            │ upsert / search                                │
            ▼                                                │
┌─────────────────────────┐                                  │
│   LocalVectorEngine      │  in-memory + JSON file on disk   │
│   (cosine similarity)    │──────────────────────────────────┘
└───────────┬─────────────┘
            │ push() / restoreInto()   — only when online & opted in
            ▼
┌─────────────────────────┐
│   S3VectorSync            │  AES-256-GCM encrypt/decrypt
│   (AwsS3Backend)          │  content-hash incremental
└───────────┬─────────────┘
            ▼
   AWS S3 / Cloudflare R2 / any S3-compatible bucket
```

## 💛 Support this project

LocalVectorSync is **100% open-source under the MIT license** and free to use in commercial and personal projects alike. There's no paid tier, no feature gate — maintenance is funded entirely by the community. If it's useful to you or your company, please consider supporting it:

- **[GitHub Sponsors](https://github.com/sponsors/Evangelikcaos)** — recurring or one-time, no platform fee to the maintainer.
- **[Open Collective](https://opencollective.com/local-vector-sync)** — transparent finances, ideal if your company wants a receipt/invoice.
- **[Buy Me a Coffee](https://www.buymeacoffee.com/evangelikcaos)** — quick one-off support.
- **[PayPal](https://www.paypal.com/ncp/payment/KN78NFJJBQFEY)** — a direct one-off donation, no account needed.

<p align="center">
  <a href="https://www.paypal.com/ncp/payment/KN78NFJJBQFEY">
    <img src="./paypal-qr.png" width="140" alt="Scan to donate via PayPal">
  </a>
</p>

See [DONATIONS.md](./DONATIONS.md) for the full roadmap this funds and what sponsors get in return.

## Contributing

```bash
npm install
npm run typecheck
npm test
npm run build
```

The generated WASM bindings in `src/wasm/` are committed, so the steps above never require a Rust toolchain. If you change the Rust crate in `rust/`, see [`rust/README.md`](./rust/README.md) for how to rebuild them (`npm run build:wasm`) and `npm run test:rust` for the crate's own unit tests.

Issues and PRs welcome. Please add a test for any behavior change — the engine and sync module are both covered by real fixtures and round-trip tests, not mocks of the logic under test.

## License

[MIT](./LICENSE)
