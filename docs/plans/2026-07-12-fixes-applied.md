# Tap Story — Fixes & Redesign (2026-07-12)

Summary of the audit-driven work in this session. The full raw audit is in
[2026-07-12-investigation-findings.md](./2026-07-12-investigation-findings.md)
(59 confirmed findings from a 99-agent adversarial review).

## Verified working in the iOS simulator

The app builds and runs, and the core loop works end to end:
record → durable local save → S3 upload → backend persistence, including the
duet overlay (record-while-playing). Simulators cannot validate acoustic
latency, so on-device loopback acceptance is still required (see below).

> Build note: `npx expo run:ios` fails from the devenv shell because Nix's
> clang shadows Apple's. Build with a sanitized env — unset `CC`/`CXX`/`LD`/
> `LDFLAGS`/`CPPFLAGS`/`NIX_*` and put `/usr/bin` first on `PATH`.

## Fixed this session

### Audio engine robustness (`mobile/services/audio/`)
- **Route-change recovery on the record path.** `RECORD_START_ERROR` (the iOS
  capture-arm rejection) is now treated as recoverable, so an unplug/interrupt
  between takes is retried instead of surfaced as an error. `startRecordingOnly`
  now uses the same retry path as `playFrom`.
- **Latency compensation survives a rebuild.** A route-change rebuild re-measures
  and re-applies capture latency; previously the retried overdub gated at
  requested+0 frames and was silently mis-synced on Android.
- **`stop()` never loses a finalized take.** A transport-stop rejection no longer
  discards a WAV that `stopRecording()` successfully finalized.
- **Playback completion reaches the UI.** Both players fire `onPlaybackComplete`
  at end-of-timeline; the recorder leaves the "playing" state instead of wedging
  with a frozen playhead and a hidden Play button.

### Data safety (`mobile/components/DuetRecorderWithTrackPlayer.tsx`, `services/audio/pendingUploads.ts`)
- **A take can no longer be lost.** The WAV is copied to durable storage and a
  pending-upload record is written **before** any network call. On failure the
  take stays on the timeline with a tap-to-retry banner; queued takes flush on
  the next launch. The UI no longer blocks on the upload round-trip.

### UI / UX
- New violet-on-near-black design system (`utils/theme.ts`: spacing, radius,
  typography) and a reusable `AppButton`.
- **List:** hero "New Story" CTA, story cards with clip counts, pull-to-refresh,
  and distinct loading / empty / network-error states (a network failure no
  longer masquerades as "no stories").
- **Detail:** cleaner header, a punch-in "Get ready" cue, a Discard-take
  affordance, retry banners for failed load/upload, and friendlier copy (native
  error strings are translated to plain language).
- Timeline segments no longer remount ~10×/sec during playback (the animated
  segment component was hoisted out of render), so the play-glow animates and
  segment taps register.
- Disabled transport controls are now visibly dimmed and carry accessibility
  roles/labels/state.
- Android hardware back returns to the story list instead of exiting the app.
- Delete warning now matches behavior (clips shared with other stories are kept).

### Backend (`backend/src/`)
- `/upload-url` rejects path-traversal / unsafe filenames (the filename becomes
  part of the S3 key) and non-audio content types.
- `/save` rejects keys the service didn't mint, so a client cannot register an
  arbitrary/forged S3 object.
- Seed uses S3-key-shaped `audioUrl` values (the column stores keys, not URLs).

## Remaining — needs a physical device or a product decision

These confirmed findings were **not** changed because they either require
on-device audio testing to verify safely, or are product/architecture calls:

- **Native take-rejection is too aggressive (data loss).** iOS discards the
  in-flight take on *every* route-change/interruption notification without
  inspecting the reason; Android invalidates on *any* device-set change (even a
  Bluetooth speaker auto-connecting across the room) and on a stop tail-drain
  timeout. A fully-captured take can be thrown away. Fix needs device testing of
  the notification/route logic in `AudioEngineIOS.mm`, `TapStoryAudioModule.swift`,
  `TapStoryAudioEngine.kt`, `TapStoryAudioModule.kt`.
- **WAV-conversion failure deletes the validated raw PCM** (disk-full destroys a
  good take) — `TapStoryAudioModule.swift` / `AudioEngineIOS.mm`.
- **No auth on any backend route**, including permanent story deletion (DB + S3).
  This is the biggest architectural gap and needs an auth design.
- **`GET /chains` is an unbounded N+1** ancestor walk with no pagination — fine
  for now, will need batching as the library grows.
- **Dead/duplicated audio layers** (`duetPlayer.ts`, `useDuetPlayback`, parts of
  `DuetTrackPlayer`/`TapStoryAudio`) can be pruned once the native path is the
  sole path.

## On-device acceptance still required

Per the sync plan, a release candidate is reliable only after a loopback run on
physical iOS and Android hardware across built-in and wired routes. The
simulator validated lifecycle and frame math, not acoustic latency.
