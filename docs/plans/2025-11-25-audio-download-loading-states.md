# Audio Download Loading States Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show visual loading indicators when downloading missing local audio during story load, and disable play/record controls until all audio is ready.

**Architecture:** Add download tracking state to DuetRecorderWithTrackPlayer, modify loadChain to check and download missing audio, pass download state to AudioTimeline for per-segment visual indicators, and disable CassettePlayerControls during download.

**Tech Stack:** React Native, TypeScript, expo-file-system, existing audioStorage service

---

## Task 1: Add Download State Management

**Files:**
- Modify: `mobile/components/DuetRecorderWithTrackPlayer.tsx:35-55`

**Step 1: Add new state variables for tracking downloads**

Add after existing state declarations (around line 52):

```typescript
const [downloadingSegmentIds, setDownloadingSegmentIds] = useState<Set<string>>(new Set());
const [isDownloadingAudio, setIsDownloadingAudio] = useState(false);
```

**Step 2: Add derived state for control disabling**

Add after state declarations:

```typescript
const hasDownloadingSegments = downloadingSegmentIds.size > 0;
const canPlayOrRecord = !isDownloadingAudio && !hasDownloadingSegments && !isLoading;
```

**Step 3: Verify TypeScript compiles**

Run: `npm run check`
Expected: No TypeScript errors

**Step 4: Commit**

```bash
git add mobile/components/DuetRecorderWithTrackPlayer.tsx
git commit -m "feat: add download tracking state for audio loading"
```

---

## Task 2: Modify loadChain to Track and Download Missing Audio

**Files:**
- Modify: `mobile/components/DuetRecorderWithTrackPlayer.tsx:216-258`
- Read: `mobile/services/audioStorage.ts:53-57` (localAudioExists)
- Read: `mobile/services/audioStorage.ts:88-110` (downloadAndCacheAudio)

**Step 1: Write test for loadChain with missing audio**

Create: `mobile/components/__tests__/DuetRecorderWithTrackPlayer.test.tsx`

```typescript
import { renderHook, act } from '@testing-library/react-native';
import * as audioStorage from '../../services/audioStorage';

jest.mock('../../services/audioStorage');
jest.mock('../../services/audio/DuetTrackPlayer');

describe('DuetRecorderWithTrackPlayer - loadChain', () => {
  it('should track downloading segments when audio is missing', async () => {
    const mockLocalAudioExists = jest.spyOn(audioStorage, 'localAudioExists')
      .mockResolvedValueOnce(false) // First segment missing
      .mockResolvedValueOnce(true);  // Second segment exists

    const mockDownloadAndCacheAudio = jest.spyOn(audioStorage, 'downloadAndCacheAudio')
      .mockResolvedValue();

    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          chain: [
            { id: 'seg1', audioUrl: 's3://audio1.m4a', duration: 5000, parentId: null },
            { id: 'seg2', audioUrl: 's3://audio2.m4a', duration: 5000, parentId: 'seg1' }
          ]
        })
      });

    // Test will check that downloadingSegmentIds contains 'seg1' and isDownloadingAudio is true
    // Then after download completes, both should be cleared
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test DuetRecorderWithTrackPlayer.test.tsx`
Expected: FAIL (test not fully implemented yet, but structure should be there)

**Step 3: Implement loadChain modifications**

Modify the `loadChain` function (lines 216-258):

