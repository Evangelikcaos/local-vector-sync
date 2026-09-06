# Security Policy

## Reporting a vulnerability

Please **do not open a public GitHub issue** for a suspected security vulnerability. Instead, use GitHub's private vulnerability reporting for this repository ("Security" tab → "Report a vulnerability"), or email the maintainer listed on the repository's GitHub profile. Include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce (a minimal code sample is ideal).
- The version of `local-vector-sync` affected.

You should expect an initial response within 5 business days. This is a solo-maintained open-source project — please be patient, but a security report will always be prioritized over routine issues/PRs.

## Scope and what "secure" means here

`local-vector-sync` handles two categories of sensitive material, and its security model is designed around each:

1. **Vector embeddings and metadata at rest and in transit.** The core engine (`LocalVectorEngine`) never transmits anything off-device on its own. The optional `S3VectorSync` module encrypts the full index with AES-256-GCM (authenticated encryption — tampering is cryptographically detected, not silently ignored) before it ever leaves the device, using a key derived locally via `scrypt` from a passphrase the library never stores or transmits. Only a small, deliberately unencrypted manifest (a hash, a timestamp, and a byte count — no vector data or metadata) is stored in the clear, so that `push()` can decide whether an upload is needed without ever having to decrypt anything remotely.
2. **Credentials for the S3-compatible backend.** `AwsS3Backend` accepts standard `@aws-sdk/client-s3` credentials/config and passes them straight through to the AWS SDK; this library does not log, cache, or persist them anywhere itself.

## Known limitations (by design, not oversights)

- **Lost passphrase = unrecoverable backup.** There is no key-recovery mechanism, intentionally — anyone who could recover it (including the bucket operator) could also decrypt other users' data.
- **The unencrypted manifest reveals sync activity metadata** (that *some* backup exists, its approximate size, and when it last changed) even though it reveals nothing about the vectors or metadata themselves. If even that is unacceptable for a given threat model, do not use `S3VectorSync`, or wrap the bucket itself in server-side encryption and strict IAM/bucket policies as an additional layer.
- **No built-in rate limiting, request signing beyond what the AWS SDK provides, or replay protection** on the sync path — `S3VectorSync` is a thin, auditable layer over the AWS SDK's own transport security (TLS) and the bucket's own access controls, not a replacement for correctly configuring bucket IAM policies.

## Supported versions

Security fixes are made against the latest published `0.x` release. There is no long-term-support branch at this stage of the project.
