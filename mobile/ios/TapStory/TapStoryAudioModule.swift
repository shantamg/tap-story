import Foundation
import AVFoundation
import React

/**
 * TapStoryAudioModule - React Native bridge for synchronized audio on iOS
 *
 * Uses AudioEngineIOS (RemoteIO AudioUnit) for low-latency synchronized playback and recording.
 * This provides the same sync behavior as the Android Oboe implementation.
 */
@objc(TapStoryAudio)
class TapStoryAudioModule: RCTEventEmitter {
    
    private static let sampleRate: Double = 44100
    
    private var audioEngine: AudioEngineIOS?
    private var hasListeners = false
    
    // Recording state
    private var rawRecordingFile: URL?
    private var pendingRecordStartMs: Double = -1
    private var onRecordingStartedCallback: (() -> Void)?
    
    override init() {
        super.init()
    }
    
    // MARK: - RCTEventEmitter
    
    override func supportedEvents() -> [String]! {
        return ["onRecordingStarted", "onPositionUpdate", "onPlaybackComplete"]
    }
    
    override func startObserving() {
        hasListeners = true
    }
    
    override func stopObserving() {
        hasListeners = false
    }
    
    override static func requiresMainQueueSetup() -> Bool {
        return false
    }
    
    // MARK: - Public API
    
    @objc
    func initialize(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        print("[TapStoryAudio] Initializing with AudioEngineIOS (RemoteIO)")
        
        if audioEngine == nil {
            audioEngine = AudioEngineIOS()
        }
        
        var error: NSError?
        let success = audioEngine?.initialize(&error) ?? false
        
        if success {
            print("[TapStoryAudio] Initialized successfully")
            resolve(nil)
        } else {
            print("[TapStoryAudio] Failed to initialize: \(error?.localizedDescription ?? "unknown error")")
            reject("INIT_ERROR", "Failed to initialize audio engine: \(error?.localizedDescription ?? "unknown")", error)
        }
    }
    
    @objc
    func loadTracks(_ tracks: [[String: Any]], resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let engine = audioEngine else {
            reject("NOT_INITIALIZED", "Audio engine not initialized", nil)
            return
        }
        
        print("[TapStoryAudio] Loading \(tracks.count) tracks")
        
        // Clear existing tracks
        engine.clearTracks()
        
        // Decode and load each track
        for track in tracks {
            guard let id = track["id"] as? String,
                  let uri = track["uri"] as? String,
                  let startTimeMs = track["startTimeMs"] as? Double else {
                print("[TapStoryAudio] Invalid track data, skipping")
                continue
            }
            
            // Decode audio file to PCM samples
            if let pcmData = decodeAudioFile(uri: uri) {
                // Convert startTimeMs to frames
                let startFrame = Int32(startTimeMs * TapStoryAudioModule.sampleRate / 1000)
                
                // Load into engine
                pcmData.withUnsafeBufferPointer { buffer in
                    engine.loadTrack(withId: id,
                                     data: buffer.baseAddress!,
                                     numSamples: Int32(pcmData.count),
                                     startFrame: startFrame)
                }
                
                print("[TapStoryAudio] Loaded track \(id.prefix(8)): \(pcmData.count) samples, startFrame=\(startFrame)")
            } else {
                print("[TapStoryAudio] Failed to decode track: \(uri)")
            }
        }
        
        resolve(nil)
    }
    
    @objc
    func play(_ playFromMs: Double, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let engine = audioEngine else {
            reject("NOT_INITIALIZED", "Audio engine not initialized", nil)
            return
        }
        
        print("[TapStoryAudio] Playing from \(playFromMs)ms")
        
        // Seek to starting position
        let startFrame = Int64(playFromMs * TapStoryAudioModule.sampleRate / 1000)
        engine.seek(toFrame: startFrame)
        
        // Start playback
        engine.start()
        
        resolve(nil)
    }
    
