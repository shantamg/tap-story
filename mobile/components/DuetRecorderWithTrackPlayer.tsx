/**
 * DuetRecorderWithTrackPlayer - Audio duet recording component
 * 
 * Uses native audio module (TapStoryAudioModule) for synchronized playback and recording
 * when available, falling back to expo-av otherwise.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, BackHandler } from 'react-native';
import { AudioRecorder } from '../services/audioService';
import { DuetTrackPlayer, DuetSegment, NativeDuetPlayer, getTapStoryAudio } from '../services/audio';
import { CassettePlayerControls } from './CassettePlayerControls';
import { AudioTimeline } from './AudioTimeline';
import { SavedChainsList } from './SavedChainsList';
import { AppButton } from './AppButton';
import { getApiUrl } from '../utils/api';
import {
  saveRecordingLocally,
  saveLatencyOffset,
  getLatencyOffset,
  localAudioExists,
  downloadAndCacheAudio,
  deleteLocalAudio,
} from '../services/audioStorage';
import { colors, spacing, radius, typography } from '../utils/theme';
import { LatencyNudge } from './LatencyNudge';
import type {
  AudioChainSummary,
  AudioNode,
  SaveAudioRequest,
} from '@shared/types/audio';
import { getNextTimelineStartTimeMs } from '@shared/utils/audioTimeline';
import { createPendingAudioSegment } from '../services/audio/pendingAudioSegment';
import {
  savePendingUpload,
  removePendingUpload,
  listPendingUploads,
} from '../services/audio/pendingUploads';
import { isAudioInteractionLocked } from './audioInteractionState';

/** Turn native/developer error strings into something a musician can read. */
function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (/native audio engine|Expo Go|development build/i.test(raw)) {
    return 'Layered recording needs the full app. Open Tap Story from your home screen, not Expo Go.';
  }
  if (/wired or built-in|UNSUPPORTED_SYNC_ROUTE|Bluetooth|AirPods|AirPlay/i.test(raw)) {
    return 'Please unplug Bluetooth headphones. Layered recording needs the built-in mic or wired earbuds to stay in sync.';
  }
  if (/microphone|permission/i.test(raw)) {
    return 'Tap Story needs microphone access. Enable it in Settings to record.';
  }
  if (/network|fetch|Failed to (fetch|upload|save)|timeout/i.test(raw)) {
    return "Couldn't reach the server. Your recording is saved on this device — tap to retry.";
  }
  return 'Something went wrong. Your recording is safe on this device.';
}

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
  const [failedSegmentIds, setFailedSegmentIds] = useState<Set<string>>(new Set());  // Takes whose upload failed (kept for retry)
  const [latencyOffsetMs, setLatencyOffsetMs] = useState(0);

  // Download state
  const [downloadingSegmentIds, setDownloadingSegmentIds] = useState<Set<string>>(new Set());
  const [isDownloadingAudio, setIsDownloadingAudio] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);  // Detail-view load/download failure

  // Saved chains state
  const [savedChains, setSavedChains] = useState<AudioChainSummary[]>([]);
  const [isLoadingChains, setIsLoadingChains] = useState(false);
  const [chainsError, setChainsError] = useState<string | null>(null);  // Story-list fetch failure

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
    // Flush any takes recorded offline in a previous session before they age.
    flushPendingUploads();
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

  // Android hardware back should return to the story list from the detail
  // view (never mid-take), not silently exit the whole app.
  useEffect(() => {
    const onBack = () => {
      if (viewMode !== 'detail') return false;
      if (isRecording || isWaitingToRecord) return true; // swallow; don't lose a take
      goBackToList();
      return true;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [viewMode, isRecording, isWaitingToRecord]);

  async function initAudio() {
    try {
      // AudioRecorder owns the runtime microphone permission request. Native
      // engines still need that permission even though they do the capture.
      await recorder.current.init();
      // Initialize the player (either native or expo-av based)
      await player.current.initialize();
      // Leave the "playing" state when playback reaches the end of the story,
      // instead of wedging with a frozen playhead and a hidden Play button.
      player.current.setOnPlaybackComplete(() => {
        setIsPlaying(false);
        stopPositionTracking();
      });
      setUsingNativeAudio(isUsingNativeRef.current);
      
      if (isUsingNativeRef.current) {
        console.log('[DuetRecorderWithTrackPlayer] Native synchronized audio engine initialized');
      }
    } catch (error) {
      console.error('[DuetRecorderWithTrackPlayer] Failed to initialize audio:', error);
      setAudioError(friendlyError(error));
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
      setChainsError(null);
      const response = await fetch(`${getApiUrl()}/api/audio/chains`);
      if (!response.ok) {
        throw new Error('Failed to fetch chains');
      }
      const data = await response.json() as { chains: AudioChainSummary[] };
      setSavedChains(data.chains);
    } catch (error) {
      console.error('[DuetRecorder] Failed to fetch chains:', error);
      // Distinguish a real fetch failure from a genuinely empty library so the
      // list does not masquerade a network outage as "No stories yet".
      setChainsError("Couldn't load your stories. Check your connection and try again.");
    } finally {
      setIsLoadingChains(false);
    }
  }, []);

  /**
   * Upload a durable local take and register it on the server. Shared by the
   * live save path, the retry affordance, and the launch-time flush. Returns
   * the saved node (relinked to a local file keyed by its real id).
   */
  const uploadPendingRecord = useCallback(async (record: {
    tempId: string;
    localUri: string;
    durationMs: number;
    parentId: string | null;
  }): Promise<{ node: AudioNode; localUri: string }> => {
    const key = await recorder.current.uploadRecording(record.localUri);
    const savePayload: SaveAudioRequest = {
      key,
      durationMs: record.durationMs,
      parentId: record.parentId,
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
    // Relink the durable copy to the real node id, then drop the temp-keyed
    // copy and the pending record — the take is now safely on the server.
    const localUri = await saveRecordingLocally(record.localUri, savedNode.id);
    await removePendingUpload(record.tempId);
    await deleteLocalAudio(record.tempId);
    return { node: savedNode, localUri };
  }, []);

  /** Retry the upload of a take that previously failed, from its durable copy. */
  const retryUpload = useCallback(async (tempId: string) => {
    const node = audioChain.find(n => n.id === tempId);
    if (!node?.localUri) return;
    setFailedSegmentIds(prev => { const next = new Set(prev); next.delete(tempId); return next; });
    setProcessingSegmentIds(prev => new Set(prev).add(tempId));
    setAudioError(null);
    try {
      const { node: savedNode, localUri } = await uploadPendingRecord({
        tempId,
        localUri: node.localUri,
        durationMs: node.durationMs,
        parentId: node.parentId,
      });
      setAudioChain(prev => prev.map(n => n.id === tempId ? {
        id: savedNode.id,
        audioUrl: savedNode.audioUrl,
        parentId: savedNode.parentId,
        durationMs: savedNode.durationMs,
        startTimeMs: savedNode.startTimeMs,
        duration: savedNode.durationMs / 1000,
        startTime: savedNode.startTimeMs / 1000,
        localUri,
      } : n));
      setCurrentNodeId(savedNode.id);
    } catch (error) {
      console.error('[DuetRecorder] Retry upload failed:', error);
      setFailedSegmentIds(prev => new Set(prev).add(tempId));
      setAudioError(friendlyError(error));
    } finally {
      setProcessingSegmentIds(prev => { const next = new Set(prev); next.delete(tempId); return next; });
    }
  }, [audioChain, uploadPendingRecord]);

  /** On launch, push any takes recorded offline to the server in the background. */
  const flushPendingUploads = useCallback(async () => {
    let records: Awaited<ReturnType<typeof listPendingUploads>>;
    try {
      records = await listPendingUploads();
    } catch {
      return;
    }
    if (records.length === 0) return;
    let anySucceeded = false;
    for (const record of records) {
      try {
        await uploadPendingRecord(record);
        anySucceeded = true;
      } catch (error) {
        // Leave it queued; it will retry on the next launch.
        console.log('[DuetRecorder] Pending upload still failing, will retry later');
      }
    }
    if (anySucceeded) fetchSavedChains();
  }, [uploadPendingRecord, fetchSavedChains]);

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
    setLoadError(null);
    const newDownloadingIds = new Set<string>();
    const failedDownloadIds = new Set<string>();

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
              }
              setDownloadingSegmentIds(prev => {
                const next = new Set(prev);
                next.delete(segmentId);
                return next;
              });
            } catch (error) {
              console.error(`Failed to download segment ${segmentId}:`, error);
              failedDownloadIds.add(segmentId);
              // Clear the "downloading" flag so the timeline stops spinning;
              // the load error banner surfaces the retry instead.
              setDownloadingSegmentIds(prev => {
                const next = new Set(prev);
                next.delete(segmentId);
                return next;
              });
            }
          })
        );
        setIsDownloadingAudio(false);
        if (failedDownloadIds.size > 0) {
          setLoadError("Some audio couldn't be downloaded. Check your connection and tap Retry.");
        }
      }

    } catch (error) {
      console.error('[DuetRecorder] Failed to load chain:', error);
      setDownloadingSegmentIds(new Set());
      setIsDownloadingAudio(false);
      setLoadError("Couldn't open this story. Check your connection and tap Retry.");
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
      setAudioError(friendlyError(error));
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
      setAudioError(friendlyError(error));
      setIsRecording(false);
      setIsWaitingToRecord(false);
    } finally {
      setIsLoading(false);
    }
  }

  async function stopDuetRecording() {
    let tempSegmentId: string | null = null;
    try {
      setIsLoading(true);

      if (recordingDurationInterval.current) {
        clearInterval(recordingDurationInterval.current);
        recordingDurationInterval.current = null;
      }

      const take = await captureTake();

      setIsRecording(false);
      setRecordingDuration(0);
      setIsPlaying(false);
      stopPositionTracking();

      // Durability first: copy the take into permanent storage and record a
      // pending upload BEFORE touching the network, so a flaky connection,
      // backend outage, or app restart can never lose the recording.
      tempSegmentId = `temp-${Date.now()}`;
      const durableUri = await saveRecordingLocally(take.uri, tempSegmentId);
      await savePendingUpload({
        tempId: tempSegmentId,
        localUri: durableUri,
        durationMs: take.durationMs,
        startTimeMs: take.startTimeMs,
        parentId: currentNodeId,
        createdAt: Date.now(),
      });

      // Optimistically show the take on the timeline (playable from the durable
      // local copy) and mark it uploading.
      const tempNode: AudioChainNode = createPendingAudioSegment({
        id: tempSegmentId,
        recordingUri: durableUri,
        durationMs: take.durationMs,
        startTimeMs: take.startTimeMs,
        parentId: currentNodeId,
      });
      setAudioChain(prev => [...prev, tempNode]);
      setProcessingSegmentIds(prev => new Set(prev).add(tempSegmentId!));
      setIsLoading(false); // Don't block the whole UI on the network round-trip.

      const { node: savedNode, localUri } = await uploadPendingRecord({
        tempId: tempSegmentId,
        localUri: durableUri,
        durationMs: take.durationMs,
        parentId: currentNodeId,
      });

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
      setAudioChain(prev => prev.map(node => node.id === tempSegmentId ? nodeWithLocalUri : node));
      setCurrentNodeId(savedNode.id);
      setProcessingSegmentIds(prev => { const next = new Set(prev); next.delete(tempSegmentId!); return next; });
    } catch (error) {
      console.error('[DuetRecorderWithTrackPlayer] Recording save error:', error);
      setIsRecording(false);
      setIsWaitingToRecord(false);
      setIsPlaying(false);
      setRecordingDuration(0);
      stopPositionTracking();

      if (tempSegmentId) {
        // The take is durably saved and queued — keep it visible with a
        // tap-to-retry affordance instead of discarding it.
        setProcessingSegmentIds(prev => { const next = new Set(prev); next.delete(tempSegmentId!); return next; });
        setFailedSegmentIds(prev => new Set(prev).add(tempSegmentId!));
        setAudioError(friendlyError(error));
      } else {
        // Failure before the take was even captured — nothing to keep.
        setAudioError(friendlyError(error));
      }
    } finally {
      setIsLoading(false);
    }
  }

  /** Stop the active recording and return the raw take (native or expo-av). */
  async function captureTake(): Promise<{ uri: string; durationMs: number; startTimeMs: number }> {
    if (isUsingNativeRef.current) {
      const nativePlayer = player.current as NativeDuetPlayer;
      const result = await nativePlayer.stop();
      if (!result) {
        throw new Error('No recording result from native player');
      }
      return {
        uri: result.uri,
        durationMs: Math.max(1, Math.round(result.durationMs)),
        // Persist the canonical story rule, not a millisecond value that has
        // made a lossy round-trip through device sample frames.
        startTimeMs: getNextTimelineStartTimeMs(audioChain),
      };
    }

    const recordedFile = await recorder.current.stopRecording();
    if (isPlaying) {
      await player.current.stop();
    }
    return {
      uri: recordedFile.uri,
      durationMs: recordedFile.durationMs,
      startTimeMs: Math.max(0, Math.round(recordingStartTime * 1000)),
    };
  }

  async function handleRecordPress() {
    if (isLoading || processingSegmentIds.size > 0 || isWaitingToRecord) return;
    if (isRecording) {
      await stopDuetRecording();
    } else {
      await startDuetRecording();
    }
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
      setAudioError(friendlyError(error));
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

  /** Stop the in-progress take and throw it away without saving or uploading. */
  async function discardTake() {
    if (recordingDurationInterval.current) {
      clearInterval(recordingDurationInterval.current);
      recordingDurationInterval.current = null;
    }
    try {
      await player.current.stop();
      if (!isUsingNativeRef.current) {
        await recorder.current.stopRecording().catch(() => undefined);
      }
    } catch (error) {
      console.log('[DuetRecorder] Discard stop error (ignored):', error);
    } finally {
      setIsRecording(false);
      setIsWaitingToRecord(false);
      setIsPlaying(false);
      setRecordingDuration(0);
      stopPositionTracking();
      setAudioError(null);
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
          <Text style={styles.subtitle}>Record an idea. Pass it on. Build it together.</Text>
        </View>

        <AppButton
          label="New Story"
          onPress={startNewStory}
          accessibilityHint="Start a new blank story to record into"
          style={styles.newStoryButton}
        />

        <View style={styles.savedChainsFullContainer}>
          <SavedChainsList
            chains={savedChains}
            isLoading={isLoadingChains}
            error={chainsError}
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
  const failedSegmentId = audioChain.find(node => failedSegmentIds.has(node.id))?.id;
  const statusMessage = isWaitingToRecord
    ? 'Get ready — recording starts at the mark…'
    : isRecording && isPlaying
      ? 'Recording along with the story…'
      : isRecording
        ? 'Recording…'
        : null;

  return (
    <View style={styles.detailContainer}>
      <View style={styles.detailHeader}>
        <AppButton
          label="‹ Stories"
          variant="ghost"
          onPress={goBackToList}
          disabled={isLoading || isRecording || isWaitingToRecord}
          style={styles.backButton}
        />
        <Text style={styles.chainInfo}>
          {audioChain.length === 0
            ? 'New story'
            : `${audioChain.length} ${audioChain.length === 1 ? 'clip' : 'clips'}`}
        </Text>
        {usingNativeAudio ? (
          <Text style={styles.syncBadge}>⚡ Synced</Text>
        ) : (
          <View style={styles.headerSpacer} />
        )}
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

      {/* Status + error banners */}
      <View style={styles.info}>
        {statusMessage && (
          <Text style={[styles.statusText, isWaitingToRecord ? styles.waitingText : styles.recordingText]}>
            {statusMessage}
          </Text>
        )}

        {(loadError || (audioError && !failedSegmentId)) && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{loadError ?? audioError}</Text>
            {loadError && currentNodeId && (
              <AppButton label="Retry" variant="secondary" onPress={() => loadChain(currentNodeId)} style={styles.bannerButton} />
            )}
          </View>
        )}

        {failedSegmentId && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>
              Your take is saved on this device but hasn't uploaded yet.
            </Text>
            <AppButton
              label="Retry upload"
              variant="secondary"
              onPress={() => retryUpload(failedSegmentId)}
              loading={processingSegmentIds.has(failedSegmentId)}
              style={styles.bannerButton}
            />
          </View>
        )}
      </View>

      {/* Transport controls */}
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

      {/* Discard affordance while a take is in progress */}
      {(isRecording || isWaitingToRecord) && (
        <AppButton
          label="Discard take"
          variant="ghost"
          onPress={discardTake}
          style={styles.discardButton}
          accessibilityHint="Stop recording without saving this take"
        />
      )}

      {/* Fine-tune sync (auto-detected route latency, nudged per device) */}
      {usingNativeAudio && !isRecording && !isWaitingToRecord && audioChain.length > 0 && (
        <LatencyNudge
          offsetMs={latencyOffsetMs}
          onOffsetChange={handleLatencyChange}
          disabled={isPlaying}
        />
      )}

      {/* Hint text */}
      {!isRecording && !isWaitingToRecord && (
        <Text style={styles.hint}>
          {audioChain.length === 0
            ? 'Tap the red button to record your first idea.'
            : 'Tap play to listen, or record to add the next part.'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  listContainer: {
    flex: 1,
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.xl,
    backgroundColor: colors.background,
  },
  listHeader: {
    marginTop: spacing.lg,
    marginBottom: spacing.xl,
  },
  newStoryButton: {
    marginBottom: spacing.xl,
  },
  savedChainsFullContainer: {
    flex: 1,
  },
  detailContainer: {
    flex: 1,
    paddingTop: spacing.md,
    backgroundColor: colors.background,
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg,
  },
  backButton: {
    paddingHorizontal: 0,
    minHeight: 36,
  },
  headerSpacer: {
    width: 72,
  },
  timelineFullWidth: {
    width: '100%',
  },
  title: {
    ...typography.display,
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  },
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
  },
  info: {
    paddingHorizontal: spacing.xl,
    marginTop: spacing.lg,
    alignItems: 'center',
    gap: spacing.md,
  },
  chainInfo: {
    ...typography.heading,
    color: colors.textPrimary,
  },
  syncBadge: {
    ...typography.label,
    color: colors.success,
    width: 72,
    textAlign: 'right',
  },
  statusText: {
    ...typography.heading,
    textAlign: 'center',
  },
  recordingText: {
    color: colors.recording,
  },
  waitingText: {
    color: colors.waiting,
  },
  banner: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
    alignItems: 'center',
  },
  bannerText: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  bannerButton: {
    alignSelf: 'stretch',
  },
  discardButton: {
    alignSelf: 'center',
    marginTop: spacing.xs,
  },
  hint: {
    marginTop: spacing.xl,
    color: colors.textSecondary,
    ...typography.caption,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
  },
});
