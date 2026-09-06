/** Arbitrary JSON-serializable metadata attached to a vector record. */
export type VectorMetadata = Record<string, unknown>;

/** A vector record as provided by the caller when inserting/updating. */
export interface VectorRecordInput {
  /** Caller-assigned unique identifier. Upserting an existing id replaces that record. */
  id: string;
  /** The embedding itself. Must match the engine's configured `dimension`. */
  vector: number[];
  /** Optional arbitrary metadata returned alongside search results. */
  metadata?: VectorMetadata;
}

/** A vector record as stored internally and returned by `get`/`search` (includeVectors: true). */
export interface VectorRecord extends VectorRecordInput {
  metadata: VectorMetadata;
  /** ISO-8601 timestamp of the last insert/update for this id. */
  updatedAt: string;
}

/** One ranked hit returned by `search`. */
export interface SearchResult {
  id: string;
  /** Cosine similarity in [-1, 1] (1 = identical direction, 0 = orthogonal, -1 = opposite). */
  score: number;
  metadata: VectorMetadata;
  /** Present only when `search` was called with `includeVectors: true`. */
  vector?: number[];
}

export interface SearchOptions {
  /** Maximum number of results to return. Defaults to 10. */
  topK?: number;
  /** Only return results with score >= minScore. */
  minScore?: number;
  /** Only consider records whose metadata satisfies this predicate. */
  filter?: (metadata: VectorMetadata) => boolean;
  /** Include the stored vector on each result. Defaults to false (cheaper responses). */
  includeVectors?: boolean;
}

export interface LocalVectorEngineOptions {
  /** Fixed dimensionality every vector in this engine must have. */
  dimension: number;
  /** Optional path to a JSON index file used by `save()`/`LocalVectorEngine.load()`. */
  storagePath?: string;
}

/** On-disk / sync-wire representation of an entire engine's contents. */
export interface SerializedIndex {
  formatVersion: 1;
  dimension: number;
  createdAt: string;
  updatedAt: string;
  records: VectorRecord[];
}

/** Base class for all errors thrown by LocalVectorSync, so callers can `instanceof LocalVectorSyncError`. */
export class LocalVectorSyncError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "LocalVectorSyncError";
  }
}

/** Thrown when a vector's length doesn't match the engine's configured dimension. */
export class VectorDimensionError extends LocalVectorSyncError {
  constructor(expected: number, actual: number, recordId?: string) {
    super(
      `Vector dimension mismatch${recordId ? ` for record "${recordId}"` : ""}: expected ${expected}, got ${actual}.`
    );
    this.name = "VectorDimensionError";
  }
}

/** Thrown when a stored/synced index file is missing, unreadable, or fails schema validation. */
export class IndexIntegrityError extends LocalVectorSyncError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "IndexIntegrityError";
  }
}