    @objc
    func playAndRecord(_ playFromMs: Double, recordStartMs: Double, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let engine = audioEngine else {
            reject("NOT_INITIALIZED", "Audio engine not initialized", nil)
            return
        }
        
        print("[TapStoryAudio] Play and record: playFrom=\(playFromMs)ms, recordAt=\(recordStartMs)ms")
        
        pendingRecordStartMs = recordStartMs
        
        // Prepare raw recording file
        let documentsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        rawRecordingFile = documentsPath.appendingPathComponent("recording_raw_\(Date().timeIntervalSince1970).pcm")
        
        // Convert times to frames
        let startFrame = Int64(playFromMs * TapStoryAudioModule.sampleRate / 1000)
        let recordStartFrame = Int32(recordStartMs * TapStoryAudioModule.sampleRate / 1000)
        
        // Seek to starting position
        engine.seek(toFrame: startFrame)
        
        // Start recording (engine will write raw PCM to file at the specified frame)
        engine.startRecording(toPath: rawRecordingFile!.path, startFrame: recordStartFrame)
        
        // Start playback
        engine.start()
        
        // Send recording started event (native engine starts at exact frame)
        if hasListeners {
            sendEvent(withName: "onRecordingStarted", body: ["actualStartMs": recordStartMs])
        }
        
        resolve(nil)
    }
    
    @objc
    func getCurrentPositionMs(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let engine = audioEngine else {
            resolve(0.0)
            return
        }
        
        let currentFrame = engine.currentFrame()
        let positionMs = Double(currentFrame) * 1000 / TapStoryAudioModule.sampleRate
        resolve(positionMs)
    }
    
    @objc
    func stop(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        print("[TapStoryAudio] Stopping")
        audioEngine?.stop()
        resolve(nil)
    }
    
    @objc
    func stopRecording(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let engine = audioEngine else {
            reject("NOT_INITIALIZED", "Audio engine not initialized", nil)
            return
        }
        
        print("[TapStoryAudio] Stopping recording")
        
        // Stop native recording
        engine.stopRecording()
        
        // Get recording info
        let startFrame = engine.recordingStartFrame()
        let sampleCount = engine.recordedSampleCount()
        
        if sampleCount <= 0 {
            reject("NO_RECORDING", "No samples recorded", nil)
            return
        }
        
        guard let rawFile = rawRecordingFile else {
            reject("NO_RECORDING", "No recording file", nil)
            return
        }
        
        // Convert raw PCM to WAV
        let documentsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let wavFile = documentsPath.appendingPathComponent("recording_\(Date().timeIntervalSince1970).wav")
        
        do {
            try convertRawToWav(rawFile: rawFile, wavFile: wavFile, sampleCount: Int(sampleCount))
            
            // Clean up raw file
            try? FileManager.default.removeItem(at: rawFile)
            
            let startTimeMs = Double(startFrame) * 1000 / TapStoryAudioModule.sampleRate
            let durationMs = Double(sampleCount) * 1000 / TapStoryAudioModule.sampleRate
            
            print("[TapStoryAudio] Recording saved: \(wavFile.path), duration: \(durationMs)ms")
            
            resolve([
                "uri": "file://\(wavFile.path)",
                "startTimeMs": startTimeMs,
                "durationMs": durationMs
            ])
        } catch {
            print("[TapStoryAudio] Failed to convert recording: \(error)")
            reject("CONVERSION_ERROR", "Failed to save recording: \(error.localizedDescription)", error)
        }
    }
    
    @objc
    func getLatencyInfo(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let engine = audioEngine else {
            // Return default values if engine not initialized
            resolve([
                "inputLatencyMs": 0,
                "outputLatencyMs": 0,
                "bufferDurationMs": 0,
                "sampleRate": TapStoryAudioModule.sampleRate
            ])
            return
        }
        
        resolve(engine.getLatencyInfo())
    }
    
    @objc
    func cleanup(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        print("[TapStoryAudio] Cleaning up")
        audioEngine?.cleanup()
        audioEngine = nil
        rawRecordingFile = nil
        resolve(nil)
    }
    
    // MARK: - Audio Decoding
    
