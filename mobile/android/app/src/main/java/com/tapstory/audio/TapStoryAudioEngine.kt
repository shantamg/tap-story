package com.tapstory.audio

import android.content.Context
import android.media.AudioFormat
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
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * Android synchronized audio engine backed by Oboe FullDuplexStream.
 * Compressed files are decoded, mixed to mono, and resampled to the actual
 * negotiated duplex rate before crossing JNI.
 */
class TapStoryAudioEngine(private val context: Context) {

    companion object {
        private const val TAG = "TapStoryAudioEngine"
        private const val CHANNELS_IN = 1
        private const val BYTES_PER_SAMPLE = 2
        private const val CODEC_TIMEOUT_US = 10_000L
        private const val LATENCY_WARMUP_MS = 250L
        private const val MAX_LATENCY_COMPENSATION_MS = 1_000.0

        init {
            System.loadLibrary("tapstory-audio")
        }
    }

    private external fun nativeCreateEngine()
    private external fun nativeDeleteEngine()
    private external fun nativePrepare(): Int
    private external fun nativeStart(): Boolean
    private external fun nativeStop()
    private external fun nativeLoadTrack(
        id: String,
        data: ShortArray,
        startFrame: Long
    ): Boolean
    private external fun nativeClearTracks(): Boolean
    private external fun nativeStartRecording(filePath: String, startFrame: Long): Boolean
    private external fun nativeSetLatencyCompensationFrames(frames: Long)
    private external fun nativeInvalidateAudioRoute()
    private external fun nativeStopRecording()
    private external fun nativeGetCurrentFrame(): Long
    private external fun nativeSeekToFrame(frame: Long)
    private external fun nativeGetRecordingStartFrame(): Long
    private external fun nativeGetRecordingEndFrame(): Long
    private external fun nativeGetRequestedPunchFrame(): Long
    private external fun nativeGetLatencyCompensationFrames(): Long
    private external fun nativeGetRecordedSampleCount(): Long
    private external fun nativeGetDroppedCaptureFrameCount(): Long
    private external fun nativeGetShortInputFrameCount(): Long
    private external fun nativeIsCaptureOnsetExact(): Boolean
    private external fun nativeIsCaptureClockDriftWithinBounds(): Boolean
    private external fun nativeGetCaptureClockDriftFrameLimit(): Long
    private external fun nativeGetInputXRunDelta(): Int
    private external fun nativeGetOutputXRunDelta(): Int
    private external fun nativeGetSampleRate(): Int
    private external fun nativeGetInputLatencyMillis(): Double
    private external fun nativeGetOutputLatencyMillis(): Double
    private external fun nativeGetInputXRunCount(): Int
    private external fun nativeGetOutputXRunCount(): Int
    private external fun nativeGetInputFramesPerBurst(): Int
    private external fun nativeGetOutputFramesPerBurst(): Int
    private external fun nativeGetInputPerformanceMode(): Int
    private external fun nativeGetOutputPerformanceMode(): Int
    private external fun nativeGetLastStreamError(): Int

    private val isPlaying = AtomicBoolean(false)
    private val isRecording = AtomicBoolean(false)
    private var loadedTracks: List<TrackInfo> = emptyList()
    private var rawRecordingFile: File? = null
    private var sampleRate: Int = 0
    private var requestedRecordingStartMs: Long = 0
    @Volatile private var recordingNotifierThread: Thread? = null

    fun initialize() {
        nativeCreateEngine()
        sampleRate = nativePrepare()
        if (sampleRate <= 0) {
            nativeDeleteEngine()
            throw IllegalStateException(
                "Unable to open matching low-latency input/output streams. " +
                    "Verify microphone permission and the active audio route."
            )
        }
        // Timestamps are unavailable until both streams have moved audio. Run a
        // short silent duplex warmup once so the first overdub can use measured
        // route latency instead of silently falling back to zero.
        try {
            check(nativeStart()) { "Unable to start duplex latency warmup" }
            Thread.sleep(LATENCY_WARMUP_MS)
        } finally {
            nativeStop()
            nativeSeekToFrame(0)
        }
        check(nativeGetLastStreamError() == 0) {
            "Duplex latency warmup failed with native error ${nativeGetLastStreamError()}"
        }
        Log.i(TAG, "Native duplex engine prepared at ${sampleRate}Hz")
    }

