# External Services

## AWS S3

S3 stores isolated audio stems. The backend issues one-hour presigned upload and
download URLs through `backend/src/services/s3Service.ts`; audio bytes move
directly between the mobile app and S3. Object keys use
`audio/{uuid}-{filename}` and preserve the actual container extension.

S3 configuration comes from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_REGION`, and `AWS_S3_BUCKET`.

## PostgreSQL

PostgreSQL is the source of truth for the branching `AudioNode` graph and exact
`durationMs`/`startTimeMs` metadata. Local development uses the database defined
in `devenv.nix`; production hosting is not selected yet.

## FFmpeg

FFmpeg decodes S3 calibration objects to canonical mono PCM for waveform
correlation. It is not currently used to destructively mix story stems; native
mobile playback mixes the isolated files.

## Not yet integrated

Authentication, analytics, crash monitoring, push notifications, a CDN, and
production managed PostgreSQL are not yet configured.
