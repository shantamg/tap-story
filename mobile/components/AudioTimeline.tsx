import React, { useRef, useCallback, useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, LayoutChangeEvent, ScrollView } from 'react-native';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, runOnJS, interpolateColor } from 'react-native-reanimated';
import { colors } from '../utils/theme';

interface AudioSegment {
  id: string;
  duration: number;
  startTime: number;
  parentId: string | null;
}

interface AudioTimelineProps {
  segments: AudioSegment[];
  onSegmentTap?: (segment: AudioSegment) => void;
  // Recording state
  isRecording?: boolean;
  isWaitingToRecord?: boolean;  // Waiting for playback to reach recording start time
  recordingStartTime?: number;  // When the current recording starts in the timeline
  recordingDuration?: number;   // How long we've been recording (seconds)
  // Playback state
  currentTimelinePosition?: number;  // Current playback position in timeline (seconds)
  onSeek?: (position: number) => void;  // Callback when user seeks to a position (actual seek)
  onSeekPreview?: (position: number) => void;  // Callback during drag for visual feedback only
  previewTimelinePosition?: number | null; // Visual preview position during dragging
  processingSegmentIds?: Set<string>; // IDs of segments currently being uploaded/processed
  downloadingSegmentIds?: Set<string>; // IDs of segments currently being downloaded
}

const MIN_WIDTH_PX = 30; // Minimum segment width in pixels