    /**
     * Decode audio file to Int16 PCM samples using AVAudioFile
     */
    private func decodeAudioFile(uri: String) -> [Int16]? {
        // Handle file:// URIs
        let path: String
        if uri.hasPrefix("file://") {
            path = String(uri.dropFirst(7))
        } else {
            path = uri
        }
        
        let url = URL(fileURLWithPath: path)
        
        guard FileManager.default.fileExists(atPath: url.path) else {
            print("[TapStoryAudio] File not found: \(path)")
            return nil
        }
        
        do {
            let audioFile = try AVAudioFile(forReading: url)
            
            // Check sample rate
            let fileSampleRate = audioFile.processingFormat.sampleRate
            if fileSampleRate != TapStoryAudioModule.sampleRate {
                print("[TapStoryAudio] WARNING: File sample rate (\(fileSampleRate)) != engine sample rate (\(TapStoryAudioModule.sampleRate))")
                // TODO: Implement resampling if needed
            }
            
            // Read all frames as Float32
            let frameCount = AVAudioFrameCount(audioFile.length)
            guard let floatBuffer = AVAudioPCMBuffer(pcmFormat: audioFile.processingFormat, frameCapacity: frameCount) else {
                print("[TapStoryAudio] Failed to create buffer")
                return nil
            }
            
            try audioFile.read(into: floatBuffer)
            
            // Convert to mono Int16
            let channelCount = Int(audioFile.processingFormat.channelCount)
            guard let floatData = floatBuffer.floatChannelData else {
                print("[TapStoryAudio] No float channel data")
                return nil
            }
            
            var int16Samples = [Int16](repeating: 0, count: Int(frameCount))
            
            for frame in 0..<Int(frameCount) {
                var sample: Float = 0
                
                // Mix down to mono if stereo
                for channel in 0..<channelCount {
                    sample += floatData[channel][frame]
                }
                sample /= Float(channelCount)
                
                // Convert to Int16 with clipping
                let scaledSample = sample * 32767.0
                let clippedSample = max(-32768.0, min(32767.0, scaledSample))
                int16Samples[frame] = Int16(clippedSample)
            }
            
            print("[TapStoryAudio] Decoded \(frameCount) frames from \(url.lastPathComponent)")
            return int16Samples
            
        } catch {
            print("[TapStoryAudio] Failed to decode audio file: \(error)")
            return nil
        }
    }
    
    // MARK: - WAV Conversion
    
    /**
     * Convert raw PCM file to WAV file by prepending the 44-byte header
     */
    private func convertRawToWav(rawFile: URL, wavFile: URL, sampleCount: Int) throws {
        let bytesPerSample = 2  // Int16
        let channelCount = 1    // Mono
        let sampleRate = Int(TapStoryAudioModule.sampleRate)
        
        let dataSize = sampleCount * bytesPerSample
        let fileSize = 36 + dataSize
        
        // Read raw PCM data
        let rawData = try Data(contentsOf: rawFile)
        
        // Create WAV data
        var wavData = Data()
        
        // RIFF header
        wavData.append("RIFF".data(using: .ascii)!)
        wavData.append(contentsOf: withUnsafeBytes(of: UInt32(fileSize).littleEndian) { Array($0) })
        wavData.append("WAVE".data(using: .ascii)!)
        
        // fmt chunk
        wavData.append("fmt ".data(using: .ascii)!)
        wavData.append(contentsOf: withUnsafeBytes(of: UInt32(16).littleEndian) { Array($0) })  // Chunk size
        wavData.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian) { Array($0) })   // Audio format (PCM)
        wavData.append(contentsOf: withUnsafeBytes(of: UInt16(channelCount).littleEndian) { Array($0) })  // Channels
        wavData.append(contentsOf: withUnsafeBytes(of: UInt32(sampleRate).littleEndian) { Array($0) })    // Sample rate
        wavData.append(contentsOf: withUnsafeBytes(of: UInt32(sampleRate * channelCount * bytesPerSample).littleEndian) { Array($0) })  // Byte rate
        wavData.append(contentsOf: withUnsafeBytes(of: UInt16(channelCount * bytesPerSample).littleEndian) { Array($0) })  // Block align
        wavData.append(contentsOf: withUnsafeBytes(of: UInt16(bytesPerSample * 8).littleEndian) { Array($0) })  // Bits per sample
        
        // data chunk
        wavData.append("data".data(using: .ascii)!)
        wavData.append(contentsOf: withUnsafeBytes(of: UInt32(dataSize).littleEndian) { Array($0) })
        wavData.append(rawData)
        
        // Write to file
        try wavData.write(to: wavFile)
    }
}
