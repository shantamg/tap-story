import React from 'react';
import { TouchableOpacity, Text, StyleSheet, ActivityIndicator, View } from 'react-native';

interface RecordButtonProps {
  isRecording: boolean;
  isWaitingToRecord?: boolean;
  isLoading?: boolean;
  onPress: () => void;
}

export function RecordButton({ isRecording, isWaitingToRecord, isLoading, onPress }: RecordButtonProps) {
  // Determine button state
  const getButtonStyle = () => {
    if (isRecording) return styles.recording;
    if (isWaitingToRecord) return styles.waiting;
    return null;
  };

  const getButtonText = () => {
    if (isRecording) return 'Stop';
    if (isWaitingToRecord) return 'Waiting...';
    return 'Record';
  };

  return (
    <TouchableOpacity
      style={[styles.button, getButtonStyle()]}
      onPress={onPress}
      disabled={isLoading}
    >
      {isLoading ? (
        <ActivityIndicator color="white" />
      ) : isWaitingToRecord ? (
        <View style={styles.waitingContent}>
          <View style={styles.pulseDot} />
          <Text style={styles.waitingText}>Waiting</Text>
        </View>
      ) : (
        <Text style={styles.text}>
          {getButtonText()}
        </Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  recording: {
    backgroundColor: '#FF3B30',
  },
  waiting: {
    backgroundColor: '#FF9500',
  },
  text: {
    color: 'white',
    fontSize: 18,
    fontWeight: 'bold',
  },
  waitingContent: {
    alignItems: 'center',
  },
  pulseDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: 'white',
    marginBottom: 4,
  },
  waitingText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
});