```typescript
const loadChain = async (chainId: string) => {
  setIsLoading(true);
  const newDownloadingIds = new Set<string>();

  try {
    const response = await fetch(`${API_URL}/api/audio/tree/${chainId}`);
    if (!response.ok) {
      throw new Error('Failed to fetch chain');
    }
    const data = await response.json();

    // Calculate start times based on duet format (existing logic)
    const segments: AudioChainNode[] = [];
    let currentTime = 0;
    data.chain.forEach((node: any, index: number) => {
      segments.push({
        id: node.id,
        audioUrl: node.audioUrl,
        duration: node.duration,
        startTime: currentTime,
        track: index % 2,
      });
      currentTime += node.duration;
    });

    // Check which segments need downloading
    for (const segment of segments) {
      const hasLocal = await audioStorage.localAudioExists(segment.id);
      if (!hasLocal) {
        newDownloadingIds.add(segment.id);
      }
    }

    setDownloadingSegmentIds(newDownloadingIds);
    setIsDownloadingAudio(newDownloadingIds.size > 0);
    setAudioChain(segments);

    // Load chain into player
    await player.loadChain(segments);

    // Download missing audio in parallel
    if (newDownloadingIds.size > 0) {
      await Promise.all(
        Array.from(newDownloadingIds).map(async (segmentId) => {
          try {
            const segment = segments.find(s => s.id === segmentId);
            if (segment) {
              await audioStorage.downloadAndCacheAudio(segment.id, segment.audioUrl);
              setDownloadingSegmentIds(prev => {
                const next = new Set(prev);
                next.delete(segmentId);
                return next;
              });
            }
          } catch (error) {
            console.error(`Failed to download segment ${segmentId}:`, error);
            // Keep in downloading set to show error state
          }
        })
      );
      setIsDownloadingAudio(false);
    }

  } catch (error) {
    console.error('Failed to load chain:', error);
    Alert.alert('Error', 'Failed to load story');
    setDownloadingSegmentIds(new Set());
    setIsDownloadingAudio(false);
  } finally {
    setIsLoading(false);
  }
};
```

**Step 4: Run tests**

Run: `npm run test DuetRecorderWithTrackPlayer.test.tsx`
Expected: PASS

**Step 5: Verify TypeScript compiles**

Run: `npm run check`
Expected: No errors

**Step 6: Commit**

```bash
git add mobile/components/DuetRecorderWithTrackPlayer.tsx mobile/components/__tests__/DuetRecorderWithTrackPlayer.test.tsx
git commit -m "feat: check and download missing audio during loadChain"
```

---

## Task 3: Add Downloading Visual State to AudioTimeline

**Files:**
- Modify: `mobile/components/AudioTimeline.tsx:30-50` (props)
- Modify: `mobile/components/AudioTimeline.tsx:280-290` (segment styling)
- Modify: `mobile/components/AudioTimeline.tsx:490-530` (styles)

**Step 1: Add downloadingSegmentIds prop to AudioTimeline interface**

Modify the `AudioTimelineProps` interface (around line 30):

```typescript
interface AudioTimelineProps {
  segments: AudioChainNode[];
  currentPosition: number;
  duration: number;
  onSeek: (position: number) => void;
  isRecording?: boolean;
  recordingSegment?: { startTime: number; duration: number; track: number };
  processingSegmentIds?: Set<string>;
  downloadingSegmentIds?: Set<string>; // NEW
  disabled?: boolean;
}
```

**Step 2: Add downloading segment styling logic**

Modify segment rendering logic (around line 284-286):

```typescript
const isDownloading = downloadingSegmentIds?.has(segment.id);
const isProcessing = processingSegmentIds?.has(segment.id);

const segmentStyle = [
  styles.segment,
  segment.track === 0 ? styles.topTrackSegment : styles.bottomTrackSegment,
  isRecordingSegment && styles.recordingSegment,
  isProcessing && styles.processingSegment,
  isDownloading && styles.downloadingSegment,
];
```

**Step 3: Add downloading segment style**

Add to StyleSheet.create (around line 520):

```typescript
downloadingSegment: {
  backgroundColor: '#888',
  opacity: 0.5,
  borderWidth: 1,
  borderColor: '#666',
  borderStyle: 'dashed',
},
```

**Step 4: Verify TypeScript compiles**

Run: `npm run check`
Expected: No errors

**Step 5: Commit**

```bash
git add mobile/components/AudioTimeline.tsx
git commit -m "feat: add visual indicator for downloading segments in timeline"
```

---

## Task 4: Pass Download State to AudioTimeline Component

**Files:**
- Modify: `mobile/components/DuetRecorderWithTrackPlayer.tsx:702-720` (AudioTimeline usage)

