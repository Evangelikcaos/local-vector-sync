import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalVectorEngine } from "../src/core/engine";
import { IndexIntegrityError, VectorDimensionError, LocalVectorSyncError } from "../src/types";
import { __cosineSimilarityForTesting as cosineSimilarity } from "../src/core/engine";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("returns 0 (not NaN) when either vector is all zeros", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
});

describe("LocalVectorEngine — in-memory operations", () => {
  it("rejects a non-positive-integer dimension", () => {
    expect(() => new LocalVectorEngine({ dimension: 0 })).toThrow(LocalVectorSyncError);
    expect(() => new LocalVectorEngine({ dimension: -3 })).toThrow(LocalVectorSyncError);
    expect(() => new LocalVectorEngine({ dimension: 1.5 })).toThrow(LocalVectorSyncError);
  });

  it("upserts and retrieves a record", () => {
    const engine = new LocalVectorEngine({ dimension: 3 });
    engine.upsert({ id: "a", vector: [1, 2, 3], metadata: { title: "A" } });
    expect(engine.size()).toBe(1);
    expect(engine.get("a")).toMatchObject({ id: "a", vector: [1, 2, 3], metadata: { title: "A" } });
  });

  it("upserting the same id replaces the record instead of duplicating it", () => {
    const engine = new LocalVectorEngine({ dimension: 2 });
    engine.upsert({ id: "a", vector: [1, 0] });
    engine.upsert({ id: "a", vector: [0, 1], metadata: { v: 2 } });
    expect(engine.size()).toBe(1);
    expect(engine.get("a")?.vector).toEqual([0, 1]);
  });

  it("throws VectorDimensionError when a vector's length doesn't match", () => {
    const engine = new LocalVectorEngine({ dimension: 3 });
    expect(() => engine.upsert({ id: "a", vector: [1, 2] })).toThrow(VectorDimensionError);
  });

  it("rejects non-finite values in a vector", () => {
    const engine = new LocalVectorEngine({ dimension: 2 });
    expect(() => engine.upsert({ id: "a", vector: [1, NaN] })).toThrow(LocalVectorSyncError);
    expect(() => engine.upsert({ id: "a", vector: [1, Infinity] })).toThrow(LocalVectorSyncError);
  });

  it("upsertMany validates every record before applying any of them", () => {
    const engine = new LocalVectorEngine({ dimension: 2 });
    expect(() =>
      engine.upsertMany([
        { id: "good", vector: [1, 0] },
        { id: "bad", vector: [1, 0, 0] },
      ])
    ).toThrow(VectorDimensionError);
    // Neither record should have been applied — not even "good".
    expect(engine.size()).toBe(0);
  });

  it("deletes a record and reports whether it existed", () => {
    const engine = new LocalVectorEngine({ dimension: 2 });
    engine.upsert({ id: "a", vector: [1, 0] });
    expect(engine.delete("a")).toBe(true);
    expect(engine.delete("a")).toBe(false);
    expect(engine.size()).toBe(0);
  });

  it("search ranks results by cosine similarity, closest first", () => {
    const engine = new LocalVectorEngine({ dimension: 2 });
    engine.upsert({ id: "same", vector: [1, 0] });
    engine.upsert({ id: "orthogonal", vector: [0, 1] });
    engine.upsert({ id: "opposite", vector: [-1, 0] });

    const results = engine.search([1, 0], { topK: 3 });
    expect(results.map((r) => r.id)).toEqual(["same", "orthogonal", "opposite"]);
    expect(results[0]!.score).toBeCloseTo(1);
  });

  it("search respects topK", () => {
    const engine = new LocalVectorEngine({ dimension: 1 });
    for (let i = 0; i < 5; i++) engine.upsert({ id: `id${i}`, vector: [i] });
    expect(engine.search([2], { topK: 2 })).toHaveLength(2);
  });

  it("search applies the metadata filter", () => {
    const engine = new LocalVectorEngine({ dimension: 1 });
    engine.upsert({ id: "a", vector: [1], metadata: { lang: "es" } });
    engine.upsert({ id: "b", vector: [1], metadata: { lang: "en" } });
    const results = engine.search([1], { filter: (m) => m.lang === "en" });
    expect(results.map((r) => r.id)).toEqual(["b"]);
  });

  it("search applies minScore", () => {
    const engine = new LocalVectorEngine({ dimension: 2 });
    engine.upsert({ id: "close", vector: [1, 0] });
    engine.upsert({ id: "far", vector: [0, 1] });
    const results = engine.search([1, 0], { minScore: 0.5 });
    expect(results.map((r) => r.id)).toEqual(["close"]);
  });

  it("omits vectors from results unless includeVectors is set", () => {
    const engine = new LocalVectorEngine({ dimension: 2 });
    engine.upsert({ id: "a", vector: [1, 0] });
    expect(engine.search([1, 0])[0]!.vector).toBeUndefined();
    expect(engine.search([1, 0], { includeVectors: true })[0]!.vector).toEqual([1, 0]);
  });

  it("rejects an invalid topK", () => {
    const engine = new LocalVectorEngine({ dimension: 1 });
    engine.upsert({ id: "a", vector: [1] });
    expect(() => engine.search([1], { topK: 0 })).toThrow(LocalVectorSyncError);
  });

  it("mutating a returned record does not affect internal state", () => {
    const engine = new LocalVectorEngine({ dimension: 2 });
    engine.upsert({ id: "a", vector: [1, 2], metadata: { tag: "x" } });
    const record = engine.get("a")!;
    record.vector[0] = 999;
    record.metadata.tag = "mutated";
    expect(engine.get("a")!.vector).toEqual([1, 2]);
    expect(engine.get("a")!.metadata.tag).toBe("x");
  });

  it("mutating the caller's original metadata object after upsert() does not affect internal state", () => {
    // Regression test: upsert() must defensively copy `metadata` on the way
    // in, not just on the way out (get()/search() already did the latter).
    // Without the copy, a caller holding onto the object it passed in could
    // silently corrupt the engine's stored data after the fact.
    const engine = new LocalVectorEngine({ dimension: 2 });
    const meta = { title: "Original" };
    engine.upsert({ id: "a", vector: [1, 2], metadata: meta });
    meta.title = "mutated-from-outside";
    (meta as Record<string, unknown>).injected = "should not appear";
    expect(engine.get("a")!.metadata).toEqual({ title: "Original" });
  });

  it("mutating the caller's original metadata objects after upsertMany() does not affect internal state", () => {
    const engine = new LocalVectorEngine({ dimension: 1 });
    const metaA = { title: "A" };
    const metaB = { title: "B" };
    engine.upsertMany([
      { id: "a", vector: [1], metadata: metaA },
      { id: "b", vector: [2], metadata: metaB },
    ]);
    metaA.title = "mutated-a";
    metaB.title = "mutated-b";
    expect(engine.get("a")!.metadata.title).toBe("A");
    expect(engine.get("b")!.metadata.title).toBe("B");
  });
});

