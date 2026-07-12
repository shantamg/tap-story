# Backend Architecture

## Overview

The backend is an Express API that persists the branching audio graph, issues
presigned S3 URLs, and performs calibration analysis. The mobile app uploads and
downloads audio directly to/from S3; the API stores object keys rather than
audio blobs.

## Database schema

```prisma
model AudioNode {
  id          String      @id @default(uuid())
  audioUrl    String
  parentId    String?
  parent      AudioNode?  @relation("AudioNodeChildren", fields: [parentId], references: [id])
  children    AudioNode[] @relation("AudioNodeChildren")
  durationMs  Int
  startTimeMs Int
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt

  @@index([parentId])
}
```

Timing is stored in integer milliseconds. Migration
`20260712120000_exact_audio_timeline_metadata` converts legacy whole-second
durations and backfills the existing alternating-track start rule.

## Audio API

- `POST /api/audio/upload-url` — accepts a filename/content type and returns a
  presigned S3 upload URL plus object key.
- `POST /api/audio/save` — validates and saves `key`, positive integer
  `durationMs`, and optional `parentId`. It derives `startTimeMs`: roots and
  direct replies start at zero; deeper replies start at their grandparent's
  exact persisted end.
- `GET /api/audio/tree/:id` — returns a node's ordered ancestor chain with exact
  timing and fresh download URLs.
- `GET /api/audio/chains` — returns leaf chains and persisted segment timing for
  story previews.
- `POST /api/audio/calibrate` — cross-correlates two related calibration takes
  and converts their local waveform delay into an absolute timeline offset.
- `DELETE /api/audio/chain/:id` — deletes only the suffix exclusive to the
  selected leaf, stopping before the first ancestor shared by another story.
  Traversal and deletion share a serializable transaction with bounded conflict
  retries; S3 cleanup begins only after the database commit succeeds.

The calibration endpoint is intended for two takes containing the same known,
aperiodic calibration signal. It rejects low-confidence correlation; arbitrary
speech is not a trustworthy latency measurement.

## Services

`s3Service.ts` owns S3 URL generation/deletion. `latencyCalibration.ts` decodes
calibration objects to mono PCM with FFmpeg. `audioCorrelation.ts` contains the
pure normalized cross-correlation and onset-envelope calculations exercised by
synthetic tests.

The backend does not currently mix stems. Exact isolated recordings remain the
source of truth and are mixed by the native mobile player.

## Development

From the repository root:

```bash
npm run dev:api
npm run migrate
npm run seed
npm run db:query
npm run test
npm run check
```

Required configuration is documented in `backend/.env.example`.
