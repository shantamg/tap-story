# Audio Synchronization Design and Status

## Original failure

Overdubs were variably 100–300 ms late. The first implementation coordinated
Expo AV operations from JavaScript. A later Android implementation used
`AudioTrack` and `AudioRecord` on separate threads, but still treated frames
written by the app as frames heard by the performer.

The problem was not one missing delay constant. Several independent defects
combined:

- recording startup and playback used different threads/clocks;
- “recording started” was emitted when capture was armed, not when a microphone
  sample was accepted;
- a punch inside a native callback was rounded to the following callback;
- output, input, and decoded files were assumed to be 44.1 kHz;
- stereo decoder output was passed to a mixer that interpreted every sample as
  a mono frame;
- both native callbacks allocated, locked, and wrote files in real time;
- native stop invalidated recording state before the file was finalized;
- durations were rounded up and persisted as whole seconds;
- `startTime` was not persisted, and mobile/backend rebuilt it differently;
- cached WAV/M4A/WebM files were saved under misleading extensions.

Whole-second metadata alone could move a later punch by almost one second, even
if the native callback had otherwise been perfect.

## Current design

Tap Story now treats alignment as a duplex-session and data-contract problem.

### One exact timeline

`durationMs` and `startTimeMs` are persisted as integers. The backend derives
placement from the persisted parent/grandparent chain; the shared timeline
calculator previews the same rule. Saved timing is authoritative.

### Native full-duplex I/O

Android uses Oboe `FullDuplexStream`; iOS uses RemoteIO AudioUnit. Both use the
active device sample rate, canonical mono PCM for mixing, an exact partial-buffer
punch, and a preallocated lock-free ring feeding a background file writer.

### Acoustic latency compensation

The capture gate is later than the logical punch by the route's total input plus
output delay. The first stored microphone sample therefore represents what was
happening acoustically at the logical punch, while the completed file is still
placed at that logical point.

A standalone first take has no playback reference, so it uses microphone input
latency only. The UI reports recording as active only after the native writer
accepts that first compensated microphone frame.

Stop applies the matching bookend. The first realtime callback that observes
the request mutes output, defines the logical end, and captures an exact partial
input tail. This avoids clipping the final latency interval or adding/removing
one callback because of a control-thread race.

iOS uses `AVAudioSession` route latency by default. Android applies the current
route estimate. The optional signed UI fine-tune adjusts, rather than replaces,
that automatic estimate. A
future guided known-signal recording can replace the estimate; the current app
does not treat arbitrary story tracks as calibration. The backend correlation
primitive rejects low-confidence matches. Bluetooth/BLE/AirPlay
routes are rejected for synchronized overdubs because their buffering is too
variable for the stated target.

### Drift and failure handling

Finalization compares captured input frames with the exact output-timeline span
and corrects slow clock-rate drift. Ring overflow is a failed take, not a file
silently saved with missing audio. Diagnostics include frame counts, dropped
frames, sample rate, xruns, stream mode/error, route latency, and iOS render
timeline jumps. A route change or interruption invalidates the take and forces
the decoded tracks and latency estimate to be rebuilt.

## What automated tests prove

- millisecond timeline planning and API persistence;
- native stop/reinitialize ordering;
- exact punch slicing inside a callback;
- SPSC ring ordering/capacity under concurrent producer/consumer load;
- format-safe caching and upload metadata;
- normalized cross-correlation on synthetic delayed signals;
- TypeScript contracts and native compilation.

## What remains to prove

No simulator can measure speaker-to-microphone behavior. The code must complete
the physical-device matrix in
[`plans/2026-07-12-reliable-audio-sync.md`](./plans/2026-07-12-reliable-audio-sync.md)
before the 5–10 ms target is considered verified. Until those measurements are
recorded, the correct status is “designed and instrumented for reliable sync,”
not “proven on every device.”
