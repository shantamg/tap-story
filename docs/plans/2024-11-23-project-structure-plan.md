# Tap Story - Project Structure Plan

## Overview

This document outlines the initial project structure for Tap Story, based on the successful lovely-mind-app monorepo architecture. The structure prioritizes rapid development while maintaining clean separation of concerns and future scalability.

## Core Architecture Decisions

1. **Monorepo Structure** - Full monorepo with backend, mobile, and shared packages from the start
2. **Database** - Postgres with Prisma (matching lovely-mind-app, easy local development)
3. **Audio Processing** - Backend-based with FFmpeg, architected for future Lambda migration
4. **Mobile Recording** - Abstracted interface pattern for easy native module swap-in
5. **Testing** - Jest setup for backend and shared modules initially
6. **Deployment** - Reuse lovely-mind-app's deployment scripts and infrastructure

## Directory Structure

```
tap-story/
├── backend/                 # Express API with audio processing
├── mobile/                  # React Native + Expo app
├── shared/                  # Shared types and utilities
├── scripts/                 # Deployment and automation
├── docs/                    # Documentation
└── package.json            # Workspace configuration
```

## Backend Structure

```
backend/
├── src/
│   ├── server.ts                      # Express server initialization
│   ├── routes/
│   │   └── audio.ts                   # /start, /reply, /node/:id endpoints
│   ├── services/
│   │   ├── audioProcessor.ts          # Pure audio mixing functions (Lambda-ready)
│   │   ├── storageService.ts          # S3/R2 operations
│   │   └── audioService.ts            # Orchestration layer
│   ├── controllers/
│   │   └── audioController.ts         # HTTP request handling
│   ├── config/
│   │   └── database.ts                # Prisma client setup
│   └── utils/
│       └── ffmpeg.ts                  # FFmpeg wrapper utilities
├── prisma/
│   ├── schema.prisma                  # AudioNode model definition
│   ├── migrations/                    # Database migrations
│   └── seed.ts                        # Development seed data
├── package.json
├── tsconfig.json                      # TypeScript config with @shared alias
└── jest.config.js                     # Testing configuration
```

### Key Backend Services

**audioProcessor.ts** - Clean interface for future Lambda migration:
```typescript
interface AudioProcessor {
  mixAudio(parentUrl: string, newAudio: Buffer): Promise<Buffer>
  validateAudio(audio: Buffer): Promise<ValidationResult>
  getAudioMetadata(audio: Buffer): Promise<AudioMetadata>
}
```

## Mobile Structure

```
mobile/
├── app/                               # Expo Router screens
│   ├── _layout.tsx                    # Root layout
│   ├── index.tsx                      # Home screen with UUID input
│   └── record.tsx                     # Recording interface
├── services/
│   ├── audio/
│   │   ├── AudioRecorderInterface.ts  # Abstract recording interface
│   │   ├── ExpoAudioRecorder.ts       # Expo-av implementation
│   │   ├── NativeAudioRecorder.ts     # Future native module implementation
│   │   └── AudioRecorderFactory.ts    # Returns correct implementation
│   ├── audioPlayer.ts                 # Playback management
│   └── api.ts                         # Backend API client
├── components/
│   ├── RecordButton.tsx               # Main recording control
│   ├── PlaybackControls.tsx           # Play/pause/progress
│   └── ProgressBar.tsx                # Visual progress indicator
├── hooks/
│   ├── useAudioRecorder.ts            # Recording hook using interface
│   └── useAudioSession.ts             # iOS/Android audio mode configuration
├── types/
│   └── audio.ts                       # Mobile-specific audio types
├── app.json                           # Expo configuration
├── package.json                       # Minimal dependencies
└── tsconfig.json                      # TypeScript config
```

### Audio Abstraction Pattern

The mobile app uses an interface pattern for recording to enable future native module integration:

```typescript
// AudioRecorderInterface.ts
export interface AudioRecorder {
  initialize(): Promise<void>
  startRecording(): Promise<void>
  stopRecording(): Promise<AudioBuffer>
  pauseRecording(): Promise<void>
  resumeRecording(): Promise<void>
  getRecordingStatus(): RecordingStatus
}
```

Components only interact with this interface, making implementation swaps transparent.

## Shared Module Structure

