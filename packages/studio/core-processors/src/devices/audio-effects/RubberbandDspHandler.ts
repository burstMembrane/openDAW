/**
 * Rubber Band DSP handler for the ExternalWasmEffectProcessor system.
 *
 * Wraps rubberband-wasm (Daninet) with a WASI shim for AudioWorklet context.
 * Provides pitch-preserving correction for vinyl-style BPM rate changes.
 *
 * Uses a per-instance ring buffer to smooth out Rubber Band's variable
 * output (it doesn't produce exactly N frames per N input frames).
 *
 * param0 = pitchSemitones (0 = no correction)
 */

import type {AudioBuffer} from "@opendaw/lib-dsp"
import {ExternalWasmDspRegistry, type ExternalWasmDspHandler} from "./ExternalWasmDspHandler"

const RB_OPTION_REALTIME = 0x00000001
const RB_OPTION_THREADING_NEVER = 0x00010000
const RB_OPTION_ENGINE_FINER = 0x20000000
const RB_OPTIONS = RB_OPTION_REALTIME | RB_OPTION_THREADING_NEVER | RB_OPTION_ENGINE_FINER

const CHANNELS = 2
const BLOCK_SIZE = 128
const RING_SIZE = 1024 // Power of 2, per-channel frames
const RING_MASK = RING_SIZE - 1
const MAX_RETRIEVE = 512

interface RbInstance {
    state: number
    inPtrArray: number
    outPtrArray: number
    channelInPtrs: [number, number]
    channelOutPtrs: [number, number]
    lastPitchScale: number
    // Per-instance ring buffers (per-channel)
    ringL: Float32Array
    ringR: Float32Array
    ringRead: number
    ringWrite: number
}

interface WasmExports {
    memory: WebAssembly.Memory
    _initialize(): void
    wasm_malloc(size: number): number
    wasm_free(ptr: number): void
    rb_new(sampleRate: number, channels: number, options: number, timeRatio: number, pitchScale: number): number
    rb_delete(state: number): void
    rb_reset(state: number): void
    rb_set_pitch_scale(state: number, scale: number): void
    rb_set_max_process_size(state: number, samples: number): void
    rb_get_preferred_start_pad(state: number): number
    rb_process(state: number, input: number, samples: number, isFinal: number): void
    rb_available(state: number): number
    rb_retrieve(state: number, output: number, samples: number): number
}

interface HeapRef {
    HEAP8: Uint8Array
    HEAP32: Uint32Array
    HEAPF32: Float32Array
}

class RubberbandDspHandlerImpl implements ExternalWasmDspHandler {
    #exports: WasmExports | null = null
    #heapRef: HeapRef | null = null
    #instances: Map<number, RbInstance> = new Map()
    #nextId = 0
    #ready = false
    #sampleRate = 48000

