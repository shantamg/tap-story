import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView, LayoutChangeEvent } from 'react-native';
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
  onRefresh
}: SavedChainsListProps) {
  const [containerWidth, setContainerWidth] = React.useState(300);

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