describe("LocalVectorEngine — persistence", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "lvs-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("save() then load() round-trips all records and metadata", async () => {
    const indexPath = path.join(dir, "index.json");
    const engine = new LocalVectorEngine({ dimension: 2, storagePath: indexPath });
    engine.upsert({ id: "a", vector: [1, 2], metadata: { title: "A" } });
    engine.upsert({ id: "b", vector: [3, 4], metadata: { title: "B" } });
    await engine.save();

    const loaded = await LocalVectorEngine.load(indexPath, { dimension: 2 });
    expect(loaded.size()).toBe(2);
    expect(loaded.get("a")).toMatchObject({ vector: [1, 2], metadata: { title: "A" } });
    expect(loaded.get("b")).toMatchObject({ vector: [3, 4], metadata: { title: "B" } });
  });

  it("load() on a nonexistent file returns a fresh, empty engine rather than throwing", async () => {
    const engine = await LocalVectorEngine.load(path.join(dir, "does-not-exist.json"), { dimension: 4 });
    expect(engine.size()).toBe(0);
    expect(engine.getDimension()).toBe(4);
  });

  it("load() throws IndexIntegrityError on malformed JSON", async () => {
    const indexPath = path.join(dir, "corrupt.json");
    await fs.writeFile(indexPath, "{not valid json", "utf8");
    await expect(LocalVectorEngine.load(indexPath, { dimension: 2 })).rejects.toThrow(IndexIntegrityError);
  });

  it("load() throws IndexIntegrityError when the stored dimension is missing/invalid", async () => {
    const indexPath = path.join(dir, "bad-schema.json");
    await fs.writeFile(indexPath, JSON.stringify({ formatVersion: 1, records: [] }), "utf8");
    await expect(LocalVectorEngine.load(indexPath, { dimension: 2 })).rejects.toThrow(IndexIntegrityError);
  });

  it("load() throws VectorDimensionError when the file's dimension doesn't match the requested one", async () => {
    const indexPath = path.join(dir, "index.json");
    const engine = new LocalVectorEngine({ dimension: 3, storagePath: indexPath });
    engine.upsert({ id: "a", vector: [1, 2, 3] });
    await engine.save();

    await expect(LocalVectorEngine.load(indexPath, { dimension: 5 })).rejects.toThrow(VectorDimensionError);
  });

  it("save() leaves no leftover temp file behind on success", async () => {
    const indexPath = path.join(dir, "index.json");
    const engine = new LocalVectorEngine({ dimension: 1, storagePath: indexPath });
    engine.upsert({ id: "a", vector: [1] });
    await engine.save();
    const entries = await fs.readdir(dir);
    expect(entries).toEqual(["index.json"]);
  });

  it("save() without a configured or provided storagePath throws a clear error", async () => {
    const engine = new LocalVectorEngine({ dimension: 1 });
    engine.upsert({ id: "a", vector: [1] });
    await expect(engine.save()).rejects.toThrow(LocalVectorSyncError);
  });
});
