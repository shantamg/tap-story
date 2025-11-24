# Infrastructure & Deployment

> **Note:** Infrastructure is not yet configured. This document outlines the planned deployment architecture.

## Overview

Tap Story will use a cloud-based infrastructure for hosting the backend API, storing audio files, and serving the mobile application.

## Planned Infrastructure

### Backend API

**Hosting:** (To be determined)
- Options: Render, Railway, AWS ECS, or similar
- Requirements: Node.js runtime, PostgreSQL database

**Database:** PostgreSQL
- Development: Local PostgreSQL via devenv
- Production: Managed PostgreSQL service

### Audio Storage

**Storage Service:** AWS S3 or Cloudflare R2
- Audio files stored in cloud object storage
- CDN for fast global delivery
- Signed URLs for secure access

### Mobile App Distribution

**iOS:** Apple TestFlight / App Store
- Built via EAS (Expo Application Services)
- Distributed through Apple Developer Program

**Android:** Google Play Store / GitHub Releases
- Built via EAS
- Initial distribution may use GitHub Releases for testing

## Environment Configuration

### Development Environment

Managed by devenv/direnv:
- Node.js 20
- PostgreSQL (local)
- FFmpeg
- All dependencies automatically installed

### Environment Variables

#### Backend (`backend/.env`)

```bash
# Database
DATABASE_URL=postgresql://tapstory_user:tapstory_password@localhost:5432/tapstory

# Storage
AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
S3_BUCKET_NAME=

# Server
PORT=3000
NODE_ENV=development
```

See `backend/.env.example` for complete list.

#### Mobile (Future)

Mobile environment configuration will be added when external services are integrated.

## Deployment Workflows

### Backend Deployment

(Not yet configured)

Planned workflow:
1. Push to `main` branch
2. Automatic tests run
3. Deploy to production if tests pass
4. Run database migrations automatically
5. Health check verification

### Mobile Deployment

(Not yet configured)

Planned workflow:
1. Version bump in `app.json`
2. Build via EAS:
   - iOS: `npm run deploy:mobile:ios`
   - Android: `npm run deploy:mobile:android`
3. Submit to app stores

## Database Management

### Local Development

PostgreSQL runs automatically via devenv:
```bash
# Start services
devenv up -d

# Run migrations
npm run migrate

# Seed data
npm run seed

# Access database
npm run db:query
```

### Production Database

(Not yet configured)

Planned setup:
- Managed PostgreSQL service
- Automatic backups
- Migration strategy via Prisma

## Monitoring & Logging

(Not yet configured)

Planned tools:
- Application logs
- Error tracking (Sentry or similar)
- Performance monitoring
- Database query monitoring

## Scaling Considerations

The architecture is designed for future scaling:

### Audio Processing → Lambda
- Move `audioProcessor.ts` to AWS Lambda
- Trigger on upload events
- Parallel processing for multiple users

### Database → DynamoDB
- Abstract data layer
- Single-table design for serverless
- Maintain Prisma for development

### CDN for Audio Delivery
- Cloudflare CDN in front of R2
- Cache audio files globally
- Reduce latency for playback

## CI/CD Pipeline

(Not yet configured)

Planned pipeline:
- GitHub Actions for automated testing
- Automatic deployment to staging
- Manual promotion to production
- Database migration automation

## Security

### API Security
- Rate limiting (not yet implemented)
- Authentication (to be added)
- CORS configuration
- Environment variable management

### Storage Security
- Signed URLs for time-limited access
- Private S3/R2 buckets
- Encryption at rest
- SSL/TLS for all transfers

## Cost Optimization

Strategies for cost-effective operation:
- Cloudflare R2 (no egress fees)
- Lambda for on-demand processing
- Database connection pooling
- Audio file compression
- CDN caching
