# Supporting LocalVectorSync

LocalVectorSync is maintained as a community-funded, 100% open-source (MIT) project. There is no paid tier and no plan to add one — every capability described in the README is, and will remain, free. Donations and sponsorships fund the time spent maintaining it: triaging issues, reviewing PRs, keeping dependencies (and the security surface of the encryption/sync code in particular) current, and building the roadmap below.

## Ways to contribute financially

| Platform | Best for |
|---|---|
| **[GitHub Sponsors](https://github.com/sponsors/Evangelikcaos)** | Individual developers who want recurring or one-time support with zero platform fee taken from the maintainer's side. |
| **[Open Collective](https://opencollective.com/local-vector-sync)** | Companies that need a transparent, auditable ledger of funds in and out, and/or an invoice for accounting. |
| **[Buy Me a Coffee](https://www.buymeacoffee.com/evangelikcaos)** | A quick, no-account-needed one-off thank-you. |

All three are linked from the repository's "Sponsor" button (via `.github/FUNDING.yml`) and from the README.

## What sponsors get

- **Priority triage.** Sponsor-filed issues are labeled and looked at first.
- **Public recognition.** Sponsors (who opt in) are listed by name/avatar in the README's Sponsors section and in release notes for versions their sponsorship period covers.
- **A say in the roadmap.** Sponsors at the "Backer" tier and above can propose and vote on which roadmap item below gets prioritized next via a pinned GitHub Discussion.
- **Direct access.** A private sponsor-only Discussion category for questions, integration help, and early looks at pre-release builds.

## Roadmap this funds

Ordered by current priority, not by date — items move up when there's demand (issues/reactions) or sponsor votes behind them.

1. **Approximate nearest neighbor (ANN) index option.** The current brute-force cosine scan is intentionally simple and is the right choice up to tens of thousands of vectors; a pluggable HNSW-style index (opt-in, same `search()` API) removes that ceiling for larger on-device corpora.
2. **Browser/IndexedDB storage backend.** Today's `LocalVectorEngine` persistence targets Node.js's filesystem (Tauri, Electron, Node servers). A `VectorStore` interface split plus an IndexedDB implementation extends the same engine to pure web/PWA and React Native contexts without a filesystem.
3. **Peer-to-peer sync backend.** An alternative to `S3VectorSync` that syncs directly between a user's own devices (e.g. over WebRTC or a libp2p transport) with the same encrypt-locally guarantee, for users who want zero third-party storage at all.
4. **Rust core compiled to WebAssembly.** A `wasm-bindgen`-based reimplementation of the similarity search hot path, for embedding contexts (mobile, constrained devices) where shipping a Node/V8 runtime isn't an option and every millisecond of query latency matters.
5. **Batch embedding helpers.** Thin, optional adapters for popular local embedding runtimes (e.g. `@xenova/transformers`, `llama.cpp` embedding mode, Ollama's `/api/embeddings`) so `upsertMany` can take raw text and an embedder instead of requiring pre-computed vectors.
6. **Multi-metric search.** Optional dot-product and Euclidean distance metrics alongside cosine similarity, selectable per `search()` call, for embedding models whose training objective assumes a different metric.

## Where the money goes

This is a solo-maintained project today. Funds go toward maintainer time (issue triage, releases, security review of the crypto/sync code path) and, once Open Collective balance supports it, toward one-off contracted work on specific roadmap items (e.g. commissioning the WASM core) rather than a fixed monthly draw. Open Collective's public ledger is the source of truth for exact income/expense once the collective is active.

## Non-financial ways to help

Financial support isn't the only way to help this project survive — and for many users it isn't the right one. Filing a clear, reproducible issue, opening a PR (even a small doc fix), starring the repo so others can find it, or just using it and telling others in a community like r/LocalLLaMA or r/opensource all genuinely help. Thank you either way.
