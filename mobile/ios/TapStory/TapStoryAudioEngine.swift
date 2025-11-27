import Foundation
import AVFoundation

/**
 * TapStoryAudioEngine - Core audio engine for synchronized playback and recording on iOS
 *
 * Uses AVAudioEngine to provide:
 * - Single audio graph with shared time base
 * - Sample-accurate timestamps via AVAudioTime
 * - Multi-track mixing with precise timing
 * - Synchronized recording that starts at exact playback position
 */
class TapStoryAudioEngine: NSObject {
    
    // MARK: - Constants
    
    static let sampleRate: Double = 44100
    static let channelsOut: AVAudioChannelCount = 2
    static let channelsIn: AVAudioChannelCount = 1
    
    // MARK: - Audio Engine Components
    
    private let audioEngine = AVAudioEngine()
    private var playerNodes: [String: AVAudioPlayerNode] = [:]
    private var audioFiles: [String: AVAudioFile] = [:]
    private var trackStartTimes: [String: Double] = [:] // Start time in ms
    
    // MARK: - State
    
    private var isPlaying = false
    private var isRecording = false
    private var playbackStartTime: AVAudioTime?
    private var playbackStartPositionMs: Double = 0
    
    // Recording state
    private var recordingBuffer: AVAudioPCMBuffer?
    private var recordingFrameCount: AVAudioFrameCount = 0
    private var recordingStartMs: Double = 0
    private var recordingActualStartMs: Double = 0
    private var recordingFile: URL?
    private var recordingTapInstalled = false
    
    // Callback for when recording starts
    private var onRecordingStartedCallback: ((Double) -> Void)?
    private var pendingRecordStartMs: Double = -1
    private var positionMonitorTimer: Timer?
    
    // MARK: - Initialization
    
    override init() {
        super.init()
        setupAudioSession()
    }
    
