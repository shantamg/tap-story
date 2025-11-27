import Foundation
import React

/**
 * TapStoryAudioModule - React Native bridge for synchronized audio on iOS
 *
 * Exposes TapStoryAudioEngine functionality to JavaScript via React Native bridge.
 */
@objc(TapStoryAudio)
class TapStoryAudioModule: RCTEventEmitter {
    
    private var audioEngine: TapStoryAudioEngine?
    private var hasListeners = false
    
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
        do {
            print("[TapStoryAudio] Initializing")
            
            if audioEngine == nil {
                audioEngine = TapStoryAudioEngine()
            }
            
            try audioEngine?.initialize()
            
            print("[TapStoryAudio] Initialized successfully")
            resolve(nil)
        } catch {
            print("[TapStoryAudio] Failed to initialize: \(error)")
            reject("INIT_ERROR", "Failed to initialize audio engine: \(error.localizedDescription)", error)
        }
    }
    
    @objc
    func loadTracks(_ tracks: [[String: Any]], resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            guard let engine = audioEngine else {
                reject("NOT_INITIALIZED", "Audio engine not initialized", nil)
                return
            }
            
            print("[TapStoryAudio] Loading \(tracks.count) tracks")
            try engine.loadTracks(tracks)
            resolve(nil)
        } catch {
            print("[TapStoryAudio] Failed to load tracks: \(error)")
            reject("LOAD_ERROR", "Failed to load tracks: \(error.localizedDescription)", error)
        }
    }
    
    @objc
    func play(_ playFromMs: Double, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            guard let engine = audioEngine else {
                reject("NOT_INITIALIZED", "Audio engine not initialized", nil)
                return
            }
            
            print("[TapStoryAudio] Playing from \(playFromMs)ms")
            try engine.play(playFromMs: playFromMs)
            resolve(nil)
        } catch {
            print("[TapStoryAudio] Failed to play: \(error)")
            reject("PLAY_ERROR", "Failed to start playback: \(error.localizedDescription)", error)
        }
    }
    
    @objc
    func playAndRecord(_ playFromMs: Double, recordStartMs: Double, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            guard let engine = audioEngine else {
                reject("NOT_INITIALIZED", "Audio engine not initialized", nil)
                return
            }
            
            print("[TapStoryAudio] Play and record: playFrom=\(playFromMs)ms, recordAt=\(recordStartMs)ms")
            
            try engine.playAndRecord(playFromMs: playFromMs, recordStartMs: recordStartMs) { [weak self] actualStartMs in
                print("[TapStoryAudio] Recording started at \(actualStartMs)ms")
                
                if self?.hasListeners == true {
                    self?.sendEvent(withName: "onRecordingStarted", body: ["actualStartMs": actualStartMs])
                }
            }
            
            resolve(nil)
        } catch {
            print("[TapStoryAudio] Failed to play and record: \(error)")
            reject("PLAY_RECORD_ERROR", "Failed to start playback and recording: \(error.localizedDescription)", error)
        }
    }
    
    @objc
    func getCurrentPositionMs(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let engine = audioEngine else {
            resolve(0.0)
            return
        }
        
        let position = engine.getCurrentPositionMs()
        resolve(position)
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
        
        if let result = engine.stopRecording() {
            resolve(result)
        } else {
            reject("NO_RECORDING", "No recording in progress", nil)
        }
    }
    
    @objc
    func cleanup(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        print("[TapStoryAudio] Cleaning up")
        audioEngine?.cleanup()
        audioEngine = nil
        resolve(nil)
    }
}
