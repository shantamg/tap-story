/**
 * DuetRecorderWithTrackPlayer - Audio duet recording component
 * 
 * Uses native audio module (TapStoryAudioModule) for synchronized playback and recording
 * when available, falling back to expo-av otherwise.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, Button, TouchableOpacity, Platform } from 'react-native';
import { AudioRecorder } from '../services/audioService';
import { DuetTrackPlayer, DuetSegment, NativeDuetPlayer, getTapStoryAudio } from '../services/audio';
import { CassettePlayerControls } from './CassettePlayerControls';
import { AudioTimeline } from './AudioTimeline';
import { SavedChainsList } from './SavedChainsList';
import { getApiUrl } from '../utils/api';
import { saveRecordingLocally, saveLatencyOffset, getLatencyOffset, localAudioExists, downloadAndCacheAudio } from '../services/audioStorage';
import { colors } from '../utils/theme';
import { LatencyNudge } from './LatencyNudge';
import type {
  AudioChainSummary,
  AudioNode,
  SaveAudioRequest,
} from '@shared/types/audio';
import { getNextTimelineStartTimeMs } from '@shared/utils/audioTimeline';
import { createPendingAudioSegment } from '../services/audio/pendingAudioSegment';
import { isAudioInteractionLocked } from './audioInteractionState';

// Type for player that works with both DuetTrackPlayer and NativeDuetPlayer
type DuetPlayerType = DuetTrackPlayer | NativeDuetPlayer;

interface AudioChainNode extends DuetSegment {
  parentId: string | null;
  durationMs: number;
  startTimeMs: number;
}

export function DuetRecorderWithTrackPlayer() {
  const [isRecording, setIsRecording] = useState(false);
  const [isWaitingToRecord, setIsWaitingToRecord] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [audioChain, setAudioChain] = useState<AudioChainNode[]>([]);
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
  const [currentPosition, setCurrentPosition] = useState(0);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [recordingStartTime, setRecordingStartTime] = useState(0); // Start time for current recording
  const [seekPreviewPosition, setSeekPreviewPosition] = useState<number | null>(null);
  const [processingSegmentIds, setProcessingSegmentIds] = useState<Set<string>>(new Set());  // Segments being uploaded/processed
  const [latencyOffsetMs, setLatencyOffsetMs] = useState(0);

  // Download state
  const [downloadingSegmentIds, setDownloadingSegmentIds] = useState<Set<string>>(new Set());
  const [isDownloadingAudio, setIsDownloadingAudio] = useState(false);

  // Saved chains state
  const [savedChains, setSavedChains] = useState<AudioChainSummary[]>([]);
  const [isLoadingChains, setIsLoadingChains] = useState(false);

  // View state
  const [viewMode, setViewMode] = useState<'list' | 'detail'>('list');

  // Derived state for control disabling
  const audioInteractionLocked = isAudioInteractionLocked({
    isLoading,
    isDownloadingAudio,
    downloadingSegmentCount: downloadingSegmentIds.size,
    processingSegmentCount: processingSegmentIds.size,
    isRecording,
    isWaitingToRecord,
  });

  // Track if using native audio (for UI feedback)
  const [usingNativeAudio, setUsingNativeAudio] = useState(false);

  // Lazy initialization to prevent creating new instances on every render
  // Use NativeDuetPlayer when available for better sync
  const recorderRef = useRef<AudioRecorder | null>(null);
  const playerRef = useRef<DuetPlayerType | null>(null);
  const isUsingNativeRef = useRef(false);
  
  if (!recorderRef.current) {
    recorderRef.current = new AudioRecorder();
  }
  if (!playerRef.current) {
    // Check if native audio is available
    const nativeAudio = getTapStoryAudio();
    if (nativeAudio.isAvailable()) {
      console.log('[DuetRecorderWithTrackPlayer] Using NativeDuetPlayer for better sync');
      playerRef.current = new NativeDuetPlayer();
      isUsingNativeRef.current = true;
    } else {
      console.log('[DuetRecorderWithTrackPlayer] Native audio not available, using DuetTrackPlayer');
      playerRef.current = new DuetTrackPlayer();
      isUsingNativeRef.current = false;
    }
  }
  
  // Non-null references (guaranteed by lazy init above)
  const recorder = recorderRef as React.MutableRefObject<AudioRecorder>;
  const player = playerRef as React.MutableRefObject<DuetPlayerType>;
  
  const recordingStartTimestamp = useRef(0);
  const positionInterval = useRef<NodeJS.Timeout | null>(null);
  const recordingDurationInterval = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    initAudio();
    fetchSavedChains();
     // Load persisted latency offset for this device
    loadLatencyOffset();
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
      // AudioRecorder owns the runtime microphone permission request. Native
      // engines still need that permission even though they do the capture.
      await recorder.current.init();
      // Initialize the player (either native or expo-av based)
      await player.current.initialize();
      setUsingNativeAudio(isUsingNativeRef.current);
      
      if (isUsingNativeRef.current) {
        console.log('[DuetRecorderWithTrackPlayer] Native synchronized audio engine initialized');
      }
    } catch (error) {
      console.error('[DuetRecorderWithTrackPlayer] Failed to initialize audio:', error);
      setAudioError(error instanceof Error ? error.message : 'Failed to initialize audio');
    }
  }

  async function loadLatencyOffset() {
    const offset = await getLatencyOffset();
    setLatencyOffsetMs(offset);
  }

  async function handleLatencyChange(newOffset: number) {
    const clampedOffset = Math.max(-250, Math.min(250, newOffset));
    setLatencyOffsetMs(clampedOffset);
    await saveLatencyOffset(clampedOffset);
  }

  const fetchSavedChains = useCallback(async () => {
    try {
      setIsLoadingChains(true);
      const response = await fetch(`${getApiUrl()}/api/audio/chains`);
      if (!response.ok) {
        throw new Error('Failed to fetch chains');
      }
      const data = await response.json() as { chains: AudioChainSummary[] };
      setSavedChains(data.chains);
    } catch (error) {
      console.error('[DuetRecorder] Failed to fetch chains:', error);
    } finally {
      setIsLoadingChains(false);
    }
  }, []);

  const deleteChain = useCallback(async (chainId: string) => {
    try {
      setIsLoading(true);
      console.log('[DuetRecorderWithTrackPlayer] Deleting chain:', chainId);

      // The backend deletes only the suffix exclusive to this leaf and retains
      // ancestors shared by sibling stories.
      const deleteResponse = await fetch(`${getApiUrl()}/api/audio/chain/${chainId}`, {
        method: 'DELETE',
      });

      if (!deleteResponse.ok) {
        throw new Error('Failed to delete chain');
      }

      const result = await deleteResponse.json() as { nodeIds?: string[] };
      const { deleteLocalAudio } = await import('../services/audioStorage');
      await Promise.all((result.nodeIds ?? []).map(async nodeId => {
        try {
          await deleteLocalAudio(nodeId);
        } catch (error) {
          console.error(
            `[DuetRecorderWithTrackPlayer] Failed to delete local file for ${nodeId}:`,
            error
          );
        }
      }));

      console.log('[DuetRecorderWithTrackPlayer] Chain deleted successfully');
      
      // Refresh the chains list
      await fetchSavedChains();
    } catch (error) {
      console.error('[DuetRecorderWithTrackPlayer] Failed to delete chain:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [fetchSavedChains]);

  async function loadChain(chainId: string) {
    setIsLoading(true);
    const newDownloadingIds = new Set<string>();

    try {
      console.log('[DuetRecorder] Loading chain:', chainId);

      const response = await fetch(`${getApiUrl()}/api/audio/tree/${chainId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch chain');
      }
      const data = await response.json() as { ancestors: AudioNode[] };
      const chain: AudioChainNode[] = data.ancestors.map(node => ({
        id: node.id,
        audioUrl: node.audioUrl,
        parentId: node.parentId,
        durationMs: node.durationMs,
        startTimeMs: node.startTimeMs,
        duration: node.durationMs / 1000,
        startTime: node.startTimeMs / 1000,
      }));

      // Check which segments need downloading
      for (const segment of chain) {
        const hasLocal = await localAudioExists(segment.id);
        if (!hasLocal) {
          newDownloadingIds.add(segment.id);
        }
      }

      setDownloadingSegmentIds(newDownloadingIds);
      setIsDownloadingAudio(newDownloadingIds.size > 0);
      setAudioChain(chain);
      setCurrentNodeId(chainId);
      setViewMode('detail');

      await player.current.cleanup();

      // Download missing audio in parallel
      if (newDownloadingIds.size > 0) {
        await Promise.all(
          Array.from(newDownloadingIds).map(async (segmentId) => {
            try {
              const segment = chain.find(s => s.id === segmentId);
              if (segment) {
                await downloadAndCacheAudio(segment.audioUrl, segment.id);
                setDownloadingSegmentIds(prev => {
                  const next = new Set(prev);
                  next.delete(segmentId);
                  return next;
                });
              }
            } catch (error) {
              console.error(`Failed to download segment ${segmentId}:`, error);
              // Keep in downloading set to show error state
            }
          })
        );
        setIsDownloadingAudio(false);
      }

    } catch (error) {
      console.error('[DuetRecorder] Failed to load chain:', error);
      setDownloadingSegmentIds(new Set());
      setIsDownloadingAudio(false);
    } finally {
      setIsLoading(false);
    }
  }

  function getNextRecordingStartTime(): number {
    return getNextTimelineStartTimeMs(audioChain) / 1000;
  }

  async function startDuetRecording() {
    try {
      setIsLoading(true);
      setAudioError(null);
      console.log('[DuetRecorder] Starting duet recording, chain length:', audioChain.length);

      // Calculate the logical start time (where the new track should begin)
      const logicalStartTime = getNextRecordingStartTime();

      console.log('[DuetRecorder] Recording will start at:', logicalStartTime);

      if (audioChain.length > 0 && !isUsingNativeRef.current) {
        throw new Error(
          'Synchronized overdubs require the Tap Story native audio engine. Open the app in an iOS/Android development build instead of Expo Go.'
        );
      }

      if (audioChain.length > 0) {
        if (isUsingNativeRef.current) {
          await (player.current as NativeDuetPlayer)
            .configureLatencyCompensation(latencyOffsetMs);
        }
        await player.current.loadChain(audioChain);

        // Only prepare recorder if not using native audio (native handles recording internally)
        if (!isUsingNativeRef.current) {
          await recorder.current.prepareRecording();
        }

        // Get current playhead position
        const currentPlayheadPosition = isPlaying 
          ? await player.current.getCurrentPosition() 
          : currentPosition;

        // If playhead is past the recording start, seek back
        if (currentPlayheadPosition >= logicalStartTime) {
          console.log('[DuetRecorder] Playhead is after recording start point, seeking back');
          const seekPosition = Math.max(0, logicalStartTime - 1.0);
          await player.current.stop();
          setIsPlaying(false);
          stopPositionTracking();
          
          // Seek and wait for it to complete
          await player.current.loadChain(audioChain);
          
          // Start playback from seek position, will trigger recording when ready
          setCurrentPosition(seekPosition);
          setIsWaitingToRecord(true);
          setIsLoading(false);
          
          setRecordingStartTime(logicalStartTime);
          
          console.log('[DuetRecorder] Playback from', seekPosition, 'recording at:', logicalStartTime);
          
          // Start playback first, then start position tracking
          await player.current.playFrom(seekPosition, logicalStartTime, () => {
            console.log('[DuetRecorder] Reached recording start point, beginning recording at:', logicalStartTime);
            setIsWaitingToRecord(false);
            actuallyStartRecording();
          });
          setIsPlaying(true);
          startPositionTracking();
        } else if (!isPlaying) {
          // Not playing and playhead is before recording start - start from beginning
          setCurrentPosition(0);
          setIsWaitingToRecord(true);
          setIsLoading(false);

          setRecordingStartTime(logicalStartTime);

          console.log('[DuetRecorder] Playback from 0, recording at:', logicalStartTime);
          
          // Start playback first, then start position tracking
          await player.current.playFrom(0, logicalStartTime, () => {
            console.log('[DuetRecorder] Reached recording start point at:', logicalStartTime);
            setIsWaitingToRecord(false);
            actuallyStartRecording();
          });
          setIsPlaying(true);
          startPositionTracking();
        } else {
          // Already playing - stop and restart with callback
          setRecordingStartTime(logicalStartTime);
          setIsWaitingToRecord(true);
          setIsLoading(false);
          
          const currentPos = await player.current.getCurrentPosition();
          console.log('[DuetRecorder] Resuming from', currentPos, 'recording at:', logicalStartTime);
          
          // Stop and restart with callback (simplest reliable approach)
          await player.current.stop();
          await player.current.playFrom(currentPos, logicalStartTime, () => {
            console.log('[DuetRecorder] Reached recording start point at:', logicalStartTime);
            setIsWaitingToRecord(false);
            actuallyStartRecording();
          });
        }
      } else {
        // First recording - start at 0
        setRecordingStartTime(0);
        
        if (isUsingNativeRef.current) {
          // Use native recording for first recording
          const nativePlayer = player.current as NativeDuetPlayer;
          await nativePlayer.startRecordingOnly();
        }
        
        await actuallyStartRecording();
      }
    } catch (error) {
      console.error('[DuetRecorder] Failed to start recording:', error);
      setAudioError(error instanceof Error ? error.message : 'Failed to start recording');
      setIsRecording(false);
      setIsWaitingToRecord(false);
      setIsLoading(false);
    }
  }

  async function actuallyStartRecording() {
    try {
      // When using native audio, recording is already started by playAndRecord
      // We just need to update state and start duration tracking
      if (isUsingNativeRef.current) {
        console.log('[DuetRecorder] Native recording started at:', recordingStartTime);
        recordingStartTimestamp.current = Date.now();
        
        setIsRecording(true);
        setRecordingDuration(0);

        recordingDurationInterval.current = setInterval(() => {
          const elapsed = (Date.now() - recordingStartTimestamp.current) / 1000;
          setRecordingDuration(elapsed);
        }, 100);
      } else {
        // Non-native: use AudioRecorder
        const actualStartTimestamp = await recorder.current.startRecording();
        recordingStartTimestamp.current = actualStartTimestamp;

        console.log('[DuetRecorder] Recording started at:', recordingStartTime);

        setIsRecording(true);
        setRecordingDuration(0);

        recordingDurationInterval.current = setInterval(() => {
          const elapsed = (Date.now() - recordingStartTimestamp.current) / 1000;
          setRecordingDuration(elapsed);
        }, 100);
      }
    } catch (error) {
      console.error('[DuetRecorder] Failed to start recording:', error);
      setAudioError(error instanceof Error ? error.message : 'Failed to start recording');
      setIsRecording(false);
      setIsWaitingToRecord(false);
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

      let tempUri: string;
      let durationMs: number;
      let startTimeMs: number;

      if (isUsingNativeRef.current) {
        // Native audio: stop player which also stops recording
        const nativePlayer = player.current as NativeDuetPlayer;
        const result = await nativePlayer.stop();
        
        if (!result) {
          throw new Error('No recording result from native player');
        }
        
        tempUri = result.uri;
        durationMs = Math.max(1, Math.round(result.durationMs));
        // Persist the canonical story rule, not a millisecond value that has
        // made a lossy round-trip through device sample frames.
        startTimeMs = getNextTimelineStartTimeMs(audioChain);
        
        console.log('[DuetRecorder] Native recording stopped:', {
          uri: tempUri,
          durationMs,
          startTimeMs,
        });
      } else {
        // Non-native: use AudioRecorder
        const recordedFile = await recorder.current.stopRecording();
        tempUri = recordedFile.uri;
        durationMs = recordedFile.durationMs;
        startTimeMs = Math.max(0, Math.round(recordingStartTime * 1000));
        
        if (isPlaying) {
          await player.current.stop();
        }
      }

      setIsRecording(false);
      setRecordingDuration(0);
      setIsPlaying(false);
      stopPositionTracking();

      console.log('[DuetRecorder] Saving segment metadata:', { startTimeMs, durationMs });

      // Create temporary segment ID for the new recording
      const tempSegmentId = `temp-${Date.now()}`;
      
      // Add segment to chain immediately with temporary data (before upload)
      const tempNode: AudioChainNode = createPendingAudioSegment({
        id: tempSegmentId,
        recordingUri: tempUri,
        durationMs,
        startTimeMs,
        parentId: currentNodeId,
      });

      // Add to chain and mark as processing
      const newChain = [...audioChain, tempNode];
      setAudioChain(newChain);
      setProcessingSegmentIds(prev => new Set([...prev, tempSegmentId]));

      const key = await recorder.current.uploadRecording(tempUri);

      const savePayload: SaveAudioRequest = {
        key,
        durationMs,
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

      const savedNode = await saveResponse.json() as AudioNode;
      const localUri = await saveRecordingLocally(tempUri, savedNode.id);

      const nodeWithLocalUri: AudioChainNode = {
        id: savedNode.id,
        audioUrl: savedNode.audioUrl,
        parentId: savedNode.parentId,
        durationMs: savedNode.durationMs,
        startTimeMs: savedNode.startTimeMs,
        duration: savedNode.durationMs / 1000,
        startTime: savedNode.startTimeMs / 1000,
        localUri,
      };

      // Replace temp node with real node
      const updatedChain = newChain.map(node => 
        node.id === tempSegmentId ? nodeWithLocalUri : node
      );

      setAudioChain(updatedChain);
      setCurrentNodeId(savedNode.id);
      
      // Remove from processing set
      setProcessingSegmentIds(prev => {
        const next = new Set(prev);
        next.delete(tempSegmentId);
        return next;
      });
    } catch (error) {
      console.error('[DuetRecorderWithTrackPlayer] Recording save error:', error);
      setAudioError(error instanceof Error ? error.message : 'Failed to finalize recording');
      setIsRecording(false);
      setIsWaitingToRecord(false);
      setIsPlaying(false);
      setRecordingDuration(0);
      stopPositionTracking();
      // Remove the temp segment on error
      setAudioChain(prev => prev.filter(node => !node.id.startsWith('temp-')));
      setProcessingSegmentIds(prev => {
        const next = new Set(prev);
        Array.from(prev).forEach(id => {
          if (id.startsWith('temp-')) {
            next.delete(id);
          }
        });
        return next;
      });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRecordPress() {
    if (isLoading || processingSegmentIds.size > 0 || isWaitingToRecord) return;
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
    if (!isPlaying && !isWaitingToRecord) return;

    try {
      await player.current.stop();
    } catch (error) {
      console.error('[DuetRecorder] Failed to cancel playback session:', error);
      setAudioError(error instanceof Error ? error.message : 'Failed to stop audio session');
    } finally {
      setIsPlaying(false);
      setIsWaitingToRecord(false);
      setIsRecording(false);
      stopPositionTracking();
      setCurrentPosition(0);
      setSeekPreviewPosition(null);
    }
  }

  async function handleStopButton() {
    if (isWaitingToRecord) {
      await stopPlayback();
    } else if (isRecording) {
      await stopDuetRecording();
    } else {
      await stopPlayback();
    }
  }

  async function handleRewind() {
    if (isRecording || isWaitingToRecord) return;
    await handleSeek(0);
  }

  async function handleFastForward() {
    if (audioInteractionLocked) return;
    if (audioChain.length > 0) {
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
      // Note: Recording is triggered by the playFrom callback, not position tracking
      // This avoids race conditions between the two triggers
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
    if (audioInteractionLocked || audioChain.length === 0) {
      return;
    }

    const startPosition =
      seekPreviewPosition !== null
        ? seekPreviewPosition
        : currentPosition;

    await playFromPosition(startPosition);
  }

  async function playFromPosition(startPosition: number) {
    if (isWaitingToRecord) return;
    try {
      setIsLoading(true);
      await player.current.loadChain(audioChain);

      setIsLoading(false);
      setIsPlaying(true);
      setCurrentPosition(startPosition);
      setSeekPreviewPosition(null);

      await player.current.playFrom(startPosition);
      startPositionTracking();
    } catch (error) {
      console.error('[DuetRecorder] Playback error:', error);
      setIsPlaying(false);
      setIsLoading(false);
      stopPositionTracking();
    }
  }

  async function handleSegmentTap(segment: { id: string; startTime: number }) {
    if (audioInteractionLocked) return;
    await playFromPosition(segment.startTime);
  }

  function handleSeekPreview(position: number) {
    if (audioInteractionLocked) return;
    if (audioChain.length === 0) return;

    setCurrentPosition(position);
    setSeekPreviewPosition(position);
  }

  async function handleSeek(position: number) {
    if (audioInteractionLocked) return;
    if (audioChain.length === 0) return;

    try {
      const wasPlaying = isPlaying;
      if (isPlaying) {
        await player.current.stop();
        setIsPlaying(false);
        stopPositionTracking();
      }

      setCurrentPosition(position);
      setSeekPreviewPosition(null);

      if (wasPlaying) {
        await player.current.loadChain(audioChain);
        if (isWaitingToRecord) {
          setIsPlaying(true);
          await player.current.playFrom(position, recordingStartTime, () => {
            setIsWaitingToRecord(false);
            actuallyStartRecording();
          });
          startPositionTracking();
        } else {
          setIsPlaying(true);
          await player.current.playFrom(position);
          startPositionTracking();
        }
      }
    } catch (error) {
      console.error('[DuetRecorder] Seek error:', error);
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
            onDeleteChain={deleteChain}
          />
        </View>
      </View>
    );
  }

  // DETAIL VIEW
  return (
    <View style={styles.detailContainer}>
      <View style={styles.backButtonContainer}>
        <Button title="< Back" onPress={goBackToList} disabled={isLoading || isRecording || isWaitingToRecord} />
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
          recordingStartTime={recordingStartTime}
          recordingDuration={recordingDuration}
          currentTimelinePosition={currentPosition}
          previewTimelinePosition={seekPreviewPosition}
          onSeek={handleSeek}
          onSeekPreview={handleSeekPreview}
          processingSegmentIds={processingSegmentIds}
          downloadingSegmentIds={downloadingSegmentIds}
        />
      </View>

      {/* Status info */}
      <View style={styles.info}>
        <Text style={styles.chainInfo}>
          {audioChain.length} {audioChain.length === 1 ? 'segment' : 'segments'}
        </Text>
        {usingNativeAudio && (
          <Text style={styles.syncStatus}>⚡ Native sync engine</Text>
        )}
        {audioError && <Text style={styles.errorText}>{audioError}</Text>}
        {isRecording && isPlaying && (
          <Text style={styles.recordingText}>Recording while playing...</Text>
        )}
        {isRecording && !isPlaying && (
          <Text style={styles.recordingText}>Recording...</Text>
        )}
      </View>

      {/* Cassette player controls */}
      <CassettePlayerControls
        isPlaying={isPlaying}
        isRecording={isRecording}
        isWaitingToRecord={isWaitingToRecord}
        isLoading={isLoading}
        hasAudio={audioChain.length > 0}
        isDownloadingAudio={isDownloadingAudio}
        downloadingSegmentCount={downloadingSegmentIds.size}
        onPlay={playFromPlayhead}
        onStop={handleStopButton}
        onRecord={handleRecordPress}
        onRewind={handleRewind}
        onFastForward={handleFastForward}
      />

      {/* Zero uses route auto-detection; a measured value overrides it. */}
      {usingNativeAudio && (
        <LatencyNudge
          offsetMs={latencyOffsetMs}
          onOffsetChange={handleLatencyChange}
          disabled={isRecording || isPlaying || isWaitingToRecord}
        />
      )}

      {/* Hint text */}
      {audioChain.length === 0 && (
        <Text style={styles.hint}>
          Tap the record button to start your first recording.
        </Text>
      )}
      {audioChain.length > 0 && (
        <Text style={styles.hint}>
          Tap record to add to the story.
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
  syncStatus: {
    fontSize: 12,
    color: '#4CAF50',
    marginTop: 4,
    fontWeight: '500',
  },
  recordingText: {
    color: colors.recording,
    marginTop: 8,
    fontWeight: '600',
  },
  errorText: {
    color: colors.recording,
    marginTop: 8,
    textAlign: 'center',
  },
  hint: {
    marginTop: 20,
    color: colors.textSecondary,
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 20,
  },
});
