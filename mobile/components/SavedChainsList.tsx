import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';

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

// Colors for each track (matching AudioTimeline)
const TRACK_COLORS = [
  '#007AFF', // Blue
  '#FF9500', // Orange
  '#34C759', // Green
  '#AF52DE', // Purple
  '#5AC8FA', // Light Blue
  '#FFCC00', // Yellow
  '#FF2D55', // Pink
];

function TimelinePreview({ segments, totalDuration }: { segments: ChainSegment[]; totalDuration: number }) {
  if (segments.length === 0 || totalDuration === 0) return null;

  return (
    <View style={previewStyles.container}>
      {segments.map((segment, index) => {
        const widthPercent = (segment.duration / totalDuration) * 100;
        const leftPercent = (segment.startTime / totalDuration) * 100;
        const color = TRACK_COLORS[index % TRACK_COLORS.length];

        return (
          <View key={segment.id} style={previewStyles.trackRow}>
            <View
              style={[
                previewStyles.segmentBar,
                {
                  width: `${Math.max(widthPercent, 5)}%`,
                  marginLeft: `${leftPercent}%`,
                  backgroundColor: color,
                },
              ]}
            />
          </View>
        );
      })}
    </View>
  );
}

const previewStyles = StyleSheet.create({
  container: {
    flex: 1,
    gap: 3,
    justifyContent: 'center',
  },
  trackRow: {
    height: 8,
    flexDirection: 'row',
  },
  segmentBar: {
    height: '100%',
    borderRadius: 2,
  },
});

export function SavedChainsList({
  chains,
  isLoading,
  selectedChainId,
  onSelectChain,
  onRefresh
}: SavedChainsListProps) {
  const formatDuration = (seconds: number) => {
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  };

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="small" color="#007AFF" />
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

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      {!selectedChainId && (
        <View style={styles.header}>
          <Text style={styles.title}>Saved Stories</Text>
          <TouchableOpacity onPress={onRefresh} style={styles.refreshButton}>
            <Text style={styles.refreshText}>Refresh</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.listContainer}>
        {visibleChains.map((chain) => {
          const isSelected = chain.id === selectedChainId;

          return (
            <TouchableOpacity
              key={chain.id}
              style={[
                styles.chainRow,
                isSelected && styles.chainRowSelected,
              ]}
              onPress={() => onSelectChain(chain.id)}
              activeOpacity={0.7}
              disabled={isSelected}
            >
              <View style={styles.chainInfo}>
                <Text style={styles.chainNumber}>
                  #{chains.length - chains.findIndex(c => c.id === chain.id)}
                </Text>
                <Text style={styles.chainMeta}>
                  {chain.chainLength} {chain.chainLength === 1 ? 'part' : 'parts'} · {formatDuration(chain.totalDuration)}
                </Text>
              </View>
              <View style={styles.timelinePreviewContainer}>
                <TimelinePreview
                  segments={chain.segments}
                  totalDuration={chain.totalDuration}
                />
              </View>
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
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 4,
    marginBottom: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
  },
  refreshButton: {
    padding: 4,
  },
  refreshText: {
    color: '#007AFF',
    fontSize: 14,
  },
  listContainer: {
    gap: 8,
  },
  chainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8f8f8',
    borderRadius: 12,
    padding: 12,
    gap: 12,
  },
  chainRowSelected: {
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#007AFF',
  },
  chainInfo: {
    width: 70,
  },
  chainNumber: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#007AFF',
  },
  chainMeta: {
    fontSize: 10,
    color: '#666',
    marginTop: 2,
  },
  timelinePreviewContainer: {
    flex: 1,
    height: 50,
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    gap: 8,
  },
  loadingText: {
    color: '#666',
    fontSize: 14,
  },
  emptyContainer: {
    alignItems: 'center',
    padding: 20,
  },
  emptyText: {
    color: '#666',
    fontSize: 14,
  },
  emptySubtext: {
    color: '#999',
    fontSize: 12,
    marginTop: 4,
  },
});
