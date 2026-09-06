import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { IndexIntegrityError, LocalVectorSyncError } from "../types";
import type { SerializedIndex } from "../types";
import { LocalVectorEngine } from "../core/engine";

const ENC_FORMAT_VERSION = 1;
const SALT_LENGTH = 16;
const IV_LENGTH = 12; // recommended IV length for AES-GCM
const AUTH_TAG_LENGTH = 16;
const SCRYPT_KEY_LENGTH = 32; // AES-256

/**
 * Encrypts `plaintext` with AES-256-GCM using a key derived from
 * `passphrase` via scrypt. The output is fully self-contained — it embeds
 * the random salt, IV, and auth tag it needs to decrypt itself — so the
 * caller never has to separately track or transmit those alongside the
 * ciphertext (a common source of "encrypted data I can no longer decrypt"
 * bugs). Layout: [1B version][16B salt][12B iv][16B authTag][ciphertext].
 */
export function encryptBuffer(plaintext: Buffer, passphrase: string): Buffer {
  if (passphrase.length === 0) {
    throw new LocalVectorSyncError("Encryption passphrase must not be empty.");
  }
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = scryptSync(passphrase, salt, SCRYPT_KEY_LENGTH);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([Buffer.from([ENC_FORMAT_VERSION]), salt, iv, authTag, ciphertext]);
}

/**
 * Reverses `encryptBuffer`. Throws `LocalVectorSyncError` if the passphrase
 * is wrong or the data was corrupted/tampered with — AES-GCM's built-in
 * authentication tag makes this cryptographically detectable rather than
 * silently returning garbage plaintext.
 */
export function decryptBuffer(encrypted: Buffer, passphrase: string): Buffer {
  const minLength = 1 + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;
  if (encrypted.length < minLength) {
    throw new LocalVectorSyncError(
      `Encrypted data is too short to be a valid local-vector-sync payload (${encrypted.length} bytes, need at least ${minLength}).`
    );
  }
  const version = encrypted[0];
  if (version !== ENC_FORMAT_VERSION) {
    throw new LocalVectorSyncError(`Unsupported encryption format version "${String(version)}" (expected ${ENC_FORMAT_VERSION}).`);
  }
  let offset = 1;
  const salt = encrypted.subarray(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;
  const iv = encrypted.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const authTag = encrypted.subarray(offset, offset + AUTH_TAG_LENGTH);
  offset += AUTH_TAG_LENGTH;
  const ciphertext = encrypted.subarray(offset);

  const key = scryptSync(passphrase, salt, SCRYPT_KEY_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw new LocalVectorSyncError(
      "Decryption failed: wrong passphrase, or the data was corrupted/tampered with in transit or in storage.",
      error
    );
  }
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

interface RemoteManifest {
  sha256: string;
  updatedAt: string;
  sizeBytes: number;
}

/**
 * Minimal S3 operations `S3VectorSync` actually needs, so it can be unit
 * tested against a fast in-memory fake instead of real AWS credentials/
 * network — the same seam a real integration test would mock at. The
 * concrete `AwsS3Backend` below is the real, functional implementation used
 * in production (works against AWS S3 or any S3-compatible endpoint,
 * including Cloudflare R2 — R2 speaks the S3 API, so pointing `endpoint` at
 * an R2 account URL is all that differs).
 */
export interface S3Backend {
  putObject(key: string, body: Buffer): Promise<void>;
  /** Resolves to null if the key does not exist. */
  getObject(key: string): Promise<Buffer | null>;
}

/**
 * "Object not found" is reported inconsistently across S3-compatible
 * providers: real AWS S3 (recent SDK versions) surfaces `error.name ===
 * "NoSuchKey"`, but some S3-compatible services (this package explicitly
 * targets Cloudflare R2 and MinIO alongside AWS) or older SDK/proxy setups
 * report only an HTTP 404 without that exact error name — that case must
 * still resolve to `null` ("no manifest/index yet") rather than crashing
 * `push()`/`pull()` for anyone not running against AWS itself.
 */
function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number }; Code?: string };
  if (candidate.name === "NoSuchKey" || candidate.Code === "NoSuchKey") {
    return true;
  }
  return candidate.$metadata?.httpStatusCode === 404;
}

/** Real S3Backend implementation on top of @aws-sdk/client-s3. */
export class AwsS3Backend implements S3Backend {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: { bucket: string } & S3ClientConfig) {
    const { bucket, ...clientConfig } = options;
    if (!bucket) {
      throw new LocalVectorSyncError("AwsS3Backend requires a `bucket`.");
    }
    this.bucket = bucket;
    this.client = new S3Client(clientConfig);
  }

  async putObject(key: string, body: Buffer): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: "application/octet-stream" })
      );
    } catch (error) {
      throw new LocalVectorSyncError(`Failed to upload "${key}" to bucket "${this.bucket}": ${(error as Error).message}`, error);
    }
  }

  async getObject(key: string): Promise<Buffer | null> {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = response.Body;
      if (!body) {
        return Buffer.alloc(0);
      }
      // The AWS SDK v3 response body exposes `transformToByteArray()` in
      // Node.js runtimes on recent SDK versions; fall back to manually
      // draining the stream for older/alternate runtimes so this doesn't
      // silently break across SDK versions.
      if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === "function") {
        const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
        return Buffer.from(bytes);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw new LocalVectorSyncError(`Failed to download "${key}" from bucket "${this.bucket}": ${(error as Error).message}`, error);
    }
  }
}

