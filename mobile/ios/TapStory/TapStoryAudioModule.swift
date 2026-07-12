import AVFoundation
import Foundation
import React

@objc(TapStoryAudio)
class TapStoryAudioModule: RCTEventEmitter {
    private var audioEngine: AudioEngineIOS?
    private var hasListeners = false
    private var rawRecordingFile: URL?
    private var audioSessionObservers: [NSObjectProtocol] = []
    private let audioControlQueue = DispatchQueue(label: "com.tapstory.audio.module-control")
    private let invalidationScheduleLock = NSLock()
    private var engineGeneration: UInt64 = 0
    private var scheduledInvalidationGeneration: UInt64?

    override var methodQueue: DispatchQueue! {
        audioControlQueue
    }

    deinit {
        stopAudioSessionObservers()
        tearDownEngine()
    }

    override func invalidate() {
        stopAudioSessionObservers()
        tearDownEngine()
        super.invalidate()
    }

    override func supportedEvents() -> [String]! {
        ["onRecordingStarted", "onPositionUpdate", "onPlaybackComplete"]
    }

    override func startObserving() {
        hasListeners = true
    }

    override func stopObserving() {
        hasListeners = false
    }

    override static func requiresMainQueueSetup() -> Bool {
        false
    }

    @objc
    func initialize(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        // Explicit initialization is also the recovery transition after a
        // route change or media-service reset. Never reuse an invalid graph.
        stopAudioSessionObservers()
        tearDownEngine()
        let engine = AudioEngineIOS()
        audioEngine = engine

        do {
            try engine.initialize()
        } catch {
            engine.cleanup()
            audioEngine = nil
            reject(
                "INIT_ERROR",
                "Failed to initialize audio engine: \(error.localizedDescription)",
                error
            )
            return
        }

        print("[TapStoryAudio] Initialized RemoteIO at \(engine.sampleRate())Hz")
        startAudioSessionObservers()
        resolve(nil)
    }

    @objc
    func loadTracks(
        _ tracks: [[String: Any]],
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let engine = audioEngine else {
            reject("NOT_INITIALIZED", "Audio engine not initialized", nil)
            return
        }

        let targetSampleRate = engine.sampleRate()
        guard targetSampleRate > 0 else {
            reject("INVALID_SAMPLE_RATE", "Audio route has no active sample rate", nil)
            return
        }

        engine.stop()
        engine.clearTracks()

        do {
            for track in tracks {
                guard let id = track["id"] as? String,
                      let uri = track["uri"] as? String,
                      let startTimeMs = track["startTimeMs"] as? Double else {
                    throw ModuleError.invalidTrack
                }

                let pcm = try decodeAudioFile(uri: uri, targetSampleRate: targetSampleRate)
                let startFrame = Int32((startTimeMs * targetSampleRate / 1000).rounded())
                pcm.withUnsafeBufferPointer { buffer in
                    guard let baseAddress = buffer.baseAddress else { return }
                    engine.loadTrack(
                        withId: id,
                        data: baseAddress,
                        numSamples: Int32(pcm.count),
                        startFrame: startFrame
                    )
                }
            }
            resolve(nil)
        } catch {
            engine.clearTracks()
            reject("TRACK_DECODE_ERROR", error.localizedDescription, error)
        }
    }

    @objc
    func play(
        _ playFromMs: Double,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let engine = audioEngine else {
            reject("NOT_INITIALIZED", "Audio engine not initialized", nil)
            return
        }

        let frame = Int64((playFromMs * engine.sampleRate() / 1000).rounded())
        engine.stop()
        engine.seek(toFrame: frame)
        do {
            try engine.start()
            resolve(nil)
        } catch {
            reject(
                "PLAY_START_ERROR",
                "Failed to start RemoteIO: \(error.localizedDescription)",
                error
            )
        }
    }