**Step 1: Pass downloadingSegmentIds to AudioTimeline**

Modify AudioTimeline component usage (around line 712):

```typescript
<AudioTimeline
  segments={audioChain}
  currentPosition={currentPosition}
  duration={totalDuration}
  onSeek={handleSeek}
  isRecording={isRecording}
  recordingSegment={
    isRecording && recordingStartTime !== null
      ? {
          startTime: recordingStartTime,
          duration: recordingDuration,
          track: audioChain.length % 2,
        }
      : undefined
  }
  processingSegmentIds={processingSegmentIds}
  downloadingSegmentIds={downloadingSegmentIds} // NEW
  disabled={isLoading || isDownloadingAudio}
/>
```

**Step 2: Verify TypeScript compiles**

Run: `npm run check`
Expected: No errors

**Step 3: Commit**

```bash
git add mobile/components/DuetRecorderWithTrackPlayer.tsx
git commit -m "feat: wire download state to timeline component"
```

---

## Task 5: Disable Controls During Download

**Files:**
- Modify: `mobile/components/CassettePlayerControls.tsx:10-25` (props interface)
- Modify: `mobile/components/CassettePlayerControls.tsx:50-100` (button disable logic)
- Modify: `mobile/components/DuetRecorderWithTrackPlayer.tsx:650-680` (CassettePlayerControls usage)

**Step 1: Add download props to CassettePlayerControls**

Modify interface (around line 15):

```typescript
interface CassettePlayerControlsProps {
  onPlay: () => void;
  onPause: () => void;
  onRecord: () => void;
  onRewind: () => void;
  isPlaying: boolean;
  isRecording: boolean;
  isLoading: boolean;
  isWaitingToRecord?: boolean;
  isDownloadingAudio?: boolean; // NEW
  downloadingSegmentCount?: number; // NEW
  disabled?: boolean;
}
```

**Step 2: Update button disable logic**

Modify button disabled props (around line 60-80):

```typescript
const playDisabled = disabled || isLoading || isDownloadingAudio;
const recordDisabled = disabled || isLoading || isDownloadingAudio || isWaitingToRecord;
const rewindDisabled = disabled || isLoading || isDownloadingAudio || isRecording;
```

**Step 3: Add downloading message below controls**

Add after the button row (around line 120):

```typescript
{isDownloadingAudio && downloadingSegmentCount && downloadingSegmentCount > 0 && (
  <View style={styles.downloadingMessage}>
    <ActivityIndicator size="small" color="#666" />
    <Text style={styles.downloadingText}>
      Downloading {downloadingSegmentCount} segment{downloadingSegmentCount !== 1 ? 's' : ''}...
    </Text>
  </View>
)}
```

**Step 4: Add styles for downloading message**

Add to StyleSheet.create:

```typescript
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
```

**Step 5: Pass download props from DuetRecorderWithTrackPlayer**

Modify CassettePlayerControls usage (around line 665):

```typescript
<CassettePlayerControls
  onPlay={handlePlay}
  onPause={handlePause}
  onRecord={handleRecord}
  onRewind={handleRewind}
  isPlaying={isPlaying}
  isRecording={isRecording}
  isLoading={isLoading}
  isWaitingToRecord={isWaitingToRecord}
  isDownloadingAudio={isDownloadingAudio} // NEW
  downloadingSegmentCount={downloadingSegmentIds.size} // NEW
  disabled={!canPlayOrRecord}
/>
```

**Step 6: Verify TypeScript compiles**

Run: `npm run check`
Expected: No errors

**Step 7: Commit**

```bash
git add mobile/components/CassettePlayerControls.tsx mobile/components/DuetRecorderWithTrackPlayer.tsx
git commit -m "feat: disable controls and show message during audio download"
```

---

## Task 6: Manual Testing & Verification

**Files:**
- Test: Manual testing in development app

**Step 1: Clear local audio cache**

In app, use developer menu or manually delete audio files from:
`${FileSystem.documentDirectory}audio/`

Can add a temporary button or use:
```typescript
await audioStorage.clearAllLocalAudio();
```

