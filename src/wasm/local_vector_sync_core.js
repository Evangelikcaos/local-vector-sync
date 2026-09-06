/* @ts-self-types="./local_vector_sync_core.d.ts" */

/**
 * Cosine similarity between two vectors of equal length.
 *
 * # Panics
 * Panics (traps in WASM) if `a.len() != b.len()`. Callers on the JS side
 * are expected to validate dimensions before calling into WASM — the same
 * invariant `LocalVectorEngine` already enforces on every write path.
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}
 */
function cosine_similarity(a, b) {
    const ptr0 = passArrayF32ToWasm0(a, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(b, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.cosine_similarity(ptr0, len0, ptr1, len1);
    return ret;
}
exports.cosine_similarity = cosine_similarity;

/**
 * Top-K cosine similarity search over a flat, row-major corpus of vectors.
 *
 * `flat_vectors` is `corpus_size * dimension` values laid out row-major
 * (record 0's `dimension` values, then record 1's, ...). `query` must have
 * exactly `dimension` values.
 *
 * Returns an interleaved flat array `[index0, score0, index1, score1, ...]`
 * of the top `top_k` matches sorted by descending score, where each index
 * is stored as an exactly-representable f32 (safe for corpora well under
 * 2^24 records, i.e. every realistic on-device corpus this targets).
 * @param {Float32Array} query
 * @param {Float32Array} flat_vectors
 * @param {number} dimension
 * @param {number} top_k
 * @returns {Float32Array}
 */
function top_k_cosine(query, flat_vectors, dimension, top_k) {
    const ptr0 = passArrayF32ToWasm0(query, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(flat_vectors, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.top_k_cosine(ptr0, len0, ptr1, len1, dimension, top_k);
    var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v3;
}
exports.top_k_cosine = top_k_cosine;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./local_vector_sync_core_bg.js": import0,
    };
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let WASM_VECTOR_LEN = 0;

const wasmPath = `${__dirname}/local_vector_sync_core_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());
let wasm = wasmInstance.exports;
wasm.__wbindgen_start();
