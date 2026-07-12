package com.tapstory.audio

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlin.math.roundToLong

/**
 * TapStoryAudioModule - React Native bridge for synchronized audio playback and recording
 * 
 * This module provides frame-accurate synchronization between audio playback and recording
 * by using Oboe (AAudio/OpenSL ES) with a shared audio clock.
 */
class TapStoryAudioModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "TapStoryAudio"
        private const val TAG = "TapStoryAudio"
    }

    private var audioEngine: TapStoryAudioEngine? = null
    private var isInitialized = false
    private var routeCallbackRegistered = false
    private val routeLock = Any()
    private val moduleLifecycleLock = Any()
    private var knownAudioDeviceIds: Set<Int> = emptySet()
    private val audioManager: AudioManager
        get() = reactContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val audioDeviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
            if (addedDevices.isNotEmpty()) invalidateIfDeviceSetChanged()
        }

        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
            if (removedDevices.isNotEmpty()) invalidateIfDeviceSetChanged()
        }
    }

    override fun getName(): String = NAME

    override fun invalidate() {
        try {
            releaseAudioEngine()
        } catch (error: Exception) {
            Log.e(TAG, "Failed to release audio during module invalidation", error)
        }
        super.invalidate()
    }

    /**
     * Initialize the audio engine with Oboe
     */
    @ReactMethod
    fun initialize(promise: Promise) {
        synchronized(moduleLifecycleLock) {
            try {
                Log.d(TAG, "Initializing TapStoryAudioEngine")

                if (audioEngine == null) {
                    audioEngine = TapStoryAudioEngine(reactContext)
                }

                audioEngine?.initialize()
                isInitialized = true
                registerRouteCallback()

                Log.d(TAG, "TapStoryAudioEngine initialized successfully")
                promise.resolve(null)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to initialize audio engine", e)
                try {
                    releaseAudioEngine()
                } catch (cleanupError: Exception) {
                    Log.e(TAG, "Failed to clean up after initialization error", cleanupError)
                }
                promise.reject("INIT_ERROR", "Failed to initialize audio engine: ${e.message}", e)
            }
        }
    }

    /**
     * Load tracks for synchronized playback
     * 
     * @param tracks Array of track objects with id, uri, and startTimeMs
     */
    @ReactMethod
    fun loadTracks(tracks: ReadableArray, promise: Promise) {
        try {
            if (!isInitialized || audioEngine == null) {
                promise.reject("NOT_INITIALIZED", "Audio engine not initialized")
                return
            }

            Log.d(TAG, "Loading ${tracks.size()} tracks")
            
            val trackList = mutableListOf<TrackInfo>()
            for (i in 0 until tracks.size()) {
                val track = tracks.getMap(i)
                if (track != null) {
                    trackList.add(
                        TrackInfo(
                            id = track.getString("id") ?: "",
                            uri = track.getString("uri") ?: "",
                            startTimeMs = track.getDouble("startTimeMs").roundToLong()
                        )
                    )
                }
            }
            
            audioEngine?.loadTracks(trackList)
            promise.resolve(null)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to load tracks", e)
            promise.reject("LOAD_ERROR", "Failed to load tracks: ${e.message}", e)
        }
    }

    /**
     * Start playback only (no recording)
     * 
     * @param playFromMs Position to start playback from in milliseconds
     */
    @ReactMethod
    fun play(playFromMs: Double, promise: Promise) {
        try {
            if (!isInitialized || audioEngine == null) {
                promise.reject("NOT_INITIALIZED", "Audio engine not initialized")
                return
            }

            Log.d(TAG, "Starting playback from ${playFromMs}ms")
            audioEngine?.play(playFromMs.roundToLong())
            promise.resolve(null)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start playback", e)
            promise.reject("PLAY_ERROR", "Failed to start playback: ${e.message}", e)
        }
    }

    /**
     * Start synchronized playback and recording
     * 
     * @param playFromMs Position to start playback from
     * @param recordStartMs Position at which recording should begin (triggers callback)
     */
    @ReactMethod
    fun playAndRecord(playFromMs: Double, recordStartMs: Double, promise: Promise) {
        try {
            if (!isInitialized || audioEngine == null) {
                promise.reject("NOT_INITIALIZED", "Audio engine not initialized")
                return
            }

            Log.d(TAG, "Starting playback from ${playFromMs}ms, recording at ${recordStartMs}ms")
            
            audioEngine?.playAndRecord(
                playFromMs.roundToLong(),
                recordStartMs.roundToLong()
            ) { actualStartMs ->
                // Emit event when recording actually starts
                sendEvent("onRecordingStarted", Arguments.createMap().apply {
                    putDouble("actualStartMs", actualStartMs.toDouble())
                })
            }
            
            promise.resolve(null)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start playback and recording", e)
            promise.reject("PLAY_RECORD_ERROR", "Failed to start playback and recording: ${e.message}", e)
        }
    }

    /**
     * Get current playback position with hardware-accurate timing
     */
    @ReactMethod
    fun getCurrentPositionMs(promise: Promise) {
        try {
            if (!isInitialized || audioEngine == null) {
                promise.resolve(0.0)
                return
            }

            val position = audioEngine?.getCurrentPositionMs() ?: 0L
            promise.resolve(position.toDouble())
        } catch (e: Exception) {
            Log.e(TAG, "Failed to get current position", e)
            promise.reject("POSITION_ERROR", "Failed to get current position: ${e.message}", e)
        }
    }

    @ReactMethod
    fun setLatencyCompensationMs(compensationMs: Double, promise: Promise) {
        try {
            val engine = audioEngine
            if (!isInitialized || engine == null) {
                promise.reject("NOT_INITIALIZED", "Audio engine not initialized")
                return
            }
            engine.setLatencyCompensationMs(compensationMs)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject(
                "LATENCY_COMPENSATION_ERROR",
                "Failed to set latency compensation: ${e.message}",
                e
            )
        }
    }

    /**
     * Stop playback
     */
    @ReactMethod
    fun stop(promise: Promise) {
        try {
            Log.d(TAG, "Stopping playback")
            audioEngine?.stop()
            promise.resolve(null)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to stop", e)
            promise.reject("STOP_ERROR", "Failed to stop: ${e.message}", e)
        }
    }

    /**
     * Stop recording and get the recording result
     */
    @ReactMethod
    fun stopRecording(promise: Promise) {
        try {
            if (!isInitialized || audioEngine == null) {
                promise.reject("NOT_INITIALIZED", "Audio engine not initialized")
                return
            }

            Log.d(TAG, "Stopping recording")
            val result = audioEngine?.stopRecording()
            
            if (result != null) {
                val response = Arguments.createMap().apply {
                    putString("uri", result.uri)
                    putDouble("startTimeMs", result.startTimeMs.toDouble())
                    putDouble("durationMs", result.durationMs.toDouble())
                    putDouble("startFrame", result.startFrame.toDouble())
                    putDouble("actualStartFrame", result.actualStartFrame.toDouble())
                    putDouble("endFrame", result.endFrame.toDouble())
                    putDouble("frameCount", result.frameCount.toDouble())
                    putDouble("rawInputFrameCount", result.rawInputFrameCount.toDouble())
                    putDouble("droppedFrameCount", result.droppedFrameCount.toDouble())
                    putDouble(
                        "shortInputFrameCount",
                        result.shortInputFrameCount.toDouble()
                    )
                    putDouble(
                        "clockDriftFrameLimit",
                        result.clockDriftFrameLimit.toDouble()
                    )
                    putInt("inputXRunCount", result.inputXRunCount)
                    putInt("outputXRunCount", result.outputXRunCount)
                    putInt("sampleRate", result.sampleRate)
                }
                promise.resolve(response)
            } else {
                promise.reject("NO_RECORDING", "No recording in progress")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to stop recording", e)
            promise.reject("STOP_RECORD_ERROR", "Failed to stop recording: ${e.message}", e)
        }
    }

    /**
     * Cleanup and release resources
     */
    @ReactMethod
    fun cleanup(promise: Promise) {
        try {
            Log.d(TAG, "Cleaning up audio engine")
            releaseAudioEngine()
            promise.resolve(null)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to cleanup", e)
            promise.reject("CLEANUP_ERROR", "Failed to cleanup: ${e.message}", e)
        }
    }

    private fun releaseAudioEngine() = synchronized(moduleLifecycleLock) {
        unregisterRouteCallback()
        audioEngine?.cleanup()
        audioEngine = null
        isInitialized = false
    }

    private fun registerRouteCallback() {
        if (!routeCallbackRegistered && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            synchronized(routeLock) {
                knownAudioDeviceIds = currentAudioDeviceIds()
            }
            audioManager.registerAudioDeviceCallback(audioDeviceCallback, null)
            routeCallbackRegistered = true
        }
    }

    private fun unregisterRouteCallback() {
        if (routeCallbackRegistered && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            audioManager.unregisterAudioDeviceCallback(audioDeviceCallback)
            routeCallbackRegistered = false
            synchronized(routeLock) {
                knownAudioDeviceIds = emptySet()
            }
        }
    }

    private fun invalidateAudioRoute() {
        if (!isInitialized) return
        Log.w(TAG, "Audio device topology changed; synchronized engine must be rebuilt")
        audioEngine?.invalidateAudioRoute()
    }

    private fun invalidateIfDeviceSetChanged() {
        val changed = synchronized(routeLock) {
            val current = currentAudioDeviceIds()
            if (current == knownAudioDeviceIds) {
                false
            } else {
                knownAudioDeviceIds = current
                true
            }
        }
        if (changed) invalidateAudioRoute()
    }

    private fun currentAudioDeviceIds(): Set<Int> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            audioManager.getDevices(AudioManager.GET_DEVICES_ALL).mapTo(mutableSetOf()) { it.id }
        } else {
            emptySet()
        }

    /** Returns Oboe timestamp-derived latency, or -1 when unavailable. */
    @ReactMethod
    fun getEstimatedLatency(promise: Promise) {
        try {
            val diagnostics = audioEngine?.getDiagnostics()
            val input = diagnostics?.inputLatencyMs ?: -1.0
            val output = diagnostics?.outputLatencyMs ?: -1.0
            promise.resolve(if (input >= 0.0 && output >= 0.0) input + output else -1.0)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to get latency", e)
            promise.resolve(-1.0)
        }
    }

    @ReactMethod
    fun getAudioDiagnostics(promise: Promise) {
        try {
            val diagnostics = audioEngine?.getDiagnostics()
            if (!isInitialized || diagnostics == null) {
                promise.reject("NOT_INITIALIZED", "Audio engine not initialized")
                return
            }
            promise.resolve(Arguments.createMap().apply {
                putInt("sampleRate", diagnostics.sampleRate)
                putDouble("inputLatencyMs", diagnostics.inputLatencyMs)
                putDouble("outputLatencyMs", diagnostics.outputLatencyMs)
                putInt("inputXRunCount", diagnostics.inputXRunCount)
                putInt("outputXRunCount", diagnostics.outputXRunCount)
                putInt("inputFramesPerBurst", diagnostics.inputFramesPerBurst)
                putInt("outputFramesPerBurst", diagnostics.outputFramesPerBurst)
                putInt("inputPerformanceMode", diagnostics.inputPerformanceMode)
                putInt("outputPerformanceMode", diagnostics.outputPerformanceMode)
                putInt("lastStreamError", diagnostics.lastStreamError)
                putDouble("requestedPunchFrame", diagnostics.requestedPunchFrame.toDouble())
                putDouble(
                    "actualRecordingStartFrame",
                    diagnostics.actualRecordingStartFrame.toDouble()
                )
                putDouble("recordingEndFrame", diagnostics.recordingEndFrame.toDouble())
                putDouble(
                    "latencyCompensationFrames",
                    diagnostics.latencyCompensationFrames.toDouble()
                )
                putDouble(
                    "latencyCompensationMs",
                    if (diagnostics.sampleRate > 0) {
                        diagnostics.latencyCompensationFrames * 1000.0 / diagnostics.sampleRate
                    } else {
                        0.0
                    }
                )
                putDouble("rawInputFrameCount", diagnostics.rawInputFrameCount.toDouble())
                putDouble(
                    "droppedCaptureFrameCount",
                    diagnostics.droppedCaptureFrameCount.toDouble()
                )
                putDouble(
                    "shortInputFrameCount",
                    diagnostics.shortInputFrameCount.toDouble()
                )
                putDouble(
                    "clockDriftFrameLimit",
                    diagnostics.clockDriftFrameLimit.toDouble()
                )
                putBoolean("captureOnsetExact", diagnostics.captureOnsetExact)
                putInt("inputXRunDelta", diagnostics.inputXRunDelta)
                putInt("outputXRunDelta", diagnostics.outputXRunDelta)
            })
        } catch (e: Exception) {
            promise.reject("DIAGNOSTICS_ERROR", "Failed to read audio diagnostics: ${e.message}", e)
        }
    }

    /**
     * Check if Bluetooth audio is currently connected.
     * Bluetooth adds 150-300ms of transmission lag that must be compensated.
     */
    @ReactMethod
    fun isBluetoothConnected(promise: Promise) {
        try {
            val audioManager = reactContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            
            // Check if Bluetooth A2DP (high-quality audio) is active
            val isBluetoothA2dp = audioManager.isBluetoothA2dpOn
            
            // Also check connected audio devices for Bluetooth types
            var hasBluetoothDevice = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val devices = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
                for (device in devices) {
                    val type = device.type
                    if (type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
                        type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                        type == AudioDeviceInfo.TYPE_BLE_HEADSET ||
                        type == AudioDeviceInfo.TYPE_BLE_SPEAKER) {
                        hasBluetoothDevice = true
                        break
                    }
                }
            }
            
            val isBluetooth = isBluetoothA2dp || hasBluetoothDevice
            Log.d(TAG, "Bluetooth Check: A2DP=$isBluetoothA2dp, HasDevice=$hasBluetoothDevice, Result=$isBluetooth")
            
            promise.resolve(isBluetooth)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to check Bluetooth", e)
            promise.reject(
                "ROUTE_CHECK_ERROR",
                "Unable to verify that the active audio route supports synchronized overdubs",
                e
            )
        }
    }

    /**
     * Send event to JavaScript
     */
    private fun sendEvent(eventName: String, params: WritableMap) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    /**
     * Required for NativeEventEmitter
     */
    @ReactMethod
    fun addListener(eventName: String) {
        // Keep: Required for RN NativeEventEmitter
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Keep: Required for RN NativeEventEmitter
    }
}
