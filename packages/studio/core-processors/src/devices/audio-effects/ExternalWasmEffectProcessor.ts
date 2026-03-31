/**
 * ExternalWasmEffectProcessor: generic audio effect processor that hosts
 * external WASM DSP modules.
 *
 * Overrides process() directly (not processAudio()) to feed full 128-frame
 * quanta to the DSP handler. This avoids sub-block splitting by AudioProcessor
 * which can cause Rubber Band to stutter (it needs full blocks to produce output).
 */

import {int, isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioBuffer, RenderQuantum} from "@opendaw/lib-dsp"
import {
    ExternalWasmEffectDeviceBoxAdapter,
    type EngineToClient,
} from "@opendaw/studio-adapters"
import {EngineContext} from "../../EngineContext"
import {ProcessInfo, Processor} from "../../processing"
import {AbstractProcessor} from "../../AbstractProcessor"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AutomatableParameter} from "../../AutomatableParameter"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"
import {ExternalWasmDspRegistry, type ExternalWasmDspHandler} from "./ExternalWasmDspHandler"

export class ExternalWasmEffectProcessor extends AbstractProcessor implements AudioEffectDeviceProcessor {
    static ID: int = 0 | 0

    readonly #id: int = ExternalWasmEffectProcessor.ID++
    readonly #context: EngineContext
    readonly #adapter: ExternalWasmEffectDeviceBoxAdapter

    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster

    #source: Option<AudioBuffer> = Option.None
    #handler: ExternalWasmDspHandler | null = null
    #instanceId: number = -1
    #terminated: boolean = false

    // Cached pitch semitones value (read from box field directly for zero-latency)
    #pitchSemitones: number = 0.0

    constructor(context: EngineContext, adapter: ExternalWasmEffectDeviceBoxAdapter) {
        super(context)
        this.#context = context
        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))

        this.ownAll(
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing),
            // Subscribe to param0 (pitchSemitones) field changes directly
            adapter.box.param0.catchupAndSubscribe(field => {
                this.#pitchSemitones = field.getValue()
                if (this.#handler !== null && this.#instanceId >= 0) {
                    this.#handler.setParam(this.#instanceId, 0, this.#pitchSemitones)
                }
            })
        )

        this.#initHandler()
    }

    get incoming(): Processor { return this }
    get outgoing(): Processor { return this }

    reset(): void {
        this.#output.clear()
        this.#peaks.clear()
        this.eventInput.clear()
        if (this.#handler !== null && this.#instanceId >= 0) {
            this.#handler.reset(this.#instanceId)
        }
    }

    get uuid(): UUID.Bytes { return this.#adapter.uuid }
    get audioOutput(): AudioBuffer { return this.#output }

    setAudioSource(source: AudioBuffer): Terminable {
        this.#source = Option.wrap(source)
        return {terminate: () => this.#source = Option.None}
    }

    index(): int { return this.#adapter.indexField.getValue() }
    adapter(): ExternalWasmEffectDeviceBoxAdapter { return this.#adapter }

    // Override process() directly to feed full 128-frame quanta.
    // This avoids AudioProcessor's sub-block splitting which causes
    // Rubber Band to stutter (it needs full blocks to produce output).
    process(_processInfo: ProcessInfo): void {
        if (this.#source.isEmpty()) { return }
        const input = this.#source.unwrap()
        const [inL, inR] = input.channels()
        const [outL, outR] = this.#output.channels()

        if (this.#terminated || this.#handler === null || !this.#handler.ready || this.#instanceId < 0 || this.#pitchSemitones === 0.0) {
            // Passthrough when handler not ready or no pitch shift active.
            // Bypassing WASM at zero semitones avoids overlap-add priming
            // artefacts that cause AM modulation on cold start.
            for (let i = 0; i < RenderQuantum; i++) {
                outL[i] = inL[i]
                outR[i] = inR[i]
            }
            this.#peaks.process(outL, outR)
            return
        }

        this.#handler.process(this.#instanceId, input, this.#output, 0, RenderQuantum)
        this.#peaks.process(outL, outR)
    }

    parameterChanged(_parameter: AutomatableParameter): void {
        // Parameter updates are handled via direct field subscription in constructor
    }

    terminate(): void {
        this.#terminated = true
        if (this.#handler !== null && this.#instanceId >= 0) {
            this.#handler.destroyInstance(this.#instanceId)
            this.#instanceId = -1
        }
        super.terminate()
    }

    toString(): string { return `{${this.constructor.name} (${this.#id})}` }

    #initHandler(): void {
        const processorType = this.#adapter.processorType
        const handler = ExternalWasmDspRegistry.get(processorType)
        if (!isDefined(handler)) {
            console.warn(`[ExternalWasm] No DSP handler registered for type "${processorType}"`)
            return
        }
        this.#handler = handler

        if (handler.ready) {
            this.#instanceId = handler.createInstance()
            this.#handler.setParam(this.#instanceId, 0, this.#pitchSemitones)
        } else {
            this.#context.awaitResource(
                this.#loadWasm(this.#context.engineToClient, processorType)
            )
        }
    }

    async #loadWasm(engineToClient: EngineToClient, processorType: string): Promise<void> {
        if (this.#handler === null) { return }
        try {
            const wasmBinary = await engineToClient.fetchExternalWasm(processorType)
            if (this.#terminated) { return }
            await this.#handler.init(wasmBinary, sampleRate)
            if (this.#terminated) { return }
            this.#instanceId = this.#handler.createInstance()
            this.#handler.setParam(this.#instanceId, 0, this.#pitchSemitones)
        } catch (error) {
            console.error(`[ExternalWasm] Failed to load WASM for "${processorType}":`, error)
        }
    }
}