    @objc
    func playAndRecord(
        _ playFromMs: Double,
        recordStartMs: Double,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let engine = audioEngine else {
            reject("NOT_INITIALIZED", "Audio engine not initialized", nil)
            return
        }

        let unsupportedPorts = unsupportedSynchronizedPorts(
            in: AVAudioSession.sharedInstance().currentRoute
        )
        guard unsupportedPorts.isEmpty else {
            let routeNames = unsupportedPorts
                .map { "\($0.portName) (\($0.portType.rawValue))" }
                .joined(separator: ", ")
            reject(
                "UNSUPPORTED_SYNC_ROUTE",
                "Synchronized play-and-record requires a wired or built-in audio route; unsupported route: \(routeNames)",
                nil
            )
            return
        }

        let sampleRate = engine.sampleRate()
        let playFrame = Int64((playFromMs * sampleRate / 1000).rounded())
        let requestedRecordFrame = Int64((recordStartMs * sampleRate / 1000).rounded())
        let captureFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("tapstory-recording-\(UUID().uuidString).pcm")
        rawRecordingFile = captureFile

        engine.recordingStartedHandler = { [weak self, weak engine] actualFrame in
            guard let self, let engine else { return }
            let diagnostics = engine.getLatencyInfo()
            let actualStartMs = Double(actualFrame) * 1000 / engine.sampleRate()
            let alignedStartMs = Double(engine.recordingStartFrame()) * 1000 / engine.sampleRate()

            DispatchQueue.main.async {
                guard self.hasListeners else { return }
                self.sendEvent(
                    withName: "onRecordingStarted",
                    body: [
                        "actualStartMs": actualStartMs,
                        "alignedStartMs": alignedStartMs,
                        "diagnostics": diagnostics,
                    ]
                )
            }
        }

        engine.stop()
        engine.seek(toFrame: playFrame)
        do {
            try engine.startRecording(
                toPath: captureFile.path,
                startFrame: requestedRecordFrame
            )
        } catch {
            engine.recordingStartedHandler = nil
            discardRawRecording()
            reject(
                "RECORD_START_ERROR",
                "Failed to arm recording: \(error.localizedDescription)",
                error
            )
            return
        }

        do {
            try engine.start()
            resolve(nil)
        } catch {
            engine.stopRecording()
            engine.recordingStartedHandler = nil
            discardRawRecording()
            reject(
                "PLAY_RECORD_START_ERROR",
                "Failed to start synchronized capture: \(error.localizedDescription)",
                error
            )
        }
    }

    @objc
    func getCurrentPositionMs(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let engine = audioEngine, engine.sampleRate() > 0 else {
            resolve(0.0)
            return
        }
        resolve(Double(engine.currentFrame()) * 1000 / engine.sampleRate())
    }

    @objc
    func stop(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        // Stopping transport intentionally does not destroy capture metadata or
        // the writer. stopRecording can still drain and finalize it afterward.
        audioEngine?.stop()
        resolve(nil)
    }

