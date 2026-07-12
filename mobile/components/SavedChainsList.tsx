import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView, LayoutChangeEvent, Modal, Alert, RefreshControl } from 'react-native';
import { colors, spacing, radius, typography } from '../utils/theme';
import { AppButton } from './AppButton';
import type { AudioChainSegment, AudioChainSummary } from '@shared/types/audio';

interface SavedChainsListProps {
  chains: AudioChainSummary[];
  isLoading: boolean;
  error?: string | null;
  selectedChainId: string | null;
  onSelectChain: (chainId: string) => void;
  onRefresh: () => void;
  onDeleteChain?: (chainId: string) => Promise<void>;
}

function TimelinePreview({ 
  segments, 
  totalDurationMs,
  containerWidth 
}: { 
  segments: AudioChainSegment[];
  totalDurationMs: number;
  containerWidth: number;
}) {
  if (segments.length === 0 || totalDurationMs === 0) return null;

  // Separate segments into top row (even indices) and bottom row (odd indices)
  const topRowSegments: Array<{ segment: AudioChainSegment; index: number }> = [];
  const bottomRowSegments: Array<{ segment: AudioChainSegment; index: number }> = [];
  
  segments.forEach((segment, index) => {
    if (index % 2 === 0) {
      topRowSegments.push({ segment, index });
    } else {
      bottomRowSegments.push({ segment, index });
    }
  });

  // Helper to convert time to pixel width
  const timeToWidth = (durationMs: number): number => {
    const width = (durationMs / totalDurationMs) * containerWidth;
    return Math.max(width, 30); // Minimum width
  };

  // Helper to convert time to pixel position
  const timeToLeft = (startTimeMs: number): number => {
    return (startTimeMs / totalDurationMs) * containerWidth;
  };

  return (
    <View style={previewStyles.container}>
      {/* Top row - even indices (0, 2, 4, ...) */}
      <View style={previewStyles.trackRow}>
        {topRowSegments.map(({ segment, index }) => {
          const width = timeToWidth(segment.durationMs);
          const left = timeToLeft(segment.startTimeMs);
          return (
            <View
              key={segment.id}
              style={[
                previewStyles.segmentBar,
                {
                  width,
                  position: 'absolute',
                  left,
                },
              ]}
            />
          );
        })}
      </View>

      {/* Bottom row - odd indices (1, 3, 5, ...) */}
      <View style={previewStyles.trackRow}>
        {bottomRowSegments.map(({ segment, index }) => {
          const width = timeToWidth(segment.durationMs);
          const left = timeToLeft(segment.startTimeMs);
          return (
            <View
              key={segment.id}
              style={[
                previewStyles.segmentBar,
                {
                  width,
                  position: 'absolute',
                  left,
                },
              ]}
            />
          );
        })}
      </View>
    </View>
  );
}

const previewStyles = StyleSheet.create({
  container: {
    width: '100%',
    gap: 6,
    position: 'relative',
  },
  trackRow: {
    height: 24,
    position: 'relative',
  },
  segmentBar: {
    height: 24,
    borderRadius: 4,
    backgroundColor: 'rgba(139, 92, 246, 0.85)', // Violet, matching the timeline
    borderWidth: 1,
    borderColor: 'rgba(167, 139, 250, 0.35)',
  },
});