export interface S3VectorSyncOptions {
  backend: S3Backend;
  /** Passphrase used to derive the AES-256-GCM key. Never transmitted or stored — only used locally to derive keys. */
  passphrase: string;
  /** Key prefix for both objects this class writes, e.g. "users/42/". Defaults to "". */
  prefix?: string;
}

export interface PushResult {
  /** True when the remote copy already matched (by content hash) and nothing was uploaded. */
  skipped: boolean;
  bytesUploaded: number;
}

/**
 * Encrypted, incremental sync of a `LocalVectorEngine`'s index to any
 * S3-compatible object store (AWS S3, Cloudflare R2, MinIO, etc. — anything
 * reachable through `AwsS3Backend`). "Incremental" here means content-hash
 * based skip-if-unchanged, not a byte-level diff: the full index is still a
 * single object (simplicity and correctness over marginal bandwidth
 * savings for the local-corpus sizes this engine targets), but a `push()`
 * with no changes since the last sync costs one small manifest read and no
 * upload at all.
 */
export class S3VectorSync {
  private readonly backend: S3Backend;
  private readonly passphrase: string;
  private readonly prefix: string;

  constructor(options: S3VectorSyncOptions) {
    if (!options.passphrase) {
      throw new LocalVectorSyncError("S3VectorSync requires a non-empty `passphrase`.");
    }
    this.backend = options.backend;
    this.passphrase = options.passphrase;
    this.prefix = options.prefix ?? "";
  }

  private get manifestKey(): string {
    return `${this.prefix}manifest.json`;
  }

  private get indexKey(): string {
    return `${this.prefix}index.json.enc`;
  }

  /**
   * Uploads the engine's current contents if (and only if) they differ from
   * what's already remote, determined by comparing a sha256 of the
   * serialized plaintext against a small, unencrypted manifest object
   * (the manifest holds only a hash and a timestamp — no vector data — so
   * leaving it unencrypted reveals nothing sensitive while letting `push`
   * decide whether to skip without ever downloading/decrypting the full
   * index).
   */
  async push(engine: LocalVectorEngine): Promise<PushResult> {
    const plaintext = Buffer.from(JSON.stringify(engine.toJSON()));
    const hash = sha256Hex(plaintext);

    const existingManifest = await this.readManifest();
    if (existingManifest && existingManifest.sha256 === hash) {
      return { skipped: true, bytesUploaded: 0 };
    }

    const encrypted = encryptBuffer(plaintext, this.passphrase);
    await this.backend.putObject(this.indexKey, encrypted);

    const manifest: RemoteManifest = { sha256: hash, updatedAt: new Date().toISOString(), sizeBytes: encrypted.length };
    await this.backend.putObject(this.manifestKey, Buffer.from(JSON.stringify(manifest)));

    return { skipped: false, bytesUploaded: encrypted.length };
  }

  /**
   * Downloads and decrypts the remote index, returning null if nothing has
   * ever been synced to this prefix yet (not an error — a fresh
   * device/install with no remote backup is an expected, normal state).
   */
  async pull(): Promise<SerializedIndex | null> {
    const encrypted = await this.backend.getObject(this.indexKey);
    if (encrypted === null) {
      return null;
    }
    const plaintext = decryptBuffer(encrypted, this.passphrase);
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext.toString("utf8"));
    } catch (error) {
      throw new IndexIntegrityError("Decrypted remote index is not valid JSON — it may have been written by an incompatible version.", error);
    }
    return parsed as SerializedIndex;
  }

  /**
   * Convenience wrapper: pulls the remote index (if any) and loads it
   * directly into `engine`, replacing its current contents. Returns false
   * without modifying `engine` if there is nothing remote to restore.
   */
  async restoreInto(engine: LocalVectorEngine): Promise<boolean> {
    const remote = await this.pull();
    if (remote === null) {
      return false;
    }
    engine.loadFromJSON(remote);
    return true;
  }

  private async readManifest(): Promise<RemoteManifest | null> {
    const raw = await this.backend.getObject(this.manifestKey);
    if (raw === null) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw.toString("utf8")) as Partial<RemoteManifest>;
      if (typeof parsed.sha256 !== "string") {
        return null;
      }
      return parsed as RemoteManifest;
    } catch {
      // A corrupt/foreign manifest object should never block syncing —
      // treat it the same as "no manifest yet" and push fresh.
      return null;
    }
  }
}