    fun loadTracks(tracks: List<TrackInfo>) {
        check(!isRecording.get()) { "Cannot replace tracks while recording" }
        if (isPlaying.get()) stop()
        check(sampleRate > 0) { "Audio engine is not initialized" }
        check(nativeClearTracks()) { "Native engine refused to clear tracks" }

        for (track in tracks) {
            val pcmData = decodeAudioFile(track.uri, sampleRate)
                ?: throw IllegalArgumentException("Failed to decode track ${track.id}")
            val startFrame = millisecondsToFrames(track.startTimeMs)
            check(nativeLoadTrack(track.id, pcmData, startFrame)) {
                "Native engine refused track ${track.id}"
            }
            Log.i(
                TAG,
                "Loaded ${track.id}: ${pcmData.size} mono frames at ${sampleRate}Hz, " +
                    "startFrame=$startFrame"
            )
        }
        loadedTracks = tracks
    }

    fun play(playFromMs: Long) {
        if (isPlaying.get()) stop()
        check(sampleRate > 0) { "Audio engine is not initialized" }
        nativeSeekToFrame(millisecondsToFrames(playFromMs))
        check(nativeStart()) { "Failed to start native duplex streams" }
        isPlaying.set(true)
    }

    fun playAndRecord(
        playFromMs: Long,
        recordStartMs: Long,
        onRecordingStarted: (Long) -> Unit
    ) {
        if (isPlaying.get()) stop()
        check(!isRecording.get()) { "A recording is already active" }
        check(sampleRate > 0) { "Audio engine is not initialized" }

        rawRecordingFile = File(
            context.cacheDir,
            "recording_raw_${System.currentTimeMillis()}.pcm"
        )
        nativeSeekToFrame(millisecondsToFrames(playFromMs))
        val punchFrame = millisecondsToFrames(recordStartMs)
        requestedRecordingStartMs = recordStartMs
        check(nativeStartRecording(rawRecordingFile!!.absolutePath, punchFrame)) {
            "Failed to arm native recording"
        }

        isRecording.set(true)
        if (!nativeStart()) {
            nativeStopRecording()
            isRecording.set(false)
            rawRecordingFile?.delete()
            rawRecordingFile = null
            throw IllegalStateException(
                "Failed to start native duplex streams (error ${nativeGetLastStreamError()}); " +
                    "reinitialize after an audio route change"
            )
        }
        isPlaying.set(true)
        startRecordingStartNotifier(onRecordingStarted)
    }

    fun setLatencyCompensationMs(compensationMs: Double) {
        require(
            compensationMs.isFinite() &&
                compensationMs in 0.0..MAX_LATENCY_COMPENSATION_MS
        ) {
            "Latency compensation must be between 0 and " +
                "${MAX_LATENCY_COMPENSATION_MS.toInt()}ms"
        }
        check(sampleRate > 0) { "Audio engine is not initialized" }
        check(!isRecording.get()) { "Cannot change latency compensation during a take" }
        val frames = (compensationMs * sampleRate / 1000.0).roundToLong()
        nativeSetLatencyCompensationFrames(frames)
        Log.i(TAG, "Latency compensation set to ${compensationMs}ms ($frames frames)")
    }

    fun invalidateAudioRoute() {
        if (sampleRate <= 0) return
        nativeInvalidateAudioRoute()
        isPlaying.set(false)
    }

    private fun startRecordingStartNotifier(onRecordingStarted: (Long) -> Unit) {
        recordingNotifierThread?.interrupt()
        recordingNotifierThread = Thread({
            while (isRecording.get() && !Thread.currentThread().isInterrupted) {
                val actualStartFrame = nativeGetRecordingStartFrame()
                if (actualStartFrame >= 0) {
                    onRecordingStarted(actualStartFrame * 1000L / sampleRate)
                    return@Thread
                }
                try {
                    Thread.sleep(2)
                } catch (_: InterruptedException) {
                    return@Thread
                }
            }
        }, "TapStoryRecordingStart").also { it.start() }
    }

    fun getCurrentPositionMs(): Long {
        if (sampleRate <= 0) return 0
        return nativeGetCurrentFrame() * 1000L / sampleRate
    }

    /** Stops playback without invalidating an armed or completed recording. */
    fun stop() {
        nativeStop()
        isPlaying.set(false)
    }

