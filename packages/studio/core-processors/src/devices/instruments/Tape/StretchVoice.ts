/**
 * StretchVoice: pitch-preserving alternative to PitchVoice.
 *
 * Uses Signalsmith Stretch for real-time time-stretching. Reads samples
 * from the file at 1.0x and calls process(inputN, outputN) which guarantees
 * exactly outputN frames — no ring buffer, no underruns.
 *
 * Falls back to PitchVoice behavior (vinyl) if the handler isn't loaded.
 */

import {int, UUID} from "@opendaw/lib-std"
import {AudioBuffer, AudioData} from "@opendaw/lib-dsp"
import {VoiceState} from "./VoiceState"
import {ExternalWasmDspRegistry} from "../../audio-effects/ExternalWasmDspHandler"
import type {ExternalWasmRawDspHandler} from "../../audio-effects/ExternalWasmDspHandler"

export class StretchVoice {
    readonly sourceUuid: UUID.Bytes
    readonly #output: AudioBuffer
    readonly #data: AudioData
    readonly #fadeLength: number

    #state: VoiceState
    #fadeDirection: number
    #readPosition: number
    #fadeProgress: number = 0.0
    #playbackRate: number
    #blockOffset: int
    #fadeOutBlockOffset: int = 0

    // Signalsmith handler
    readonly #handler: ExternalWasmRawDspHandler | null
    readonly #instanceId: number

    // Temp buffers for reading file samples
    readonly #tempL: Float32Array = new Float32Array(256)
    readonly #tempR: Float32Array = new Float32Array(256)

    constructor(sourceUuid: UUID.Bytes, output: AudioBuffer, data: AudioData, fadeLength: number, playbackRate: number,
                offset: number = 0.0, blockOffset: int = 0) {
        this.sourceUuid = sourceUuid
        this.#output = output
        this.#data = data
        this.#fadeLength = fadeLength
        this.#playbackRate = playbackRate
        this.#readPosition = offset
        this.#blockOffset = blockOffset
        if (this.#readPosition >= data.numberOfFrames) {
            this.#state = VoiceState.Done
            this.#fadeDirection = 0.0
        } else if (offset === 0) {
            this.#state = VoiceState.Active
            this.#fadeDirection = 0.0
        } else {
            this.#state = VoiceState.Fading
            this.#fadeDirection = 1.0
        }

        // Get Signalsmith Stretch handler for pitch-preserving time-stretch
        const h = ExternalWasmDspRegistry.get("signalsmith")
        if (h !== undefined && h.ready && "processRaw" in h) {
            const raw = h as ExternalWasmRawDspHandler
            const id = raw.createInstance()
            if (id >= 0) {
                raw.setParam(id, 0, 0.0)
                this.#handler = raw
                this.#instanceId = id
            } else {
                this.#handler = null
                this.#instanceId = -1
            }
        } else {
            this.#handler = null
            this.#instanceId = -1
        }
    }

