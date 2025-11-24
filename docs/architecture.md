# System Architecture

> **Note:** This document will be expanded as the system is built. Currently describes planned architecture based on project structure.

## Overview

Tap Story is a collaborative audio storytelling platform built as a TypeScript monorepo with a React Native mobile app and Express.js backend API.

## Core Components

### Backend API

Express.js server providing REST endpoints for:
- Audio node creation and retrieval
- Audio file processing and mixing
- Storage management (S3/R2)

**Technology Stack:**
- Express.js (API server)
- Prisma + PostgreSQL (data layer)
- FFmpeg (audio processing)
- AWS S3 / Cloudflare R2 (audio storage)

See [Backend Architecture](./backend.md) for details.

### Mobile App

React Native + Expo application for iOS and Android providing:
- Audio recording interface
- Audio playback controls
- Story navigation and branching

**Technology Stack:**
- React Native + Expo
- Expo Router (navigation)
- expo-av (audio recording/playback)

See [Mobile App Documentation](./mobile.md) for details.

### Shared Package

TypeScript library providing type safety across frontend and backend:
- Audio types (AudioNode, AudioMetadata, etc.)
- API request/response types
- Validation utilities
- Format conversion helpers

## Data Model

### AudioNode

The core data structure representing a single audio recording in the story tree:

```typescript
{
  id: string;           // UUID
  audioUrl: string;     // S3/R2 URL
  parentId: string?;    // Reference to parent node
  duration: number;     // Seconds
  createdAt: Date;
  updatedAt: Date;
}
```

Audio nodes form a tree structure where each node can have multiple children (branches in the story).

## Key Workflows

### Starting a New Story

1. Mobile app requests new story start
2. Backend creates root AudioNode
3. Mobile uploads audio to storage
4. Backend updates AudioNode with final URL

### Replying to a Story

1. Mobile app selects parent node
2. Mobile records new audio
3. Backend mixes parent audio + new audio
4. Backend creates new AudioNode with mixed audio
5. Returns mixed audio URL to mobile

## Future Architecture Considerations

The current architecture is designed for easy migration to serverless infrastructure:

- **Audio processing** → AWS Lambda (audioProcessor.ts is already isolated)
- **Database** → DynamoDB (data access can be abstracted)
- **Mobile recording** → Native modules (AudioRecorderInterface abstraction ready)

See [Infrastructure Documentation](./infrastructure.md) for deployment architecture.
