import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  IndexIntegrityError,
  LocalVectorSyncError,
  VectorDimensionError,
} from "../types";
import type {
  LocalVectorEngineOptions,
  SearchOptions,
  SearchResult,
  SerializedIndex,
  VectorMetadata,
  VectorRecord,
  VectorRecordInput,
} from "../types";

const FORMAT_VERSION = 1 as const;

/**
 * Cosine similarity between two equal-length vectors, in [-1, 1].
 *
 * A zero-magnitude vector (all zeros) has no defined direction, so cosine
 * similarity against it is mathematically undefined (0/0). Rather than
 * propagate a NaN into search results — which would silently corrupt
 * ranking, since NaN comparisons are always false and Array.sort behaves
 * unpredictably once NaN enters the comparator — this returns 0 (no
 * similarity) for that case, which is the conventional, safe convention.
 */
function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  if (magA === 0 || magB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function assertValidVector(vector: number[], dimension: number, recordId?: string): void {
  if (vector.length !== dimension) {
    throw new VectorDimensionError(dimension, vector.length, recordId);
  }
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i]!;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new LocalVectorSyncError(
        `Vector${recordId ? ` for record "${recordId}"` : ""} contains a non-finite value at index ${i} (${String(value)}). ` +
          "Vectors must contain only finite numbers."
      );
    }
  }
}

/**
 * A local-first, in-memory (with optional on-disk persistence) vector store.
 * Designed for embedding inside a desktop (Tauri/Electron) or Node.js
 * process where every query must be answerable fully offline. Search is a
 * brute-force cosine-similarity scan — deliberately simple and dependency-
 * free rather than an approximate-nearest-neighbor index, which is the
 * right tradeoff for the on-device corpora (thousands to low tens of
 * thousands of vectors) this engine targets; for a corpus so large that a
 * linear scan is the bottleneck, that indicates outgrowing "local-first"
 * and needing a dedicated ANN index instead.
 */
export class LocalVectorEngine {
  private readonly records = new Map<string, VectorRecord>();
  private readonly dimension: number;
  private readonly storagePath?: string;
  private createdAt: string;
  private updatedAt: string;

  constructor(options: LocalVectorEngineOptions) {
    if (!Number.isInteger(options.dimension) || options.dimension <= 0) {
      throw new LocalVectorSyncError(`dimension must be a positive integer (got ${options.dimension}).`);
    }
    this.dimension = options.dimension;
    this.storagePath = options.storagePath;
    const now = new Date().toISOString();
    this.createdAt = now;
    this.updatedAt = now;
  }

  /** The fixed vector length this engine was configured for. */
  getDimension(): number {
    return this.dimension;
  }

  /** Number of records currently held. */
  size(): number {
    return this.records.size;
  }

  /** Inserts a new record or replaces an existing one with the same id. */
  upsert(record: VectorRecordInput): void {
    assertValidVector(record.vector, this.dimension, record.id);
    const now = new Date().toISOString();
    this.records.set(record.id, {
      id: record.id,
      vector: [...record.vector],
      metadata: record.metadata ?? {},
      updatedAt: now,
    });
    this.updatedAt = now;
  }

  /** Inserts/replaces many records in one call. Validates every record before applying any of them, so a bad record in the batch never leaves the engine half-updated. */
  upsertMany(records: VectorRecordInput[]): void {
    for (const record of records) {
      assertValidVector(record.vector, this.dimension, record.id);
    }
    const now = new Date().toISOString();
    for (const record of records) {
      this.records.set(record.id, {
        id: record.id,
        vector: [...record.vector],
        metadata: record.metadata ?? {},
        updatedAt: now,
      });
    }
    this.updatedAt = now;
  }

  /** Removes a record. Returns true if it existed. */
  delete(id: string): boolean {
    const existed = this.records.delete(id);
    if (existed) {
      this.updatedAt = new Date().toISOString();
    }
    return existed;
  }

  /** Retrieves a single record by id, or undefined if it doesn't exist. */
  get(id: string): VectorRecord | undefined {
    const record = this.records.get(id);
    return record ? { ...record, vector: [...record.vector], metadata: { ...record.metadata } } : undefined;
  }

  /** Removes every record. Does not touch a persisted file until `save()` is called. */
  clear(): void {
    if (this.records.size > 0) {
      this.records.clear();
      this.updatedAt = new Date().toISOString();
    }
  }

