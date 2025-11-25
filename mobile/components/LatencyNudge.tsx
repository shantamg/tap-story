import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { colors } from '../utils/theme';

interface LatencyNudgeProps {
  offsetMs: number;
  onOffsetChange: (newOffset: number) => void;
  disabled?: boolean;
}

export function LatencyNudge({ offsetMs, onOffsetChange, disabled = false }: LatencyNudgeProps) {
  const adjust = (delta: number) => {
    onOffsetChange(offsetMs + delta);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Sync Adjust</Text>
      <View style={styles.controls}>
        <TouchableOpacity 
          style={[styles.button, styles.bigButton]} 
          onPress={() => adjust(-10)}
          disabled={disabled}
        >
          <Text style={styles.buttonText}>{'<<'}</Text>
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={[styles.button, styles.smallButton]} 
          onPress={() => adjust(-1)}
          disabled={disabled}
        >
          <Text style={styles.buttonText}>{'<'}</Text>
        </TouchableOpacity>

        <View style={styles.display}>
          <Text style={styles.valueText}>
            {offsetMs > 0 ? '+' : ''}{offsetMs} ms
          </Text>
        </View>

        <TouchableOpacity 
          style={[styles.button, styles.smallButton]} 
          onPress={() => adjust(1)}
          disabled={disabled}
        >
          <Text style={styles.buttonText}>{'>'}</Text>
        </TouchableOpacity>

        <TouchableOpacity 
          style={[styles.button, styles.bigButton]} 
          onPress={() => adjust(10)}
          disabled={disabled}
        >
          <Text style={styles.buttonText}>{'>>'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 8,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 12,
    marginBottom: 8,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  button: {
    backgroundColor: colors.surface,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  bigButton: {
    width: 40,
    height: 32,
  },
  smallButton: {
    width: 32,
    height: 32,
  },
  buttonText: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  display: {
    minWidth: 70,
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  valueText: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: 'bold',
    fontVariant: ['tabular-nums'],
  },
});

