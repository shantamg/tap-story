/**
 * DuetRecorderWithTrackPlayer - Audio duet recording component
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, Button, TouchableOpacity } from 'react-native';
import { AudioRecorder } from '../services/audioService';
import { DuetTrackPlayer, DuetSegment } from '../services/audio';
import { CassettePlayerControls } from './CassettePlayerControls';
import { AudioTimeline } from './AudioTimeline';
import { SavedChainsList } from './SavedChainsList';
import { getApiUrl } from '../utils/api';
import { saveRecordingLocally, saveLatencyOffset, getLatencyOffset, localAudioExists, downloadAndCacheAudio } from '../services/audioStorage';
import { colors } from '../utils/theme';
import { LatencyNudge } from './LatencyNudge';

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

export function DuetRecorderWithTrackPlayer() {
  const [isRecording, setIsRecording] = useState(false);
  const [isWaitingToRecord, setIsWaitingToRecord] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [audioChain, setAudioChain] = useState<AudioChainNode[]>([]);
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
  const [currentPosition, setCurrentPosition] = useState(0);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [recordingStartTime, setRecordingStartTime] = useState(0); // Start time for current recording
  const [seekPreviewPosition, setSeekPreviewPosition] = useState<number | null>(null);
  const [processingSegmentIds, setProcessingSegmentIds] = useState<Set<string>>(new Set());  // Segments being uploaded/processed
  const [latencyOffsetMs, setLatencyOffsetMs] = useState(0);
  const [isCalibratingLatency, setIsCalibratingLatency] = useState(false);

  // Download state
  const [downloadingSegmentIds, setDownloadingSegmentIds] = useState<Set<string>>(new Set());
  const [isDownloadingAudio, setIsDownloadingAudio] = useState(false);

  // Saved chains state
  const [savedChains, setSavedChains] = useState<ChainSummary[]>([]);
  const [isLoadingChains, setIsLoadingChains] = useState(false);

  // View state
  const [viewMode, setViewMode] = useState<'list' | 'detail'>('list');

  // Derived state for control disabling
  const hasDownloadingSegments = downloadingSegmentIds.size > 0;
  const canPlayOrRecord = !isDownloadingAudio && !hasDownloadingSegments && !isLoading;

  // Lazy initialization to prevent creating new instances on every render
  const recorderRef = useRef<AudioRecorder | null>(null);
  const playerRef = useRef<DuetTrackPlayer | null>(null);
  
  if (!recorderRef.current) {
    recorderRef.current = new AudioRecorder();
  }
  if (!playerRef.current) {
    playerRef.current = new DuetTrackPlayer();
  }
  
  // Non-null references (guaranteed by lazy init above)
  const recorder = recorderRef as React.MutableRefObject<AudioRecorder>;
  const player = playerRef as React.MutableRefObject<DuetTrackPlayer>;
  
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
      await recorder.current.init();
      // Initialize the track player
      await player.current.initialize();
    } catch (error) {
      console.error('[DuetRecorderWithTrackPlayer] Failed to initialize audio:', error);
    }
  }

  async function loadLatencyOffset() {
    const offset = await getLatencyOffset();
    setLatencyOffsetMs(offset);
  }

  async function handleLatencyChange(newOffset: number) {
    setLatencyOffsetMs(newOffset);
    await saveLatencyOffset(newOffset);
  }

  async function calibrateLatencyFromLastTwo() {
    if (audioChain.length < 2) {
      console.warn('[DuetRecorderWithTrackPlayer] Not enough segments to calibrate latency');
      return;
    }

    const referenceNodeId = audioChain[audioChain.length - 2].id;
    const testNodeId = audioChain[audioChain.length - 1].id;

    try {
      setIsCalibratingLatency(true);
      console.log('[DuetRecorderWithTrackPlayer] Calibrating latency from nodes:', referenceNodeId, testNodeId);

      const response = await fetch(`${getApiUrl()}/api/audio/calibrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referenceNodeId, testNodeId }),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('[DuetRecorderWithTrackPlayer] Latency calibration failed:', response.status, text);
        throw new Error('Latency calibration failed');
      }

      const data = await response.json() as { offsetMs?: number };
      if (typeof data.offsetMs !== 'number' || Number.isNaN(data.offsetMs)) {
        console.error('[DuetRecorderWithTrackPlayer] Invalid offsetMs from calibration:', data);
        throw new Error('Invalid calibration result');
      }

      const newOffset = Math.round(data.offsetMs);
      console.log('[DuetRecorderWithTrackPlayer] Calibration result offsetMs:', newOffset);
      setLatencyOffsetMs(newOffset);
      await saveLatencyOffset(newOffset);
    } catch (error) {
      console.error('[DuetRecorderWithTrackPlayer] Error during latency calibration:', error);
    } finally {
      setIsCalibratingLatency(false);
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

  const deleteChain = useCallback(async (chainId: string) => {
    try {
      setIsLoading(true);
      console.log('[DuetRecorderWithTrackPlayer] Deleting chain:', chainId);

      // First, get all nodes in the chain to delete local files
      const treeResponse = await fetch(`${getApiUrl()}/api/audio/tree/${chainId}`);
      if (!treeResponse.ok) {
        throw new Error('Failed to fetch chain tree');
      }
      const treeData = await treeResponse.json();
      const ancestors = treeData.ancestors || [];

      // Delete local files for all nodes in the chain
      const { deleteLocalAudio } = await import('../services/audioStorage');
      for (const node of ancestors) {
        try {
          await deleteLocalAudio(node.id);
        } catch (error) {
          console.error(`[DuetRecorderWithTrackPlayer] Failed to delete local file for ${node.id}:`, error);
          // Continue even if local delete fails
        }
      }

      // Delete from backend (S3 and database)
      const deleteResponse = await fetch(`${getApiUrl()}/api/audio/chain/${chainId}`, {
        method: 'DELETE',
      });

      if (!deleteResponse.ok) {
        throw new Error('Failed to delete chain');
      }

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
      const data = await response.json();
      const ancestors: Array<{
        id: string;
        audioUrl: string;
        parentId: string | null;
        duration: number;
      }> = data.ancestors;

      // Calculate start times - first two at 0, then alternating tracks
      const chain: AudioChainNode[] = [];
      for (let i = 0; i < ancestors.length; i++) {
        const node = ancestors[i];
        let startTime = 0;

        if (i >= 2) {
          // 3rd+ segment starts at end of segment 2 positions back (same track)
          const sameTrackSegment = chain[i - 2];
          startTime = sameTrackSegment.startTime + sameTrackSegment.duration;
        }

        chain.push({ ...node, startTime });
      }

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
    // First two recordings start at 0 (duet format - both tracks start together)
    if (audioChain.length < 2) {
      return 0;
    }
    // 3rd+ recording: start at the end of the segment 2 positions back (same track)
    // Segment 3 starts when segment 1 ends, segment 4 when segment 2 ends, etc.
    const sameTrackSegment = audioChain[audioChain.length - 2];
    return sameTrackSegment.startTime + sameTrackSegment.duration;
  }

  async function startDuetRecording() {
    try {
      setIsLoading(true);
      console.log('[DuetRecorder] Starting duet recording, chain length:', audioChain.length);

      // Calculate the logical start time (where the new track should begin)
      const logicalStartTime = getNextRecordingStartTime();

      console.log('[DuetRecorder] Recording will start at:', logicalStartTime);

      if (audioChain.length > 0) {
        await player.current.loadChain(audioChain);

        await recorder.current.prepareRecording();

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
        await actuallyStartRecording();
      }
    } catch (error) {
      console.error('[DuetRecorder] Failed to start recording:', error);
      setIsLoading(false);
      setIsWaitingToRecord(false);
    }
  }

  async function actuallyStartRecording() {
    try {
      const actualStartTimestamp = await recorder.current.startRecording();
      recordingStartTimestamp.current = actualStartTimestamp;

      console.log('[DuetRecorder] Recording started at:', recordingStartTime);

      setIsRecording(true);
      setRecordingDuration(0);

      recordingDurationInterval.current = setInterval(() => {
        const elapsed = (Date.now() - recordingStartTimestamp.current) / 1000;
        setRecordingDuration(elapsed);
      }, 100);
    } catch (error) {
      console.error('[DuetRecorder] Failed to start recording:', error);
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
      const startTime = recordingStartTime;

      console.log('[DuetRecorder] Saving segment - startTime:', startTime, 'duration:', duration);

      // Create temporary segment ID for the new recording
      const tempSegmentId = `temp-${Date.now()}`;
      
      // Add segment to chain immediately with temporary data (before upload)
      const tempNode: AudioChainNode = {
        id: tempSegmentId,
        audioUrl: '', // Will be updated after upload
        duration,
        startTime,
        parentId: currentNodeId,
      };

      // Add to chain and mark as processing
      const newChain = [...audioChain, tempNode];
      setAudioChain(newChain);
      setProcessingSegmentIds(prev => new Set([...prev, tempSegmentId]));

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
        startTime,
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
      await handleSeek(recordingStartTime);
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
    if (audioChain.length === 0) {
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
    if (isRecording) return;
    await playFromPosition(segment.startTime);
  }

  function handleSeekPreview(position: number) {
    if (isRecording) return;
    if (audioChain.length === 0) return;

    if (isWaitingToRecord && position >= recordingStartTime) {
      position = Math.max(0, recordingStartTime - 0.1);
    }

    setCurrentPosition(position);
    setSeekPreviewPosition(position);
  }

  async function handleSeek(position: number) {
    if (isRecording) return;
    if (audioChain.length === 0) return;

    if (isWaitingToRecord && position >= recordingStartTime) {
      position = Math.max(0, recordingStartTime - 0.1);
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
          recordingStartTime={recordingStartTime}
          recordingDuration={recordingDuration}
          currentTimelinePosition={currentPosition}
          previewTimelinePosition={seekPreviewPosition}
          onSeek={handleSeek}
          onSeekPreview={handleSeekPreview}
          processingSegmentIds={processingSegmentIds}
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

      <LatencyNudge
        offsetMs={latencyOffsetMs}
        onOffsetChange={handleLatencyChange}
        disabled={isRecording || isPlaying || isCalibratingLatency}
      />

      {audioChain.length >= 2 && (
        <View style={styles.calibrationContainer}>
          <Button
            title={isCalibratingLatency ? 'Calibrating…' : 'Calibrate sync from last 2 tracks'}
            onPress={calibrateLatencyFromLastTwo}
            disabled={isRecording || isPlaying || isCalibratingLatency}
          />
        </View>
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
  calibrationContainer: {
    marginTop: 8,
    alignItems: 'center',
  },
});