  /**
   * Ranks every stored record by cosine similarity to `queryVector` and
   * returns the top matches. Runs entirely in-process/offline.
   */
  search(queryVector: number[], options: SearchOptions = {}): SearchResult[] {
    assertValidVector(queryVector, this.dimension);
    const topK = options.topK ?? 10;
    if (!Number.isInteger(topK) || topK <= 0) {
      throw new LocalVectorSyncError(`topK must be a positive integer (got ${topK}).`);
    }
    const minScore = options.minScore ?? -Infinity;
    const includeVectors = options.includeVectors ?? false;

    const scored: SearchResult[] = [];
    for (const record of this.records.values()) {
      if (options.filter && !options.filter(record.metadata)) {
        continue;
      }
      const score = cosineSimilarity(queryVector, record.vector);
      if (score < minScore) {
        continue;
      }
      const result: SearchResult = { id: record.id, score, metadata: { ...record.metadata } };
      if (includeVectors) {
        result.vector = [...record.vector];
      }
      scored.push(result);
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Serializes the full engine contents (used by `save()` and by the sync module). */
  toJSON(): SerializedIndex {
    return {
      formatVersion: FORMAT_VERSION,
      dimension: this.dimension,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      records: [...this.records.values()].map((r) => ({ ...r, vector: [...r.vector], metadata: { ...r.metadata } })),
    };
  }

  /** Replaces this engine's entire contents from a previously serialized index. Validates the dimension matches before applying anything. */
  loadFromJSON(index: SerializedIndex): void {
    validateSerializedIndex(index);
    if (index.dimension !== this.dimension) {
      throw new VectorDimensionError(this.dimension, index.dimension);
    }
    for (const record of index.records) {
      assertValidVector(record.vector, this.dimension, record.id);
    }
    this.records.clear();
    for (const record of index.records) {
      this.records.set(record.id, { ...record, vector: [...record.vector], metadata: { ...record.metadata } });
    }
    this.createdAt = index.createdAt;
    this.updatedAt = index.updatedAt;
  }

  /**
   * Persists the current contents to `storagePath` (or the path given here,
   * overriding the constructor option). Writes to a temporary file first and
   * renames it into place, so a crash or power loss mid-write can never
   * leave a truncated/corrupt index file — the rename is atomic on the same
   * filesystem, meaning readers always see either the old complete file or
   * the new complete file, never a partial one.
   */
  async save(targetPath?: string): Promise<void> {
    const resolvedPath = targetPath ?? this.storagePath;
    if (!resolvedPath) {
      throw new LocalVectorSyncError(
        "No storagePath configured. Pass one to the constructor or to save(path) directly."
      );
    }
    const serialized = JSON.stringify(this.toJSON(), null, 2);
    const dir = path.dirname(resolvedPath);
    const tmpPath = path.join(dir, `.${path.basename(resolvedPath)}.tmp-${process.pid}-${Date.now()}`);

    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmpPath, serialized, "utf8");
      await fs.rename(tmpPath, resolvedPath);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      throw new LocalVectorSyncError(`Failed to save index to "${resolvedPath}": ${(error as Error).message}`, error);
    }
  }

  /**
   * Loads an engine from a JSON index file on disk. If the file does not
   * exist, returns a fresh, empty engine for `dimension` instead of
   * throwing — this matches how a first run of an app with no prior local
   * index should behave (no index yet is normal, not an error).
   */
  static async load(storagePath: string, options: { dimension: number }): Promise<LocalVectorEngine> {
    let raw: string;
    try {
      raw = await fs.readFile(storagePath, "utf8");
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return new LocalVectorEngine({ dimension: options.dimension, storagePath });
      }
      throw new IndexIntegrityError(`Could not read index file "${storagePath}": ${nodeError.message}`, error);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new IndexIntegrityError(
        `Index file "${storagePath}" is not valid JSON: ${(error as Error).message}`,
        error
      );
    }

    validateSerializedIndex(parsed);
    const engine = new LocalVectorEngine({ dimension: options.dimension, storagePath });
    engine.loadFromJSON(parsed);
    return engine;
  }
}

function validateSerializedIndex(value: unknown): asserts value is SerializedIndex {
  if (typeof value !== "object" || value === null) {
    throw new IndexIntegrityError("Index data is not a JSON object.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.formatVersion !== FORMAT_VERSION) {
    throw new IndexIntegrityError(
      `Unsupported index formatVersion "${String(candidate.formatVersion)}" (expected ${FORMAT_VERSION}). ` +
        "This index may have been written by an incompatible version of local-vector-sync."
    );
  }
  if (typeof candidate.dimension !== "number" || !Number.isInteger(candidate.dimension) || candidate.dimension <= 0) {
    throw new IndexIntegrityError("Index data has an invalid or missing `dimension`.");
  }
  if (typeof candidate.createdAt !== "string" || typeof candidate.updatedAt !== "string") {
    throw new IndexIntegrityError("Index data is missing `createdAt`/`updatedAt` timestamps.");
  }
  if (!Array.isArray(candidate.records)) {
    throw new IndexIntegrityError("Index data has an invalid or missing `records` array.");
  }
  for (const [i, record] of candidate.records.entries()) {
    if (typeof record !== "object" || record === null) {
      throw new IndexIntegrityError(`Index record at position ${i} is not an object.`);
    }
    const r = record as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id.length === 0) {
      throw new IndexIntegrityError(`Index record at position ${i} has an invalid or missing \`id\`.`);
    }
    if (!Array.isArray(r.vector) || !r.vector.every((n) => typeof n === "number")) {
      throw new IndexIntegrityError(`Index record "${r.id}" has an invalid or missing \`vector\`.`);
    }
    if (typeof r.metadata !== "object" || r.metadata === null || Array.isArray(r.metadata)) {
      throw new IndexIntegrityError(`Index record "${r.id}" has invalid \`metadata\` (must be an object).`);
    }
    if (typeof r.updatedAt !== "string") {
      throw new IndexIntegrityError(`Index record "${r.id}" is missing \`updatedAt\`.`);
    }
  }
}

export { cosineSimilarity as __cosineSimilarityForTesting, validateSerializedIndex as __validateSerializedIndexForTesting };
export type { VectorMetadata };
