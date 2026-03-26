/**
 * Signalsmith Stretch DSP handler — multi-instance, real-time time-stretch.
 *
 * Each instance has its own Stretch object in WASM. Multiple tracks can
 * use separate instances without corrupting each other's state.
 *
 * process(id, inputN, outputN) guarantees exactly outputN frames.
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
    createInstance(): number
    destroyInstance(id: number): void
    setBuffers(id: number, channels: number, length: number): number
    presetDefault(id: number, channels: number, sampleRate: number): void
    reset(id: number): void
    setTransposeSemitones(id: number, semitones: number, tonalityLimit: number): void
    setTransposeFactor(id: number, factor: number, tonalityLimit: number): void
    seek(id: number, inputSamples: number, playbackRate: number): void
    process(id: number, inputSamples: number, outputSamples: number): void
    inputLatency(id: number): number
    outputLatency(id: number): number
    malloc(size: number): number
    free(ptr: number): void
}

interface HeapRef {
    HEAPF32: Float32Array
}

interface InstanceInfo {
    wasmId: number
    bufferPtr: number  // pointer to the start of the buffer block in WASM heap
    bufferLength: number
}

class SignalsmithDspHandlerImpl implements ExternalWasmRawDspHandler {
    #exports: WasmExports | null = null
    #heapRef: HeapRef | null = null
    #ready = false
    #sampleRate = 48000
    #instances = new Map<number, InstanceInfo>()
    #nextId = 0

    get ready(): boolean { return this.#ready }

    async init(wasmBinary: ArrayBuffer, sr: number): Promise<void> {
        if (this.#ready) { return }
        this.#sampleRate = sr
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
                fd_write: () => 0,
                fd_seek: () => 52,
                fd_close: () => 52,
                environ_sizes_get: () => 52,
                environ_get: () => 52,
                clock_time_get: () => 52,
                random_get: (bufPtr: number, bufLen: number) => {
                    const buf = new Uint8Array(exports.memory.buffer, bufPtr, bufLen)
                    for (let i = 0; i < bufLen; i++) { buf[i] = (Math.random() * 256) | 0 }
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
        this.#ready = true
    }

    createInstance(): number {
        if (!this.#exports || !this.#heapRef) { return -1 }
        const exports = this.#exports
        const wasmId = exports.createInstance()
        exports.presetDefault(wasmId, CHANNELS, this.#sampleRate)
        const bufferPtr = exports.setBuffers(wasmId, CHANNELS, MAX_BLOCK)
        // Re-read heap after allocation
        this.#heapRef.HEAPF32 = new Float32Array(exports.memory.buffer)
        const id = this.#nextId++
        this.#instances.set(id, { wasmId, bufferPtr, bufferLength: MAX_BLOCK })
        return id
    }

    destroyInstance(id: number): void {
        const inst = this.#instances.get(id)
        if (!inst || !this.#exports) { return }
        this.#exports.destroyInstance(inst.wasmId)
        this.#instances.delete(id)
    }

    reset(id: number): void {
        const inst = this.#instances.get(id)
        if (!inst || !this.#exports) { return }
        this.#exports.reset(inst.wasmId)
    }

    setParam(id: number, paramIndex: number, value: number): void {
        if (paramIndex !== 0) { return }
        const inst = this.#instances.get(id)
        if (!inst || !this.#exports) { return }
        this.#exports.setTransposeSemitones(inst.wasmId, value, 8000)
    }

    setTimeRatio(_id: number, _ratio: number): void {
        // Signalsmith uses inputN/outputN directly, not a ratio parameter
    }

    process(id: number, input: AudioBuffer, output: AudioBuffer, s0: number, s1: number): void {
        const [inL, inR] = input.channels()
        const [outL, outR] = output.channels()
        const inst = this.#instances.get(id)
        if (!inst || !this.#exports || !this.#heapRef) {
            for (let i = s0; i < s1; i++) { outL[i] = inL[i]; outR[i] = inR[i] }
            return
        }
        const exports = this.#exports
        let heapF32 = this.#heapRef.HEAPF32
        const ptrF32 = inst.bufferPtr >> 2
        const len = inst.bufferLength
        const frameCount = Math.min(s1 - s0, len)
        for (let i = 0; i < frameCount; i++) {
            heapF32[ptrF32 + i] = inL[s0 + i]
            heapF32[ptrF32 + len + i] = inR[s0 + i]
        }
        exports.process(inst.wasmId, frameCount, frameCount)
        heapF32 = this.#heapRef.HEAPF32
        const outBase = len * CHANNELS
        for (let i = 0; i < frameCount; i++) {
            outL[s0 + i] = heapF32[ptrF32 + outBase + i]
            outR[s0 + i] = heapF32[ptrF32 + outBase + len + i]
        }
    }

    processRaw(id: number,
               inputL: Float32Array, inputR: Float32Array, inputFrames: number,
               outputL: Float32Array, outputR: Float32Array, outputStart: number, outputFrames: number): number {
        const inst = this.#instances.get(id)
        if (!inst || !this.#exports || !this.#heapRef) { return 0 }
        const exports = this.#exports
        let heapF32 = this.#heapRef.HEAPF32
        const ptrF32 = inst.bufferPtr >> 2
        const len = inst.bufferLength
        // Write input: ch0 at ptrF32, ch1 at ptrF32+len
        const inN = Math.min(inputFrames, len)
        for (let i = 0; i < inN; i++) {
            heapF32[ptrF32 + i] = inputL[i]
            heapF32[ptrF32 + len + i] = inputR[i]
        }
        // Process — each instance has its own stretcher
        const outN = Math.min(outputFrames, len)
        exports.process(inst.wasmId, inN, outN)
        // Re-read heap
        heapF32 = this.#heapRef.HEAPF32
        // Read output: ch0 at ptrF32 + len*2, ch1 at ptrF32 + len*3
        const outBase = len * CHANNELS
        for (let i = 0; i < outN; i++) {
            outputL[outputStart + i] = heapF32[ptrF32 + outBase + i]
            outputR[outputStart + i] = heapF32[ptrF32 + outBase + len + i]
        }
        return outN
    }
}

ExternalWasmDspRegistry.set("signalsmith", new SignalsmithDspHandlerImpl())
