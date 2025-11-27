#include <jni.h>
#include <string>
#include "AudioEngine.h"

static AudioEngine *engine = nullptr;

extern "C" {

    JNIEXPORT void JNICALL
    Java_com_tapstory_audio_TapStoryAudioEngine_nativeCreateEngine(JNIEnv *env, jobject thiz) {
        if (engine == nullptr) {
            engine = new AudioEngine();
        }
    }

    JNIEXPORT void JNICALL
    Java_com_tapstory_audio_TapStoryAudioEngine_nativeDeleteEngine(JNIEnv *env, jobject thiz) {
        if (engine) {
            delete engine;
            engine = nullptr;
        }
    }

    JNIEXPORT void JNICALL
    Java_com_tapstory_audio_TapStoryAudioEngine_nativeStart(JNIEnv *env, jobject thiz) {
        if (engine) {
            engine->start();
        }
    }

    JNIEXPORT void JNICALL
    Java_com_tapstory_audio_TapStoryAudioEngine_nativeStop(JNIEnv *env, jobject thiz) {
        if (engine) {
            engine->stop();
        }
    }
    
    JNIEXPORT void JNICALL
    Java_com_tapstory_audio_TapStoryAudioEngine_nativeLoadTrack(
            JNIEnv *env, jobject thiz,
            jstring trackId,
            jshortArray audioData,
            jint startFrame) {
        
        if (!engine) return;

        // Convert jstring to std::string
        const char *idChars = env->GetStringUTFChars(trackId, nullptr);
        std::string sId(idChars);
        env->ReleaseStringUTFChars(trackId, idChars);

        // Access Java ShortArray directly (zero-copy access)
        jsize len = env->GetArrayLength(audioData);
        jshort *body = env->GetShortArrayElements(audioData, nullptr);

        engine->loadTrack(sId, body, len, startFrame);

        env->ReleaseShortArrayElements(audioData, body, JNI_ABORT);  // JNI_ABORT = don't copy back
    }
    
    JNIEXPORT void JNICALL
    Java_com_tapstory_audio_TapStoryAudioEngine_nativeClearTracks(JNIEnv *env, jobject thiz) {
        if (engine) {
            engine->clearTracks();
        }
    }
    
    JNIEXPORT void JNICALL
    Java_com_tapstory_audio_TapStoryAudioEngine_nativeStartRecording(
            JNIEnv *env, jobject thiz, 
            jstring filePath, 
            jint startFrame) {
        if (!engine) return;
        
        const char *pathChars = env->GetStringUTFChars(filePath, nullptr);
        std::string sPath(pathChars);
        env->ReleaseStringUTFChars(filePath, pathChars);
        
        engine->startRecording(sPath, startFrame);
    }
    
    JNIEXPORT void JNICALL
    Java_com_tapstory_audio_TapStoryAudioEngine_nativeStopRecording(JNIEnv *env, jobject thiz) {
        if (engine) {
            engine->stopRecording();
        }
    }
    
    JNIEXPORT jlong JNICALL
    Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetCurrentFrame(JNIEnv *env, jobject thiz) {
        if (engine) {
            return static_cast<jlong>(engine->getCurrentFrame());
        }
        return 0;
    }
    
    JNIEXPORT void JNICALL
    Java_com_tapstory_audio_TapStoryAudioEngine_nativeSeekToFrame(JNIEnv *env, jobject thiz, jlong frame) {
        if (engine) {
            engine->seekToFrame(static_cast<int64_t>(frame));
        }
    }
    
    JNIEXPORT jlong JNICALL
    Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetRecordingStartFrame(JNIEnv *env, jobject thiz) {
        if (engine) {
            return static_cast<jlong>(engine->getRecordingStartFrame());
        }
        return 0;
    }
    
    JNIEXPORT jlong JNICALL
    Java_com_tapstory_audio_TapStoryAudioEngine_nativeGetRecordedSampleCount(JNIEnv *env, jobject thiz) {
        if (engine) {
            return static_cast<jlong>(engine->getRecordedSampleCount());
        }
        return 0;
    }

}

