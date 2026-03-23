import {MeterProcessor} from "./MeterProcessor"
import {EngineProcessor} from "./EngineProcessor"
import {RecordingProcessor} from "./RecordingProcessor"

// Side-effect import: registers DSP handlers in ExternalWasmDspRegistry
import "./devices/audio-effects/RubberbandDspHandler"

registerProcessor("meter-processor", MeterProcessor)
registerProcessor("engine-processor", EngineProcessor)
registerProcessor("recording-processor", RecordingProcessor)