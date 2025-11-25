import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, Button } from 'react-native';
import { AudioRecorder } from '../services/audioService';
import { DuetPlayer } from '../services/duetPlayer';
import { CassettePlayerControls } from './CassettePlayerControls';
import { AudioTimeline } from './AudioTimeline';
import { SavedChainsList } from './SavedChainsList';
import { getApiUrl } from '../utils/api';
import { saveRecordingLocally, getLocalAudioPath, saveLatencyOffset, getLatencyOffset } from '../services/audioStorage';
import { colors } from '../utils/theme';
import { LatencyNudge } from './LatencyNudge';

interface AudioChainNode {
  id: string;
  audioUrl: string;       // Remote S3 presigned URL
  localUri?: string;      // Local file URI (if available)
  duration: number;
  startTime: number;      // When this segment starts in the timeline (seconds)
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

export function DuetRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [isWaitingToRecord, setIsWaitingToRecord] = useState(false);  // Playing back, waiting for punch-in
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [audioChain, setAudioChain] = useState<AudioChainNode[]>([]);
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
  const [currentPosition, setCurrentPosition] = useState(0);
  const [recordingDuration, setRecordingDuration] = useState(0);  // Current recording length in seconds
  const [seekPreviewPosition, setSeekPreviewPosition] = useState<number | null>(null);
  const [processingSegmentIds, setProcessingSegmentIds] = useState<Set<string>>(new Set());  // Segments being uploaded/processed
  const [latencyOffsetMs, setLatencyOffsetMs] = useState(0);
  const [isCalibratingLatency, setIsCalibratingLatency] = useState(false);

  // Saved chains state
  const [savedChains, setSavedChains] = useState<ChainSummary[]>([]);
  const [isLoadingChains, setIsLoadingChains] = useState(false);

  // View state: 'list' or 'detail'
  const [viewMode, setViewMode] = useState<'list' | 'detail'>('list');

  // Lazy initialization to prevent creating new instances on every render
  const recorder = useRef<AudioRecorder | null>(null);
  if (!recorder.current) {
    recorder.current = new AudioRecorder();
  }

  const player = useRef<DuetPlayer | null>(null);
  if (!player.current) {
    player.current = new DuetPlayer();
  }

  const recordingStartTimestamp = useRef(0);
  const recordingStartTimeInChain = useRef(0);  // When in the chain timeline this recording starts
  const positionInterval = useRef<NodeJS.Timeout | null>(null);
  const recordingDurationInterval = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    initAudio();
    fetchSavedChains();
    loadLatencyOffset();
    return () => {
      recorder.current?.cleanup();
      player.current?.cleanup();
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
      await recorder.current!.init();
    } catch (error) {
      console.error('[DuetRecorder] Failed to initialize audio:', error);
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
      console.warn('[DuetRecorder] Not enough segments to calibrate latency');
      return;
    }

    const referenceNodeId = audioChain[audioChain.length - 2].id;
    const testNodeId = audioChain[audioChain.length - 1].id;

