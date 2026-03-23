/**
 * Generic interface for external WASM DSP handlers.
 *
 * Each handler wraps a specific WASM module (e.g. Rubber Band, a convolver, etc.)
 * and exposes a standardized API for the ExternalWasmEffectProcessor to call.
 * Handlers register themselves in the ExternalWasmDspRegistry by type name.
 */

import type {AudioBuffer} from "@opendaw/lib-dsp"

export interface ExternalWasmDspHandler {
    /** Compile and instantiate the WASM module. Called once with the binary. */
    init(wasmBinary: ArrayBuffer, sampleRate: number): Promise<void>

    /** Whether init() has completed successfully. */
    readonly ready: boolean

    /** Create a new processing instance. Returns an opaque instance ID. */
    createInstance(): number

    /** Destroy a processing instance and free its resources. */
    destroyInstance(id: number): void

    /** Reset internal state (e.g. on seek or transport stop). */
    reset(id: number): void

    /**
     * Set a parameter on an instance.
     * @param id - Instance ID from createInstance()
     * @param paramIndex - Parameter index (0-3, maps to param0..param3 on the box)
     * @param value - Parameter value (Float32)
     */
    setParam(id: number, paramIndex: number, value: number): void

    /**
     * Process audio in-place. Called once per render quantum per block.
     * @param id - Instance ID
     * @param input - Source audio buffer (read from)
     * @param output - Destination audio buffer (write to)
     * @param s0 - Start sample index within the render quantum
     * @param s1 - End sample index within the render quantum
     */
    process(id: number, input: AudioBuffer, output: AudioBuffer, s0: number, s1: number): void
}

/**
 * Registry of external WASM DSP handlers, keyed by processor type name.
 * Handlers register themselves at module load time (e.g. in RubberbandDspHandler.ts).
 */
export const ExternalWasmDspRegistry = new Map<string, ExternalWasmDspHandler>()