    @objc
    func stopRecording(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let engine = audioEngine else {
            reject("NOT_INITIALIZED", "Audio engine not initialized", nil)
            return
        }

        engine.stopRecording()
        engine.recordingStartedHandler = nil

        guard let rawFile = rawRecordingFile else {
            reject("NO_RECORDING", "No recording file", nil)
            return
        }

        let actualStartFrame = engine.actualRecordingStartFrame()
        let captureEndFrame = engine.recordingTimelineEndFrame()
        let sampleCount = engine.recordedSampleCount()
        let overflowFrames = engine.recordingOverflowFrameCount()
        let inputErrors = engine.recordingInputErrorCount()
        let timelineDiscontinuities = engine.recordingTimelineDiscontinuityCount()
        let routeInvalidated = engine.recordingRouteInvalidated()
        let expectedFrames = actualStartFrame >= 0 && captureEndFrame >= actualStartFrame
            ? captureEndFrame - actualStartFrame
            : 0

        guard !routeInvalidated else {
            discardRawRecording()
            reject(
                "CAPTURE_ROUTE_CHANGED",
                "The audio route changed or was interrupted; the take was discarded",
                nil
            )
            return
        }
        guard timelineDiscontinuities == 0 else {
            discardRawRecording()
            reject(
                "CAPTURE_TIMELINE_DISCONTINUITY",
                "RemoteIO timeline jumped \(timelineDiscontinuities) times; the take was discarded",
                nil
            )
            return
        }
        guard actualStartFrame >= 0, sampleCount > 0 else {
            discardRawRecording()
            reject("NO_RECORDING", "No microphone frames reached the capture gate", nil)
            return
        }
        guard overflowFrames == 0 else {
            discardRawRecording()
            reject(
                "CAPTURE_OVERFLOW",
                "Capture ring overflowed by \(overflowFrames) frames; recording was not saved",
                nil
            )
            return
        }
        guard inputErrors == 0 else {
            discardRawRecording()
            reject(
                "CAPTURE_INPUT_ERROR",
                "RemoteIO input failed for \(inputErrors) render callbacks",
                nil
            )
            return
        }
        guard !engine.recordingWriteFailed() else {
            discardRawRecording()
            reject("CAPTURE_WRITE_ERROR", "Background PCM writer failed", nil)
            return
        }
        guard sampleCount == expectedFrames else {
            discardRawRecording()
            reject(
                "CAPTURE_SPAN_MISMATCH",
                "Captured \(sampleCount) PCM frames for a \(expectedFrames)-frame timeline span",
                nil
            )
            return
        }

        var partialWavFile: URL?
        do {
            let expectedBytes = sampleCount * Int64(MemoryLayout<Int16>.size)
            let attributes = try FileManager.default.attributesOfItem(atPath: rawFile.path)
            let rawBytes = (attributes[.size] as? NSNumber)?.int64Value ?? -1
            guard rawBytes == expectedBytes else {
                throw ModuleError.rawFileSize(expected: expectedBytes, actual: rawBytes)
            }

            let wavFile = FileManager.default.temporaryDirectory
                .appendingPathComponent("tapstory-recording-\(UUID().uuidString).wav")
            partialWavFile = wavFile
            try convertRawToWav(
                rawFile: rawFile,
                wavFile: wavFile,
                sampleCount: sampleCount,
                sampleRate: engine.sampleRate()
            )
            discardRawRecording()

            let alignedStartFrame = engine.recordingStartFrame()
            let sampleRate = engine.sampleRate()
            let startTimeMs = Double(alignedStartFrame) * 1000 / sampleRate
            let durationMs = Double(sampleCount) * 1000 / sampleRate
            resolve([
                "uri": "file://\(wavFile.path)",
                "startTimeMs": startTimeMs,
                "durationMs": durationMs,
                "actualCaptureStartMs": Double(actualStartFrame) * 1000 / sampleRate,
                "captureTimelineEndMs": Double(captureEndFrame) * 1000 / sampleRate,
                "sampleRate": sampleRate,
                "overflowFrames": overflowFrames,
                "diagnostics": engine.getLatencyInfo(),
            ])
        } catch {
            discardRawRecording()
            if let partialWavFile {
                try? FileManager.default.removeItem(at: partialWavFile)
            }
            reject("CONVERSION_ERROR", error.localizedDescription, error)
        }
    }

    @objc
    func getLatencyInfo(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        if let engine = audioEngine {
            resolve(engine.getLatencyInfo())
            return
        }

        let session = AVAudioSession.sharedInstance()
        resolve([
            "inputLatencyMs": session.inputLatency * 1000,
            "outputLatencyMs": session.outputLatency * 1000,
            "roundTripLatencyMs": (session.inputLatency + session.outputLatency) * 1000,
            "bufferDurationMs": session.ioBufferDuration * 1000,
            "sampleRate": session.sampleRate,
        ])
    }

    @objc
    func setLatencyCompensationMs(
        _ milliseconds: Double,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard milliseconds.isFinite, milliseconds >= 0 else {
            reject(
                "INVALID_LATENCY_COMPENSATION",
                "Latency compensation must be zero (automatic) or a positive number of milliseconds",
                nil
            )
            return
        }
        guard let engine = audioEngine else {
            reject("NOT_INITIALIZED", "Audio engine not initialized", nil)
            return
        }

        engine.setLatencyCompensationMs(milliseconds)
        resolve(nil)
    }

    @objc
    func cleanup(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        stopAudioSessionObservers()
        tearDownEngine()
        resolve(nil)
    }

    private func tearDownEngine() {
        audioEngine?.cleanup()
        audioEngine = nil
        engineGeneration &+= 1
        discardRawRecording()
    }