    fun stopRecording(): RecordingResult? {
        if (!isRecording.get()) return null

        nativeStopRecording()
        isRecording.set(false)
        recordingNotifierThread?.interrupt()
        recordingNotifierThread = null

        val requestedPunchFrame = nativeGetRequestedPunchFrame()
        val actualStartFrame = nativeGetRecordingStartFrame()
        val endFrame = nativeGetRecordingEndFrame()
        val rawInputFrames = nativeGetRecordedSampleCount()
        val droppedFrames = nativeGetDroppedCaptureFrameCount()
        val shortInputFrames = nativeGetShortInputFrameCount()
        val captureOnsetExact = nativeIsCaptureOnsetExact()
        val clockDriftWithinBounds = nativeIsCaptureClockDriftWithinBounds()
        val clockDriftFrameLimit = nativeGetCaptureClockDriftFrameLimit()
        val inputXRuns = nativeGetInputXRunDelta()
        val outputXRuns = nativeGetOutputXRunDelta()
        val streamError = nativeGetLastStreamError()
        val timelineFrames = endFrame - actualStartFrame
        val rawFile = rawRecordingFile ?: return null

        if (streamError != 0) {
            rawFile.delete()
            rawRecordingFile = null
            throw IllegalStateException(
                "Audio stream or recording writer failed with native error $streamError. " +
                    "The take was discarded; reinitialize the engine before retrying."
            )
        }

        if (requestedPunchFrame < 0 || actualStartFrame < 0 ||
            endFrame <= actualStartFrame || rawInputFrames <= 0
        ) {
            rawFile.delete()
            rawRecordingFile = null
            return null
        }
        if (droppedFrames > 0) {
            rawFile.delete()
            rawRecordingFile = null
            throw IllegalStateException(
                "Recording overflowed its realtime ring buffer: " +
                    "$droppedFrames frames were dropped. The take was not stretched or saved."
            )
        }
        if (!captureOnsetExact) {
            rawFile.delete()
            rawRecordingFile = null
            throw IllegalStateException(
                "The input stream did not deliver the exact compensated punch frame. " +
                    "The onset-shifted take was discarded instead of being moved silently."
            )
        }
        if (loadedTracks.isNotEmpty() && (inputXRuns < 0 || outputXRuns < 0)) {
            rawFile.delete()
            rawRecordingFile = null
            throw IllegalStateException(
                "This Android audio route cannot report input/output discontinuities. " +
                    "Synchronized overdubs require xrun diagnostics, so the take was discarded."
            )
        }
        if (inputXRuns > 0 || outputXRuns > 0) {
            rawFile.delete()
            rawRecordingFile = null
            throw IllegalStateException(
                "The audio route reported discontinuities during capture " +
                    "(input xruns=$inputXRuns, output xruns=$outputXRuns). " +
                    "The take was discarded instead of concealing the gap."
            )
        }
        if (!clockDriftWithinBounds) {
            rawFile.delete()
            rawRecordingFile = null
            throw IllegalStateException(
                "Input/output clock drift exceeded the safe correction bound: " +
                    "raw=$rawInputFrames, timeline=$timelineFrames, " +
                    "limit=$clockDriftFrameLimit frames. The take was discarded."
            )
        }

        val wavFile = File(context.cacheDir, "recording_${System.currentTimeMillis()}.wav")
        try {
            convertRawToWav(
                rawFile = rawFile,
                wavFile = wavFile,
                rawSampleCount = rawInputFrames,
                targetSampleCount = timelineFrames,
                outputSampleRate = sampleRate
            )
        } catch (error: Exception) {
            wavFile.delete()
            rawFile.delete()
            rawRecordingFile = null
            throw error
        }
        rawFile.delete()
        rawRecordingFile = null

        if (rawInputFrames != timelineFrames) {
            Log.i(
                TAG,
                "Corrected duplex clock drift: rawInputFrames=$rawInputFrames, " +
                    "timelineFrames=$timelineFrames, delta=${rawInputFrames - timelineFrames}"
            )
        }

        return RecordingResult(
            uri = "file://${wavFile.absolutePath}",
            startTimeMs = requestedRecordingStartMs,
            durationMs = (timelineFrames * 1000.0 / sampleRate).roundToLong(),
            startFrame = requestedPunchFrame,
            actualStartFrame = actualStartFrame,
            endFrame = endFrame,
            frameCount = timelineFrames,
            rawInputFrameCount = rawInputFrames,
            droppedFrameCount = droppedFrames,
            shortInputFrameCount = shortInputFrames,
            clockDriftFrameLimit = clockDriftFrameLimit,
            inputXRunCount = inputXRuns,
            outputXRunCount = outputXRuns,
            sampleRate = sampleRate
        )
    }