```
shared/
├── src/
│   ├── types/
│   │   ├── audio.ts                   # Core audio types
│   │   ├── api.ts                     # API request/response types
│   │   └── index.ts                   # Type exports
│   ├── utils/
│   │   ├── audioValidation.ts         # Format and duration validation
│   │   ├── audioFormats.ts            # Format conversion utilities
│   │   └── urlGenerator.ts            # Consistent URL generation
│   ├── constants/
│   │   └── audio.ts                   # Shared audio constants
│   └── index.ts                       # Main barrel export
├── package.json                       # @tapstory/shared package
├── tsconfig.json
└── jest.config.js
```

### Shared Types Example

```typescript
// types/audio.ts
export interface AudioNode {
  id: string
  audioUrl: string
  parentId: string | null
  duration: number
  createdAt: Date
}

export interface AudioMetadata {
  duration: number
  sampleRate: number
  channels: number
  format: AudioFormat
}
```

## Root Package Configuration

```json
{
  "name": "tapstory-monorepo",
  "private": true,
  "workspaces": [
    "backend",
    "mobile",
    "shared"
  ],
  "scripts": {
    // Development
    "dev:api": "npm run dev --workspace=backend",
    "dev:mobile": "npm run start --workspace=mobile",

    // Building
    "build": "npm run build --workspace=shared && npm run build --workspace=backend",
    "build:mobile": "npm run build --workspace=mobile",

    // Testing
    "test": "npm run test --workspace=shared && npm run test --workspace=backend",
    "test:watch": "npm test -- --watch",
    "check": "npm --workspaces run check",

    // Database
    "prisma": "npm exec --workspace backend prisma",
    "migrate": "npm run migrate --workspace=backend",
    "seed": "npm run seed --workspace=backend",
    "db:push": "npm run prisma -- db push",

    // Deployment (from lovely-mind)
    "deploy:api": "node scripts/deploy.js backend",
    "deploy:mobile:ios": "cd mobile && eas build --platform ios",
    "deploy:mobile:android": "cd mobile && eas build --platform android",

    // Utilities
    "clean": "npm run clean --workspaces --if-present",
    "reset": "./scripts/reset-all.sh"
  },
  "devDependencies": {
    "typescript": "^5.3.3"
  }
}
```

## Initial Dependencies

### Backend
- **Core**: express, cors, body-parser, dotenv
- **Database**: @prisma/client, prisma
- **Audio**: fluent-ffmpeg
- **Storage**: @aws-sdk/client-s3, multer
- **Testing**: jest, supertest, @types/jest

### Mobile
- **Core**: react, react-native, expo
- **Audio**: expo-av (initially)
- **Navigation**: expo-router
- **Storage**: @react-native-async-storage/async-storage
- **Testing**: jest-expo, @testing-library/react-native

### Shared
- **Testing**: jest, ts-jest
- **Build**: typescript

## TypeScript Configuration

All packages use path aliases for clean imports:
- Backend: `@shared/*` → `../shared/src/*`
- Mobile: `@shared/*` → `../shared/src/*`, `@services/*` → `./services/*`
- Shared: Internal paths only

## Development Workflow

1. **Initial Setup**
   ```bash
   npm install          # Install all workspace dependencies
   npm run migrate      # Set up database
   npm run seed         # Add test data
   ```

2. **Development**
   ```bash
   # Terminal 1
   npm run dev:api      # Start backend with hot reload

   # Terminal 2
   npm run dev:mobile   # Start Expo development server
   ```

3. **Testing**
   ```bash
   npm test            # Run all tests
   npm run check       # TypeScript type checking
   ```

## Migration Path Planning

### Audio Processing → Lambda
The `audioProcessor.ts` service is designed as a pure function module that can be extracted into AWS Lambda without architectural changes. The interface remains consistent whether running on Express or as a serverless function.

### Expo Audio → Native Module
The `AudioRecorderInterface` abstraction allows swapping Expo's implementation with native modules (react-native-audio-record, custom Swift/Kotlin) without touching UI components.

### Postgres → DynamoDB
While starting with Postgres for simplicity, the data access layer can be abstracted later to support DynamoDB's single-table design for serverless scaling.

## Next Steps

1. Initialize the monorepo structure
2. Set up TypeScript configurations
3. Install core dependencies
4. Create basic Express server with health check
5. Set up Prisma with AudioNode schema
6. Create minimal Expo app with recording screen
7. Implement shared types and utilities
8. Connect mobile to backend with test endpoint

This structure provides a solid foundation that matches lovely-mind-app's proven patterns while being tailored for Tap Story's audio-focused requirements.