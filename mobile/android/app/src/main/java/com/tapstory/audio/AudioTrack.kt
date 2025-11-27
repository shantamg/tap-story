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
    val durationMs: Long
)

