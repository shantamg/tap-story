# Reliable Audio Synchronization Plan

**Status:** Native engine rewrite implemented; physical-device acceptance run pending.

## Product requirement

Tap Story is an alternating, collaborative multitrack timeline. The first two
recordings begin at timeline zero. Each later recording begins at the exact end
of the segment two positions back, so two contributors can continue the story
without destructively mixing earlier stems.

An overdub must be placed according to what the performer heard, not according
to when JavaScript resolved a promise or when an app filled an output buffer.

## Reliability contract

- Timeline metadata is integer milliseconds end to end. No duration is rounded
  to whole seconds and saved nodes keep their authoritative `startTimeMs`.
- Playback and capture use a native full-duplex engine and one negotiated sample
  rate. Compressed inputs are converted to mono PCM and resampled before play.
- A recording is armed before its punch point. Route round-trip latency moves
  the capture gate later while the saved recording remains placed at the logical
  punch point.
- A punch inside an audio callback keeps the exact partial buffer; it is never
  rounded to the next callback.
- Real-time callbacks do no allocation, locking, decoding, or file I/O. They
  copy PCM through a preallocated single-producer/single-consumer ring to a
  background writer.
- Native transport stop is a callback handshake: the first callback that sees
  the request mutes output and drains the compensated capture tail through an
  exact partial final buffer before transport is quiesced. Finalization then
  drains the writer; any route change, stream error, xrun, onset slip, excessive
  clock drift, timeline jump, or ring overflow fails the take.
- Input/output clock-rate differences are corrected against the exact output
  timeline span only within a bounded drift allowance. An Android overdub is
  rejected when the route cannot report xrun diagnostics.
- Bluetooth/BLE/AirPlay routes are not accepted for synchronized overdubs. Their
  variable buffering cannot support the tight-sync promise; built-in or wired
  routes are required.
- The Expo AV fallback may make a first recording and play content, but it must
  not claim synchronized overdub support.

## Objective device acceptance

Simulators can validate lifecycle and frame math, but not acoustic latency. A
release candidate is considered reliable only after a loopback run on physical
devices.

Test each supported built-in and wired route with a known aperiodic calibration
signal. Record the signal through Tap Story, estimate delay with normalized
cross-correlation, and repeat at least 20 times.

Acceptance thresholds:

- median absolute alignment error: at most 10 ms;
- p95 absolute alignment error: at most 20 ms;
- drift after a five-minute take: at most 5 ms;
- dropped capture frames: zero;
- new input/output xruns during a take: zero;
- stop/save success: 20 out of 20 runs.

Initial device matrix:

- Samsung Galaxy A15 (the original failing Android device);
- one recent Pixel or other native-AAudio device;
- one recent iPhone;
- built-in speaker/microphone and a wired-headphone route on each device.

## Calibration workflow

Automatic route latency is the default. The backend has correlation primitives
for a future guided loopback recording, but the app does not expose arbitrary
story tracks as calibration. A deliberate signed fine-tune around the automatic
estimate is still stored once per device. Before broad distribution, the guided
flow must use the same known signal on both takes and store results per audio
route.

## Remaining validation risk

The repository now has deterministic tests for timeline calculation, punch
boundaries, lock-free PCM buffering, recording lifecycle, format-safe caching,
and correlation math. Those tests prevent the known software regressions, but
they do not substitute for the physical-device matrix above.