export function AudioTimeline({
  segments,
  onSegmentTap,
  isRecording = false,
  isWaitingToRecord = false,
  recordingStartTime = 0,
  recordingDuration = 0,
  currentTimelinePosition = 0,
  onSeek,
  onSeekPreview,
  previewTimelinePosition = null,
  processingSegmentIds = new Set(),
  downloadingSegmentIds = new Set(),
}: AudioTimelineProps) {
  const [containerWidth, setContainerWidth] = useState(300);
  const [zoomScale, setZoomScale] = useState(1); // 1 = auto-fit, >1 = zoomed in
  const baseZoomScale = useRef(1);
  const scrollViewRef = useRef<ScrollView>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const previousSegmentsLength = useRef(segments.length);

  // Reset zoom scale when starting a new story (segments go from having items to empty)
  useEffect(() => {
    if (previousSegmentsLength.current > 0 && segments.length === 0) {
      // Starting a new story - reset zoom to default
      setZoomScale(1);
      setScrollOffset(0);
      baseZoomScale.current = 1;
    }
    previousSegmentsLength.current = segments.length;
  }, [segments.length]);

  // Check if we should show timeline
  const shouldShow = segments.length > 0 || isRecording;

  // Calculate the "anchor" duration - the farthest any saved segment extends
  // This is what determines the scale, NOT the current recording (until it exceeds this)
  const savedSegmentEndTimes = segments.map(seg => seg.startTime + seg.duration);
  const maxSavedEndTime = savedSegmentEndTimes.length > 0 ? Math.max(...savedSegmentEndTimes) : 0;

  // Current recording end time
  const recordingEndTime = isRecording ? recordingStartTime + recordingDuration : 0;

  // The timeline scale is based on whichever is larger:
  // - The max saved segment end time
  // - The current recording end time (only if it exceeds saved segments)
  // For the first recording (no saved segments), use a small initial duration
  // to ensure it starts at the left edge, not centered
  let timelineDuration: number;
  if (segments.length === 0 && isRecording) {
    // First recording: use recording duration, but ensure minimum of 0.5s so it's visible
    // This ensures the recording starts at the left edge (time 0) rather than centered
    timelineDuration = Math.max(0.5, recordingDuration);
  } else {
    // Subsequent recordings: use max of saved segments and current recording
    timelineDuration = Math.max(1, maxSavedEndTime, recordingEndTime);
  }

  // Handle container layout to get width
  const onContainerLayout = useCallback((event: LayoutChangeEvent) => {
    setContainerWidth(event.nativeEvent.layout.width);
  }, []);

  // Calculate available width for timeline content (full width, no padding)
  const availableWidth = containerWidth * zoomScale;

  // Helper to convert time to pixel width
  const timeToWidth = useCallback((duration: number): number => {
    const width = (duration / timelineDuration) * availableWidth;
    return Math.max(width, MIN_WIDTH_PX);
  }, [timelineDuration, availableWidth]);

  // Helper to convert time to pixel position
  const timeToLeft = useCallback((startTime: number): number => {
    // For the first recording, always start at the left edge (0) regardless of actual start time
    // The pre-roll is for audio capture, not visual positioning
    const visualStartTime = (segments.length === 0 && isRecording) ? 0 : startTime;
    return (visualStartTime / timelineDuration) * availableWidth;
  }, [segments.length, isRecording, timelineDuration, availableWidth]);

  // Helper to convert pixel position to timeline time
  const leftToTime = useCallback((pixelX: number): number => {
    const clampedX = Math.max(0, Math.min(pixelX, availableWidth));
    return (clampedX / availableWidth) * timelineDuration;
  }, [availableWidth, timelineDuration]);

  // Pinch gesture for zooming
  const pinchGesture = Gesture.Pinch()
    .onStart(() => {
      baseZoomScale.current = zoomScale;
    })
    .onUpdate((event) => {
      const newScale = Math.max(1, Math.min(10, baseZoomScale.current * event.scale));
      setZoomScale(newScale);
    });

  // Double-tap to reset zoom
  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      setZoomScale(1);
    });

  // Helper function to calculate position (runs on JS thread)
  const calculatePosition = useCallback((eventX: number) => {
    // Calculate timeline time
    const adjustedX = zoomScale > 1 ? eventX + scrollOffset : eventX;
    let timelineTime = leftToTime(adjustedX);
    
    // If waiting to record, clamp to before recording start time
    if (isWaitingToRecord && timelineTime >= recordingStartTime) {
      timelineTime = Math.max(0, recordingStartTime - 0.1);
    }
    
    return timelineTime;
  }, [zoomScale, scrollOffset, isWaitingToRecord, recordingStartTime, leftToTime]);

  const panStartX = useSharedValue(0);

  // Helper for preview (visual only during drag)
  const handleSeekPreview = useCallback((eventX: number) => {
    if (!onSeekPreview || isRecording) return;
    const timelineTime = calculatePosition(eventX);
    onSeekPreview(timelineTime);
  }, [onSeekPreview, isRecording, calculatePosition]);

  // Helper for actual seek (on tap or drag end)
  const handleSeek = useCallback((eventX: number) => {
    if (!onSeek || isRecording) return;
    const timelineTime = calculatePosition(eventX);
    onSeek(timelineTime);
  }, [onSeek, isRecording, calculatePosition]);

  // Tap gesture for seeking
  const tapGesture = Gesture.Tap()
    .onEnd((event) => {
      if (onSeek && !isRecording) {
        runOnJS(handleSeek)(event.x);
      }
    });

  // Pan gesture for dragging the playhead
  const panGesture = Gesture.Pan()
    .onBegin((event) => {
      panStartX.value = event.x;
      if (onSeekPreview && !isRecording) {
        runOnJS(handleSeekPreview)(event.x);
      }
    })
    .onUpdate((event) => {
      // During drag, update visual position based on translation
      if (onSeekPreview && !isRecording) {
        const currentX = panStartX.value + event.translationX;
        runOnJS(handleSeekPreview)(currentX);
      }
    })
    .onEnd((event) => {
      // On drag end, actually seek to the final position
      if (onSeek && !isRecording) {
        const currentX = panStartX.value + event.translationX;
        runOnJS(handleSeek)(currentX);
      }
    });

  // Compose gestures: pinch/zoom and double-tap take priority, then pan/drag, then tap
  // Use Exclusive to prevent conflicts
  const composedGesture = Gesture.Exclusive(
    Gesture.Race(pinchGesture, doubleTapGesture),
    panGesture,
    tapGesture
  );

  // Early return AFTER all hooks
  if (!shouldShow) {
    return null;
  }


  const effectiveTimelinePosition =
    previewTimelinePosition !== null
      ? previewTimelinePosition
      : currentTimelinePosition;

  // Calculate current playhead position
  // When recording, playhead is at the recording position (start time + duration)
  const getPlayheadPosition = (): number => {
    if (isRecording) {
      return recordingStartTime + recordingDuration;
    }
    return effectiveTimelinePosition;
  };

  const playheadPosition = getPlayheadPosition();
  const playheadLeft = timeToLeft(playheadPosition);

  // Separate segments into top row (even indices) and bottom row (odd indices)
  const topRowSegments: Array<{ segment: AudioSegment; index: number }> = [];
  const bottomRowSegments: Array<{ segment: AudioSegment; index: number }> = [];
  
  segments.forEach((segment, index) => {
    if (index % 2 === 0) {
      topRowSegments.push({ segment, index });
    } else {
      bottomRowSegments.push({ segment, index });
    }
  });

  // Check if a segment is currently playing
  const isSegmentPlaying = (segment: AudioSegment): boolean => {
    if (isRecording) return false;
    const segmentStart = segment.startTime;
    const segmentEnd = segment.startTime + segment.duration;
    return (
      effectiveTimelinePosition >= segmentStart &&
      effectiveTimelinePosition < segmentEnd
    );
  };

  // Animated segment component
  const AnimatedSegment = React.memo(({
    segment,
    index,
    isRecordingSegment,
    width,
    left,
    isPlaying,
    onSegmentTap,
    recordingDuration,
    isProcessing,
    isDownloading,
  }: {
    segment: AudioSegment;
    index: number;
    isRecordingSegment: boolean;
    width: number;
    left: number;
    isPlaying: boolean;
    onSegmentTap?: (segment: AudioSegment) => void;
    recordingDuration: number;
    isProcessing: boolean;
    isDownloading: boolean;
  }) => {
    // Animated values for glow effect
    const glowOpacity = useSharedValue(isPlaying ? 1 : 0);
    const brightness = useSharedValue(isPlaying ? 1 : 0);

    // Update animation values when playing state changes
    useEffect(() => {
      glowOpacity.value = withTiming(isPlaying ? 1 : 0, { duration: 300 });
      brightness.value = withTiming(isPlaying ? 1 : 0, { duration: 300 });
    }, [isPlaying, glowOpacity, brightness]);

    // Animated style for the segment
    const animatedStyle = useAnimatedStyle(() => {
      // Priority: downloading > processing > normal
      let baseColor;
      if (isDownloading) {
        baseColor = ['rgba(136, 136, 136, 0.5)', 'rgba(136, 136, 136, 0.5)']; // Gray for downloading
      } else if (isProcessing) {
        baseColor = ['rgba(255, 149, 0, 0.7)', 'rgba(255, 204, 0, 0.9)']; // Orange to yellow for processing
      } else {
        baseColor = ['rgba(88, 28, 135, 0.85)', 'rgba(147, 51, 234, 1.0)']; // Dark purple to bright purple
      }
      
      const backgroundColor = interpolateColor(
        brightness.value,
        [0, 1],
        baseColor
      );
      
      return {
        backgroundColor,
        shadowOpacity: glowOpacity.value * 0.6,
        shadowRadius: 8 + glowOpacity.value * 12,
        elevation: glowOpacity.value * 15,
      };
    });

    const segmentStyle = [
      styles.segmentBar,
      {
        width,
        position: 'absolute' as const,
        left,
      },
      isRecordingSegment && styles.recordingSegment,
      isProcessing && styles.processingSegment,
      isDownloading && styles.downloadingSegment,
    ];

    const SegmentComponent = isRecordingSegment ? View : TouchableOpacity;
    const segmentProps = isRecordingSegment
      ? {}
      : {
          onPress: () => onSegmentTap?.(segment),
          activeOpacity: 0.7,
        };

    return (
      <Animated.View
        style={[
          segmentStyle,
          animatedStyle,
          {
            shadowColor: '#9333EA', // Purple glow color
            shadowOffset: { width: 0, height: 0 },
          },
        ]}
      >
        <SegmentComponent
          {...segmentProps}
          style={styles.segmentInner}
        >
          <Text style={styles.segmentText} numberOfLines={1}>
            {isRecordingSegment
              ? `${recordingDuration.toFixed(1)}s`
              : `${segment.duration}s`}
          </Text>
        </SegmentComponent>
      </Animated.View>
    );
  });

  // Render a segment
  const renderSegment = (
    segment: AudioSegment,
    index: number,
    isRecordingSegment: boolean = false
  ) => {
    const width = timeToWidth(segment.duration);
    const left = timeToLeft(segment.startTime);
    const playing = !isRecordingSegment && isSegmentPlaying(segment);
    const isProcessing = processingSegmentIds.has(segment.id);
    const isDownloading = downloadingSegmentIds.has(segment.id);

    return (
      <AnimatedSegment
        key={segment.id}
        segment={segment}
        index={index}
        isRecordingSegment={isRecordingSegment}
        width={width}
        left={left}
        isPlaying={playing}
        onSegmentTap={onSegmentTap}
        recordingDuration={recordingDuration}
        isProcessing={isProcessing}
        isDownloading={isDownloading}
      />
    );
  };

  const content = (
    <View style={[styles.tracksContainer, { width: availableWidth }]}>
      {/* Playhead strip - rendered behind segments */}
      <View
        style={[
          styles.playhead,
          {
            left: playheadLeft,
          },
        ]}
      />

      {/* Top row - even indices (0, 2, 4, ...) */}
      <View style={styles.trackRow}>
        {topRowSegments.map(({ segment, index }) =>
          renderSegment(segment, index)
        )}
        {/* Recording segment on top row if next index would be even */}
        {isRecording && segments.length % 2 === 0 && (
          <View
            style={[
              styles.segmentBar,
              styles.recordingSegment,
              {
                width: timeToWidth(recordingDuration),
                position: 'absolute',
                left: timeToLeft(recordingStartTime),
              },
            ]}
          >
            <Text style={styles.segmentText} numberOfLines={1}>
              {recordingDuration.toFixed(1)}s
            </Text>
          </View>
        )}
      </View>

      {/* Bottom row - odd indices (1, 3, 5, ...) */}
      <View style={styles.trackRow}>
        {bottomRowSegments.map(({ segment, index }) =>
          renderSegment(segment, index)
        )}
        {/* Recording segment on bottom row if next index would be odd */}
        {isRecording && segments.length % 2 === 1 && (
          <View
            style={[
              styles.segmentBar,
              styles.recordingSegment,
              {
                width: timeToWidth(recordingDuration),
                position: 'absolute',
                left: timeToLeft(recordingStartTime),
              },
            ]}
          >
            <Text style={styles.segmentText} numberOfLines={1}>
              {recordingDuration.toFixed(1)}s
            </Text>
          </View>
        )}
      </View>
    </View>
  );

  return (
    <View style={styles.container} onLayout={onContainerLayout}>
      <GestureDetector gesture={composedGesture}>
        {zoomScale > 1 ? (
          <ScrollView
            ref={scrollViewRef}
            horizontal
            showsHorizontalScrollIndicator={true}
            style={styles.scrollView}
            contentContainerStyle={styles.scrollContent}
            onScroll={(event) => {
              setScrollOffset(event.nativeEvent.contentOffset.x);
            }}
            scrollEventThrottle={16}
          >
            {content}
          </ScrollView>
        ) : (
          <View style={styles.scrollContent}>
            {content}
          </View>
        )}
      </GestureDetector>
      {zoomScale > 1 && (
        <Text style={styles.zoomHint}>Double-tap to reset zoom</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 16,
    // No horizontal padding - segments go edge to edge
  },
  scrollView: {
    flexGrow: 0,
  },
  scrollContent: {
    paddingVertical: 4,
  },
  tracksContainer: {
    gap: 6,
    position: 'relative',
  },
  playhead: {
    position: 'absolute',
    top: 0,
    width: 3,
    height: '100%', // Spans both rows
    backgroundColor: '#FFFFFF',
    opacity: 0.8,
    zIndex: 0, // Behind segments (visible through semi-transparent segments)
  },
  trackRow: {
    height: 32,
    position: 'relative',
    zIndex: 1, // Above playhead
  },
  segmentBar: {
    height: 28,
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
    // Background color is now animated, so removed from here
    borderWidth: 1,
    borderColor: 'rgba(147, 51, 234, 0.3)', // Subtle purple border
  },
  segmentInner: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  segmentText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  recordingSegment: {
    backgroundColor: colors.recording, // Red for recording (keep red to distinguish from regular segments)
    borderWidth: 2,
    borderColor: '#fff',
    opacity: 0.9,
  },
  processingSegment: {
    // Processing segments use animated color, but we can add a border to distinguish
    borderWidth: 2,
    borderColor: colors.waiting, // Orange border for processing
    borderStyle: 'dashed', // Dashed border to indicate processing
  },
  downloadingSegment: {
    backgroundColor: '#888',
    opacity: 0.5,
    borderWidth: 1,
    borderColor: '#666',
    borderStyle: 'dashed',
  },
  zoomHint: {
    textAlign: 'center',
    fontSize: 10,
    color: colors.textTertiary,
    marginTop: 4,
  },
});