    private func discardRawRecording() {
        if let rawRecordingFile {
            try? FileManager.default.removeItem(at: rawRecordingFile)
        }
        rawRecordingFile = nil
    }

    private func startAudioSessionObservers() {
        stopAudioSessionObservers()
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        let observedGeneration = engineGeneration
        let names: [Notification.Name] = [
            AVAudioSession.routeChangeNotification,
            AVAudioSession.interruptionNotification,
            AVAudioSession.mediaServicesWereLostNotification,
            AVAudioSession.mediaServicesWereResetNotification,
        ]
        audioSessionObservers = names.map { name in
            center.addObserver(forName: name, object: session, queue: nil) { [weak self] _ in
                self?.scheduleAudioSessionInvalidation(for: observedGeneration)
            }
        }
    }

    private func stopAudioSessionObservers() {
        for observer in audioSessionObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        audioSessionObservers.removeAll()
    }

    private func scheduleAudioSessionInvalidation(for generation: UInt64) {
        invalidationScheduleLock.lock()
        guard scheduledInvalidationGeneration != generation else {
            invalidationScheduleLock.unlock()
            return
        }
        scheduledInvalidationGeneration = generation
        invalidationScheduleLock.unlock()

        audioControlQueue.async { [weak self] in
            guard let self else { return }
            if self.engineGeneration == generation {
                self.invalidateAudioSessionOnControlQueue()
            }
            self.invalidationScheduleLock.lock()
            if self.scheduledInvalidationGeneration == generation {
                self.scheduledInvalidationGeneration = nil
            }
            self.invalidationScheduleLock.unlock()
        }
    }

    private func invalidateAudioSessionOnControlQueue() {
        guard let engine = audioEngine else { return }
        engine.invalidateAudioRoute()
        engine.stop()
        engine.stopRecording()
    }

