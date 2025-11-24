# External Services

> **Note:** External services are not yet integrated. This document outlines planned integrations.

## Overview

Tap Story will integrate with cloud services for storage, processing, and infrastructure management.

## Planned Services

### Audio Storage

**AWS S3 or Cloudflare R2**

Purpose: Cloud object storage for audio files

- **Why:** Scalable, reliable storage for audio recordings
- **Use Cases:**
  - Store user-recorded audio files
  - Store mixed/processed audio
  - Serve audio files to mobile app

**Configuration:**
- Bucket for audio files
- Signed URLs for secure access
- CDN for fast global delivery (if using R2)

**Status:** Not yet configured

### Database

**PostgreSQL**

Purpose: Primary data store

- **Development:** Local PostgreSQL via devenv
- **Production:** Managed PostgreSQL service (provider TBD)

**Current Schema:**
- AudioNode model (tree structure for story branching)

**Status:** Schema defined, local database operational

### Audio Processing

**FFmpeg**

Purpose: Audio manipulation and processing

- **Use Cases:**
  - Mix parent audio + new recording
  - Format conversion
  - Metadata extraction
  - Audio normalization

**Status:** Included in devenv, not yet implemented in code

### Future Services

#### Authentication (To Be Added)

Options under consideration:
- Clerk
- Auth0
- Supabase Auth
- Custom JWT implementation

**Use Cases:**
- User accounts
- Audio ownership
- Access control

#### Analytics (To Be Added)

Options under consideration:
- Mixpanel
- PostHog
- Amplitude

**Use Cases:**
- User behavior tracking
- Feature usage
- Error tracking

#### Error Monitoring (To Be Added)

Options under consideration:
- Sentry
- Rollbar
- LogRocket

**Use Cases:**
- Error tracking
- Performance monitoring
- Crash reporting

#### Push Notifications (To Be Added)

Options under consideration:
- Expo Push Notifications
- OneSignal
- Firebase Cloud Messaging

**Use Cases:**
- New story branch notifications
- Collaboration alerts
- App updates

## Service Dependencies

### Current Dependencies

```json
{
  "required": [
    "PostgreSQL (local via devenv)",
    "FFmpeg (local via devenv)",
    "Node.js 20"
  ],
  "optional": []
}
```

### Future Production Dependencies

```json
{
  "required": [
    "Managed PostgreSQL",
    "S3 or Cloudflare R2",
    "Hosting platform (Render/Railway/etc)"
  ],
  "optional": [
    "Authentication service",
    "Analytics platform",
    "Error monitoring",
    "Push notifications"
  ]
}
```

## Configuration

Service configuration will be managed through environment variables:

### Backend Environment Variables

See `backend/.env.example` for current configuration template.

### Mobile Environment Variables

(To be added when external services are integrated)

## Cost Estimates

(To be calculated once services are selected and usage patterns are understood)

Factors affecting cost:
- Number of users
- Audio storage volume
- Processing frequency
- Data transfer/bandwidth
- Database size and queries

## Service Integration Checklist

For each new service integration:

- [ ] Evaluate service options
- [ ] Test in development
- [ ] Configure environment variables
- [ ] Add to infrastructure docs
- [ ] Update deployment scripts
- [ ] Add monitoring/alerting
- [ ] Document API usage
- [ ] Add to cost tracking
