import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView, LayoutChangeEvent, Modal, Alert } from 'react-native';
import { colors } from '../utils/theme';

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

interface SavedChainsListProps {
  chains: ChainSummary[];
  isLoading: boolean;
  selectedChainId: string | null;
  onSelectChain: (chainId: string) => void;
  onRefresh: () => void;
  onDeleteChain?: (chainId: string) => Promise<void>;
}

function TimelinePreview({ 
  segments, 
  totalDuration,
  containerWidth 
}: { 
  segments: ChainSegment[]; 
  totalDuration: number;
  containerWidth: number;
}) {
  if (segments.length === 0 || totalDuration === 0) return null;

  // Separate segments into top row (even indices) and bottom row (odd indices)
  const topRowSegments: Array<{ segment: ChainSegment; index: number }> = [];
  const bottomRowSegments: Array<{ segment: ChainSegment; index: number }> = [];
  
  segments.forEach((segment, index) => {
    if (index % 2 === 0) {
      topRowSegments.push({ segment, index });
    } else {
      bottomRowSegments.push({ segment, index });
    }
  });

  // Helper to convert time to pixel width
  const timeToWidth = (duration: number): number => {
    const width = (duration / totalDuration) * containerWidth;
    return Math.max(width, 30); // Minimum width
  };

  // Helper to convert time to pixel position
  const timeToLeft = (startTime: number): number => {
    return (startTime / totalDuration) * containerWidth;
  };

  return (
    <View style={previewStyles.container}>
      {/* Top row - even indices (0, 2, 4, ...) */}
      <View style={previewStyles.trackRow}>
        {topRowSegments.map(({ segment, index }) => {
          const width = timeToWidth(segment.duration);
          const left = timeToLeft(segment.startTime);
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
          const width = timeToWidth(segment.duration);
          const left = timeToLeft(segment.startTime);
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
    height: 28,
    position: 'relative',
  },
  segmentBar: {
    height: 28,
    borderRadius: 4,
    backgroundColor: 'rgba(88, 28, 135, 0.85)', // Dark purple matching detail page
    borderWidth: 1,
    borderColor: 'rgba(147, 51, 234, 0.3)',
  },
});

export function SavedChainsList({
  chains,
  isLoading,
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

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={styles.loadingText}>Loading saved stories...</Text>
      </View>
    );
  }

  if (chains.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>No saved stories yet</Text>
        <Text style={styles.emptySubtext}>Record your first story to get started!</Text>
      </View>
    );
  }

  // Filter: if a chain is selected, only show that one
  const visibleChains = selectedChainId
    ? chains.filter(c => c.id === selectedChainId)
    : chains;

  // Generate a name for each story (could be improved with actual names from backend)
  const getStoryName = (chain: ChainSummary, index: number) => {
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
    >
      <View style={styles.listContainer}>
        {visibleChains.map((chain, index) => {
          return (
            <TouchableOpacity
              key={chain.id}
              style={styles.chainItem}
              onPress={() => onSelectChain(chain.id)}
              onLongPress={() => handleLongPress(chain.id)}
              activeOpacity={0.7}
            >
              <View style={styles.timelineContainer}>
                <TimelinePreview
                  segments={chain.segments}
                  totalDuration={chain.totalDuration}
                  containerWidth={containerWidth}
                />
              </View>
              <Text style={styles.storyName}>
                {getStoryName(chain, index)}
              </Text>
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
            <Text style={modalStyles.title}>Delete Story?</Text>
            <Text style={modalStyles.message}>
              Are you sure you want to delete this story? This will permanently delete all audio files and cannot be undone.
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
    paddingBottom: 20,
  },
  listContainer: {
    gap: 24,
    paddingHorizontal: 0,
  },
  chainItem: {
    width: '100%',
    // No background, no border, no padding
  },
  timelineContainer: {
    width: '100%',
    marginBottom: 8,
  },
  storyName: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.textPrimary,
    textAlign: 'left',
    paddingHorizontal: 0,
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    gap: 8,
  },
  loadingText: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  emptyContainer: {
    alignItems: 'center',
    padding: 20,
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  emptySubtext: {
    color: colors.textTertiary,
    fontSize: 12,
    marginTop: 4,
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