    fun getDiagnostics(): AudioDiagnostics = AudioDiagnostics(
        sampleRate = nativeGetSampleRate(),
        inputLatencyMs = nativeGetInputLatencyMillis(),
        outputLatencyMs = nativeGetOutputLatencyMillis(),
        inputXRunCount = nativeGetInputXRunCount(),
        outputXRunCount = nativeGetOutputXRunCount(),
        inputFramesPerBurst = nativeGetInputFramesPerBurst(),
        outputFramesPerBurst = nativeGetOutputFramesPerBurst(),
        inputPerformanceMode = nativeGetInputPerformanceMode(),
        outputPerformanceMode = nativeGetOutputPerformanceMode(),
        lastStreamError = nativeGetLastStreamError(),
        requestedPunchFrame = nativeGetRequestedPunchFrame(),
        actualRecordingStartFrame = nativeGetRecordingStartFrame(),
        recordingEndFrame = nativeGetRecordingEndFrame(),
        latencyCompensationFrames = nativeGetLatencyCompensationFrames(),
        rawInputFrameCount = nativeGetRecordedSampleCount(),
        droppedCaptureFrameCount = nativeGetDroppedCaptureFrameCount(),
        shortInputFrameCount = nativeGetShortInputFrameCount(),
        clockDriftFrameLimit = nativeGetCaptureClockDriftFrameLimit(),
        captureOnsetExact = nativeIsCaptureOnsetExact(),
        inputXRunDelta = nativeGetInputXRunDelta(),
        outputXRunDelta = nativeGetOutputXRunDelta()
    )

    fun cleanup() {
        if (isPlaying.get()) stop()
        if (isRecording.get()) {
            nativeStopRecording()
            isRecording.set(false)
        }
        recordingNotifierThread?.interrupt()
        recordingNotifierThread = null
        nativeDeleteEngine()
        sampleRate = 0
        loadedTracks = emptyList()
        rawRecordingFile?.delete()
        rawRecordingFile = null
        requestedRecordingStartMs = 0
    }

    private fun millisecondsToFrames(milliseconds: Long): Long =
        (milliseconds * sampleRate / 1000.0).roundToLong()

    private class FloatAccumulator(initialCapacity: Int = 16_384) {
        private var values = FloatArray(initialCapacity)
        var size: Int = 0
            private set

        fun append(value: Float) {
            if (size == values.size) values = values.copyOf(values.size * 2)
            values[size++] = value
        }

        fun toArray(): FloatArray = values.copyOf(size)
    }

