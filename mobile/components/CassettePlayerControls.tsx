import React from 'react';
import { View, TouchableOpacity, StyleSheet, Text, ActivityIndicator } from 'react-native';
import { colors } from '../utils/theme';

interface CassettePlayerControlsProps {
  isPlaying: boolean;
  isRecording: boolean;
  isWaitingToRecord: boolean;
  isLoading: boolean;
  hasAudio: boolean;
  isDownloadingAudio?: boolean;
  downloadingSegmentCount?: number;
  onPlay: () => void;
  onStop: () => void;
  onRecord: () => void;
  onRewind: () => void;
  onFastForward: () => void;
}

export function CassettePlayerControls({
  isPlaying,
  isRecording,
  isWaitingToRecord,
  isLoading,
  hasAudio,
  isDownloadingAudio = false,
  downloadingSegmentCount = 0,
  onPlay,
  onStop,
  onRecord,
  onRewind,
  onFastForward,
}: CassettePlayerControlsProps) {
  const playDisabled = isLoading || isDownloadingAudio || !hasAudio || isRecording;
  const recordDisabled = isLoading || isDownloadingAudio;
  const rewindDisabled = isLoading || isDownloadingAudio || isRecording;
  return (
    <View style={styles.container}>
      <View style={styles.buttonRow}>
        {/* Rewind button */}
        <TouchableOpacity
          style={[styles.button, styles.secondaryButton]}
          onPress={onRewind}
          disabled={rewindDisabled}
        >
          <DoubleTriangle direction="left" />
        </TouchableOpacity>

        {/* Stop button (Square) - show when playing or recording */}
        {(isPlaying || isRecording) && (
          <TouchableOpacity
            style={[styles.button, styles.stopButton]}
            onPress={onStop}
            disabled={isLoading}
          >
            <View style={styles.square} />
          </TouchableOpacity>
        )}

        {/* Play button (Triangle) - only show when not playing */}
        {!isPlaying && (
          <TouchableOpacity
            style={[styles.button, styles.playButton]}
            onPress={onPlay}
            disabled={playDisabled}
          >
            <View style={styles.triangle} />
          </TouchableOpacity>
        )}

        {/* Record button (Circle) */}
        <TouchableOpacity
          style={[
            styles.button,
            styles.recordButton,
            isRecording && styles.recordButtonActive,
            isWaitingToRecord && styles.recordButtonWaiting,
          ]}
          onPress={onRecord}
          disabled={recordDisabled}
        >
          <View style={styles.circle} />
        </TouchableOpacity>

        {/* Fast Forward button */}
        <TouchableOpacity
          style={[styles.button, styles.secondaryButton]}
          onPress={onFastForward}
          disabled={rewindDisabled}
        >
          <DoubleTriangle direction="right" />
        </TouchableOpacity>
      </View>

      {/* Downloading message */}
      {isDownloadingAudio && downloadingSegmentCount > 0 && (
        <View style={styles.downloadingMessage}>
          <ActivityIndicator size="small" color="#666" />
          <Text style={styles.downloadingText}>
            Downloading {downloadingSegmentCount} segment{downloadingSegmentCount !== 1 ? 's' : ''}...
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: 20,
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
  },
  downloadingMessage: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    gap: 8,
  },
  downloadingText: {
    fontSize: 12,
    color: '#666',
    fontFamily: 'Courier New',
  },
  button: {
    width: 70,
    height: 70,
    borderRadius: 35,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.border,
  },
  secondaryButton: {
    width: 50,
    height: 50,
    borderRadius: 25,
  },
  stopButton: {
    backgroundColor: colors.surface,
  },
  playButton: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  recordButton: {
    backgroundColor: colors.surface,
  },
  recordButtonActive: {
    backgroundColor: colors.recording,
    borderColor: colors.recording,
  },
  recordButtonWaiting: {
    backgroundColor: colors.waiting,
    borderColor: colors.waiting,
  },
  // Square (Stop icon)
  square: {
    width: 24,
    height: 24,
    backgroundColor: colors.textPrimary,
    borderRadius: 2,
  },
  // Triangle (Play icon)
  triangle: {
    width: 0,
    height: 0,
    backgroundColor: 'transparent',
    borderStyle: 'solid',
    borderLeftWidth: 20,
    borderTopWidth: 12,
    borderBottomWidth: 12,
    borderLeftColor: 'white',
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    marginLeft: 4, // Slight offset to center the triangle visually
  },
  // Circle (Record icon)
  circle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.textPrimary,
  },
});

// Helper component for double triangle icons (rewind/fast forward)
const DoubleTriangle = ({ direction }: { direction: 'left' | 'right' }) => {
  const triangleStyle = {
    width: 0,
    height: 0,
    backgroundColor: 'transparent' as const,
    borderStyle: 'solid' as const,
    borderTopWidth: 8,
    borderBottomWidth: 8,
    ...(direction === 'left'
      ? {
          borderRightWidth: 12,
          borderRightColor: colors.textPrimary,
          borderTopColor: 'transparent',
          borderBottomColor: 'transparent',
        }
      : {
          borderLeftWidth: 12,
          borderLeftColor: colors.textPrimary,
          borderTopColor: 'transparent',
          borderBottomColor: 'transparent',
        }),
  };

  return (
    <View style={{ flexDirection: 'row', gap: 2 }}>
      <View style={triangleStyle} />
      <View style={triangleStyle} />
    </View>
  );
};
