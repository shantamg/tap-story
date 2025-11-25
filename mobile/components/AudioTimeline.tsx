import React, { useRef, useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, LayoutChangeEvent, ScrollView } from 'react-native';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';

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
  recordingStartTime?: number;  // When the current recording starts in the timeline
  recordingDuration?: number;   // How long we've been recording (seconds)
}

// Colors for each track (cycling if more than available)
const TRACK_COLORS = [
  '#007AFF', // Blue
  '#FF9500', // Orange
  '#34C759', // Green
  '#AF52DE', // Purple
  '#5AC8FA', // Light Blue
  '#FFCC00', // Yellow
  '#FF2D55', // Pink
];

const MIN_WIDTH_PX = 30; // Minimum segment width in pixels

export function AudioTimeline({
  segments,
  onSegmentTap,
  isRecording = false,
  recordingStartTime = 0,
  recordingDuration = 0,
}: AudioTimelineProps) {
  const [containerWidth, setContainerWidth] = useState(300);
  const [zoomScale, setZoomScale] = useState(1); // 1 = auto-fit, >1 = zoomed in
  const baseZoomScale = useRef(1);
  const scrollViewRef = useRef<ScrollView>(null);

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
  // This means: first recording = always full width, second recording doesn't shrink first until it's longer
  const timelineDuration = Math.max(1, maxSavedEndTime, recordingEndTime);

  // Handle container layout to get width
  const onContainerLayout = useCallback((event: LayoutChangeEvent) => {
    setContainerWidth(event.nativeEvent.layout.width);
  }, []);

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

  const composedGesture = Gesture.Race(pinchGesture, doubleTapGesture);

  // Early return AFTER all hooks
  if (!shouldShow) {
    return null;
  }

  // Calculate available width for timeline content (full width, no padding)
  const availableWidth = containerWidth * zoomScale;

  // Helper to convert time to pixel width
  const timeToWidth = (duration: number): number => {
    const width = (duration / timelineDuration) * availableWidth;
    return Math.max(width, MIN_WIDTH_PX);
  };

  // Helper to convert time to pixel position
  const timeToLeft = (startTime: number): number => {
    return (startTime / timelineDuration) * availableWidth;
  };

  const content = (
    <View style={[styles.tracksContainer, { width: availableWidth }]}>
      {segments.map((segment, index) => {
        const width = timeToWidth(segment.duration);
        const left = timeToLeft(segment.startTime);
        const color = TRACK_COLORS[index % TRACK_COLORS.length];

        return (
          <View key={segment.id} style={styles.trackRow}>
            <TouchableOpacity
              onPress={() => onSegmentTap?.(segment)}
              activeOpacity={0.7}
              style={[
                styles.segmentBar,
                {
                  width,
                  marginLeft: left,
                  backgroundColor: color,
                },
              ]}
            >
              <Text style={styles.segmentText} numberOfLines={1}>
                {segment.duration}s
              </Text>
            </TouchableOpacity>
          </View>
        );
      })}

      {/* Growing recording segment */}
      {isRecording && (
        <View style={styles.trackRow}>
          <View
            style={[
              styles.segmentBar,
              styles.recordingSegment,
              {
                width: timeToWidth(recordingDuration),
                marginLeft: timeToLeft(recordingStartTime),
                backgroundColor: '#FF3B30', // Red for recording
              },
            ]}
          >
            <Text style={styles.segmentText} numberOfLines={1}>
              {recordingDuration.toFixed(1)}s
            </Text>
          </View>
        </View>
      )}
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
  },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 32,
  },
  segmentBar: {
    height: 28,
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  segmentText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  recordingSegment: {
    borderWidth: 2,
    borderColor: '#fff',
    opacity: 0.9,
  },
  zoomHint: {
    textAlign: 'center',
    fontSize: 10,
    color: '#999',
    marginTop: 4,
  },
});