**Step 2: Load a saved story**

Expected behavior:
1. Timeline segments appear gray with dashed borders (downloading state)
2. Play/record buttons are disabled
3. Message shows "Downloading N segments..."
4. As each segment downloads, it turns purple
5. When all complete, message disappears and buttons enable

**Step 3: Test with slow network**

Use network throttling in dev tools or test on slow connection.
Expected: Download states visible for longer, UI remains responsive

**Step 4: Test error handling**

Disconnect network mid-download.
Expected: Failed segments stay gray, console shows errors, controls remain disabled

**Step 5: Verify normal flow still works**

Load story with all audio cached.
Expected: No downloading state, immediate playback available

**Step 6: Run full test suite**

Run: `npm run test`
Expected: All tests pass

**Step 7: Run type check**

Run: `npm run check`
Expected: No TypeScript errors

**Step 8: Final commit if any fixes needed**

```bash
git add .
git commit -m "fix: address edge cases in audio download loading"
```

---

## Task 7: Update Documentation

**Files:**
- Create: `docs/features/audio-download-loading-states.md`

**Step 1: Write feature documentation**

```markdown
# Audio Download Loading States

## Overview

When loading a saved story, the app checks for locally cached audio files. If any are missing, they are downloaded from S3 before allowing playback or recording.

## User Experience

1. User taps to load a saved story
2. Timeline appears with segments in gray/dashed style (downloading)
3. Play and record buttons are disabled
4. Message shows "Downloading N segments..."
5. As each segment downloads, it transitions to normal purple color
6. When all downloads complete, controls enable

## Technical Implementation

**State Management (DuetRecorderWithTrackPlayer.tsx):**
- `downloadingSegmentIds: Set<string>` - tracks which segments are downloading
- `isDownloadingAudio: boolean` - overall download state
- `canPlayOrRecord` - derived state for button enabling

**Download Flow (loadChain function):**
1. Fetch story tree from backend
2. Check each segment with `audioStorage.localAudioExists()`
3. Add missing segments to `downloadingSegmentIds`
4. Load chain into player (can use remote URLs as fallback)
5. Download all missing segments in parallel
6. Update state as each completes
7. Enable controls when all done

**Visual Indicators:**
- Timeline segments: Gray with dashed border while downloading
- Controls: Disabled with message showing progress
- Per-segment updates as downloads complete

## Error Handling

- Failed downloads keep segment in gray state
- Console logs capture errors
- Player can use remote URLs as fallback
- User can retry by reloading story
```

**Step 2: Commit documentation**

```bash
git add docs/features/audio-download-loading-states.md
git commit -m "docs: add audio download loading states feature documentation"
```

---

## Completion Checklist

- [ ] Download tracking state added to DuetRecorderWithTrackPlayer
- [ ] loadChain checks and downloads missing audio
- [ ] AudioTimeline shows downloading segments visually
- [ ] CassettePlayerControls disabled during download with message
- [ ] Manual testing verified all states
- [ ] Tests pass (`npm run test`)
- [ ] Type checking passes (`npm run check`)
- [ ] Documentation created
- [ ] All changes committed

---

## Notes for Engineer

**Key Principles:**
- **DRY**: Reuse existing audioStorage functions, don't duplicate download logic
- **YAGNI**: Only handle initial load case, not mid-session cache clearing
- **TDD**: Write tests first where possible, verify failures before implementation

**Testing Tips:**
- Mock `audioStorage.localAudioExists` to simulate missing files
- Mock `audioStorage.downloadAndCacheAudio` to control timing
- Use React Testing Library for component tests
- Manual testing critical for visual states and timing

**Common Pitfalls:**
- Don't forget to clear downloading state on error
- Set state updates must use functional form with Set for downloadingSegmentIds
- Parallel downloads need individual try/catch to prevent one failure blocking others
- Controls must check both isDownloadingAudio AND downloadingSegmentIds.size

**Performance:**
- Parallel downloads faster than sequential
- State updates per-segment keep UI responsive
- Player can load with remote URLs, download is enhancement not blocker
