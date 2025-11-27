package com.tapstory.audio

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import android.util.Log
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * TapStoryAudioEngine - Core audio engine for synchronized playback and recording
 * 
 * This engine uses Oboe (via C++) for low-latency, synchronized audio I/O.
 * Audio decoding remains in Kotlin using MediaCodec.
 * 
 * Key features:
 * - Low-latency playback and recording via Oboe
 * - Synchronized I/O (mic read inside speaker callback)
 * - Multi-track mixing in native code
 * - Frame-accurate timing
 */
class TapStoryAudioEngine(private val context: Context) {

    companion object {
        private const val TAG = "TapStoryAudioEngine"
        private const val SAMPLE_RATE = 44100
        private const val CHANNELS_IN = 1
        private const val BYTES_PER_SAMPLE = 2 // 16-bit

        init {
            System.loadLibrary("tapstory-audio")
            Log.d(TAG, "Loaded tapstory-audio native library")
        }
    }

    // Native method declarations
    private external fun nativeCreateEngine()
    private external fun nativeDeleteEngine()
    private external fun nativeStart()
    private external fun nativeStop()
    private external fun nativeLoadTrack(id: String, data: ShortArray, startFrame: Int)
    private external fun nativeClearTracks()
    private external fun nativeStartRecording(filePath: String, startFrame: Int)
    private external fun nativeStopRecording()
    private external fun nativeGetCurrentFrame(): Long
    private external fun nativeSeekToFrame(frame: Long)
    private external fun nativeGetRecordingStartFrame(): Long
    private external fun nativeGetRecordedSampleCount(): Long

    // State tracking
    private val isPlaying = AtomicBoolean(false)
    private val isRecording = AtomicBoolean(false)
    private var loadedTracks: List<TrackInfo> = emptyList()
    
    // Recording state
    private var rawRecordingFile: File? = null
    private val recordingActualStartMs = AtomicLong(0)
    
    // Callback for when recording starts
    private var onRecordingStartedCallback: ((Long) -> Unit)? = null
    private var pendingRecordStartMs: Long = -1

    fun initialize() {
        Log.d(TAG, "Initializing audio engine (Oboe)")
        nativeCreateEngine()
        Log.d(TAG, "Audio engine initialized")
    }

