import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Button, Alert, ScrollView } from 'react-native';
import { AudioRecorder } from '../services/audioService';
import { DuetPlayer } from '../services/duetPlayer';
import { RecordButton } from './RecordButton';
import { AudioTimeline } from './AudioTimeline';
import { getApiUrl } from '../utils/api';
import { saveRecordingLocally, getLocalAudioPath } from '../services/audioStorage';

interface AudioChainNode {
  id: string;
  audioUrl: string;       // Remote S3 presigned URL
  localUri?: string;      // Local file URI (if available)
  duration: number;
  startTime: number;      // When this segment starts in the timeline (seconds)
  parentId: string | null;
}

export function DuetRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [audioChain, setAudioChain] = useState<AudioChainNode[]>([]);
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);

  const recorder = useRef(new AudioRecorder());
  const player = useRef(new DuetPlayer());
  const recordingStartTimestamp = useRef(0);
  const recordingStartTimeInChain = useRef(0);  // When in the chain timeline this recording starts

  useEffect(() => {
    initAudio();
    return () => {
      recorder.current.cleanup();
      player.current.cleanup();
    };
  }, []);

  async function initAudio() {
    try {
      await recorder.current.init();
    } catch (error) {
      Alert.alert('Error', 'Failed to initialize audio. Please grant microphone permissions.');
    }
  }

  /**
   * Calculate when the next recording should start in the timeline.
   *
   * Rules:
   * - Recording 1 (A): starts at 0
   * - Recording 2 (B): starts at 0 (duet with A)
   * - Recording 3+ (C, D, ...): starts when the OLDEST still-playing track ends
   *
   * Example timeline:
   *   A: [0-10]
   *   B: [0-15]      <- starts at 0, plays with A
   *   C: [10-20]     <- starts at 10 (when A ends)
   *   D: [15-25]     <- starts at 15 (when B ends)
   *   E: [20-30]     <- starts at 20 (when C ends)
   */
  function getNextRecordingStartTime(): number {
    if (audioChain.length === 0) {
      // First recording starts at 0
      return 0;
    }
    if (audioChain.length === 1) {
      // Second recording also starts at 0 (duet with first)
      return 0;
    }

    // For 3rd+ recording: find the oldest track that's still playing at the current end
    // Sort by end time (startTime + duration) and return the earliest end time
    const endTimes = audioChain.map(seg => seg.startTime + seg.duration);
    const sortedEndTimes = [...endTimes].sort((a, b) => a - b);

    // The next recording starts when the OLDEST track ends
    // But we need to find which track ends first that hasn't been "used" yet
    // Actually simpler: the recording starts at the END of the track that ends earliest
    // among tracks that are still "active" at that point

    // Find the minimum end time - that's when the next recording starts
    const earliestEndTime = sortedEndTimes[audioChain.length - 2]; // Second-to-last end time

    console.log('[DuetRecorder] End times:', endTimes, 'Next recording starts at:', earliestEndTime);
    return earliestEndTime;
  }

  async function startDuetRecording() {
    try {
      setIsLoading(true);
      console.log('[DuetRecorder] Starting duet recording, chain length:', audioChain.length);

      // Calculate when this recording will start in the timeline
      recordingStartTimeInChain.current = getNextRecordingStartTime();
      console.log('[DuetRecorder] This recording will start at timeline position:', recordingStartTimeInChain.current);

      // If we have a chain, start playback
      if (audioChain.length > 0) {
        console.log('[DuetRecorder] Loading chain for playback:', audioChain.map(n => ({ id: n.id, duration: n.duration, startTime: n.startTime })));
        await player.current.loadChain(audioChain);

        // Start playback from beginning
        console.log('[DuetRecorder] Starting playback from 0');
        player.current.playFrom(0, recordingStartTimeInChain.current, () => {
          // Callback when it's time to start recording
          console.log('[DuetRecorder] Reached recording start point, beginning recording');
          actuallyStartRecording();
        });
        setIsPlaying(true);
      } else {
        // First recording - start immediately
        await actuallyStartRecording();
      }
    } catch (error) {
      console.error('[DuetRecorder] Failed to start recording:', error);
      Alert.alert('Error', 'Failed to start recording');
      setIsLoading(false);
    }
  }

  async function actuallyStartRecording() {
    try {
      // Record the start timestamp to calculate duration
      recordingStartTimestamp.current = Date.now();
      console.log('[DuetRecorder] Recording start timestamp:', recordingStartTimestamp.current);

      // Start recording
      console.log('[DuetRecorder] Calling recorder.startRecording()');
      await recorder.current.startRecording();
      console.log('[DuetRecorder] Recording started successfully');
      setIsRecording(true);
    } catch (error) {
      console.error('[DuetRecorder] Failed to start recording:', error);
      Alert.alert('Error', 'Failed to start recording');
    } finally {
      setIsLoading(false);
    }
  }

  async function stopDuetRecording() {
    try {
      setIsLoading(true);
      console.log('[DuetRecorder] Stopping duet recording');

      // Stop recording - get temp URI
      console.log('[DuetRecorder] Calling recorder.stopRecording()');
      const tempUri = await recorder.current.stopRecording();
      console.log('[DuetRecorder] Recording stopped, tempUri:', tempUri);
      setIsRecording(false);

      // Stop playback if playing
      if (isPlaying) {
        console.log('[DuetRecorder] Stopping playback');
        await player.current.stop();
        setIsPlaying(false);
      }

      // Calculate duration from timestamp
      const duration = Math.ceil((Date.now() - recordingStartTimestamp.current) / 1000);
      console.log('[DuetRecorder] Calculated duration:', duration, 'seconds');

      // Upload to S3
      console.log('[DuetRecorder] Uploading to S3...');
      const key = await recorder.current.uploadRecording(tempUri);
      console.log('[DuetRecorder] S3 upload complete, key:', key);

      // Save to database
      const savePayload = {
        key,
        duration,
        parentId: currentNodeId,
      };
      console.log('[DuetRecorder] Saving to database:', savePayload);

      const saveResponse = await fetch(`${getApiUrl()}/api/audio/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(savePayload),
      });

      if (!saveResponse.ok) {
        const errorText = await saveResponse.text();
        console.error('[DuetRecorder] Save failed:', saveResponse.status, errorText);
        throw new Error('Failed to save audio metadata');
      }

      const savedNode = await saveResponse.json();
      console.log('[DuetRecorder] Saved node from API:', savedNode);

      // Save recording to permanent local storage using the node ID
      console.log('[DuetRecorder] Saving locally with ID:', savedNode.id);
      const localUri = await saveRecordingLocally(tempUri, savedNode.id);
      console.log('[DuetRecorder] Local save complete:', localUri);

      // Update chain with both remote URL, local URI, and startTime
      const nodeWithLocalUri: AudioChainNode = {
        ...savedNode,
        localUri,
        startTime: recordingStartTimeInChain.current,
      };

      const newChain = [...audioChain, nodeWithLocalUri];
      console.log('[DuetRecorder] New chain:', newChain.map(n => ({ id: n.id, duration: n.duration, startTime: n.startTime, parentId: n.parentId })));

      setAudioChain(newChain);
      setCurrentNodeId(savedNode.id);

      Alert.alert('Success', `Recording saved! Duration: ${duration}s (Node: ${savedNode.id.slice(0, 8)}...)`);
    } catch (error) {
      Alert.alert('Error', 'Failed to save recording');
      console.error('[DuetRecorder] Recording save error:', error);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRecordPress() {
    if (isRecording) {
      await stopDuetRecording();
    } else {
      await startDuetRecording();
    }
  }

  async function resetChain() {
    setAudioChain([]);
    setCurrentNodeId(null);
    await player.current.cleanup();
    Alert.alert('Reset', 'Starting fresh recording chain');
  }

  async function playFullChain() {
    if (audioChain.length === 0) {
      Alert.alert('No Audio', 'Record something first!');
      return;
    }

    try {
      console.log('[DuetRecorder] Playing full chain, segments:', audioChain.map(n => ({ id: n.id, duration: n.duration, localUri: n.localUri?.slice(-20) })));
      setIsLoading(true);
      await player.current.loadChain(audioChain);
      console.log('[DuetRecorder] Chain loaded, starting playback');
      setIsLoading(false); // Loading done, now playing
      setIsPlaying(true);
      await player.current.playFrom(0);
      console.log('[DuetRecorder] Playback complete');
    } catch (error) {
      console.error('[DuetRecorder] Playback error:', error);
      Alert.alert('Error', 'Failed to play audio');
    } finally {
      setIsPlaying(false);
      setIsLoading(false);
    }
  }

  return (
    <ScrollView style={styles.scrollContainer} contentContainerStyle={styles.scrollContent}>
      <View style={styles.container}>
        <Text style={styles.title}>Tap Story</Text>
        <Text style={styles.subtitle}>Duet Mode</Text>

        <View style={styles.info}>
          <Text style={styles.chainInfo}>Chain Length: {audioChain.length} segments</Text>
          {audioChain.length > 0 && (
            <Text style={styles.duration}>
              Total Duration: {player.current.getTotalDuration()}s
            </Text>
          )}
          {isRecording && isPlaying && (
            <Text style={styles.recordingText}>🔴 Recording while playing...</Text>
          )}
          {isPlaying && !isRecording && (
            <Text style={styles.playing}>▶️ Playing...</Text>
          )}
          {isRecording && !isPlaying && (
            <Text style={styles.recordingText}>🔴 Recording...</Text>
          )}
        </View>

        <RecordButton
          isRecording={isRecording}
          isLoading={isLoading}
          onPress={handleRecordPress}
        />

        <View style={styles.controls}>
          {audioChain.length > 0 && (
            <>
              <Button title="Play All" onPress={playFullChain} disabled={isLoading || isRecording} />
              <View style={styles.buttonSpacer} />
            </>
          )}
          <Button title="Reset Chain" onPress={resetChain} disabled={isLoading || isRecording} />
        </View>

        {/* Audio Timeline Visualization */}
        <AudioTimeline
          segments={audioChain.map(node => ({
            id: node.id,
            duration: node.duration,
            startTime: node.startTime,
            parentId: node.parentId,
          }))}
          pixelsPerSecond={10}
        />

        {audioChain.length === 0 && (
          <Text style={styles.hint}>
            Press Record to start your first recording.
          </Text>
        )}
        {audioChain.length > 0 && (
          <Text style={styles.hint}>
            Press Record to add to the chain. Previous audio will play while you record.
          </Text>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollContainer: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 18,
    color: '#666',
    marginBottom: 30,
  },
  info: {
    marginBottom: 30,
    alignItems: 'center',
  },
  chainInfo: {
    fontSize: 16,
    color: '#333',
  },
  duration: {
    fontSize: 14,
    color: '#666',
    marginTop: 4,
  },
  playing: {
    color: '#007AFF',
    marginTop: 10,
    fontWeight: '500',
  },
  recordingText: {
    color: '#FF3B30',
    marginTop: 10,
    fontWeight: '600',
  },
  controls: {
    marginTop: 30,
    alignItems: 'center',
  },
  buttonSpacer: {
    height: 10,
  },
  hint: {
    marginTop: 20,
    color: '#666',
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 20,
  },
});
