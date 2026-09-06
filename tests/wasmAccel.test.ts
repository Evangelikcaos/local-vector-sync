import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalVectorEngine } from "../src/core/engine";
import { __wasmAccelMinCorpusSizeForTesting as WASM_ACCEL_MIN_CORPUS_SIZE } from "../src/core/engine";
import * as wasmAccelModule from "../src/core/wasmAccel";
import { __resetWasmAccelCacheForTesting, loadWasmAccel } from "../src/core/wasmAccel";

function buildEngineWithRecords(count: number, dimension: number): LocalVectorEngine {
  const engine = new LocalVectorEngine({ dimension });
  const records = [];
  for (let i = 0; i < count; i++) {
    // Deterministic pseudo-random-looking vectors so scores vary and ties are unlikely.
    const vector = Array.from({ length: dimension }, (_, d) => Math.sin(i * 12.9898 + d * 78.233) * 43758.5453 % 1);
    records.push({ id: `record-${i}`, vector, metadata: { i } });
  }
  engine.upsertMany(records);
  return engine;
}

describe("WASM accelerator loading", () => {
  beforeEach(() => {
    __resetWasmAccelCacheForTesting();
  });

  it("loads the real compiled module and exposes the expected functions", () => {
    const accel = loadWasmAccel();
    expect(accel).not.toBeNull();
    expect(typeof accel!.cosineSimilarity).toBe("function");
    expect(typeof accel!.topKCosine).toBe("function");
  });

  it("caches the load result across calls", () => {
    const first = loadWasmAccel();
    const second = loadWasmAccel();
    expect(first).toBe(second);
  });
});

describe("LocalVectorEngine — WASM-accelerated search parity with pure TypeScript", () => {
  const dimension = 8;
  const corpusSize = WASM_ACCEL_MIN_CORPUS_SIZE + 20; // comfortably over the threshold

  beforeEach(() => {
    __resetWasmAccelCacheForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetWasmAccelCacheForTesting();
  });

  it("returns the same ranked ids as the pure-JS path for a large corpus", () => {
    const engine = buildEngineWithRecords(corpusSize, dimension);
    const query = Array.from({ length: dimension }, (_, d) => Math.cos(d));

    // Accelerated path (corpus size is above threshold, no filter).
    const accelerated = engine.search(query, { topK: 5 });

    // Force the pure-JS path for comparison by going just above threshold
    // isn't enough to disable WASM, so instead compare against a filter-based
    // JS-only run over the same data using a filter that matches everything —
    // filters always disable the WASM path.
    const pureJs = engine.search(query, { topK: 5, filter: () => true });

    expect(accelerated.map((r) => r.id)).toEqual(pureJs.map((r) => r.id));
    for (let i = 0; i < accelerated.length; i++) {
      expect(accelerated[i]!.score).toBeCloseTo(pureJs[i]!.score, 4);
    }
  });

  it("respects topK on the accelerated path", () => {
    const engine = buildEngineWithRecords(corpusSize, dimension);
    const query = Array.from({ length: dimension }, () => 1);
    const results = engine.search(query, { topK: 3 });
    expect(results).toHaveLength(3);
  });

  it("respects minScore on the accelerated path", () => {
    const engine = buildEngineWithRecords(corpusSize, dimension);
    const query = Array.from({ length: dimension }, () => 1);
    const all = engine.search(query, { topK: corpusSize, filter: () => true });
    const midScore = all[Math.floor(all.length / 2)]!.score;

    const filtered = engine.search(query, { topK: corpusSize, minScore: midScore });
    expect(filtered.every((r) => r.score >= midScore)).toBe(true);
    expect(filtered.length).toBeLessThan(all.length);
  });

  it("includes vectors on the accelerated path only when requested", () => {
    const engine = buildEngineWithRecords(corpusSize, dimension);
    const query = Array.from({ length: dimension }, () => 1);
    expect(engine.search(query, { topK: 1 })[0]!.vector).toBeUndefined();
    expect(engine.search(query, { topK: 1, includeVectors: true })[0]!.vector).toHaveLength(dimension);
  });

  it("falls back to the pure-TypeScript path when a filter is provided, even for a large corpus", () => {
    const engine = buildEngineWithRecords(corpusSize, dimension);
    const query = Array.from({ length: dimension }, () => 1);
    const results = engine.search(query, {
      topK: 5,
      filter: (metadata) => (metadata.i as number) % 2 === 0,
    });
    expect(results.every((r) => {
      const idNum = Number(r.id.replace("record-", ""));
      return idNum % 2 === 0;
    })).toBe(true);
  });

  it("falls back to identical pure-TypeScript results when the WASM accelerator is unavailable", () => {
    const engine = buildEngineWithRecords(corpusSize, dimension);
    const query = Array.from({ length: dimension }, (_, d) => Math.cos(d));

    const withWasm = engine.search(query, { topK: 5 });

    const spy = vi.spyOn(wasmAccelModule, "loadWasmAccel").mockReturnValue(null);
    try {
      const withoutWasm = engine.search(query, { topK: 5 });
      expect(withoutWasm.map((r) => r.id)).toEqual(withWasm.map((r) => r.id));
      for (let i = 0; i < withoutWasm.length; i++) {
        expect(withoutWasm[i]!.score).toBeCloseTo(withWasm[i]!.score, 4);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("falls back cleanly when the WASM accelerator throws mid-search", () => {
    const engine = buildEngineWithRecords(corpusSize, dimension);
    const query = Array.from({ length: dimension }, (_, d) => Math.cos(d));
    const expected = engine.search(query, { topK: 5 });

    const spy = vi.spyOn(wasmAccelModule, "loadWasmAccel").mockReturnValue({
      cosineSimilarity: () => {
        throw new Error("simulated WASM failure");
      },
      topKCosine: () => {
        throw new Error("simulated WASM failure");
      },
    });
    try {
      const result = engine.search(query, { topK: 5 });
      expect(result.map((r) => r.id)).toEqual(expected.map((r) => r.id));
    } finally {
      spy.mockRestore();
    }
  });

  it("small corpora (below the threshold) never use the accelerator, and still work", () => {
    const engine = buildEngineWithRecords(5, 3);
    const results = engine.search([1, 0, 0], { topK: 5 });
    expect(results).toHaveLength(5);
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
  });
});
