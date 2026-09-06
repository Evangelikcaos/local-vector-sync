import { describe, expect, it, vi } from "vitest";
import { LocalVectorEngine } from "../src/core/engine";
import { LocalVectorSyncError } from "../src/types";
import { AwsS3Backend, S3VectorSync, decryptBuffer, encryptBuffer } from "../src/sync/s3";
import type { S3Backend } from "../src/sync/s3";

describe("encryptBuffer / decryptBuffer", () => {
  it("round-trips arbitrary data through the correct passphrase", () => {
    const plaintext = Buffer.from(JSON.stringify({ hello: "world", n: 42 }));
    const encrypted = encryptBuffer(plaintext, "correct horse battery staple");
    const decrypted = decryptBuffer(encrypted, "correct horse battery staple");
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("produces different ciphertext each time (random salt/IV) even for the same input", () => {
    const plaintext = Buffer.from("same input");
    const a = encryptBuffer(plaintext, "pw");
    const b = encryptBuffer(plaintext, "pw");
    expect(a.equals(b)).toBe(false);
  });

  it("fails to decrypt with the wrong passphrase", () => {
    const encrypted = encryptBuffer(Buffer.from("secret"), "right-passphrase");
    expect(() => decryptBuffer(encrypted, "wrong-passphrase")).toThrow(LocalVectorSyncError);
  });

  it("fails to decrypt tampered ciphertext (GCM authentication catches it)", () => {
    const encrypted = encryptBuffer(Buffer.from("secret data"), "pw");
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    expect(() => decryptBuffer(tampered, "pw")).toThrow(LocalVectorSyncError);
  });

  it("rejects an empty passphrase", () => {
    expect(() => encryptBuffer(Buffer.from("x"), "")).toThrow(LocalVectorSyncError);
  });

  it("rejects data too short to be a valid payload", () => {
    expect(() => decryptBuffer(Buffer.from([1, 2, 3]), "pw")).toThrow(LocalVectorSyncError);
  });
});

/** Simple in-memory S3Backend fake — the real AwsS3Backend is exercised by the interface it implements, not by hitting real AWS in unit tests. */
class InMemoryS3Backend implements S3Backend {
  readonly store = new Map<string, Buffer>();
  putCalls = 0;
  getCalls = 0;

  async putObject(key: string, body: Buffer): Promise<void> {
    this.putCalls += 1;
    this.store.set(key, Buffer.from(body));
  }

  async getObject(key: string): Promise<Buffer | null> {
    this.getCalls += 1;
    return this.store.get(key) ?? null;
  }
}

describe("AwsS3Backend — not-found detection across S3-compatible providers", () => {
  // AwsS3Backend wraps the real S3Client; these tests stub its `send` method
  // rather than hitting real AWS/R2/MinIO, to exercise `isNotFoundError`'s
  // branches directly (see src/sync/s3.ts for why more than one shape of
  // "not found" has to be recognized).
  function backendWithStubbedSend(rejection: unknown): AwsS3Backend {
    const backend = new AwsS3Backend({ bucket: "test-bucket", region: "us-east-1" });
    (backend as unknown as { client: { send: unknown } }).client.send = vi.fn().mockRejectedValue(rejection);
    return backend;
  }

  it("treats an AWS-style NoSuchKey error as not-found", async () => {
    const backend = backendWithStubbedSend(Object.assign(new Error("no such key"), { name: "NoSuchKey" }));
    await expect(backend.getObject("missing")).resolves.toBeNull();
  });

  it("treats a bare HTTP 404 (no NoSuchKey error name) as not-found, for R2/MinIO-style responses", async () => {
    const backend = backendWithStubbedSend(
      Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } })
    );
    await expect(backend.getObject("missing")).resolves.toBeNull();
  });

  it("still surfaces a real failure (e.g. access denied) as LocalVectorSyncError, not a silent null", async () => {
    const backend = backendWithStubbedSend(
      Object.assign(new Error("access denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } })
    );
    await expect(backend.getObject("some-key")).rejects.toThrow(LocalVectorSyncError);
  });
});

describe("S3VectorSync", () => {
  it("restoreInto returns false when nothing has been pushed yet", async () => {
    const backend = new InMemoryS3Backend();
    const sync = new S3VectorSync({ backend, passphrase: "pw" });
    const engine = new LocalVectorEngine({ dimension: 2 });
    await expect(sync.restoreInto(engine)).resolves.toBe(false);
    expect(engine.size()).toBe(0);
  });

  it("push then restoreInto on a different engine instance round-trips all data", async () => {
    const backend = new InMemoryS3Backend();
    const sync = new S3VectorSync({ backend, passphrase: "correct horse battery staple" });

    const source = new LocalVectorEngine({ dimension: 3 });
    source.upsert({ id: "a", vector: [1, 2, 3], metadata: { title: "A" } });
    source.upsert({ id: "b", vector: [4, 5, 6], metadata: { title: "B" } });

    const pushResult = await sync.push(source);
    expect(pushResult.skipped).toBe(false);
    expect(pushResult.bytesUploaded).toBeGreaterThan(0);

    const destination = new LocalVectorEngine({ dimension: 3 });
    const restored = await sync.restoreInto(destination);
    expect(restored).toBe(true);
    expect(destination.size()).toBe(2);
    expect(destination.get("a")).toMatchObject({ vector: [1, 2, 3], metadata: { title: "A" } });
  });

  it("stores the remote index encrypted, not as plaintext JSON", async () => {
    const backend = new InMemoryS3Backend();
    const sync = new S3VectorSync({ backend, passphrase: "pw" });
    const engine = new LocalVectorEngine({ dimension: 1 });
    engine.upsert({ id: "secret-id", vector: [1] });
    await sync.push(engine);

    const rawIndexObject = [...backend.store.entries()].find(([key]) => key.endsWith("index.json.enc"))![1];
    expect(rawIndexObject.toString("utf8")).not.toContain("secret-id");
  });

  it("push skips uploading the index again when content is unchanged", async () => {
    const backend = new InMemoryS3Backend();
    const sync = new S3VectorSync({ backend, passphrase: "pw" });
    const engine = new LocalVectorEngine({ dimension: 1 });
    engine.upsert({ id: "a", vector: [1] });

    const first = await sync.push(engine);
    expect(first.skipped).toBe(false);
    const putCallsAfterFirst = backend.putCalls;

    const second = await sync.push(engine);
    expect(second.skipped).toBe(true);
    expect(second.bytesUploaded).toBe(0);
    expect(backend.putCalls).toBe(putCallsAfterFirst); // no additional uploads

    engine.upsert({ id: "b", vector: [2] });
    const third = await sync.push(engine);
    expect(third.skipped).toBe(false);
    expect(backend.putCalls).toBeGreaterThan(putCallsAfterFirst);
  });

  it("keeps separate prefixes fully isolated from each other", async () => {
    const backend = new InMemoryS3Backend();
    const syncA = new S3VectorSync({ backend, passphrase: "pw", prefix: "tenant-a/" });
    const syncB = new S3VectorSync({ backend, passphrase: "pw", prefix: "tenant-b/" });

    const engineA = new LocalVectorEngine({ dimension: 1 });
    engineA.upsert({ id: "only-in-a", vector: [1] });
    await syncA.push(engineA);

    await expect(syncB.pull()).resolves.toBeNull();
  });

  it("rejects an empty passphrase at construction time", () => {
    const backend = new InMemoryS3Backend();
    expect(() => new S3VectorSync({ backend, passphrase: "" })).toThrow(LocalVectorSyncError);
  });
});
