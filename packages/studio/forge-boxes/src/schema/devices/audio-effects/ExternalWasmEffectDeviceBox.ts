import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"

export const ExternalWasmEffectDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("ExternalWasmEffectDeviceBox", {
    10: {type: "string", name: "processorType"},
    11: {type: "float32", name: "param0", value: 0.0, constraints: "non-negative", unit: ""},
    12: {type: "float32", name: "param1", value: 0.0, constraints: "non-negative", unit: ""},
    13: {type: "float32", name: "param2", value: 0.0, constraints: "non-negative", unit: ""},
    14: {type: "float32", name: "param3", value: 0.0, constraints: "non-negative", unit: ""}
})
