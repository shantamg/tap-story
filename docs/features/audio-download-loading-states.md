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

## Components Modified

### DuetRecorderWithTrackPlayer.tsx
- Added download tracking state variables
- Modified `loadChain` to check for local audio and download missing files
- Pass download state to child components

### AudioTimeline.tsx
- Added `downloadingSegmentIds` prop
- Visual styling for downloading segments (gray, dashed border)
- Download state takes priority over processing state in visual hierarchy

### CassettePlayerControls.tsx
- Added `isDownloadingAudio` and `downloadingSegmentCount` props
- Disabled buttons during download
- Added downloading message with activity indicator

## Files Changed

- `mobile/components/DuetRecorderWithTrackPlayer.tsx`
- `mobile/components/AudioTimeline.tsx`
- `mobile/components/CassettePlayerControls.tsx`
- `mobile/services/audioStorage.ts` (used existing functions)

## Testing

### Automated Tests
- All existing tests pass
- TypeScript compilation successful

### Manual Testing Scenarios
1. **Fresh load (no cache)**: All segments show downloading state, then transition to normal
2. **Partial cache**: Only missing segments show downloading state
3. **Full cache**: No downloading state, immediate playback
4. **Slow network**: Extended downloading state visible
5. **Network failure**: Failed segments remain gray, controls stay disabled for those segments

## Performance Considerations

- Parallel downloads maximize speed
- State updates per-segment keep UI responsive
- Player loads with remote URLs, so downloads enhance but don't block
- Download state properly cleaned up on errors