export function SavedChainsList({
  chains,
  isLoading,
  error,
  selectedChainId,
  onSelectChain,
  onRefresh,
  onDeleteChain
}: SavedChainsListProps) {
  const [containerWidth, setContainerWidth] = React.useState(300);
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [chainToDelete, setChainToDelete] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const onContainerLayout = React.useCallback((event: LayoutChangeEvent) => {
    setContainerWidth(event.nativeEvent.layout.width);
  }, []);

  if (isLoading && chains.length === 0) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={styles.loadingText}>Loading your stories…</Text>
      </View>
    );
  }

  // A fetch failure must not masquerade as an empty library.
  if (error && chains.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyIcon}>📡</Text>
        <Text style={styles.emptyText}>{error}</Text>
        <AppButton label="Try again" variant="secondary" onPress={onRefresh} style={styles.retryButton} />
      </View>
    );
  }

  if (chains.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyIcon}>🎙️</Text>
        <Text style={styles.emptyText}>No stories yet</Text>
        <Text style={styles.emptySubtext}>Tap “New Story” above to record your first idea.</Text>
      </View>
    );
  }

  // Filter: if a chain is selected, only show that one
  const visibleChains = selectedChainId
    ? chains.filter(c => c.id === selectedChainId)
    : chains;

  // Generate a name for each story (could be improved with actual names from backend)
  const getStoryName = (chain: AudioChainSummary, index: number) => {
    // For now, use a simple naming scheme
    return `Story ${visibleChains.length - index}`;
  };

  const handleLongPress = (chainId: string) => {
    if (!onDeleteChain) return;
    setChainToDelete(chainId);
    setDeleteModalVisible(true);
  };

  const handleDeleteConfirm = async () => {
    if (!chainToDelete || !onDeleteChain) return;

    try {
      setIsDeleting(true);
      await onDeleteChain(chainToDelete);
      setDeleteModalVisible(false);
      setChainToDelete(null);
    } catch (error) {
      console.error('[SavedChainsList] Failed to delete chain:', error);
      Alert.alert('Error', 'Failed to delete story. Please try again.');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteModalVisible(false);
    setChainToDelete(null);
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
      onLayout={onContainerLayout}
      refreshControl={
        <RefreshControl
          refreshing={isLoading}
          onRefresh={onRefresh}
          tintColor={colors.primary}
          colors={[colors.primary]}
        />
      }
    >
      <View style={styles.listContainer}>
        {visibleChains.map((chain, index) => {
          const clipCount = chain.segments.length;
          return (
            <TouchableOpacity
              key={chain.id}
              style={styles.chainItem}
              onPress={() => onSelectChain(chain.id)}
              onLongPress={() => handleLongPress(chain.id)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Open ${getStoryName(chain, index)}, ${clipCount} ${clipCount === 1 ? 'clip' : 'clips'}. Long-press to delete.`}
            >
              <View style={styles.timelineContainer}>
                <TimelinePreview
                  segments={chain.segments}
                  totalDurationMs={chain.totalDurationMs}
                  containerWidth={containerWidth - spacing.lg * 2}
                />
              </View>
              <View style={styles.chainMeta}>
                <Text style={styles.storyName}>
                  {getStoryName(chain, index)}
                </Text>
                <Text style={styles.clipCount}>
                  {clipCount} {clipCount === 1 ? 'clip' : 'clips'}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Delete Confirmation Modal */}
      <Modal
        visible={deleteModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={handleDeleteCancel}
      >
        <View style={modalStyles.overlay}>
          <View style={modalStyles.container}>
            <Text style={modalStyles.title}>Delete story?</Text>
            <Text style={modalStyles.message}>
              Clips unique to this story will be permanently removed. Clips shared with other stories are kept. This can't be undone.
            </Text>
            <View style={modalStyles.buttonContainer}>
              <TouchableOpacity
                style={[modalStyles.button, modalStyles.cancelButton]}
                onPress={handleDeleteCancel}
                disabled={isDeleting}
              >
                <Text style={modalStyles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[modalStyles.button, modalStyles.deleteButton]}
                onPress={handleDeleteConfirm}
                disabled={isDeleting}
              >
                <Text style={modalStyles.deleteButtonText}>
                  {isDeleting ? 'Deleting...' : 'Delete'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: spacing.xl,
  },
  listContainer: {
    gap: spacing.md,
  },
  chainItem: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  timelineContainer: {
    width: '100%',
    marginBottom: spacing.md,
  },
  chainMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  storyName: {
    ...typography.heading,
    color: colors.textPrimary,
  },
  clipCount: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  loadingText: {
    color: colors.textSecondary,
    ...typography.body,
  },
  emptyContainer: {
    alignItems: 'center',
    paddingVertical: spacing.xxxl,
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  emptyIcon: {
    fontSize: 40,
    marginBottom: spacing.xs,
  },
  emptyText: {
    color: colors.textSecondary,
    ...typography.heading,
    textAlign: 'center',
  },
  emptySubtext: {
    color: colors.textTertiary,
    ...typography.body,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: spacing.md,
  },
});

const modalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  container: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 24,
    width: '100%',
    maxWidth: 400,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: colors.textPrimary,
    marginBottom: 12,
  },
  message: {
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: 24,
    lineHeight: 20,
  },
  buttonContainer: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'flex-end',
  },
  button: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    minWidth: 100,
    alignItems: 'center',
  },
  cancelButton: {
    backgroundColor: colors.border,
  },
  cancelButtonText: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  deleteButton: {
    backgroundColor: colors.recording,
  },
  deleteButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
