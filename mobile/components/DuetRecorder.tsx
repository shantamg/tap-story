import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Button, Alert } from 'react-native';
import { AudioRecorder } from '../services/audioService';
import { DuetPlayer } from '../services/duetPlayer';
import { RecordButton } from './RecordButton';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';

interface AudioChainNode {
  id: string;
  audioUrl: string;
  duration: number;
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

  async function startDuetRecording() {
    try {
      setIsLoading(true);

      // If we have a chain, start playback
      if (audioChain.length > 0) {
        await player.current.loadChain(audioChain);

        // Start playback from beginning
        player.current.playFrom(0);
        setIsPlaying(true);
      }

      // Record the start timestamp to calculate duration
      recordingStartTimestamp.current = Date.now();

      // Start recording
      await recorder.current.startRecording();
      setIsRecording(true);
    } catch (error) {
      Alert.alert('Error', 'Failed to start recording');
    } finally {
      setIsLoading(false);
    }
  }

  async function stopDuetRecording() {
    try {
      setIsLoading(true);

      // Stop recording
      const uri = await recorder.current.stopRecording();
      setIsRecording(false);

      // Stop playback if playing
      if (isPlaying) {
        await player.current.stop();
        setIsPlaying(false);
      }

      // Calculate duration from timestamp
      const duration = Math.ceil((Date.now() - recordingStartTimestamp.current) / 1000);

      // Upload to S3
      const key = await recorder.current.uploadRecording(uri, API_URL);

      // Save to database
      const saveResponse = await fetch(`${API_URL}/api/audio/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key,
          duration,
          parentId: currentNodeId,
        }),
      });

      if (!saveResponse.ok) {
        throw new Error('Failed to save audio metadata');
      }

      const savedNode = await saveResponse.json();

      // Update chain and current node
      setAudioChain([...audioChain, savedNode]);
      setCurrentNodeId(savedNode.id);

      Alert.alert('Success', `Recording saved! Duration: ${duration}s`);
    } catch (error) {
      Alert.alert('Error', 'Failed to save recording');
      console.error('Recording save error:', error);
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
      setIsLoading(true);
      await player.current.loadChain(audioChain);
      setIsPlaying(true);
      await player.current.playFrom(0);
      setIsPlaying(false);
    } catch (error) {
      Alert.alert('Error', 'Failed to play audio');
    } finally {
      setIsLoading(false);
    }
  }

  return (
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
        {isPlaying && <Text style={styles.playing}>Playing previous audio...</Text>}
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

      {audioChain.length > 0 && (
        <Text style={styles.hint}>
          Press Record to add to the chain. Previous audio will play while you record.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
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