    fun loadTracks(tracks: List<TrackInfo>) {
        Log.d(TAG, "Loading ${tracks.size} tracks")
        loadedTracks = tracks
        
        // Clear any previously loaded tracks in native
        nativeClearTracks()
        
        // Decode and load each track
        for (track in tracks) {
            try {
                val pcmData = decodeAudioFile(track.uri)
                if (pcmData != null) {
                    // Convert startTimeMs to frames (44100 samples/sec)
                    val startFrame = (track.startTimeMs * SAMPLE_RATE / 1000).toInt()
                    
                    // Pass decoded audio to native engine
                    nativeLoadTrack(track.id, pcmData, startFrame)
                    Log.d(TAG, "Loaded track ${track.id}: ${pcmData.size} samples, startFrame=$startFrame")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to decode track ${track.id}", e)
            }
        }
        
        Log.d(TAG, "Loaded ${tracks.size} tracks to native engine")
    }

    fun play(playFromMs: Long) {
        if (isPlaying.get()) {
            Log.w(TAG, "Already playing, stopping first")
            stop()
        }
        
        Log.d(TAG, "Starting playback from ${playFromMs}ms")
        
        // Seek to starting position
        val startFrame = (playFromMs * SAMPLE_RATE / 1000)
        nativeSeekToFrame(startFrame)
        
        isPlaying.set(true)
        nativeStart()
    }

    fun playAndRecord(playFromMs: Long, recordStartMs: Long, onRecordingStarted: (Long) -> Unit) {
        if (isPlaying.get()) {
            Log.w(TAG, "Already playing, stopping first")
            stop()
        }
        
        Log.d(TAG, "Starting playback from ${playFromMs}ms, recording at ${recordStartMs}ms")
        
        onRecordingStartedCallback = onRecordingStarted
        pendingRecordStartMs = recordStartMs
        
        // Prepare raw recording file
        rawRecordingFile = File(context.cacheDir, "recording_raw_${System.currentTimeMillis()}.pcm")
        
        // Convert times to frames
        val startFrame = (playFromMs * SAMPLE_RATE / 1000)
        val recordStartFrame = (recordStartMs * SAMPLE_RATE / 1000).toInt()
        
        // Seek to starting position
        nativeSeekToFrame(startFrame)
        
        // Start recording (native will write raw PCM to file)
        nativeStartRecording(rawRecordingFile!!.absolutePath, recordStartFrame)
        
        isPlaying.set(true)
        isRecording.set(true)
        nativeStart()
        
        // Store actual start time for result
        recordingActualStartMs.set(recordStartMs)
        
        // Trigger callback immediately (native starts recording at exact frame)
        onRecordingStarted(recordStartMs)
    }

    fun getCurrentPositionMs(): Long {
        val currentFrame = nativeGetCurrentFrame()
        return currentFrame * 1000 / SAMPLE_RATE
    }

    fun stop() {
        Log.d(TAG, "Stopping playback and recording")
        nativeStop()
        isPlaying.set(false)
        isRecording.set(false)
    }

    fun stopRecording(): RecordingResult? {
        if (!isRecording.get()) {
            Log.w(TAG, "Not recording")
            return null
        }
        
        // Stop native recording
        nativeStopRecording()
        isRecording.set(false)
        
        // Get recording info from native
        val startFrame = nativeGetRecordingStartFrame()
        val sampleCount = nativeGetRecordedSampleCount()
        
        if (sampleCount <= 0) {
            Log.w(TAG, "No samples recorded")
            return null
        }
        
        val rawFile = rawRecordingFile ?: return null
        
        // Convert raw PCM to WAV
        val wavFile = File(context.cacheDir, "recording_${System.currentTimeMillis()}.wav")
        try {
            convertRawToWav(rawFile, wavFile, sampleCount.toInt())
            
            // Clean up raw file
            rawFile.delete()
            
            val startTimeMs = startFrame * 1000 / SAMPLE_RATE
            val durationMs = sampleCount * 1000 / SAMPLE_RATE
            
            Log.d(TAG, "Recording saved: ${wavFile.absolutePath}, duration: ${durationMs}ms")
            
            return RecordingResult(
                uri = "file://${wavFile.absolutePath}",
                startTimeMs = startTimeMs,
                durationMs = durationMs
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed to convert recording to WAV", e)
            return null
        }
    }

    /**
     * Convert raw PCM file to WAV file by prepending the 44-byte header
     */
    private fun convertRawToWav(rawFile: File, wavFile: File, sampleCount: Int) {
        val dataSize = sampleCount * BYTES_PER_SAMPLE
        val fileSize = 36 + dataSize
        
        RandomAccessFile(wavFile, "rw").use { raf ->
            // RIFF header
            raf.writeBytes("RIFF")
            raf.write(intToByteArrayLE(fileSize))
            raf.writeBytes("WAVE")
            
            // fmt chunk
            raf.writeBytes("fmt ")
            raf.write(intToByteArrayLE(16)) // Chunk size
            raf.write(shortToByteArrayLE(1)) // Audio format (PCM)
            raf.write(shortToByteArrayLE(CHANNELS_IN.toShort())) // Channels (mono)
            raf.write(intToByteArrayLE(SAMPLE_RATE)) // Sample rate
            raf.write(intToByteArrayLE(SAMPLE_RATE * CHANNELS_IN * BYTES_PER_SAMPLE)) // Byte rate
            raf.write(shortToByteArrayLE((CHANNELS_IN * BYTES_PER_SAMPLE).toShort())) // Block align
            raf.write(shortToByteArrayLE((BYTES_PER_SAMPLE * 8).toShort())) // Bits per sample
            
            // data chunk
            raf.writeBytes("data")
            raf.write(intToByteArrayLE(dataSize))
            
            // Copy raw PCM data
            rawFile.inputStream().use { input ->
                val buffer = ByteArray(8192)
                var bytesRead: Int
                while (input.read(buffer).also { bytesRead = it } != -1) {
                    raf.write(buffer, 0, bytesRead)
                }
            }
        }
    }

    private fun intToByteArrayLE(value: Int): ByteArray {
        return byteArrayOf(
            (value and 0xFF).toByte(),
            ((value shr 8) and 0xFF).toByte(),
            ((value shr 16) and 0xFF).toByte(),
            ((value shr 24) and 0xFF).toByte()
        )
    }

    private fun shortToByteArrayLE(value: Short): ByteArray {
        return byteArrayOf(
            (value.toInt() and 0xFF).toByte(),
            ((value.toInt() shr 8) and 0xFF).toByte()
        )
    }

    /**
     * Decode audio file to PCM samples using MediaCodec
     * This remains in Kotlin as it requires Android APIs
     */
    private fun decodeAudioFile(uriString: String): ShortArray? {
        try {
            val uri = Uri.parse(uriString)
            
            // Handle file:// URIs
            val path = if (uriString.startsWith("file://")) {
                uriString.removePrefix("file://")
            } else {
                uriString
            }
            
            val extractor = MediaExtractor()
            
            // Try to set data source
            try {
                if (File(path).exists()) {
                    extractor.setDataSource(path)
                } else {
                    val fd = context.contentResolver.openFileDescriptor(uri, "r")
                    if (fd != null) {
                        extractor.setDataSource(fd.fileDescriptor)
                        fd.close()
                    } else {
                        Log.e(TAG, "Could not open file: $uriString")
                        return null
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to set data source: $uriString", e)
                return null
            }
            
            // Find audio track
            var audioTrackIndex = -1
            var format: MediaFormat? = null
            for (i in 0 until extractor.trackCount) {
                val trackFormat = extractor.getTrackFormat(i)
                val mime = trackFormat.getString(MediaFormat.KEY_MIME) ?: continue
                if (mime.startsWith("audio/")) {
                    audioTrackIndex = i
                    format = trackFormat
                    break
                }
            }
            
            if (audioTrackIndex < 0 || format == null) {
                Log.e(TAG, "No audio track found in: $uriString")
                extractor.release()
                return null
            }
            
            extractor.selectTrack(audioTrackIndex)
            
            val mime = format.getString(MediaFormat.KEY_MIME)
            val decoder = MediaCodec.createDecoderByType(mime!!)
            decoder.configure(format, null, null, 0)
            decoder.start()
            
            // Check sample rate from input format (output format may not be available yet)
            val inputSampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            if (inputSampleRate != SAMPLE_RATE) {
                Log.e(TAG, "CRITICAL WARNING: Track is ${inputSampleRate}Hz but engine expects ${SAMPLE_RATE}Hz. " +
                    "Playback may be out of sync or have pitch issues! File: $uriString")
            }
            
            val samples = mutableListOf<Short>()
            val info = MediaCodec.BufferInfo()
            var isEOS = false
            var outputSampleRateChecked = false
            
            while (!isEOS) {
                // Feed input
                val inputIndex = decoder.dequeueInputBuffer(10000)
                if (inputIndex >= 0) {
                    val inputBuffer = decoder.getInputBuffer(inputIndex)
                    if (inputBuffer != null) {
                        val sampleSize = extractor.readSampleData(inputBuffer, 0)
                        if (sampleSize < 0) {
                            decoder.queueInputBuffer(
                                inputIndex, 0, 0, 0,
                                MediaCodec.BUFFER_FLAG_END_OF_STREAM
                            )
                            isEOS = true
                        } else {
                            decoder.queueInputBuffer(
                                inputIndex, 0, sampleSize,
                                extractor.sampleTime, 0
                            )
                            extractor.advance()
                        }
                    }
                }
                
                // Get output
                val outputIndex = decoder.dequeueOutputBuffer(info, 10000)
                if (outputIndex >= 0) {
                    // Check output sample rate on first valid output
                    if (!outputSampleRateChecked) {
                        outputSampleRateChecked = true
                        try {
                            val outputFormat = decoder.outputFormat
                            val outputSampleRate = outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                            if (outputSampleRate != SAMPLE_RATE) {
                                Log.e(TAG, "CRITICAL WARNING: Decoded output is ${outputSampleRate}Hz but engine expects ${SAMPLE_RATE}Hz. " +
                                    "Playback will be out of sync! Consider resampling. File: $uriString")
                            } else {
                                Log.d(TAG, "Audio sample rate OK: ${outputSampleRate}Hz")
                            }
                        } catch (e: Exception) {
                            Log.w(TAG, "Could not verify output sample rate", e)
                        }
                    }
                    
                    val outputBuffer = decoder.getOutputBuffer(outputIndex)
                    if (outputBuffer != null) {
                        outputBuffer.order(ByteOrder.LITTLE_ENDIAN)
                        val shortBuffer = outputBuffer.asShortBuffer()
                        val shortArray = ShortArray(shortBuffer.remaining())
                        shortBuffer.get(shortArray)
                        samples.addAll(shortArray.toList())
                    }
                    decoder.releaseOutputBuffer(outputIndex, false)
                    
                    if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                        isEOS = true
                    }
                }
            }
            
            decoder.stop()
            decoder.release()
            extractor.release()
            
            return samples.toShortArray()
            
        } catch (e: Exception) {
        Log.e(TAG, "Failed to decode audio file: $uriString", e)
            return null
        }
    }

    fun cleanup() {
        Log.d(TAG, "Cleaning up audio engine")
        
        stop()
        nativeDeleteEngine()
        
        loadedTracks = emptyList()
        rawRecordingFile?.delete()
        rawRecordingFile = null
        
        Log.d(TAG, "Audio engine cleaned up")
    }
}
