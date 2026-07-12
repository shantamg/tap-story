# Mobile App Architecture

## Overview

The mobile workspace is a React Native/Expo app with checked-in native iOS and
Android projects. The home screen uses `DuetRecorderWithTrackPlayer` to list
saved chains, download missing stems, display the two-lane timeline, play a
story, and add a recording.

## Active audio stack

```text
DuetRecorderWithTrackPlayer
  -> NativeDuetPlayer
    -> TapStoryNativeAudio (React Native bridge wrapper)
      -> Android: Kotlin decoder/bridge + Oboe C++ duplex engine
      -> iOS: Swift decoder/bridge + RemoteIO AudioUnit engine
```

When the native module is unavailable, Expo AV can record the first take and
provide ordinary playback. Synchronized overdubbing is blocked in that mode;
JavaScript promise/interval timing is not reliable enough for the product's
alignment guarantee. The fallback persists Expo's finalized media duration,
not a wall-clock estimate, so a later native continuation still receives an
accurate timeline boundary.

## Recording session

1. `AudioRecorder.init()` requests runtime microphone permission on every
   platform, including native mode.
2. Existing local/remote stems are decoded to mono PCM and resampled to the
   native duplex rate.
3. The native engine uses input-only latency for a standalone first take and
   round-trip route latency for an overdub. A signed fine-tune may adjust the
   automatic value. Bluetooth-class routes are rejected for overdubs.
4. Playback starts from the requested position and capture is armed at the
   planned punch point.
5. The engine publishes `onRecordingStarted` only after it accepts the first
   real input sample; the event is not emitted merely because recording was
   armed.
6. Stop publishes a realtime-safe tail request. The first native callback that
   observes it mutes the backing mix, drains the compensated input tail through
   an exact partial final callback, then quiesces transport and the writer.
   Finalization validates onset, bounded clock drift, stream errors, xruns,
   route changes, and overflow.
7. The app uploads the aligned WAV and `durationMs`; the backend derives exact
   `startTimeMs` from the persisted chain. The cache keeps the real extension.

## Android engine

Android uses Oboe `FullDuplexStream`:

- output is opened first at the native device rate;
- input matches the granted output rate and uses the full-duplex buffering
  helper;
- compressed source channels are mixed to mono and resampled during load;
- exact partial-buffer capture handles a punch inside a callback;
- the callback mixes float PCM and writes capture samples to a preallocated
  lock-free SPSC ring;
- a background thread performs file I/O;
- finalization corrects input/output clock-rate drift against the output
  timeline and exposes sample rate, xruns, latency estimates, frame counts,
  overflow, and stream error diagnostics.
- a take is rejected when a short input read slips the compensated punch, when
  accumulated drift exceeds the explicit correction bound, or when an overdub
  route cannot report xrun diagnostics;
- compensated stop emits silence while capture drains to the exact logical end,
  so latency trimming does not remove the take's final frames;
- device topology changes invalidate the engine instead of reopening streams
  underneath tracks decoded at the previous route rate.

## iOS engine

iOS uses a RemoteIO AudioUnit in a play-and-record `AVAudioSession`:

- input and output are presented through the same aggregated render cycle;
- the actual active-session sample rate is used;
- `AVAudioConverter` normalizes loaded assets;
- reported input plus output latency moves the capture gate while preserving
  the logical placement frame;
- capture-only sessions use input latency without adding an irrelevant output
  delay;
- the render callback uses the same real-time-safe ring/writer separation and
  exact partial-buffer punch behavior as Android;
- a deliberate signed fine-tune may adjust automatic route compensation. The
  correlation endpoint is reserved for a future guided,
  known-signal workflow rather than arbitrary story tracks.

The Swift bridge, Objective-C export, and Objective-C++ engine must all remain
members of the Xcode application target.

## Timeline and cache

The API/shared contract uses integer milliseconds. Player/UI components convert
to seconds only at their existing display boundary. `getNextTimelineStartTimeMs`
is the only scheduling rule.

Audio cache paths preserve the actual `.wav`, `.m4a`, or `.webm` container.
Downloads use a `.download` temporary file and an atomic move so interrupted
files are never considered playable.

## Development and tests

From the repository root:

```bash
npm run start
npm run android
npm run ios
npm run test
npm run check
```

Mobile Jest covers Expo lifecycle, playback loading, native session lifecycle,
upload metadata, and format-safe caching. Portable C++ host tests under
`mobile/android/app/src/testNative` cover the punch boundary and SPSC ring.
Native builds validate compilation; physical hardware is still required for
the acoustic acceptance matrix in
[`plans/2026-07-12-reliable-audio-sync.md`](./plans/2026-07-12-reliable-audio-sync.md).
