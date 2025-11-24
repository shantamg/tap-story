# Backend Architecture

> **Note:** This document will be expanded as the backend is implemented. Currently describes planned structure.

## Overview

The backend is an Express.js API server responsible for audio processing, storage management, and data persistence.

## Project Structure

```
backend/
├── src/
│   ├── server.ts           # Express server initialization
│   ├── routes/             # API route definitions
│   ├── controllers/        # HTTP request handlers
│   ├── services/           # Business logic layer
│   │   ├── audioProcessor.ts    # Audio mixing (Lambda-ready)
│   │   ├── audioService.ts      # Audio orchestration
│   │   └── storageService.ts    # S3/R2 operations
│   ├── config/             # Configuration
│   │   └── database.ts     # Prisma client setup
│   └── utils/              # Utility functions
│       └── ffmpeg.ts       # FFmpeg wrapper
├── prisma/
│   ├── schema.prisma       # Database schema
│   ├── migrations/         # Database migrations
│   └── seed.ts             # Development seed data
└── package.json
```

## Database Schema

### AudioNode Model

```prisma
model AudioNode {
  id        String   @id @default(uuid())
  audioUrl  String
  parentId  String?
  parent    AudioNode?  @relation("AudioNodeChildren", fields: [parentId], references: [id])
  children  AudioNode[] @relation("AudioNodeChildren")
  duration  Int      // Duration in seconds
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([parentId])
}
```

Forms a tree structure where each node can have multiple children.

## API Endpoints

### Planned Endpoints

- `POST /api/start` - Create a new root audio node
- `POST /api/reply` - Create a child node with mixed audio
- `GET /api/node/:id` - Retrieve audio node metadata
- `GET /api/node/:id/children` - Get child nodes

(Not yet implemented)

## Services Layer

### audioProcessor.ts

Pure audio processing functions designed for future Lambda migration:
- `mixAudio(parentUrl, newAudio)` - Mix parent + new audio
- `validateAudio(audio)` - Validate format and duration
- `getAudioMetadata(audio)` - Extract audio metadata

### storageService.ts

S3/Cloudflare R2 operations:
- Upload audio files
- Generate signed URLs
- Delete old files

### audioService.ts

Orchestration layer coordinating audio processing and storage.

## Audio Processing

Audio processing uses FFmpeg for:
- Format conversion
- Audio mixing/concatenation
- Metadata extraction
- Quality normalization

The audioProcessor service is intentionally isolated to enable easy migration to AWS Lambda for serverless processing.

## Environment Variables

See `backend/.env.example` for required configuration:

```bash
DATABASE_URL=              # PostgreSQL connection
AWS_ACCESS_KEY_ID=         # S3/R2 credentials
AWS_SECRET_ACCESS_KEY=
S3_BUCKET_NAME=
PORT=3000
```

## Development

```bash
npm run dev              # Start with hot reload
npm run test             # Run tests
npm run check            # TypeScript checking
npm run migrate          # Run database migrations
npm run seed             # Seed development data
npm run db:query         # Open Prisma Studio
```

## Testing

Tests are located in `__tests__/` directories alongside source files.

Current test coverage:
- Audio validation utilities (shared package)
- FFmpeg utilities (placeholder)

Run tests: `npm test`

## Database Operations

### Migrations

```bash
npm run migrate          # Create and apply migration
npm run prisma -- migrate reset  # Reset database
```

### Prisma Studio

Visual database browser:
```bash
npm run db:query
```

## Future Considerations

- **Lambda Migration**: audioProcessor.ts → AWS Lambda functions
- **Database Scaling**: Abstract data layer for DynamoDB support
- **Caching**: Add Redis for frequently accessed nodes
- **CDN**: Cloudflare CDN for audio delivery