    private func decodeAudioFile(uri: String, targetSampleRate: Double) throws -> [Int16] {
        let url = try localAudioFileURL(from: uri)

        let audioFile = try AVAudioFile(forReading: url)
        let inputFormat = audioFile.processingFormat
        let inputCapacity = AVAudioFrameCount(audioFile.length)
        guard let inputBuffer = AVAudioPCMBuffer(
            pcmFormat: inputFormat,
            frameCapacity: inputCapacity
        ) else {
            throw ModuleError.bufferAllocation
        }
        try audioFile.read(into: inputBuffer)

        guard let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: targetSampleRate,
            channels: 1,
            interleaved: false
        ), let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
            throw ModuleError.converterCreation
        }

        converter.sampleRateConverterQuality = AVAudioQuality.max.rawValue
        let rateRatio = targetSampleRate / inputFormat.sampleRate
        let outputCapacity = AVAudioFrameCount(
            ceil(Double(inputBuffer.frameLength) * rateRatio) + 32
        )
        guard let outputBuffer = AVAudioPCMBuffer(
            pcmFormat: outputFormat,
            frameCapacity: outputCapacity
        ) else {
            throw ModuleError.bufferAllocation
        }

        var suppliedInput = false
        var conversionError: NSError?
        let status = converter.convert(to: outputBuffer, error: &conversionError) {
            _, inputStatus in
            if suppliedInput {
                inputStatus.pointee = .endOfStream
                return nil
            }
            suppliedInput = true
            inputStatus.pointee = .haveData
            return inputBuffer
        }
        if status == .error {
            throw conversionError ?? ModuleError.conversion
        }

        guard let channel = outputBuffer.floatChannelData?[0] else {
            throw ModuleError.conversion
        }
        return (0..<Int(outputBuffer.frameLength)).map { frame in
            let sample = channel[frame].isFinite ? channel[frame] : 0
            let scaled = Int((sample * 32767).rounded())
            return Int16(max(Int(Int16.min), min(Int(Int16.max), scaled)))
        }
    }

    private func localAudioFileURL(from uri: String) throws -> URL {
        guard !uri.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ModuleError.emptyAudioURI
        }

        let url: URL
        if uri.hasPrefix("/") {
            // Retain compatibility with callers that supply an explicit
            // absolute sandbox path instead of a file URL.
            url = URL(fileURLWithPath: uri).standardizedFileURL
        } else {
            guard let parsed = URL(string: uri), parsed.isFileURL else {
                throw ModuleError.unsupportedAudioURI
            }
            url = parsed.standardizedFileURL
        }

        let path = url.path
        guard !path.isEmpty else {
            throw ModuleError.emptyAudioURI
        }

        var isDirectory = ObjCBool(false)
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else {
            throw ModuleError.fileNotFound(path)
        }
        guard !isDirectory.boolValue,
              (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else {
            throw ModuleError.notRegularAudioFile(path)
        }

        return url
    }

    private func unsupportedSynchronizedPorts(
        in route: AVAudioSessionRouteDescription
    ) -> [AVAudioSessionPortDescription] {
        (route.inputs + route.outputs).filter { port in
            switch port.portType {
            case .airPlay, .bluetoothA2DP, .bluetoothHFP, .bluetoothLE:
                return true
            default:
                return false
            }
        }
    }

    private func convertRawToWav(
        rawFile: URL,
        wavFile: URL,
        sampleCount: Int64,
        sampleRate: Double
    ) throws {
        let bytesPerSample: UInt32 = UInt32(MemoryLayout<Int16>.size)
        let dataSize64 = sampleCount * Int64(bytesPerSample)
        guard dataSize64 >= 0, dataSize64 <= Int64(UInt32.max - 36) else {
            throw ModuleError.recordingTooLarge
        }

        let dataSize = UInt32(dataSize64)
        let integerSampleRate = UInt32(sampleRate.rounded())
        var header = Data()
        header.append("RIFF".data(using: .ascii)!)
        header.appendLittleEndian(UInt32(36) + dataSize)
        header.append("WAVE".data(using: .ascii)!)
        header.append("fmt ".data(using: .ascii)!)
        header.appendLittleEndian(UInt32(16))
        header.appendLittleEndian(UInt16(1))
        header.appendLittleEndian(UInt16(1))
        header.appendLittleEndian(integerSampleRate)
        header.appendLittleEndian(integerSampleRate * bytesPerSample)
        header.appendLittleEndian(UInt16(bytesPerSample))
        header.appendLittleEndian(UInt16(bytesPerSample * 8))
        header.append("data".data(using: .ascii)!)
        header.appendLittleEndian(dataSize)

        _ = FileManager.default.createFile(atPath: wavFile.path, contents: nil)
        let input = try FileHandle(forReadingFrom: rawFile)
        let output = try FileHandle(forWritingTo: wavFile)
        defer {
            try? input.close()
            try? output.close()
        }

        try output.write(contentsOf: header)
        while let chunk = try input.read(upToCount: 64 * 1024), !chunk.isEmpty {
            try output.write(contentsOf: chunk)
        }
        try output.synchronize()
    }
}

private enum ModuleError: LocalizedError {
    case invalidTrack
    case emptyAudioURI
    case unsupportedAudioURI
    case fileNotFound(String)
    case notRegularAudioFile(String)
    case bufferAllocation
    case converterCreation
    case conversion
    case rawFileSize(expected: Int64, actual: Int64)
    case recordingTooLarge

    var errorDescription: String? {
        switch self {
        case .invalidTrack:
            return "Invalid track metadata"
        case .emptyAudioURI:
            return "Audio track has no local file URI"
        case .unsupportedAudioURI:
            return "Audio tracks must use a file:// URI or an absolute local path"
        case .fileNotFound(let path):
            return "Audio file not found: \(path)"
        case .notRegularAudioFile(let path):
            return "Audio track is not a regular file: \(path)"
        case .bufferAllocation:
            return "Unable to allocate an audio conversion buffer"
        case .converterCreation:
            return "Unable to create the audio sample-rate converter"
        case .conversion:
            return "Audio conversion failed"
        case .rawFileSize(let expected, let actual):
            return "Raw capture contains \(actual) bytes; expected \(expected)"
        case .recordingTooLarge:
            return "Recording is too large for a PCM WAV file"
        }
    }
}

private extension Data {
    mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { bytes in
            append(contentsOf: bytes)
        }
    }
}
