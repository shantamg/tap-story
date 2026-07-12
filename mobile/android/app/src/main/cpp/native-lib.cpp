#include <jni.h>

#include <mutex>
#include <shared_mutex>
#include <string>

#include "AudioEngine.h"

namespace {
AudioEngine *engine = nullptr;
// React Native methods and AudioDeviceCallback invalidation can enter JNI from
// different threads. Hold this for every engine access so deletion cannot race
// a route callback, notifier poll, diagnostic read, or recording finalization.
std::shared_mutex engineMutex;
}

extern "C" {

JNIEXPORT void JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeCreateEngine(JNIEnv *, jobject) {
    std::unique_lock<std::shared_mutex> lock(engineMutex);
    if (engine == nullptr) engine = new AudioEngine();
}

JNIEXPORT void JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeDeleteEngine(JNIEnv *, jobject) {
    std::unique_lock<std::shared_mutex> lock(engineMutex);
    delete engine;
    engine = nullptr;
}

JNIEXPORT jint JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativePrepare(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    if (!engine || !engine->prepare()) return 0;
    return engine->getSampleRate();
}

JNIEXPORT jboolean JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeStart(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine && engine->startSession() ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeStop(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    if (engine) engine->stopPlayback();
}

JNIEXPORT jboolean JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeLoadTrack(
        JNIEnv *env,
        jobject,
        jstring trackId,
        jshortArray audioData,
        jlong startFrame) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    if (!engine || !trackId || !audioData) return JNI_FALSE;

    const char *idChars = env->GetStringUTFChars(trackId, nullptr);
    if (!idChars) return JNI_FALSE;
    const std::string id(idChars);
    env->ReleaseStringUTFChars(trackId, idChars);

    const jsize frameCount = env->GetArrayLength(audioData);
    jshort *samples = env->GetShortArrayElements(audioData, nullptr);
    if (!samples) return JNI_FALSE;
    const bool loaded = engine->loadTrack(id, samples, frameCount, startFrame);
    env->ReleaseShortArrayElements(audioData, samples, JNI_ABORT);
    return loaded ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeClearTracks(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine && engine->clearTracks() ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeStartRecording(
        JNIEnv *env,
        jobject,
        jstring filePath,
        jlong punchFrame) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    if (!engine || !filePath) return JNI_FALSE;
    const char *pathChars = env->GetStringUTFChars(filePath, nullptr);
    if (!pathChars) return JNI_FALSE;
    const std::string path(pathChars);
    env->ReleaseStringUTFChars(filePath, pathChars);
    return engine->startRecording(path, punchFrame) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeSetLatencyCompensationFrames(
        JNIEnv *, jobject, jlong frames) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    if (engine) engine->setLatencyCompensationFrames(static_cast<int64_t>(frames));
}

JNIEXPORT void JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeInvalidateAudioRoute(
        JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    if (engine) engine->invalidateAudioRoute();
}

JNIEXPORT void JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeStopRecording(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    if (engine) engine->stopRecording();
}

JNIEXPORT jlong JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetCurrentFrame(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? static_cast<jlong>(engine->getCurrentFrame()) : 0;
}

JNIEXPORT void JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeSeekToFrame(
        JNIEnv *, jobject, jlong frame) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    if (engine) engine->seekToFrame(static_cast<int64_t>(frame));
}

JNIEXPORT jlong JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetRecordingStartFrame(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? static_cast<jlong>(engine->getRecordingStartFrame()) : -1;
}

JNIEXPORT jlong JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetRecordingEndFrame(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? static_cast<jlong>(engine->getRecordingEndFrame()) : -1;
}

JNIEXPORT jlong JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetRequestedPunchFrame(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? static_cast<jlong>(engine->getRequestedPunchFrame()) : -1;
}

JNIEXPORT jlong JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetLatencyCompensationFrames(
        JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? static_cast<jlong>(engine->getLatencyCompensationFrames()) : 0;
}

JNIEXPORT jlong JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetRecordedSampleCount(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? static_cast<jlong>(engine->getRecordedSampleCount()) : 0;
}

JNIEXPORT jlong JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetDroppedCaptureFrameCount(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? static_cast<jlong>(engine->getDroppedCaptureFrameCount()) : 0;
}

JNIEXPORT jlong JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetShortInputFrameCount(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? static_cast<jlong>(engine->getShortInputFrameCount()) : 0;
}

JNIEXPORT jboolean JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeIsCaptureOnsetExact(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine && engine->isCaptureOnsetExact() ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeIsCaptureClockDriftWithinBounds(
        JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine && engine->isCaptureClockDriftWithinBounds() ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jlong JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetCaptureClockDriftFrameLimit(
        JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? static_cast<jlong>(engine->getCaptureClockDriftFrameLimit()) : 0;
}

JNIEXPORT jint JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetInputXRunDelta(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? engine->getInputXRunDelta() : 0;
}

JNIEXPORT jint JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetOutputXRunDelta(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? engine->getOutputXRunDelta() : 0;
}

JNIEXPORT jint JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetSampleRate(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? engine->getSampleRate() : 0;
}

JNIEXPORT jdouble JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetInputLatencyMillis(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? engine->getInputLatencyMillis() : -1.0;
}

JNIEXPORT jdouble JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetOutputLatencyMillis(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? engine->getOutputLatencyMillis() : -1.0;
}

JNIEXPORT jint JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetInputXRunCount(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? engine->getInputXRunCount() : -1;
}

JNIEXPORT jint JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetOutputXRunCount(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? engine->getOutputXRunCount() : -1;
}

JNIEXPORT jint JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetInputFramesPerBurst(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? engine->getInputFramesPerBurst() : 0;
}

JNIEXPORT jint JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetOutputFramesPerBurst(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? engine->getOutputFramesPerBurst() : 0;
}

JNIEXPORT jint JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetInputPerformanceMode(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? engine->getInputPerformanceMode() : -1;
}

JNIEXPORT jint JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetOutputPerformanceMode(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? engine->getOutputPerformanceMode() : -1;
}

JNIEXPORT jint JNICALL
Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetLastStreamError(JNIEnv *, jobject) {
    std::shared_lock<std::shared_mutex> lock(engineMutex);
    return engine ? engine->getLastStreamError() : 0;
}

}
