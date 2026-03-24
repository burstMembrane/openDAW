import {MeterProcessor} from "./MeterProcessor"
import {EngineProcessor} from "./EngineProcessor"
import {RecordingProcessor} from "./RecordingProcessor"

// Side-effect import: registers Signalsmith DSP handler in ExternalWasmDspRegistry
import "./devices/audio-effects/SignalsmithDspHandler"

registerProcessor("meter-processor", MeterProcessor)
registerProcessor("engine-processor", EngineProcessor)
registerProcessor("recording-processor", RecordingProcessor)