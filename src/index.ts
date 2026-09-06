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
