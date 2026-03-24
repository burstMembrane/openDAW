/**
 * Signalsmith Stretch DSP handler for real-time pitch-preserving time-stretch.
 *
 * Uses a standalone WASM binary (compiled with -sSTANDALONE_WASM=1).
 * Loaded via WASI shim identical to the Rubber Band handler pattern.
 *
 * Key advantage: process(inputN, outputN) guarantees exactly outputN frames.
 * No ring buffer needed. No underruns.
 */

import {ExternalWasmDspRegistry} from "./ExternalWasmDspHandler"
import type {AudioBuffer} from "@opendaw/lib-dsp"
import type {ExternalWasmDspHandler, ExternalWasmRawDspHandler} from "./ExternalWasmDspHandler"

const CHANNELS = 2
const MAX_BLOCK = 256

interface WasmExports {
    memory: WebAssembly.Memory
    _initialize(): void
    setBuffers(channels: number, length: number): number
    presetDefault(channels: number, sampleRate: number): void
    presetCheaper(channels: number, sampleRate: number): void
    process(inputSamples: number, outputSamples: number): void
    setTransposeSemitones(semitones: number, tonalityLimit: number): void
    setTransposeFactor(factor: number, tonalityLimit: number): void
    seek(inputSamples: number, playbackRate: number): void
    reset(): void
    inputLatency(): number
    outputLatency(): number
    malloc(size: number): number
    free(ptr: number): void
}

interface HeapRef {
    HEAPF32: Float32Array
}

class SignalsmithDspHandlerImpl implements ExternalWasmRawDspHandler {
    #exports: WasmExports | null = null
    #heapRef: HeapRef | null = null
    #ready = false
    #bufferPtr = 0
    #bufferLength = 0

    #instances = new Map<number, { active: boolean }>()
    #nextId = 0

    get ready(): boolean { return this.#ready }

    async init(wasmBinary: ArrayBuffer, sr: number): Promise<void> {
        if (this.#ready) { return }

        const heapRef: HeapRef = { HEAPF32: new Float32Array(0) }

        const wasiImports = {
            env: {
                emscripten_notify_memory_growth: () => {
                    heapRef.HEAPF32 = new Float32Array(exports.memory.buffer)
                },
            },
            wasi_snapshot_preview1: {
                proc_exit: () => 52,
                fd_read: () => 52,
                fd_write: (_fd: number, _iov: number, _iovcnt: number, pnum: number) => {
                    heapRef.HEAPF32 // touch to keep ref
                    return 0
                },
                fd_seek: () => 52,
                fd_close: () => 52,
                environ_sizes_get: () => 52,
                environ_get: () => 52,
                clock_time_get: () => 52,
                random_get: (bufPtr: number, bufLen: number) => {
                    // Fill buffer with random bytes (used by Signalsmith's random phase init).
                    // globalThis.crypto may not exist in all AudioWorklet implementations,
                    // so fall back to Math.random().
                    const buf = new Uint8Array(exports.memory.buffer, bufPtr, bufLen)
                    if (typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues) {
                        globalThis.crypto.getRandomValues(buf)
                    } else {
                        for (let i = 0; i < bufLen; i++) {
                            buf[i] = (Math.random() * 256) | 0
                        }
                    }
                    return 0
                },
            },
        }

        const module = await WebAssembly.compile(wasmBinary)
        const instance = await WebAssembly.instantiate(module, wasiImports)
        const exports = instance.exports as unknown as WasmExports

        heapRef.HEAPF32 = new Float32Array(exports.memory.buffer)
        exports._initialize()

        this.#exports = exports
        this.#heapRef = heapRef

        // Initialize stretcher
        exports.presetDefault(CHANNELS, sr)

        // Allocate shared buffers
        this.#bufferLength = MAX_BLOCK
        this.#bufferPtr = exports.setBuffers(CHANNELS, MAX_BLOCK)
        heapRef.HEAPF32 = new Float32Array(exports.memory.buffer)

        this.#ready = true
    }

    createInstance(): number {
        const id = this.#nextId++
        this.#instances.set(id, { active: true })
        return id
    }

    destroyInstance(id: number): void {
        this.#instances.delete(id)
    }

    reset(id: number): void {
        if (!this.#exports || !this.#instances.has(id)) { return }
        this.#exports.reset()
    }

    setParam(id: number, paramIndex: number, value: number): void {
        if (paramIndex !== 0 || !this.#exports || !this.#instances.has(id)) { return }
        this.#exports.setTransposeSemitones(value, 8000)
    }

    setTimeRatio(_id: number, _ratio: number): void {
        // Signalsmith uses inputN/outputN directly in process(), not a ratio parameter
    }

    process(id: number, input: AudioBuffer, output: AudioBuffer, s0: number, s1: number): void {
        // Passthrough for the effect processor (time-stretch is in the voice)
        const [inL, inR] = input.channels()
        const [outL, outR] = output.channels()
        for (let i = s0; i < s1; i++) { outL[i] = inL[i]; outR[i] = inR[i] }
    }

    processRaw(id: number,
               inputL: Float32Array, inputR: Float32Array, inputFrames: number,
               outputL: Float32Array, outputR: Float32Array, outputStart: number, outputFrames: number): number {
        if (!this.#exports || !this.#heapRef || !this.#instances.has(id)) { return 0 }

        const exports = this.#exports
        let heapF32 = this.#heapRef.HEAPF32
        const ptrF32 = this.#bufferPtr >> 2
        const len = this.#bufferLength

        // Write input: ch0 at ptrF32, ch1 at ptrF32+len
        const inN = Math.min(inputFrames, len)
        for (let i = 0; i < inN; i++) {
            heapF32[ptrF32 + i] = inputL[i]
            heapF32[ptrF32 + len + i] = inputR[i]
        }

        // Process: Signalsmith guarantees exactly outN output frames
        const outN = Math.min(outputFrames, len)
        exports.process(inN, outN)

        // Re-read heap after potential memory growth
        heapF32 = this.#heapRef.HEAPF32

        // Read output: ch0 at ptrF32 + len*2, ch1 at ptrF32 + len*3
        // (setBuffers layout: in[ch][len], out[ch][len])
        const outBase = len * CHANNELS
        for (let i = 0; i < outN; i++) {
            outputL[outputStart + i] = heapF32[ptrF32 + outBase + i]
            outputR[outputStart + i] = heapF32[ptrF32 + outBase + len + i]
        }

        return outN
    }
}

ExternalWasmDspRegistry.set("signalsmith", new SignalsmithDspHandlerImpl())
