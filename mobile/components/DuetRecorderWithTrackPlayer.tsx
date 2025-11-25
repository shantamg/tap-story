/**
 * DuetRecorderWithTrackPlayer - Example integration of react-native-track-player
 *
 * This file demonstrates how to use the new track player service with the
 * existing DuetRecorder component. You can either:
 * 1. Replace DuetRecorder.tsx with this implementation
 * 2. Or use it as a reference to update your existing component
 *
 * Key changes from the original:
 * - Uses DuetTrackPlayer instead of DuetPlayer (expo-av)
 * - Uses getCorrectedRecordingStartTime() for better sync
 * - Supports time stretching via setPlaybackRate()
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, Button, Alert, TouchableOpacity } from 'react-native';
import { AudioRecorder } from '../services/audioService';
import { DuetTrackPlayer, DuetSegment, LATENCY_OFFSET_MS } from '../services/audio';
import { CassettePlayerControls } from './CassettePlayerControls';
import { AudioTimeline } from './AudioTimeline';
import { SavedChainsList } from './SavedChainsList';
import { getApiUrl } from '../utils/api';
import { saveRecordingLocally, getLocalAudioPath } from '../services/audioStorage';
import { colors } from '../utils/theme';

interface AudioChainNode extends DuetSegment {
  parentId: string | null;
}

interface ChainSegment {
  id: string;
  duration: number;
  startTime: number;
  parentId: string | null;
}

interface ChainSummary {
  id: string;
  chainLength: number;
  totalDuration: number;
  createdAt: string;
  segments: ChainSegment[];
}

// Available playback speeds for time stretching
const PLAYBACK_SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

export function DuetRecorderWithTrackPlayer() {
  const [isRecording, setIsRecording] = useState(false);
  const [isWaitingToRecord, setIsWaitingToRecord] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [audioChain, setAudioChain] = useState<AudioChainNode[]>([]);
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
  const [currentPosition, setCurrentPosition] = useState(0);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [seekPreviewPosition, setSeekPreviewPosition] = useState<number | null>(null);

  // NEW: Playback speed state
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);

  // Saved chains state
  const [savedChains, setSavedChains] = useState<ChainSummary[]>([]);
  const [isLoadingChains, setIsLoadingChains] = useState(false);

  // View state
  const [viewMode, setViewMode] = useState<'list' | 'detail'>('list');

  // Use the new DuetTrackPlayer instead of DuetPlayer
  const recorder = useRef(new AudioRecorder());
  const player = useRef(new DuetTrackPlayer());
  const recordingStartTimestamp = useRef(0);
  const recordingStartTimeInChain = useRef(0);
  const positionInterval = useRef<NodeJS.Timeout | null>(null);
  const recordingDurationInterval = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    initAudio();
    fetchSavedChains();
    return () => {
      recorder.current.cleanup();
      player.current.cleanup();
      if (positionInterval.current) {
        clearInterval(positionInterval.current);
      }
      if (recordingDurationInterval.current) {
        clearInterval(recordingDurationInterval.current);
      }
    };
  }, []);

  async function initAudio() {
    try {
      await recorder.current.init();
      // Initialize the track player
      await player.current.initialize();
    } catch (error) {
      Alert.alert('Error', 'Failed to initialize audio. Please grant microphone permissions.');
    }
  }

  const fetchSavedChains = useCallback(async () => {
    try {
      setIsLoadingChains(true);
      const response = await fetch(`${getApiUrl()}/api/audio/chains`);
      if (!response.ok) {
        throw new Error('Failed to fetch chains');
      }
      const data = await response.json();
      setSavedChains(data.chains);
    } catch (error) {
      console.error('[DuetRecorder] Failed to fetch chains:', error);
    } finally {
      setIsLoadingChains(false);
    }
  }, []);

  async function loadChain(chainId: string) {
    try {
      setIsLoading(true);
      console.log('[DuetRecorder] Loading chain:', chainId);

      const response = await fetch(`${getApiUrl()}/api/audio/tree/${chainId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch chain');
      }
      const data = await response.json();
      const ancestors: Array<{
        id: string;
        audioUrl: string;
        parentId: string | null;
        duration: number;
      }> = data.ancestors;

      console.log('[DuetRecorder] Loaded ancestors:', ancestors.length);

      // Calculate start times
      const chain: AudioChainNode[] = [];
      for (let i = 0; i < ancestors.length; i++) {
        const node = ancestors[i];
        let startTime = 0;

        if (i === 0) {
          startTime = 0;
        } else if (i === 1) {
          startTime = 0;
        } else {
          const endTimes = chain.map(seg => seg.startTime + seg.duration);
          const sortedEndTimes = [...endTimes].sort((a, b) => a - b);
          startTime = sortedEndTimes[i - 2];
        }

        chain.push({
          ...node,
          startTime,
        });
      }

      setAudioChain(chain);
      setCurrentNodeId(chainId);
      setViewMode('detail');

      await player.current.cleanup();
    } catch (error) {
      console.error('[DuetRecorder] Failed to load chain:', error);
      Alert.alert('Error', 'Failed to load story');
    } finally {
      setIsLoading(false);
    }
  }

  function getNextRecordingStartTime(): number {
    if (audioChain.length === 0) return 0;
    if (audioChain.length === 1) return 0;

    const endTimes = audioChain.map(seg => seg.startTime + seg.duration);
    const sortedEndTimes = [...endTimes].sort((a, b) => a - b);
    return sortedEndTimes[audioChain.length - 2];
  }

  const RECORDING_PRE_ROLL_SECONDS = 1.0;

  async function startDuetRecording() {
    try {
      setIsLoading(true);
      console.log('[DuetRecorder] Starting duet recording');

      const logicalStartTime = getNextRecordingStartTime();
      const actualRecordingStartTime = Math.max(0, logicalStartTime - RECORDING_PRE_ROLL_SECONDS);
      recordingStartTimeInChain.current = actualRecordingStartTime;

      if (audioChain.length > 0) {
        await player.current.loadChain(audioChain);

        // Set the playback speed (time stretching)
        await player.current.setPlaybackRate(playbackSpeed);

        await recorder.current.prepareRecording();

        if (!isPlaying) {
          setCurrentPosition(0);
          startPositionTracking();
          setIsWaitingToRecord(true);
          setIsLoading(false);

          // Use the new playFrom with callback
          player.current.playFrom(0, actualRecordingStartTime, () => {
            console.log('[DuetRecorder] Reached pre-roll point');
            setIsWaitingToRecord(false);
            actuallyStartRecording();
          });
          setIsPlaying(true);
        } else {
          setIsWaitingToRecord(true);
          setIsLoading(false);

          if (currentPosition >= actualRecordingStartTime) {
            setIsWaitingToRecord(false);
            await actuallyStartRecording();
          }
        }
      } else {
        await actuallyStartRecording();
      }
    } catch (error) {
      console.error('[DuetRecorder] Failed to start recording:', error);
      Alert.alert('Error', 'Failed to start recording');
      setIsLoading(false);
      setIsWaitingToRecord(false);
    }
  }

  /**
   * CRITICAL: Use getCorrectedRecordingStartTime for better sync
   *
   * This function gets the player's current position and subtracts the
   * latency offset to determine where the recording actually starts
   * relative to the backing track.
   */
  async function actuallyStartRecording() {
    try {
      // NEW: Get the CORRECTED recording start time using the player's position
      // This accounts for audio output latency
      const correctedStartTime = await player.current.getCorrectedRecordingStartTime();
      console.log(`[DuetRecorder] Corrected start time: ${correctedStartTime.toFixed(3)}s (latency offset: ${LATENCY_OFFSET_MS}ms)`);

      // Start recording
      const actualStartTimestamp = await recorder.current.startRecording();

      // Use the corrected position for alignment
      recordingStartTimeInChain.current = correctedStartTime;
      recordingStartTimestamp.current = actualStartTimestamp;

      console.log('[DuetRecorder] Recording started, aligned to timeline position:', correctedStartTime);

      setIsRecording(true);
      setRecordingDuration(0);

      recordingDurationInterval.current = setInterval(() => {
        const elapsed = (Date.now() - recordingStartTimestamp.current) / 1000;
        setRecordingDuration(elapsed);
      }, 100);
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

      if (recordingDurationInterval.current) {
        clearInterval(recordingDurationInterval.current);
        recordingDurationInterval.current = null;
      }

      const tempUri = await recorder.current.stopRecording();
      setIsRecording(false);
      setRecordingDuration(0);

      if (isPlaying) {
        await player.current.stop();
        setIsPlaying(false);
      }
      stopPositionTracking();

      const duration = Math.ceil((Date.now() - recordingStartTimestamp.current) / 1000);

      const key = await recorder.current.uploadRecording(tempUri);

      const savePayload = {
        key,
        duration,
        parentId: currentNodeId,
      };

      const saveResponse = await fetch(`${getApiUrl()}/api/audio/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(savePayload),
      });

      if (!saveResponse.ok) {
        throw new Error('Failed to save audio metadata');
      }

      const savedNode = await saveResponse.json();

      const localUri = await saveRecordingLocally(tempUri, savedNode.id);

      const nodeWithLocalUri: AudioChainNode = {
        ...savedNode,
        localUri,
        startTime: recordingStartTimeInChain.current,
      };

      const newChain = [...audioChain, nodeWithLocalUri];
      setAudioChain(newChain);
      setCurrentNodeId(savedNode.id);

      Alert.alert('Success', `Recording saved! Duration: ${duration}s`);
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
    setViewMode('list');
    await player.current.cleanup();
    fetchSavedChains();
  }

  function startNewStory() {
    setAudioChain([]);
    setCurrentNodeId(null);
    setViewMode('detail');
  }

  async function goBackToList() {
    if (isPlaying) {
      await player.current.stop();
      setIsPlaying(false);
    }
    stopPositionTracking();
    await player.current.cleanup();

    setViewMode('list');
    fetchSavedChains();
  }

  async function stopPlayback() {
    if (isPlaying) {
      await player.current.stop();
      setIsPlaying(false);
      stopPositionTracking();
      setCurrentPosition(0);
      setSeekPreviewPosition(null);
    }
  }

  async function handleStopButton() {
    if (isRecording) {
      await stopDuetRecording();
    } else {
      await stopPlayback();
    }
  }

  async function handleRewind() {
    if (isRecording) return;
    await handleSeek(0);
  }

  async function handleFastForward() {
    if (isRecording) return;
    if (isWaitingToRecord) {
      await handleSeek(recordingStartTimeInChain.current);
    } else if (audioChain.length > 0) {
      await player.current.loadChain(audioChain);
      const totalDuration = player.current.getTotalDuration();
      await handleSeek(totalDuration);
    }
  }

  function startPositionTracking() {
    if (positionInterval.current) {
      clearInterval(positionInterval.current);
    }

    positionInterval.current = setInterval(async () => {
      const pos = await player.current.getCurrentPosition();
      setCurrentPosition(pos);

      if (isWaitingToRecord && pos >= recordingStartTimeInChain.current) {
        console.log('[DuetRecorder] Reached recording start point');
        setIsWaitingToRecord(false);
        await actuallyStartRecording();
      }
    }, 100);
  }

  function stopPositionTracking() {
    if (positionInterval.current) {
      clearInterval(positionInterval.current);
      positionInterval.current = null;
    }
    setCurrentPosition(0);
  }

  async function playFromPlayhead() {
    if (audioChain.length === 0) {
      Alert.alert('No Audio', 'Record something first!');
      return;
    }

    const startPosition =
      seekPreviewPosition !== null
        ? seekPreviewPosition
        : currentPosition;

    await playFromPosition(startPosition);
  }

  async function playFromPosition(startPosition: number) {
    try {
      setIsLoading(true);
      await player.current.loadChain(audioChain);

      // Apply the playback speed (time stretching)
      await player.current.setPlaybackRate(playbackSpeed);

      setIsLoading(false);
      setIsPlaying(true);
      setCurrentPosition(startPosition);
      setSeekPreviewPosition(null);
      startPositionTracking();

      await player.current.playFrom(startPosition);
    } catch (error) {
      console.error('[DuetRecorder] Playback error:', error);
      Alert.alert('Error', 'Failed to play audio');
      setIsPlaying(false);
      setIsLoading(false);
      stopPositionTracking();
    }
  }

  async function handleSegmentTap(segment: { id: string; startTime: number }) {
    if (isRecording) return;
    await playFromPosition(segment.startTime);
  }

  function handleSeekPreview(position: number) {
    if (isRecording) return;
    if (audioChain.length === 0) return;

    if (isWaitingToRecord && position >= recordingStartTimeInChain.current) {
      position = Math.max(0, recordingStartTimeInChain.current - 0.1);
    }

    setCurrentPosition(position);
    setSeekPreviewPosition(position);
  }

  async function handleSeek(position: number) {
    if (isRecording) return;
    if (audioChain.length === 0) return;

    if (isWaitingToRecord && position >= recordingStartTimeInChain.current) {
      position = Math.max(0, recordingStartTimeInChain.current - 0.1);
    }

    try {
      await player.current.loadChain(audioChain);

      const wasPlaying = isPlaying;
      if (isPlaying) {
        await player.current.stop();
        setIsPlaying(false);
        stopPositionTracking();
      }

      setCurrentPosition(position);
      setSeekPreviewPosition(null);

      if (wasPlaying) {
        if (isWaitingToRecord) {
          setIsPlaying(true);
          startPositionTracking();
          await player.current.playFrom(position, recordingStartTimeInChain.current, () => {
            setIsWaitingToRecord(false);
            actuallyStartRecording();
          });
        } else {
          setIsPlaying(true);
          startPositionTracking();
          await player.current.playFrom(position);
        }
      }
    } catch (error) {
      console.error('[DuetRecorder] Seek error:', error);
      Alert.alert('Error', 'Failed to seek audio');
    }
  }

  /**
   * NEW: Handle playback speed change
   * This allows users to speed up or slow down playback without changing pitch
   */
  async function handleSpeedChange(speed: number) {
    setPlaybackSpeed(speed);

    // If currently playing, apply the speed change immediately
    if (isPlaying) {
      await player.current.setPlaybackRate(speed);
    }
  }

  // LIST VIEW
  if (viewMode === 'list') {
    return (
      <View style={styles.listContainer}>
        <View style={styles.listHeader}>
          <Text style={styles.title}>Tap Story</Text>
          <Text style={styles.subtitle}>Your Stories</Text>
        </View>

        <View style={styles.newStoryButton}>
          <Button title="+ New Story" onPress={startNewStory} />
        </View>

        <View style={styles.savedChainsFullContainer}>
          <SavedChainsList
            chains={savedChains}
            isLoading={isLoadingChains}
            selectedChainId={null}
            onSelectChain={loadChain}
            onRefresh={fetchSavedChains}
          />
        </View>
      </View>
    );
  }

  // DETAIL VIEW
  return (
    <View style={styles.detailContainer}>
      <View style={styles.backButtonContainer}>
        <Button title="< Back" onPress={goBackToList} disabled={isLoading || isRecording} />
      </View>

      {/* Timeline */}
      <View style={styles.timelineFullWidth}>
        <AudioTimeline
          segments={audioChain.map(node => ({
            id: node.id,
            duration: node.duration,
            startTime: node.startTime,
            parentId: node.parentId,
          }))}
          onSegmentTap={handleSegmentTap}
          isRecording={isRecording}
          isWaitingToRecord={isWaitingToRecord}
          recordingStartTime={recordingStartTimeInChain.current}
          recordingDuration={recordingDuration}
          currentTimelinePosition={currentPosition}
          previewTimelinePosition={seekPreviewPosition}
          onSeek={handleSeek}
          onSeekPreview={handleSeekPreview}
        />
      </View>

      {/* Status info */}
      <View style={styles.info}>
        <Text style={styles.chainInfo}>
          {audioChain.length} {audioChain.length === 1 ? 'segment' : 'segments'}
        </Text>
        {isRecording && isPlaying && (
          <Text style={styles.recordingText}>Recording while playing...</Text>
        )}
        {isRecording && !isPlaying && (
          <Text style={styles.recordingText}>Recording...</Text>
        )}
      </View>

      {/* NEW: Playback Speed Control */}
      <View style={styles.speedControlContainer}>
        <Text style={styles.speedLabel}>Speed:</Text>
        <View style={styles.speedButtons}>
          {PLAYBACK_SPEEDS.map((speed) => (
            <TouchableOpacity
              key={speed}
              style={[
                styles.speedButton,
                playbackSpeed === speed && styles.speedButtonActive,
              ]}
              onPress={() => handleSpeedChange(speed)}
              disabled={isRecording}
            >
              <Text
                style={[
                  styles.speedButtonText,
                  playbackSpeed === speed && styles.speedButtonTextActive,
                ]}
              >
                {speed}x
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Cassette player controls */}
      <CassettePlayerControls
        isPlaying={isPlaying}
        isRecording={isRecording}
        isWaitingToRecord={isWaitingToRecord}
        isLoading={isLoading}
        hasAudio={audioChain.length > 0}
        onPlay={playFromPlayhead}
        onStop={handleStopButton}
        onRecord={handleRecordPress}
        onRewind={handleRewind}
        onFastForward={handleFastForward}
      />

      {/* Hint text */}
      {audioChain.length === 0 && (
        <Text style={styles.hint}>
          Tap the record button to start your first recording.
        </Text>
      )}
      {audioChain.length > 0 && (
        <Text style={styles.hint}>
          Tap record to add to the story. Use speed controls for time stretching.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  listContainer: {
    flex: 1,
    paddingTop: 60,
    paddingHorizontal: 20,
    backgroundColor: colors.background,
  },
  listHeader: {
    alignItems: 'center',
    marginBottom: 20,
  },
  newStoryButton: {
    marginBottom: 20,
  },
  savedChainsFullContainer: {
    flex: 1,
  },
  detailContainer: {
    flex: 1,
    paddingTop: 60,
    backgroundColor: colors.background,
  },
  backButtonContainer: {
    paddingHorizontal: 20,
    marginBottom: 20,
    alignItems: 'flex-start',
  },
  timelineFullWidth: {
    width: '100%',
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    marginBottom: 4,
    color: colors.textPrimary,
  },
  subtitle: {
    fontSize: 18,
    color: colors.textSecondary,
  },
  info: {
    paddingHorizontal: 20,
    marginTop: 20,
    alignItems: 'center',
  },
  chainInfo: {
    fontSize: 16,
    color: colors.textPrimary,
  },
  recordingText: {
    color: colors.recording,
    marginTop: 8,
    fontWeight: '600',
  },
  hint: {
    marginTop: 20,
    color: colors.textSecondary,
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  // NEW: Speed control styles
  speedControlContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    marginTop: 16,
    marginBottom: 8,
  },
  speedLabel: {
    fontSize: 14,
    color: colors.textSecondary,
    marginRight: 12,
  },
  speedButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  speedButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: colors.surface || '#333',
    borderWidth: 1,
    borderColor: colors.border || '#444',
  },
  speedButtonActive: {
    backgroundColor: colors.primary || '#007AFF',
    borderColor: colors.primary || '#007AFF',
  },
  speedButtonText: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  speedButtonTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
});

