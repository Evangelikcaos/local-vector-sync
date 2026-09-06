export { LocalVectorEngine } from "./core/engine";
export {
  IndexIntegrityError,
  LocalVectorSyncError,
  VectorDimensionError,
} from "./types";
export type {
  LocalVectorEngineOptions,
  SearchOptions,
  SearchResult,
  SerializedIndex,
  VectorMetadata,
  VectorRecord,
  VectorRecordInput,
} from "./types";

export { AwsS3Backend, S3VectorSync, decryptBuffer, encryptBuffer } from "./sync/s3";
export type { PushResult, S3Backend, S3VectorSyncOptions } from "./sync/s3";

/**
 * Reports whether the optional Rust/WASM search accelerator is available in
 * this runtime. Search always works without it (pure-TypeScript fallback);
 * this is exposed for diagnostics/telemetry only, e.g. logging at startup
 * whether the native module loaded on this platform.
 */
export { loadWasmAccel } from "./core/wasmAccel";
