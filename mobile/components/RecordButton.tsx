import React from 'react';
import { TouchableOpacity, Text, StyleSheet, ActivityIndicator } from 'react-native';

interface RecordButtonProps {
  isRecording: boolean;
  isLoading?: boolean;
  onPress: () => void;
}

export function RecordButton({ isRecording, isLoading, onPress }: RecordButtonProps) {
  return (
    <TouchableOpacity
      style={[styles.button, isRecording && styles.recording]}
      onPress={onPress}
      disabled={isLoading}
    >
      {isLoading ? (
        <ActivityIndicator color="white" />
      ) : (
        <Text style={styles.text}>
          {isRecording ? 'Stop' : 'Record'}
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
  text: {
    color: 'white',
    fontSize: 18,
    fontWeight: 'bold',
  },
});
