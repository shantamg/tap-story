package com.tapstory.audio

/**
 * Data class representing an audio track for playback
 * Named TrackInfo to avoid conflict with android.media.AudioTrack
 */
data class TrackInfo(
    val id: String,
    val uri: String,
    val startTimeMs: Long
)

/**
 * Data class representing the result of a recording
 */
data class RecordingResult(
    val uri: String,
    val startTimeMs: Long,
    val durationMs: Long,
    val startFrame: Long,
    val actualStartFrame: Long,
    val endFrame: Long,
    val frameCount: Long,
    val rawInputFrameCount: Long,
    val droppedFrameCount: Long,
    val shortInputFrameCount: Long,
    val clockDriftFrameLimit: Long,
    val inputXRunCount: Int,
    val outputXRunCount: Int,
    val sampleRate: Int
)

data class AudioDiagnostics(
    val sampleRate: Int,
    val inputLatencyMs: Double,
    val outputLatencyMs: Double,
    val inputXRunCount: Int,
    val outputXRunCount: Int,
    val inputFramesPerBurst: Int,
    val outputFramesPerBurst: Int,
    val inputPerformanceMode: Int,
    val outputPerformanceMode: Int,
    val lastStreamError: Int,
    val requestedPunchFrame: Long,
    val actualRecordingStartFrame: Long,
    val recordingEndFrame: Long,
    val latencyCompensationFrames: Long,
    val rawInputFrameCount: Long,
    val droppedCaptureFrameCount: Long,
    val shortInputFrameCount: Long,
    val clockDriftFrameLimit: Long,
    val captureOnsetExact: Boolean,
    val inputXRunDelta: Int,
    val outputXRunDelta: Int
)