    try {
      setIsCalibratingLatency(true);
      console.log('[DuetRecorder] Calibrating latency from nodes:', referenceNodeId, testNodeId);

      const response = await fetch(`${getApiUrl()}/api/audio/calibrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referenceNodeId, testNodeId }),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('[DuetRecorder] Latency calibration failed:', response.status, text);
        throw new Error('Latency calibration failed');
      }

      const data = await response.json() as { offsetMs?: number };
      if (typeof data.offsetMs !== 'number' || Number.isNaN(data.offsetMs)) {
        console.error('[DuetRecorder] Invalid offsetMs from calibration:', data);
        throw new Error('Invalid calibration result');
      }

      const newOffset = Math.round(data.offsetMs);
      console.log('[DuetRecorder] Calibration result offsetMs:', newOffset);
      setLatencyOffsetMs(newOffset);
      await saveLatencyOffset(newOffset);
    } catch (error) {
      console.error('[DuetRecorder] Error during latency calibration:', error);
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
      console.log('[DuetRecorder] Deleting chain:', chainId);

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
          console.error(`[DuetRecorder] Failed to delete local file for ${node.id}:`, error);
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

      console.log('[DuetRecorder] Chain deleted successfully');
      
      // Refresh the chains list
      await fetchSavedChains();
    } catch (error) {
      console.error('[DuetRecorder] Failed to delete chain:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [fetchSavedChains]);

  async function loadChain(chainId: string) {
    try {
      setIsLoading(true);
      console.log('[DuetRecorder] Loading chain:', chainId);

      // Fetch the chain tree from the API
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

      // Calculate start times iteratively based on duet rules
      const chain: AudioChainNode[] = [];
      for (let i = 0; i < ancestors.length; i++) {
        const node = ancestors[i];
        let startTime = 0;

        if (i === 0) {
          // First recording starts at 0
          startTime = 0;
        } else if (i === 1) {
          // Second recording also starts at 0 (duet with first)
          startTime = 0;
        } else {
          // For 3rd+ recording: start at the end of the next-to-most-recent recording
          const endTimes = chain.map(seg => seg.startTime + seg.duration);
          const sortedEndTimes = [...endTimes].sort((a, b) => a - b);
          // For N recordings, we want the (N-2)th end time (second-to-last)
          startTime = sortedEndTimes[i - 2];
        }

        chain.push({
          ...node,
          startTime,
        });
      }

      console.log('[DuetRecorder] Chain with start times:', chain.map(n => ({
        id: n.id.slice(0, 8),
        duration: n.duration,
        startTime: n.startTime,
      })));

      setAudioChain(chain);
      setCurrentNodeId(chainId);
      setViewMode('detail');  // Switch to detail view

      // Cleanup player
      await player.current!.cleanup();
    } catch (error) {
      console.error('[DuetRecorder] Failed to load chain:', error);
    } finally {
      setIsLoading(false);
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

    // For 3rd+ recording: start at the end of the next-to-most-recent recording
    // Sort by end time (startTime + duration)
    const endTimes = audioChain.map(seg => seg.startTime + seg.duration);
    const sortedEndTimes = [...endTimes].sort((a, b) => a - b);

    // The next recording starts at the end of the next-to-most-recent recording
    // For N recordings, we want the (N-2)th end time (second-to-last)
    const nextToMostRecentEndTime = sortedEndTimes[audioChain.length - 2];

    console.log('[DuetRecorder] End times:', endTimes, 'Next recording starts at:', nextToMostRecentEndTime);
    return nextToMostRecentEndTime;
  }

  // Pre-roll: start recording this many seconds BEFORE the target punch-in point
  // This ensures we capture audio before and after the transition for cross-fading
  const RECORDING_PRE_ROLL_SECONDS = 1.0;

  async function startDuetRecording() {
    try {
      setIsLoading(true);
      console.log('[DuetRecorder] Starting duet recording, chain length:', audioChain.length);

      // Calculate the "logical" start time (where the new track conceptually begins - the tail start)
      const logicalStartTime = getNextRecordingStartTime();
      
      // Actual recording starts PRE_ROLL seconds earlier to capture lead-in audio
      // This gives us buffer for cross-fading and absorbs any startup latency
      const actualRecordingStartTime = Math.max(0, logicalStartTime - RECORDING_PRE_ROLL_SECONDS);
      recordingStartTimeInChain.current = actualRecordingStartTime;
      
      console.log('[DuetRecorder] Logical start time (tail start):', logicalStartTime);
      console.log('[DuetRecorder] Actual recording starts at:', actualRecordingStartTime, `(${RECORDING_PRE_ROLL_SECONDS}s pre-roll)`);

      // If we have a chain, start or continue playback
      if (audioChain.length > 0) {
        console.log('[DuetRecorder] Loading chain for playback:', audioChain.map(n => ({ id: n.id, duration: n.duration, startTime: n.startTime })));
        await player.current!.loadChain(audioChain);

        // Pre-prepare the recording so it starts faster when we need it
        console.log('[DuetRecorder] Pre-preparing recording for faster start');
        await recorder.current!.prepareRecording();

        // Get current playhead position
        const currentPlayheadPosition = isPlaying 
          ? await player.current!.getCurrentPosition() 
          : currentPosition;

        // If playhead is after the recording start point, seek back to 1 second before it
        if (currentPlayheadPosition >= actualRecordingStartTime) {
          console.log('[DuetRecorder] Playhead is after recording start point, seeking back');
          const seekPosition = Math.max(0, actualRecordingStartTime - 1.0);
          await player.current!.stop();
          setIsPlaying(false);
          stopPositionTracking();
          setCurrentPosition(seekPosition);
          
          // Now start playback from the seek position
          setCurrentPosition(seekPosition);
          startPositionTracking();
          setIsWaitingToRecord(true);
          setIsLoading(false);
          
          console.log('[DuetRecorder] Starting playback from seek position:', seekPosition);
          player.current!.playFrom(seekPosition, actualRecordingStartTime, () => {
            console.log('[DuetRecorder] Reached pre-roll point, beginning recording');
            setIsWaitingToRecord(false);
            actuallyStartRecording();
          });
          setIsPlaying(true);
        } else if (!isPlaying) {
          // Not playing and playhead is before recording start - start from beginning
          setCurrentPosition(0);
          startPositionTracking();

          // Set waiting state - we're playing back, waiting to record
          setIsWaitingToRecord(true);
          setIsLoading(false);

          // Start playback from beginning, trigger recording at the ACTUAL start time (with pre-roll)
          console.log('[DuetRecorder] Starting playback from 0');
          player.current!.playFrom(0, actualRecordingStartTime, () => {
            // Callback when it's time to start recording (1 second before logical start)
            console.log('[DuetRecorder] Reached pre-roll point, beginning recording');
            setIsWaitingToRecord(false);
            actuallyStartRecording();
          });
          setIsPlaying(true);
        } else {
          // Already playing and playhead is before recording start - set up callback
          setIsWaitingToRecord(true);
          setIsLoading(false);
          
          // The position tracking will check and trigger recording when we reach the start time
        }
      } else {
        // First recording - start immediately
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
      // Get the current playback position - this is where the recording actually starts
      // Since we have pre-roll, any startup latency is absorbed by the buffer
      const playbackPosition = await player.current!.getCurrentPosition();
      
      // Start recording - this returns the actual timestamp when recording began
      console.log('[DuetRecorder] Calling recorder.startRecording()');
      const actualStartTimestamp = await recorder.current!.startRecording();
      
      // Log the latency for debugging
      const latencySeconds = recorder.current!.getLastStartLatency();
      console.log(`[DuetRecorder] Recording started with latency: ${(latencySeconds * 1000).toFixed(0)}ms`);
      
      // Apply global offset adjustment (convert ms to seconds)
      const offsetSeconds = latencyOffsetMs / 1000;
      console.log(`[DuetRecorder] Applying global latency offset: ${latencyOffsetMs}ms (${offsetSeconds.toFixed(3)}s)`);

      // Update the recording start time
      // Add measured latency (which pushes start time later)
      // Subtract global offset (if positive, it shifts start time earlier to compensate for lag)
      let adjustedStartTime = playbackPosition + latencySeconds - offsetSeconds;
      
      // FIX: For the first and second recordings, always anchor to 0
      // There is no backing track to sync to for the first,
      // and the second is a true duet with the first at time 0.
      if (audioChain.length === 0 || audioChain.length === 1) {
        console.log('[DuetRecorder] First/second recording - forcing start time to 0');
        adjustedStartTime = 0;
      }
      
      recordingStartTimeInChain.current = adjustedStartTime;
      console.log(`[DuetRecorder] Recording aligned to timeline position: ${adjustedStartTime.toFixed(2)}s`);
      
      // Use the actual start timestamp for duration calculation
      recordingStartTimestamp.current = actualStartTimestamp;
      console.log('[DuetRecorder] Recording start timestamp:', recordingStartTimestamp.current);

      console.log('[DuetRecorder] Recording started successfully');
      setIsRecording(true);
      setRecordingDuration(0);

      // Start tracking recording duration
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
      console.log('[DuetRecorder] Stopping duet recording');

      // Stop recording duration tracking
      if (recordingDurationInterval.current) {
        clearInterval(recordingDurationInterval.current);
        recordingDurationInterval.current = null;
      }

      // Stop recording - get temp URI
      console.log('[DuetRecorder] Calling recorder.stopRecording()');
      const tempUri = await recorder.current!.stopRecording();
      console.log('[DuetRecorder] Recording stopped, tempUri:', tempUri);
      setIsRecording(false);
      setRecordingDuration(0);

      // Stop playback if playing
      if (isPlaying) {
        console.log('[DuetRecorder] Stopping playback');
        await player.current!.stop();
        setIsPlaying(false);
      }
      stopPositionTracking();

      // Calculate duration from timestamp
      const duration = Math.ceil((Date.now() - recordingStartTimestamp.current) / 1000);
      console.log('[DuetRecorder] Calculated duration:', duration, 'seconds');

      // Create temporary segment ID for the new recording
      const tempSegmentId = `temp-${Date.now()}`;
      
      // Add segment to chain immediately with temporary data (before upload)
      const tempNode: AudioChainNode = {
        id: tempSegmentId,
        audioUrl: '', // Will be updated after upload
        duration,
        startTime: recordingStartTimeInChain.current,
        parentId: currentNodeId,
      };

      // Add to chain and mark as processing
      const newChain = [...audioChain, tempNode];
      setAudioChain(newChain);
      setProcessingSegmentIds(prev => new Set([...prev, tempSegmentId]));

      // Upload to S3
      console.log('[DuetRecorder] Uploading to S3...');
      const key = await recorder.current!.uploadRecording(tempUri);
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

      // Update chain: replace temp node with real node
      const nodeWithLocalUri: AudioChainNode = {
        ...savedNode,
        localUri,
        startTime: recordingStartTimeInChain.current,
      };

      const updatedChain = newChain.map(node => 
        node.id === tempSegmentId ? nodeWithLocalUri : node
      );
      console.log('[DuetRecorder] Updated chain:', updatedChain.map(n => ({ id: n.id, duration: n.duration, startTime: n.startTime, parentId: n.parentId })));

      setAudioChain(updatedChain);
      setCurrentNodeId(savedNode.id);
      
      // Remove from processing set
      setProcessingSegmentIds(prev => {
        const next = new Set(prev);
        next.delete(tempSegmentId);
        return next;
      });
    } catch (error) {
      console.error('[DuetRecorder] Recording save error:', error);
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
    setViewMode('list');  // Return to list view
    await player.current!.cleanup();
    fetchSavedChains(); // Refresh the list in case we saved something
  }

  function startNewStory() {
    setAudioChain([]);
    setCurrentNodeId(null);
    setViewMode('detail');  // Go to detail view for new recording
  }

  async function goBackToList() {
    // Stop any playback and release resources
    if (isPlaying) {
      await player.current!.stop();
      setIsPlaying(false);
    }
    stopPositionTracking();
    await player.current!.cleanup();

    setViewMode('list');
    fetchSavedChains(); // Refresh the list
  }

  async function stopPlayback() {
    if (isPlaying) {
      console.log('[DuetRecorder] Stopping playback');
      await player.current!.stop();
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
    // Fast forward to where recording would start (or end of timeline if no recording pending)
    if (isWaitingToRecord) {
      await handleSeek(recordingStartTimeInChain.current);
    } else if (audioChain.length > 0) {
      // Need to load chain first to get total duration
      await player.current!.loadChain(audioChain);
      const totalDuration = player.current!.getTotalDuration();
      await handleSeek(totalDuration);
    }
  }

  function startPositionTracking() {
    // Clear any existing interval
    if (positionInterval.current) {
      clearInterval(positionInterval.current);
    }

    // Update position every 100ms
    positionInterval.current = setInterval(async () => {
      const pos = await player.current!.getCurrentPosition();
      setCurrentPosition(pos);
      
      // Check if we're waiting to record and have reached the recording start time
      if (isWaitingToRecord && pos >= recordingStartTimeInChain.current) {
        console.log('[DuetRecorder] Reached recording start point during playback, beginning recording');
        setIsWaitingToRecord(false);
        await actuallyStartRecording();
      }
      
      // Check if playback has ended (position stops advancing or reaches end)
      // The DuetPlayer will handle stopping internally, we just track position
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
      console.log('[DuetRecorder] Playing from position:', startPosition);
      setIsLoading(true);
      await player.current!.loadChain(audioChain);
      console.log('[DuetRecorder] Chain loaded, starting playback');
      setIsLoading(false);
      setIsPlaying(true);
      setCurrentPosition(startPosition);
      setSeekPreviewPosition(null);
      startPositionTracking();
      // playFrom returns immediately after setting up playback
      // Position tracking will continue until playback ends or is stopped
      await player.current!.playFrom(startPosition);
      console.log('[DuetRecorder] Playback started');
    } catch (error) {
      console.error('[DuetRecorder] Playback error:', error);
      setIsPlaying(false);
      setIsLoading(false);
      stopPositionTracking();
    }
    // Don't stop position tracking here - it should continue during playback
    // It will be stopped when the user clicks Stop or when playback naturally ends
  }

  async function handleSegmentTap(segment: { id: string; startTime: number }) {
    if (isRecording) return; // Don't allow during recording
    await playFromPosition(segment.startTime);
  }

  // Update visual position during dragging (doesn't actually seek)
  function handleSeekPreview(position: number) {
    if (isRecording) return;
    if (audioChain.length === 0) return;
    
    // If waiting to record, only allow seeking before the recording start time
    if (isWaitingToRecord && position >= recordingStartTimeInChain.current) {
      position = Math.max(0, recordingStartTimeInChain.current - 0.1);
    }
    
    // Just update the visual position for smooth dragging
    setCurrentPosition(position);
    setSeekPreviewPosition(position);
  }

  // Actually perform the seek (called on drag end or tap)
  async function handleSeek(position: number) {
    if (isRecording) return; // Don't allow seeking during recording
    if (audioChain.length === 0) return; // No audio to seek
    
    // If waiting to record, only allow seeking before the recording start time
    if (isWaitingToRecord && position >= recordingStartTimeInChain.current) {
      // Clamp to just before recording start time
      position = Math.max(0, recordingStartTimeInChain.current - 0.1);
    }
    
    try {
      // Load chain if not already loaded
      await player.current!.loadChain(audioChain);
      
      // If currently playing, stop and seek to new position
      const wasPlaying = isPlaying;
      if (isPlaying) {
        await player.current!.stop();
        setIsPlaying(false);
        stopPositionTracking();
      }
      
      // Update position immediately for visual feedback
      setCurrentPosition(position);
      setSeekPreviewPosition(null);
      
      // If it was playing before, resume playback from new position
      if (wasPlaying) {
        // If waiting to record, set up callback for recording start time
        if (isWaitingToRecord) {
          // Start playback from the new position, with callback at recording start time
          setIsPlaying(true);
          startPositionTracking();
          await player.current!.playFrom(position, recordingStartTimeInChain.current, () => {
            console.log('[DuetRecorder] Reached recording start point after seek, beginning recording');
            setIsWaitingToRecord(false);
            actuallyStartRecording();
          });
        } else {
          // Normal playback - just start from the new position
          setIsPlaying(true);
          startPositionTracking();
          await player.current!.playFrom(position);
        }
      }
    } catch (error) {
      console.error('[DuetRecorder] Seek error:', error);
    }
  }

  // LIST VIEW - Shows saved stories
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

  // DETAIL VIEW - Recording/Playback interface
  return (
    <View style={styles.detailContainer}>
      {/* Back button */}
      <View style={styles.backButtonContainer}>
        <Button title="< Back" onPress={goBackToList} disabled={isLoading || isRecording} />
      </View>

      {/* Timeline takes full width */}
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
          Tap record to add to the story. Previous audio will play while you record.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // LIST VIEW styles
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

  // DETAIL VIEW styles
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
    // No padding - let timeline handle its own if needed
  },

  // Shared styles
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
  playing: {
    color: colors.primary,
    marginTop: 8,
    fontWeight: '500',
  },
  recordingText: {
    color: colors.recording,
    marginTop: 8,
    fontWeight: '600',
  },
  controls: {
    marginTop: 20,
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  calibrationContainer: {
    marginTop: 8,
    alignItems: 'center',
  },
  hint: {
    marginTop: 20,
    color: colors.textSecondary,
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 20,
  },
});
