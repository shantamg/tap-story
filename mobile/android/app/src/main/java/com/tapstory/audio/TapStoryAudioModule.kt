package com.tapstory.audio

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlin.math.max

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

    override fun getName(): String = NAME

    /**
     * Initialize the audio engine with Oboe
     */
    @ReactMethod
    fun initialize(promise: Promise) {
        try {
            Log.d(TAG, "Initializing TapStoryAudioEngine")
            
            if (audioEngine == null) {
                audioEngine = TapStoryAudioEngine(reactContext)
            }
            
            audioEngine?.initialize()
            isInitialized = true
            
            Log.d(TAG, "TapStoryAudioEngine initialized successfully")
            promise.resolve(null)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize audio engine", e)
            promise.reject("INIT_ERROR", "Failed to initialize audio engine: ${e.message}", e)
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
                            startTimeMs = track.getDouble("startTimeMs").toLong()
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
            audioEngine?.play(playFromMs.toLong())
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
                playFromMs.toLong(),
                recordStartMs.toLong()
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
            audioEngine?.cleanup()
            audioEngine = null
            isInitialized = false
            promise.resolve(null)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to cleanup", e)
            promise.reject("CLEANUP_ERROR", "Failed to cleanup: ${e.message}", e)
        }
    }

    /**
     * Get the device's estimated hardware round-trip latency.
     * 
     * We compare two methods and use the MAXIMUM:
     * 1. Buffer-based calculation: (frames / sampleRate) * 2 + overhead
     * 2. OS-reported output latency (if available)
     * 
     * The OS often knows about hidden DSP delays that buffer math misses.
     */
    @ReactMethod
    fun getEstimatedLatency(promise: Promise) {
        try {
            val audioManager = reactContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            
            // Get the native sample rate and buffer size
            val sampleRateString = audioManager.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)
            val framesPerBufferString = audioManager.getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER)
            
            val sampleRate = sampleRateString?.toDoubleOrNull() ?: 44100.0
            val framesPerBuffer = framesPerBufferString?.toDoubleOrNull() ?: 256.0
            
            // Method 1: Calculate buffer latency in milliseconds
            // Latency = (frames / sampleRate) * 1000
            // We have at least 2 buffers in the pipeline (input + output)
            val bufferLatencyMs = (framesPerBuffer / sampleRate) * 1000.0 * 2.0
            
            // Add processing overhead (typically 5-15ms on modern devices)
            // On cheaper phones this can be 20-50ms for DSP processing
            val processingOverhead = 15.0
            val calculatedLatency = bufferLatencyMs + processingOverhead
            
            // Method 2: Check if OS reports output latency directly
            // Note: This property may not exist on all devices
            val reportedLatencyString = try {
                // PROPERTY_OUTPUT_LATENCY is not a standard constant, 
                // but some OEMs expose it. We try to get it anyway.
                audioManager.getProperty("android.media.property.OUTPUT_LATENCY")
            } catch (e: Exception) {
                null
            }
            val reportedLatency = reportedLatencyString?.toDoubleOrNull() ?: 0.0
            
            // Use the MAXIMUM of reported vs calculated
            // The OS usually knows about hidden DSP delays that buffer math misses
            val finalLatency = if (reportedLatency > 0) {
                max(reportedLatency, calculatedLatency)
            } else {
                calculatedLatency
            }
            
            Log.d(TAG, "Audio Config: sampleRate=$sampleRate, framesPerBuffer=$framesPerBuffer")
            Log.d(TAG, "Latency Check: Reported=${reportedLatency}ms, Calculated=${calculatedLatency}ms, Final=${finalLatency}ms")
            
            promise.resolve(finalLatency)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to get latency", e)
            promise.resolve(40.0) // Safe fallback for average Android (increased from 30)
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
            promise.resolve(false)
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