    private func setupAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth, .mixWithOthers])
            try session.setPreferredSampleRate(TapStoryAudioEngine.sampleRate)
            try session.setActive(true)
            print("[TapStoryAudioEngine] Audio session configured")
        } catch {
            print("[TapStoryAudioEngine] Failed to setup audio session: \(error)")
        }
    }
    
    // MARK: - Public API
    
    func initialize() throws {
        print("[TapStoryAudioEngine] Initializing")
        
        // Prepare the audio engine
        audioEngine.prepare()
        
        print("[TapStoryAudioEngine] Initialized")
    }
    
    func loadTracks(_ tracks: [[String: Any]]) throws {
        print("[TapStoryAudioEngine] Loading \(tracks.count) tracks")
        
        // Clean up existing players
        cleanup()
        
        for track in tracks {
            guard let id = track["id"] as? String,
                  let uri = track["uri"] as? String,
                  let startTimeMs = track["startTimeMs"] as? Double else {
                continue
            }
            
            // Create audio file from URI
            let url: URL
            if uri.hasPrefix("file://") {
                url = URL(string: uri)!
            } else {
                url = URL(fileURLWithPath: uri)
            }
            
            guard FileManager.default.fileExists(atPath: url.path) else {
                print("[TapStoryAudioEngine] File not found: \(uri)")
                continue
            }
            
            do {
                let audioFile = try AVAudioFile(forReading: url)
                audioFiles[id] = audioFile
                trackStartTimes[id] = startTimeMs
                
                // Create player node
                let playerNode = AVAudioPlayerNode()
                playerNodes[id] = playerNode
                
                // Connect to engine
                audioEngine.attach(playerNode)
                audioEngine.connect(playerNode, to: audioEngine.mainMixerNode, format: audioFile.processingFormat)
                
                let durationMs = Double(audioFile.length) / audioFile.processingFormat.sampleRate * 1000
                print("[TapStoryAudioEngine] Loaded track \(id.prefix(8)): starts at \(startTimeMs)ms, duration \(durationMs)ms")
            } catch {
                print("[TapStoryAudioEngine] Failed to load track \(id): \(error)")
            }
        }
        
        print("[TapStoryAudioEngine] Loaded \(audioFiles.count) tracks")
    }
    
    func play(playFromMs: Double) throws {
        print("[TapStoryAudioEngine] Playing from \(playFromMs)ms")
        
        try startPlayback(playFromMs: playFromMs, recordStartMs: -1, onRecordingStarted: nil)
    }
    
    func playAndRecord(playFromMs: Double, recordStartMs: Double, onRecordingStarted: @escaping (Double) -> Void) throws {
        print("[TapStoryAudioEngine] Play and record: playFrom=\(playFromMs)ms, recordAt=\(recordStartMs)ms")
        
        pendingRecordStartMs = recordStartMs
        onRecordingStartedCallback = onRecordingStarted
        
        // Prepare recording
        prepareRecording()
        
        try startPlayback(playFromMs: playFromMs, recordStartMs: recordStartMs, onRecordingStarted: onRecordingStarted)
    }
    
    private func startPlayback(playFromMs: Double, recordStartMs: Double, onRecordingStarted: ((Double) -> Void)?) throws {
        if isPlaying {
            stop()
        }
        
        playbackStartPositionMs = playFromMs
        
        // Start the engine
        if !audioEngine.isRunning {
            try audioEngine.start()
        }
        
        // Get reference time
        guard let outputTime = playerNodes.values.first?.lastRenderTime else {
            // Schedule playback immediately
            scheduleAndPlay(playFromMs: playFromMs)
            return
        }
        
        // Use host time for synchronized playback
        let hostTime = mach_absolute_time()
        playbackStartTime = AVAudioTime(hostTime: hostTime)
        
        scheduleAndPlay(playFromMs: playFromMs)
        
        isPlaying = true
        
        // Start position monitoring if we need to trigger recording
        if recordStartMs >= 0 && onRecordingStarted != nil {
            startPositionMonitoring(recordStartMs: recordStartMs, onRecordingStarted: onRecordingStarted!)
        }
    }
    
    private func scheduleAndPlay(playFromMs: Double) {
        for (id, playerNode) in playerNodes {
            guard let audioFile = audioFiles[id],
                  let startTimeMs = trackStartTimes[id] else {
                continue
            }
            
            let trackEndMs = startTimeMs + Double(audioFile.length) / audioFile.processingFormat.sampleRate * 1000
            
            // Check if this track should be playing at this position
            if startTimeMs <= playFromMs && trackEndMs > playFromMs {
                // Calculate position within track
                let positionWithinTrackMs = playFromMs - startTimeMs
                let framePosition = AVAudioFramePosition(positionWithinTrackMs / 1000 * audioFile.processingFormat.sampleRate)
                let framesToPlay = AVAudioFrameCount(audioFile.length - framePosition)
                
                // Schedule from this position
                playerNode.scheduleSegment(audioFile, startingFrame: framePosition, frameCount: framesToPlay, at: nil)
                playerNode.play()
                
                print("[TapStoryAudioEngine] Started track \(id.prefix(8)) at position \(positionWithinTrackMs)ms")
            } else if startTimeMs > playFromMs {
                // This track should start later - schedule it
                let delayMs = startTimeMs - playFromMs
                let delaySamples = AVAudioFramePosition(delayMs / 1000 * audioFile.processingFormat.sampleRate)
                
                // Schedule the full file to play after delay
                // For now, we'll use a timer to start it (not perfectly sample-accurate but close)
                DispatchQueue.main.asyncAfter(deadline: .now() + delayMs / 1000) { [weak self] in
                    guard let self = self, self.isPlaying else { return }
                    playerNode.scheduleFile(audioFile, at: nil)
                    playerNode.play()
                    print("[TapStoryAudioEngine] Started delayed track \(id.prefix(8))")
                }
            }
        }
    }
    
    private func startPositionMonitoring(recordStartMs: Double, onRecordingStarted: @escaping (Double) -> Void) {
        stopPositionMonitoring()
        
        positionMonitorTimer = Timer.scheduledTimer(withTimeInterval: 0.01, repeats: true) { [weak self] _ in
            guard let self = self, self.isPlaying else {
                self?.stopPositionMonitoring()
                return
            }
            
            let currentPositionMs = self.getCurrentPositionMs()
            
            if currentPositionMs >= recordStartMs && !self.isRecording {
                self.recordingActualStartMs = currentPositionMs
                self.startRecordingInternal()
                onRecordingStarted(currentPositionMs)
                self.stopPositionMonitoring()
            }
        }
    }
    
    private func stopPositionMonitoring() {
        positionMonitorTimer?.invalidate()
        positionMonitorTimer = nil
    }
    
    private func prepareRecording() {
        recordingBuffer = nil
        recordingFrameCount = 0
        
        let documentsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        recordingFile = documentsPath.appendingPathComponent("recording_\(Date().timeIntervalSince1970).wav")
    }
    
    private func startRecordingInternal() {
        guard !isRecording else { return }
        
        print("[TapStoryAudioEngine] Starting recording")
        
        isRecording = true
        recordingStartMs = recordingActualStartMs
        
        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        
        // Allocate buffer for recording (enough for several minutes)
        let maxFrames = AVAudioFrameCount(TapStoryAudioEngine.sampleRate * 600) // 10 minutes max
        recordingBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: maxFrames)
        recordingFrameCount = 0
        
        // Install tap on input
        inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, time in
            guard let self = self, self.isRecording else { return }
            
            // Copy buffer data to our recording buffer
            if let recordingBuffer = self.recordingBuffer {
                let srcPtr = buffer.floatChannelData?[0]
                let dstPtr = recordingBuffer.floatChannelData?[0]
                
                if let src = srcPtr, let dst = dstPtr {
                    let frameCount = buffer.frameLength
                    let offset = self.recordingFrameCount
                    
                    if offset + frameCount <= recordingBuffer.frameCapacity {
                        memcpy(dst.advanced(by: Int(offset)), src, Int(frameCount) * MemoryLayout<Float>.size)
                        self.recordingFrameCount += frameCount
                    }
                }
            }
        }
        
        recordingTapInstalled = true
        print("[TapStoryAudioEngine] Recording started at \(recordingActualStartMs)ms")
    }
    
    func getCurrentPositionMs() -> Double {
        guard isPlaying else {
            return playbackStartPositionMs
        }
        
        // Calculate based on first playing node
        if let (_, playerNode) = playerNodes.first,
           let nodeTime = playerNode.lastRenderTime,
           let playerTime = playerNode.playerTime(forNodeTime: nodeTime),
           let audioFile = audioFiles.values.first {
            
            let sampleTime = Double(playerTime.sampleTime)
            let sampleRate = audioFile.processingFormat.sampleRate
            let currentPositionSeconds = sampleTime / sampleRate
            
            // Add the offset from where we started
            return playbackStartPositionMs + currentPositionSeconds * 1000
        }
        
        // Fallback: use host time
        if let startTime = playbackStartTime {
            let hostTime = mach_absolute_time()
            let elapsedNanos = Double(hostTime - startTime.hostTime)
            
            var timebaseInfo = mach_timebase_info_data_t()
            mach_timebase_info(&timebaseInfo)
            let elapsedMs = elapsedNanos * Double(timebaseInfo.numer) / Double(timebaseInfo.denom) / 1_000_000
            
            return playbackStartPositionMs + elapsedMs
        }
        
        return playbackStartPositionMs
    }
    
    func stop() {
        print("[TapStoryAudioEngine] Stopping")
        
        stopPositionMonitoring()
        isPlaying = false
        
        for playerNode in playerNodes.values {
            playerNode.stop()
        }
    }
    
    func stopRecording() -> [String: Any]? {
        guard isRecording || recordingFrameCount > 0 else {
            return nil
        }
        
        print("[TapStoryAudioEngine] Stopping recording")
        
        isRecording = false
        
        // Remove tap
        if recordingTapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            recordingTapInstalled = false
        }
        
        // Save recording to file
        guard let recordingBuffer = recordingBuffer,
              let recordingFile = recordingFile,
              recordingFrameCount > 0 else {
            return nil
        }
        
        // Set the correct frame length
        recordingBuffer.frameLength = recordingFrameCount
        
        do {
            // Create output file
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: TapStoryAudioEngine.sampleRate,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false
            ]
            
            let outputFile = try AVAudioFile(forWriting: recordingFile, settings: settings)
            try outputFile.write(from: recordingBuffer)
            
            let durationMs = Double(recordingFrameCount) / TapStoryAudioEngine.sampleRate * 1000
            
            print("[TapStoryAudioEngine] Recording saved: \(recordingFile.path), duration: \(durationMs)ms")
            
            return [
                "uri": "file://\(recordingFile.path)",
                "startTimeMs": recordingActualStartMs,
                "durationMs": durationMs
            ]
        } catch {
            print("[TapStoryAudioEngine] Failed to save recording: \(error)")
            return nil
        }
    }
    
    func cleanup() {
        print("[TapStoryAudioEngine] Cleaning up")
        
        stop()
        
        if recordingTapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            recordingTapInstalled = false
        }
        
        for (id, playerNode) in playerNodes {
            audioEngine.detach(playerNode)
        }
        
        playerNodes.removeAll()
        audioFiles.removeAll()
        trackStartTimes.removeAll()
        
        recordingBuffer = nil
        recordingFrameCount = 0
        
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        
        print("[TapStoryAudioEngine] Cleaned up")
    }
    
    deinit {
        cleanup()
    }
}