    get ready(): boolean { return this.#ready }

    async init(wasmBinary: ArrayBuffer, sr: number): Promise<void> {
        if (this.#ready) { return }
        this.#sampleRate = sr

        const heapRef: HeapRef = {
            HEAP8: new Uint8Array(0),
            HEAP32: new Uint32Array(0),
            HEAPF32: new Float32Array(0),
        }

        const wasiImports = {
            env: {
                emscripten_notify_memory_growth: () => {
                    heapRef.HEAP8 = new Uint8Array(exports.memory.buffer)
                    heapRef.HEAP32 = new Uint32Array(exports.memory.buffer)
                    heapRef.HEAPF32 = new Float32Array(exports.memory.buffer)
                },
            },
            wasi_snapshot_preview1: {
                proc_exit: () => 52,
                fd_read: () => 52,
                fd_write: (_fd: number, _iov: number, _iovcnt: number, pnum: number) => {
                    heapRef.HEAP32[pnum >> 2] = 0
                    return 0
                },
                fd_seek: () => 52,
                fd_close: () => 52,
                environ_sizes_get: () => 52,
                environ_get: () => 52,
                clock_time_get: () => 52,
            },
        }

        const module = await WebAssembly.compile(wasmBinary)
        const instance = await WebAssembly.instantiate(module, wasiImports)
        const exports = instance.exports as unknown as WasmExports

        heapRef.HEAP8 = new Uint8Array(exports.memory.buffer)
        heapRef.HEAP32 = new Uint32Array(exports.memory.buffer)
        heapRef.HEAPF32 = new Float32Array(exports.memory.buffer)

        exports._initialize()

        this.#exports = exports
        this.#heapRef = heapRef
        this.#ready = true
    }

    createInstance(): number {
        if (!this.#exports || !this.#heapRef) { return -1 }
        const exports = this.#exports
        const heapRef = this.#heapRef

        const state = exports.rb_new(this.#sampleRate, CHANNELS, RB_OPTIONS, 1.0, 1.0)
        exports.rb_set_max_process_size(state, BLOCK_SIZE)

        const channelInPtrs: [number, number] = [
            exports.wasm_malloc(BLOCK_SIZE * 4),
            exports.wasm_malloc(BLOCK_SIZE * 4),
        ]
        const channelOutPtrs: [number, number] = [
            exports.wasm_malloc(MAX_RETRIEVE * 4),
            exports.wasm_malloc(MAX_RETRIEVE * 4),
        ]
        const inPtrArray = exports.wasm_malloc(CHANNELS * 4)
        const outPtrArray = exports.wasm_malloc(CHANNELS * 4)

        heapRef.HEAP32[inPtrArray >> 2] = channelInPtrs[0]
        heapRef.HEAP32[(inPtrArray >> 2) + 1] = channelInPtrs[1]
        heapRef.HEAP32[outPtrArray >> 2] = channelOutPtrs[0]
        heapRef.HEAP32[(outPtrArray >> 2) + 1] = channelOutPtrs[1]

        const inst: RbInstance = {
            state, inPtrArray, outPtrArray, channelInPtrs, channelOutPtrs,
            lastPitchScale: 1.0,
            ringL: new Float32Array(RING_SIZE),
            ringR: new Float32Array(RING_SIZE),
            ringRead: 0,
            ringWrite: 0,
        }

        // Feed startup pad and pre-fill ring
        this.#feedStartupPad(exports, heapRef, inst)

        const id = this.#nextId++
        this.#instances.set(id, inst)
        return id
    }

    destroyInstance(id: number): void {
        const inst = this.#instances.get(id)
        if (!inst || !this.#exports) { return }
        this.#exports.rb_delete(inst.state)
        this.#exports.wasm_free(inst.channelInPtrs[0])
        this.#exports.wasm_free(inst.channelInPtrs[1])
        this.#exports.wasm_free(inst.channelOutPtrs[0])
        this.#exports.wasm_free(inst.channelOutPtrs[1])
        this.#exports.wasm_free(inst.inPtrArray)
        this.#exports.wasm_free(inst.outPtrArray)
        this.#instances.delete(id)
    }

    reset(id: number): void {
        const inst = this.#instances.get(id)
        if (!inst || !this.#exports || !this.#heapRef) { return }
        this.#exports.rb_reset(inst.state)
        inst.ringRead = 0
        inst.ringWrite = 0
        this.#feedStartupPad(this.#exports, this.#heapRef, inst)
    }

    setParam(id: number, paramIndex: number, value: number): void {
        if (paramIndex !== 0) { return }
        const inst = this.#instances.get(id)
        if (!inst || !this.#exports) { return }
        const scale = Math.pow(2, value / 12)
        if (Math.abs(scale - inst.lastPitchScale) > 1e-7) {
            this.#exports.rb_set_pitch_scale(inst.state, scale)
            inst.lastPitchScale = scale
        }
    }

    process(id: number, input: AudioBuffer, output: AudioBuffer, s0: number, s1: number): void {
        const inst = this.#instances.get(id)
        if (!inst || !this.#exports || !this.#heapRef) {
            const [inL, inR] = input.channels()
            const [outL, outR] = output.channels()
            for (let i = s0; i < s1; i++) { outL[i] = inL[i]; outR[i] = inR[i] }
            return
        }

        // Passthrough at unity pitch (no correction needed)
        if (Math.abs(inst.lastPitchScale - 1.0) < 1e-7) {
            const [inL, inR] = input.channels()
            const [outL, outR] = output.channels()
            for (let i = s0; i < s1; i++) { outL[i] = inL[i]; outR[i] = inR[i] }
            return
        }

        const exports = this.#exports
        const heapRef = this.#heapRef
        const numFrames = s1 - s0
        const [inL, inR] = input.channels()
        const [outL, outR] = output.channels()

        // 1. Copy input to WASM heap
        let heapF32 = heapRef.HEAPF32
        const ch0In = inst.channelInPtrs[0] >> 2
        const ch1In = inst.channelInPtrs[1] >> 2
        for (let i = 0; i < numFrames; i++) {
            heapF32[ch0In + i] = inL[s0 + i]
            heapF32[ch1In + i] = inR[s0 + i]
        }

        // 2. Process through Rubber Band
        exports.rb_process(inst.state, inst.inPtrArray, numFrames, 0)
        heapF32 = heapRef.HEAPF32

        // 3. Push all available output into ring buffer
        const available = exports.rb_available(inst.state)
        if (available > 0) {
            const toRetrieve = Math.min(available, MAX_RETRIEVE)
            const retrieved = exports.rb_retrieve(inst.state, inst.outPtrArray, toRetrieve)
            heapF32 = heapRef.HEAPF32
            if (retrieved > 0) {
                const ch0Out = inst.channelOutPtrs[0] >> 2
                const ch1Out = inst.channelOutPtrs[1] >> 2
                for (let j = 0; j < retrieved; j++) {
                    inst.ringL[inst.ringWrite] = heapF32[ch0Out + j]
                    inst.ringR[inst.ringWrite] = heapF32[ch1Out + j]
                    inst.ringWrite = (inst.ringWrite + 1) & RING_MASK
                }
            }
        }

        // 4. Read from ring buffer into output
        let ringAvail = (inst.ringWrite - inst.ringRead + RING_SIZE) & RING_MASK
        for (let k = 0; k < numFrames; k++) {
            if (ringAvail > 0) {
                outL[s0 + k] = inst.ringL[inst.ringRead]
                outR[s0 + k] = inst.ringR[inst.ringRead]
                inst.ringRead = (inst.ringRead + 1) & RING_MASK
                ringAvail--
            } else {
                // Underrun: use input as fallback (less jarring than silence)
                outL[s0 + k] = inL[s0 + k]
                outR[s0 + k] = inR[s0 + k]
            }
        }
    }

    #feedStartupPad(exports: WasmExports, heapRef: HeapRef, inst: RbInstance): void {
        const padFrames = exports.rb_get_preferred_start_pad(inst.state)
        if (padFrames <= 0) { return }

        // Zero input buffers
        const ch0 = inst.channelInPtrs[0] >> 2
        const ch1 = inst.channelInPtrs[1] >> 2
        for (let i = 0; i < BLOCK_SIZE; i++) {
            heapRef.HEAPF32[ch0 + i] = 0
            heapRef.HEAPF32[ch1 + i] = 0
        }

        // Feed silence to prime Rubber Band
        let fed = 0
        while (fed < padFrames) {
            const toFeed = Math.min(BLOCK_SIZE, padFrames - fed)
            exports.rb_process(inst.state, inst.inPtrArray, toFeed, 0)
            fed += toFeed
            const avail = exports.rb_available(inst.state)
            if (avail > 0) {
                exports.rb_retrieve(inst.state, inst.outPtrArray, avail)
            }
        }

        // Pre-fill ring with ~256 frames of silence-processed output
        let prefilled = 0
        while (prefilled < 256) {
            const block = Math.min(BLOCK_SIZE, 256 - prefilled)
            exports.rb_process(inst.state, inst.inPtrArray, block, 0)
            let hf = heapRef.HEAPF32
            const pavail = exports.rb_available(inst.state)
            if (pavail > 0) {
                const got = exports.rb_retrieve(inst.state, inst.outPtrArray, pavail)
                hf = heapRef.HEAPF32
                const outL = inst.channelOutPtrs[0] >> 2
                const outR = inst.channelOutPtrs[1] >> 2
                for (let p = 0; p < got; p++) {
                    inst.ringL[inst.ringWrite] = hf[outL + p]
                    inst.ringR[inst.ringWrite] = hf[outR + p]
                    inst.ringWrite = (inst.ringWrite + 1) & RING_MASK
                }
                prefilled += got
            } else {
                prefilled += block
            }
        }
    }
}

ExternalWasmDspRegistry.set("rubberband", new RubberbandDspHandlerImpl())