    get readPosition(): number {return this.#readPosition}

    done(): boolean {return this.#state === VoiceState.Done}
    isFadingOut(): boolean {return this.#state === VoiceState.Fading && this.#fadeDirection < 0}

    startFadeOut(blockOffset: int): void {
        if (this.#state !== VoiceState.Done && !(this.#state === VoiceState.Fading && this.#fadeDirection < 0)) {
            this.#state = VoiceState.Fading
            this.#fadeDirection = -1.0
            this.#fadeProgress = 0.0
            this.#fadeOutBlockOffset = blockOffset
        }
    }

    setPlaybackRate(rate: number): void {
        this.#playbackRate = rate
    }

    process(bufferStart: int, bufferCount: int, fadingGainBuffer: Float32Array): void {
        const playbackRate = this.#playbackRate
        const useStretch = this.#handler !== null && this.#instanceId >= 0 && Math.abs(playbackRate - 1.0) > 1e-6

        if (useStretch) {
            this.#processStretched(bufferStart, bufferCount, fadingGainBuffer)
        } else {
            this.#processVinyl(bufferStart, bufferCount, fadingGainBuffer)
        }
    }

    #processStretched(bufferStart: int, bufferCount: int, fadingGainBuffer: Float32Array): void {
        const [outL, outR] = this.#output.channels()
        const {frames, numberOfFrames} = this.#data
        const framesL = frames[0]
        const framesR = frames.length === 1 ? frames[0] : frames[1]
        const playbackRate = this.#playbackRate
        const blockOffset = this.#blockOffset
        const fadeOutBlockOffset = this.#fadeOutBlockOffset
        const fadeLength = this.#fadeLength

        // Read ceil(playbackRate * bufferCount) samples at 1.0x from file
        const inputSamples = Math.min(Math.ceil(playbackRate * bufferCount), 256)
        let readPos = this.#readPosition
        for (let i = 0; i < inputSamples; i++) {
            const readInt = readPos | 0
            if (readInt >= 0 && readInt < numberOfFrames - 1) {
                const alpha = readPos - readInt
                this.#tempL[i] = framesL[readInt] + alpha * (framesL[readInt + 1] - framesL[readInt])
                this.#tempR[i] = framesR[readInt] + alpha * (framesR[readInt + 1] - framesR[readInt])
            } else {
                this.#tempL[i] = 0
                this.#tempR[i] = 0
            }
            readPos += 1.0
        }

        // Signalsmith: process(inputN, outputN) guarantees exactly outputN frames
        const written = this.#handler!.processRaw(
            this.#instanceId,
            this.#tempL, this.#tempR, inputSamples,
            outL, outR, bufferStart, bufferCount
        )

        // Apply fade envelope (additive to support overlapping voices)
        let state = this.#state as VoiceState
        let fadeDirection = this.#fadeDirection
        let fadeProgress = this.#fadeProgress
        for (let i = 0; i < bufferCount; i++) {
            if (state === VoiceState.Done) { break }
            if (i < blockOffset) { continue }
            const j = bufferStart + i
            let amplitude: number
            if (state === VoiceState.Fading && fadeDirection > 0) {
                amplitude = fadeProgress / fadeLength
                if (++fadeProgress >= fadeLength) { state = VoiceState.Active; fadeProgress = 0.0; fadeDirection = 0.0 }
            } else if (state === VoiceState.Fading && fadeDirection < 0) {
                if (i < fadeOutBlockOffset) { amplitude = 1.0 }
                else {
                    amplitude = 1.0 - fadeProgress / fadeLength
                    if (++fadeProgress >= fadeLength) { state = VoiceState.Done; break }
                }
            } else { amplitude = 1.0 }

            if (i < written) {
                // processRaw wrote directly to outL/outR — apply gain in place
                // Note: outL[j] was written by processRaw, not +=, so we need to
                // handle the additive pattern for overlapping voices
                const gain = amplitude * fadingGainBuffer[i]
                outL[j] = outL[j] * gain
                outR[j] = outR[j] * gain
            }
        }
        this.#state = state
        this.#fadeDirection = fadeDirection
        this.#fadeProgress = fadeProgress

        // Advance file position at the desired rate
        this.#readPosition += playbackRate * bufferCount

        const fadeOutThreshold = numberOfFrames - fadeLength * playbackRate
        if (this.#state === VoiceState.Active && this.#readPosition >= fadeOutThreshold) {
            this.#state = VoiceState.Fading
            this.#fadeDirection = -1.0
            this.#fadeProgress = 0.0
        }

        this.#blockOffset = 0
        this.#fadeOutBlockOffset = 0
    }

    #processVinyl(bufferStart: int, bufferCount: int, fadingGainBuffer: Float32Array): void {
        const [outL, outR] = this.#output.channels()
        const {frames, numberOfFrames} = this.#data
        const framesL = frames[0]
        const framesR = frames.length === 1 ? frames[0] : frames[1]
        const fadeLength = this.#fadeLength
        const playbackRate = this.#playbackRate
        const fadeOutThreshold = numberOfFrames - fadeLength * playbackRate
        const blockOffset = this.#blockOffset
        const fadeOutBlockOffset = this.#fadeOutBlockOffset
        let state = this.#state as VoiceState
        let fadeDirection = this.#fadeDirection
        let readPosition = this.#readPosition
        let fadeProgress = this.#fadeProgress
        for (let i = 0; i < bufferCount; i++) {
            if (state === VoiceState.Done) {break}
            if (i < blockOffset) {continue}
            const j = bufferStart + i
            let amplitude: number
            if (state === VoiceState.Fading && fadeDirection > 0) {
                amplitude = fadeProgress / fadeLength
                if (++fadeProgress >= fadeLength) { state = VoiceState.Active; fadeProgress = 0.0; fadeDirection = 0.0 }
            } else if (state === VoiceState.Fading && fadeDirection < 0) {
                if (i < fadeOutBlockOffset) { amplitude = 1.0 }
                else {
                    amplitude = 1.0 - fadeProgress / fadeLength
                    if (++fadeProgress >= fadeLength) { state = VoiceState.Done; break }
                }
            } else { amplitude = 1.0 }
            const readInt = readPosition | 0
            if (readInt >= 0 && readInt < numberOfFrames - 1) {
                const alpha = readPosition - readInt
                const sL = framesL[readInt]
                const sR = framesR[readInt]
                const finalAmplitude = amplitude * fadingGainBuffer[i]
                outL[j] += (sL + alpha * (framesL[readInt + 1] - sL)) * finalAmplitude
                outR[j] += (sR + alpha * (framesR[readInt + 1] - sR)) * finalAmplitude
            }
            readPosition += playbackRate
            if (state === VoiceState.Active && readPosition >= fadeOutThreshold) {
                state = VoiceState.Fading; fadeDirection = -1.0; fadeProgress = 0.0
            }
        }
        this.#state = state
        this.#fadeDirection = fadeDirection
        this.#readPosition = readPosition
        this.#fadeProgress = fadeProgress
        this.#blockOffset = 0
        this.#fadeOutBlockOffset = 0
    }
}