    private fun decodeAudioFile(uriString: String, targetSampleRate: Int): ShortArray? {
        val extractor = MediaExtractor()
        var decoder: MediaCodec? = null
        var descriptor: android.os.ParcelFileDescriptor? = null

        try {
            val uri = Uri.parse(uriString)
            val path = uriString.removePrefix("file://")
            if (File(path).exists()) {
                extractor.setDataSource(path)
            } else {
                descriptor = context.contentResolver.openFileDescriptor(uri, "r")
                    ?: return null
                extractor.setDataSource(descriptor.fileDescriptor)
            }

            var audioTrackIndex = -1
            var inputFormat: MediaFormat? = null
            for (index in 0 until extractor.trackCount) {
                val candidate = extractor.getTrackFormat(index)
                val mime = candidate.getString(MediaFormat.KEY_MIME) ?: continue
                if (mime.startsWith("audio/")) {
                    audioTrackIndex = index
                    inputFormat = candidate
                    break
                }
            }
            val format = inputFormat ?: return null
            if (audioTrackIndex < 0) return null

            extractor.selectTrack(audioTrackIndex)
            // Request deterministic PCM16 when supported. Output-format changes
            // are still inspected rather than assuming the request was honored.
            format.setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
            val mime = format.getString(MediaFormat.KEY_MIME) ?: return null
            decoder = MediaCodec.createDecoderByType(mime)
            decoder.configure(format, null, null, 0)
            decoder.start()

            var outputChannels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            var outputSampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            var pcmEncoding = AudioFormat.ENCODING_PCM_16BIT
            val monoSamples = FloatAccumulator()
            val info = MediaCodec.BufferInfo()
            var inputDone = false
            var outputDone = false

            while (!outputDone) {
                if (!inputDone) {
                    val inputIndex = decoder.dequeueInputBuffer(CODEC_TIMEOUT_US)
                    if (inputIndex >= 0) {
                        val inputBuffer = decoder.getInputBuffer(inputIndex)
                            ?: throw IllegalStateException("Decoder returned no input buffer")
                        inputBuffer.clear()
                        val sampleSize = extractor.readSampleData(inputBuffer, 0)
                        if (sampleSize < 0) {
                            decoder.queueInputBuffer(
                                inputIndex,
                                0,
                                0,
                                0,
                                MediaCodec.BUFFER_FLAG_END_OF_STREAM
                            )
                            inputDone = true
                        } else {
                            decoder.queueInputBuffer(
                                inputIndex,
                                0,
                                sampleSize,
                                extractor.sampleTime,
                                0
                            )
                            extractor.advance()
                        }
                    }
                }

                when (val outputIndex = decoder.dequeueOutputBuffer(info, CODEC_TIMEOUT_US)) {
                    MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        val outputFormat = decoder.outputFormat
                        outputChannels = outputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                        outputSampleRate = outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                        pcmEncoding = if (outputFormat.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
                            outputFormat.getInteger(MediaFormat.KEY_PCM_ENCODING)
                        } else {
                            AudioFormat.ENCODING_PCM_16BIT
                        }
                    }
                    MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
                    else -> if (outputIndex >= 0) {
                        val outputBuffer = decoder.getOutputBuffer(outputIndex)
                        if (outputBuffer != null && info.size > 0 &&
                            info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0
                        ) {
                            appendDecodedMono(
                                outputBuffer,
                                info,
                                outputChannels,
                                pcmEncoding,
                                monoSamples
                            )
                        }
                        outputDone = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                        decoder.releaseOutputBuffer(outputIndex, false)
                    }
                }
            }

            val mono = monoSamples.toArray()
            if (mono.isEmpty()) return null
            return resampleAndConvertToPcm16(mono, outputSampleRate, targetSampleRate)
        } catch (error: Exception) {
            Log.e(TAG, "Failed to decode $uriString", error)
            return null
        } finally {
            try {
                decoder?.stop()
            } catch (_: Exception) {
            }
            decoder?.release()
            extractor.release()
            descriptor?.close()
        }
    }

    private fun appendDecodedMono(
        source: ByteBuffer,
        info: MediaCodec.BufferInfo,
        channelCount: Int,
        pcmEncoding: Int,
        destination: FloatAccumulator
    ) {
        require(channelCount > 0) { "Decoder returned invalid channel count" }
        val start = info.offset.coerceAtLeast(0)
        val end = (start + info.size).coerceAtMost(source.capacity())
        require(end >= start) { "Decoder returned invalid BufferInfo range" }
        val pcm = source.duplicate().order(ByteOrder.LITTLE_ENDIAN)
        pcm.position(start)
        pcm.limit(end)

        val bytesPerSample = when (pcmEncoding) {
            AudioFormat.ENCODING_PCM_16BIT -> 2
            AudioFormat.ENCODING_PCM_FLOAT -> 4
            else -> throw IllegalArgumentException("Unsupported decoder PCM encoding: $pcmEncoding")
        }
        val frameCount = pcm.remaining() / (bytesPerSample * channelCount)
        repeat(frameCount) {
            var mixed = 0f
            repeat(channelCount) {
                mixed += when (pcmEncoding) {
                    AudioFormat.ENCODING_PCM_16BIT -> pcm.short / 32768.0f
                    else -> pcm.float
                }
            }
            destination.append(mixed / channelCount)
        }
    }

    private fun resampleAndConvertToPcm16(
        input: FloatArray,
        inputSampleRate: Int,
        outputSampleRate: Int
    ): ShortArray {
        require(inputSampleRate > 0 && outputSampleRate > 0)
        val outputFrameCount = if (inputSampleRate == outputSampleRate) {
            input.size
        } else {
            ((input.size.toLong() * outputSampleRate + inputSampleRate / 2) /
                inputSampleRate).toInt()
        }
        val output = ShortArray(outputFrameCount)
        for (outputFrame in 0 until outputFrameCount) {
            val sourcePosition = outputFrame.toDouble() * inputSampleRate / outputSampleRate
            val lower = floor(sourcePosition).toInt().coerceIn(0, input.lastIndex)
            val upper = min(lower + 1, input.lastIndex)
            val fraction = (sourcePosition - lower).toFloat()
            val sample = input[lower] + (input[upper] - input[lower]) * fraction
            output[outputFrame] = (sample.coerceIn(-1f, 1f) * 32767f).roundToInt().toShort()
        }
        return output
    }

    /**
     * Writes an exact-timeline-length WAV. A small raw/timeline discrepancy is
     * expected when independent hardware clocks differ; linear offline
     * resampling removes that accumulated drift. Ring overflow is rejected by
     * the caller and never hidden by this method.
     */
    private fun convertRawToWav(
        rawFile: File,
        wavFile: File,
        rawSampleCount: Long,
        targetSampleCount: Long,
        outputSampleRate: Int
    ) {
        require(rawSampleCount in 1..Int.MAX_VALUE)
        require(targetSampleCount in 1..Int.MAX_VALUE)
        require(rawFile.length() >= rawSampleCount * BYTES_PER_SAMPLE)

        val targetDataSize = targetSampleCount * BYTES_PER_SAMPLE
        require(targetDataSize <= UInt.MAX_VALUE.toLong()) { "Recording exceeds WAV size limit" }

        RandomAccessFile(wavFile, "rw").use { output ->
            output.setLength(0)
            writeWavHeader(output, targetDataSize.toInt(), outputSampleRate)

            if (rawSampleCount == targetSampleCount) {
                rawFile.inputStream().use { input ->
                    val buffer = ByteArray(8192)
                    var remaining = rawSampleCount * BYTES_PER_SAMPLE
                    while (remaining > 0) {
                        val read = input.read(buffer, 0, min(buffer.size.toLong(), remaining).toInt())
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        remaining -= read
                    }
                }
                return@use
            }

            val rawFrames = rawSampleCount.toInt()
            val targetFrames = targetSampleCount.toInt()
            val outputChunk = ByteArray(8192)
            var chunkOffset = 0

            rawFile.inputStream().buffered().use { input ->
                fun readSample(): Int {
                    val low = input.read()
                    val high = input.read()
                    check(low >= 0 && high >= 0) { "Raw recording ended before its frame count" }
                    return ((high shl 8) or low).toShort().toInt()
                }

                var lowerFrame = 0
                var lowerSample = readSample()
                var upperSample = if (rawFrames > 1) readSample() else lowerSample

                for (targetFrame in 0 until targetFrames) {
                    val sourcePosition = targetFrame.toDouble() * rawFrames / targetFrames
                    val wantedLower = floor(sourcePosition).toInt().coerceIn(0, rawFrames - 1)
                    while (lowerFrame < wantedLower) {
                        lowerSample = upperSample
                        lowerFrame++
                        upperSample = if (lowerFrame + 1 < rawFrames) {
                            readSample()
                        } else {
                            lowerSample
                        }
                    }
                    val fraction = sourcePosition - wantedLower
                    val interpolated = (
                        lowerSample + (upperSample - lowerSample) * fraction
                    ).roundToInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
                    outputChunk[chunkOffset++] = (interpolated and 0xff).toByte()
                    outputChunk[chunkOffset++] = ((interpolated shr 8) and 0xff).toByte()
                    if (chunkOffset == outputChunk.size) {
                        output.write(outputChunk)
                        chunkOffset = 0
                    }
                }
            }
            if (chunkOffset > 0) output.write(outputChunk, 0, chunkOffset)
        }
    }

    private fun writeWavHeader(output: RandomAccessFile, dataSize: Int, outputSampleRate: Int) {
        output.writeBytes("RIFF")
        output.write(intToByteArrayLE(36 + dataSize))
        output.writeBytes("WAVE")
        output.writeBytes("fmt ")
        output.write(intToByteArrayLE(16))
        output.write(shortToByteArrayLE(1))
        output.write(shortToByteArrayLE(CHANNELS_IN.toShort()))
        output.write(intToByteArrayLE(outputSampleRate))
        output.write(intToByteArrayLE(outputSampleRate * CHANNELS_IN * BYTES_PER_SAMPLE))
        output.write(shortToByteArrayLE((CHANNELS_IN * BYTES_PER_SAMPLE).toShort()))
        output.write(shortToByteArrayLE((BYTES_PER_SAMPLE * 8).toShort()))
        output.writeBytes("data")
        output.write(intToByteArrayLE(dataSize))
    }

    private fun intToByteArrayLE(value: Int): ByteArray = byteArrayOf(
        (value and 0xff).toByte(),
        ((value shr 8) and 0xff).toByte(),
        ((value shr 16) and 0xff).toByte(),
        ((value shr 24) and 0xff).toByte()
    )

    private fun shortToByteArrayLE(value: Int): ByteArray = byteArrayOf(
        (value and 0xff).toByte(),
        ((value shr 8) and 0xff).toByte()
    )

    private fun shortToByteArrayLE(value: Short): ByteArray =
        shortToByteArrayLE(value.toInt())
}
