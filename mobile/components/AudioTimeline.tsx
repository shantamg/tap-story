import React from 'react';
import { View, ScrollView, Text, StyleSheet } from 'react-native';

interface AudioSegment {
  id: string;
  duration: number;
  startTime: number;
  parentId: string | null;
}

interface AudioTimelineProps {
  segments: AudioSegment[];
  pixelsPerSecond?: number;
}

// Colors for each track (cycling if more than available)
const TRACK_COLORS = [
  '#007AFF', // Blue
  '#FF9500', // Orange
  '#34C759', // Green
  '#AF52DE', // Purple
  '#FF3B30', // Red
  '#5AC8FA', // Light Blue
  '#FFCC00', // Yellow
  '#FF2D55', // Pink
];

export function AudioTimeline({ segments, pixelsPerSecond = 10 }: AudioTimelineProps) {
  if (segments.length === 0) {
    return null;
  }

  // Calculate total duration (latest end time)
  const totalDuration = Math.max(...segments.map(seg => seg.startTime + seg.duration));
  const timelineWidth = Math.max(totalDuration * pixelsPerSecond, 200);

  // Generate time markers every 5 seconds
  const timeMarkers: number[] = [];
  for (let t = 0; t <= totalDuration; t += 5) {
    timeMarkers.push(t);
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Timeline ({segments.length} segments, {totalDuration}s total)</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={true}
        style={styles.scrollView}
        contentContainerStyle={[styles.scrollContent, { width: timelineWidth + 60 }]}
      >
        {/* Time markers */}
        <View style={[styles.timeMarkers, { width: timelineWidth, marginLeft: 40 }]}>
          {timeMarkers.map((time) => (
            <View
              key={time}
              style={[styles.timeMarker, { left: time * pixelsPerSecond }]}
            >
              <View style={styles.markerLine} />
              <Text style={styles.markerText}>{time}s</Text>
            </View>
          ))}
        </View>

        {/* Audio segments as horizontal bars with absolute positioning */}
        <View style={styles.tracksContainer}>
          {segments.map((segment, index) => {
            const width = segment.duration * pixelsPerSecond;
            const left = segment.startTime * pixelsPerSecond;
            const color = TRACK_COLORS[index % TRACK_COLORS.length];

            return (
              <View key={segment.id} style={styles.trackRow}>
                <View style={styles.trackLabel}>
                  <Text style={styles.trackLabelText}>#{index + 1}</Text>
                </View>
                <View style={[styles.trackContent, { width: timelineWidth }]}>
                  <View
                    style={[
                      styles.segmentBar,
                      {
                        width: Math.max(width, 20),
                        marginLeft: left,
                        backgroundColor: color,
                      },
                    ]}
                  >
                    <Text style={styles.segmentText} numberOfLines={1}>
                      {segment.startTime}-{segment.startTime + segment.duration}s
                    </Text>
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 16,
    width: '100%',
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
    color: '#333',
    paddingHorizontal: 16,
  },
  scrollView: {
    maxHeight: 300,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  timeMarkers: {
    height: 24,
    position: 'relative',
    marginBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
  },
  timeMarker: {
    position: 'absolute',
    alignItems: 'center',
  },
  markerLine: {
    width: 1,
    height: 8,
    backgroundColor: '#999',
  },
  markerText: {
    fontSize: 10,
    color: '#666',
    marginTop: 2,
  },
  tracksContainer: {
    gap: 8,
  },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 32,
  },
  trackLabel: {
    width: 30,
    marginRight: 8,
  },
  trackContent: {
    height: 24,
  },
  trackLabelText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#666',
  },
  segmentBar: {
    height: 24,
    borderRadius: 4,
    justifyContent: 'center',
    paddingHorizontal: 8,
    minWidth: 20,
  },
  segmentText: {
    color: 'white',
    fontSize: 11,
    fontWeight: '600',
  },
});
