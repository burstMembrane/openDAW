/**
 * Adapter for ExternalWasmEffectDeviceBox.
 * Exposes processorType + param0..param3 as named parameters for automation.
 */

import {Option, UUID, ValueMapping, StringMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {ExternalWasmEffectDeviceBox} from "./ExternalWasmEffectDeviceBox"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"

export class ExternalWasmEffectDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = ""

    readonly #context: BoxAdaptersContext
    readonly #box: ExternalWasmEffectDeviceBox
    readonly #parametric: ParameterAdapterSet
    readonly namedParameter

    constructor(context: BoxAdaptersContext, box: ExternalWasmEffectDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = {
            param0: this.#parametric.createParameter(
                box.param0, ValueMapping.linear(-48.0, 48.0),
                StringMapping.numeric({unit: "", fractionDigits: 2}), "param0"),
            param1: this.#parametric.createParameter(
                box.param1, ValueMapping.linear(0.0, 1.0),
                StringMapping.numeric({unit: "", fractionDigits: 2}), "param1"),
            param2: this.#parametric.createParameter(
                box.param2, ValueMapping.linear(0.0, 1.0),
                StringMapping.numeric({unit: "", fractionDigits: 2}), "param2"),
            param3: this.#parametric.createParameter(
                box.param3, ValueMapping.linear(0.0, 1.0),
                StringMapping.numeric({unit: "", fractionDigits: 2}), "param3"),
        } as const
    }

    get box(): ExternalWasmEffectDeviceBox { return this.#box }
    get uuid(): UUID.Bytes { return this.#box.address.uuid }
    get address(): Address { return this.#box.address }
    get indexField(): Int32Field { return this.#box.index }
    get labelField(): StringField { return this.#box.label }
    get enabledField(): BooleanField { return this.#box.enabled }
    get minimizedField(): BooleanField { return this.#box.minimized }
    get host(): PointerField<Pointers.AudioEffectHost> { return this.#box.host }

    get processorType(): string { return this.#box.processorType.getValue() }

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter { return this.deviceHost().audioUnitBoxAdapter() }

    *labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {
        this.#parametric.terminate()
    }
}
