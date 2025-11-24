# Mobile App Documentation

> **Note:** This document will be expanded as the mobile app is built. Currently describes planned structure.

## Overview

The mobile app is a React Native + Expo application for iOS and Android, providing the primary interface for recording, playing, and navigating audio stories.

## Project Structure

```
mobile/
├── app/                    # Expo Router screens
│   ├── _layout.tsx         # Root layout
│   ├── index.tsx           # Home screen
│   └── record.tsx          # Recording interface (planned)
├── services/
│   ├── audioService.ts     # ✅ Audio recording service (implemented)
│   ├── duetPlayer.ts       # ✅ Duet playback with audio chaining (implemented)
│   ├── audio/
│   │   ├── AudioRecorderInterface.ts    # Abstract interface
│   │   ├── ExpoAudioRecorder.ts         # Expo-av implementation
│   │   └── AudioRecorderFactory.ts      # Returns correct implementation
│   └── api.ts              # Backend API client (planned)
├── components/             # Reusable UI components
│   ├── RecordButton.tsx    # Recording control (planned)
│   ├── PlaybackControls.tsx # Playback UI (planned)
│   └── ProgressBar.tsx     # Progress indicator (planned)
├── hooks/
│   ├── useAudioRecorder.ts # Recording hook (planned)
│   └── useAudioSession.ts  # Audio mode config (planned)
└── types/
    └── audio.ts            # Mobile-specific types (planned)
```

## Technology Stack

- **React Native** - Cross-platform mobile framework
- **Expo** - Development tooling and managed services
- **Expo Router** - File-based navigation
- **expo-av** - Audio recording and playback (initial implementation)

## Audio Architecture

### Audio Recording ✅ Implemented

**AudioRecorder class** (`services/audioService.ts`):
- Handles audio recording permissions and initialization
- Records audio using expo-av with platform-specific configurations
- Uploads recordings to S3 via presigned URLs
- Manages recording lifecycle and cleanup

Key methods:
- `init()` - Request permissions and configure audio mode
- `startRecording()` / `stopRecording()` - Control recording
- `uploadRecording(uri, apiUrl)` - Upload to S3
- `cleanup()` - Release audio resources

Platform support:
- iOS: `.m4a` (MPEG4AAC format)
- Android: `.webm` (WEBM format)
- Web: `.webm` (128kbps)

### Duet Playback ✅ Implemented

**DuetPlayer class** (`services/duetPlayer.ts`):
- Chains audio segments for sequential playback
- Supports playing from any position in the audio chain
- Manages multiple Audio.Sound instances
- Calculates cumulative timing for segments

Key methods:
- `loadChain(chain)` - Load audio node chain
- `playFrom(position)` - Start playback from specific time
- `getCurrentPosition()` - Track playback position
- `getRecordingStartPoint()` - Determine where next recording should start

### Recording Abstraction (Planned)

The mobile app will use an interface pattern for audio recording to enable future native module integration. This will allow swapping between:
- **expo-av** (current) - Expo's managed audio implementation
- **Native modules** (future) - Custom Swift/Kotlin implementations for better performance

## Planned Features

### Story Navigation
- Browse existing story nodes
- View story tree structure
- Select nodes for playback or reply

### Audio Recording
- Record new audio clips
- Visual feedback during recording
- Pause/resume functionality

### Audio Playback
- Play back mixed audio from any node
- Progress indicator
- Playback controls (play/pause/seek)

### Story Branching
- Select a node to reply to
- View all replies to a node
- Navigate the branching structure

## Development

```bash
npm run start            # Start Expo dev server
npm run ios             # Run on iOS simulator
npm run android         # Run on Android emulator
npm run test            # Run tests
npm run check           # TypeScript checking
```

## Configuration

App configuration in `app.json`:

```json
{
  "expo": {
    "name": "Tap Story",
    "slug": "tap-story",
    "version": "0.1.0",
    "ios": {
      "bundleIdentifier": "com.tapstory.app"
    },
    "android": {
      "package": "com.tapstory.app"
    }
  }
}
```

## API Integration

The mobile app communicates with the backend via REST API:

```typescript
// services/api.ts (planned)
const api = {
  startStory: () => POST /api/start
  replyToNode: (parentId, audio) => POST /api/reply
  getNode: (nodeId) => GET /api/node/:id
  getChildren: (nodeId) => GET /api/node/:id/children
}
```

## State Management

(To be determined - likely React Context or Zustand for simple state needs)

## Testing

Tests will be written using:
- Jest + jest-expo
- React Native Testing Library (when UI components are built)

Current test coverage:
- Basic app renders without crashing

## Future Considerations

### Native Modules
When performance requires it, swap expo-av for custom native audio modules:
- Lower latency recording
- Better audio quality control
- Advanced processing features

The AudioRecorderInterface abstraction is already in place to make this migration seamless.

### Offline Support
- Cache audio nodes locally
- Queue uploads when offline
- Sync when connection restored

### Real-time Features
- Live collaboration indicators
- Push notifications for new branches
- Real-time story updates
