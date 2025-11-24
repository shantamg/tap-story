# Product Requirement Document: "Tap Story"

## 1. Executive Summary

**Tap Story** is a native iOS audio application that reimagines the multi-track recorder as a fluid, elastic storytelling medium.

At its core, it is a high-performance audio tool that allows users to record and play back audio at _any_ speed or pitch, maintaining perfect synchronization regardless of how the timeline is stretched.

In its future state, Tap Story evolves into a turn-based collaborative game (a "Musical Exquisite Corpse"). Users pass a session file back and forth. Each player receives the story, adjusts the tempo to their liking, and adds their contribution to the end of the chain. The story grows longer with every turn, but previous chapters remain immutable.

## 2. Technical Architecture

### 2.1. Technology Stack

- **Platform:** iOS (Native).
- **Language:** Swift 6.0+
- **UI Framework:** SwiftUI (Required for fluid "Pill" animations and gesture handling).
- **Audio Engine:** `AVAudioEngine` (AVFoundation).
- **DSP Nodes:**
  - `AVAudioUnitTimePitch`: For independent control of rate and pitch.
  - `AVAudioUnitVarispeed`: For "linked" tape-deck style control.
- **Data Persistence:** SwiftData for local metadata; FileSystem for `.wav` storage.
- **Future Cloud Stack:** CloudKit (recommended for seamless turn-based file sharing).

### 2.2. The Core "Elastic" Audio Engine

The engine must support **Non-Destructive Elasticity**.

- **Global State:** `MasterPlaybackRate` (Default: 1.0), `MasterPitchOffset` (Default: 0 semitones).
- **Track Metadata:** Every audio file (`Asset`) saves:
  - `RecordedAtRate` — the `MasterPlaybackRate` at the moment of recording.
  - `RecordedAtPitchOffset` — the `MasterPitchOffset` at the moment of recording.
- **Playback Calculation (Speed):** When the engine plays, each track’s player node is assigned a rate calculated dynamically so that its _relative_ tempo to the master is preserved:
  $$\text{NodeRate} = \frac{\text{MasterPlaybackRate}}{\text{Asset.RecordedAtRate}}$$
  - _Scenario:_ Player A records a drum beat at 0.5x speed. Player B sets Master Speed to 1.0x. Player A's drum beat automatically plays back at 2.0x speed to stay in sync.
    -- **Playback Calculation (Pitch):** Each track’s playback pitch is computed relative to the master so that what you recorded “against” a slowed or shifted master stays musically aligned when the master changes:
    $$\text{NodePitchOffset} = \text{MasterPitchOffset} - \text{Asset.RecordedAtPitchOffset} + \text{TrackLocalPitchOffset}$$
  - _Scenario:_ Player A records a melody while the master is shifted down \(-3\) semitones. Later, the master is reset to 0. The engine automatically adds \(+3\) semitones to Player A’s clip (plus any local offset) so the melody still feels the same relative to the new master.
- **Independent Pitch Control:** Each track also has a non-destructive local pitch parameter (`TrackLocalPitchOffset`, in semitones/cents) that can be adjusted independently of speed.
- **Link / Unlink Behavior:** At the engine level, pitch and speed can be linked (classic tape-machine varispeed) or unlinked (time-stretch with constant pitch), mirroring the `AVAudioUnitTimePitch` / `AVAudioUnitVarispeed` configuration. The `RecordedAtRate` / `RecordedAtPitchOffset` fields always capture whatever the performer was hearing at record time, so later master changes preserve each clip’s relative speed and pitch.

---

## 3. User Interface (UI) Concepts

### 3.1. The Canvas (Tap Story Board)

- **Visual Metaphor:** A branching story tree of takes and responses.
- **Tree View:** A hierarchical view where each recording can branch into many possibilities. This view is primarily for **navigating and understanding the branching structure**, not for detailed waveform editing.
- **Nodes:** Each node in the tree represents a recording (or a group of recordings) and its possible child branches.
- **Recording Mode:** When recording, the UI switches to a focused mode where you only see:
  - The node you are recording **onto** (the current context you are responding to).
  - The node you are currently **recording** (the new branch being created).
    This avoids visual noise and keeps the performer focused on the immediate interaction, while the tree view remains available for broader navigation outside of active recording.

### 3.2. The Control Header

- **Speed Dial:** Rotary control for Master Speed (0.25x to 2.0x).
- **Pitch Dial:** Rotary control for Pitch, with:
  - **Semitone snapping** for musical intervals.
  - **Fine adjustment** (e.g., via modifier, long-press, or secondary gesture) for subtle detuning between semitones.
- **Link Toggle:** Chain icon.
  - _Linked:_ Tape-machine behavior (Faster = Higher Pitch).
  - _Unlinked:_ Time-stretch behavior (Faster = Same Pitch).
- **The Click:** A metronome icon. Tapping enables a click track that syncs to the Master Speed.

### 3.3. The Footer

- **The "Plus" Button:** Adds a new track to the stack.
- **Contextual Hints:** Subtle text appearing during gestures (e.g., "Hold to Punch In").

---

## 4. User Experience (UX) Flows

### 4.1. Navigation & Scrubbing

- **Gesture:** Swipe left/right on the background to scroll time.
- **Vinyl Scrub (Opt-In):** Users can choose between **silent scrolling** and **scrubbing**:
  - By default, scrolling is silent so you can move around without hearing playback.
  - When in a scrubbing mode (e.g., while holding a modifier, in a specific gesture state, or while playback is active), the audio engine "scrubs" (plays short buffers) matching the drag speed to help find transients by ear.

### 4.2. The "Gesture-First" Recording Workflow

There are no transport buttons (Play/Record/Stop). Recording is gesture-driven.

**Step 1: Target (The Punch-In Point)**

1.  **Action:** User **Touch & Holds (1s)** on an empty track area.
2.  **Feedback:** Haptic click. UI enters "Target Mode."
3.  **Refine:** User drags finger left/right to scrub and find the exact entry point.
4.  **Set:** User releases finger. A **Red Marker** appears at that timestamp.

**Step 2: Pre-Roll (The Run-Up)**

1.  **Action:** User **Touch & Holds** anywhere _before_ the Red Marker.
2.  **Refine:** Drag backward to find a listening start point (e.g., 4 bars back).

**Step 3: The Take**

1.  **Action:** With the **Playhead fixed in the center** of the screen, the user scrolls the timeline horizontally (silent by default) until they find their desired pre-roll start point.
2.  **Result:** When they are ready, the user taps to **start playback from that position**.
3.  **Transition:** When the Playhead hits the **Red Marker**, the app switches to **Record Mode** (punches in).
4.  **Visual:** A red "Pill" (or recording indicator) draws in real-time from the punch-in point.

**Step 4: Stop**

1.  **Action:** Tap anywhere. Recording stops.
2.  **Review:** The user can:
    - **Swipe horizontally** to move the timeline under the fixed playhead and audition different moments.
    - **Tap anywhere** to start playback from that position.
    - **Swipe the new Pill up** to delete it.

---

## 5. Collaborative "Tap Story" Mode

This section outlines the turn-based multiplayer architecture to be implemented after the core recorder is stable.

### 5.1. The "Correspondence" Mechanic

- **Asynchronous Multiplayer:** Only one user "holds the pen" at a time.
- **State Management:**
  - _Active State:_ It is your turn. You can edit speed/pitch and record.
  - _Locked State:_ It is not your turn. You can listen, but you cannot record or modify tracks.

### 5.2. "Tap Story" Rules (The Game Loop)

The goal is to create an evolving **chain of duets**, but with a **simple, automatic recording workflow** (gesture-based targeting can come later).

1.  **First Take:** Player A records an initial segment. This establishes the **timeline** but there is no prior tail yet.
2.  **Second Take (First Duet):** When Player B records onto Player A:
    - Their recording **automatically starts at the very beginning** of Player A's recording (no need to choose a start point).
    - They must record **past the end of Player A's take**, leaving a **tail** that extends beyond the original.
3.  **Subsequent Takes:** For every take after that (Player A or B):
    - The new recording **automatically starts at the end of the previous tail**.
    - The performer must again record **past that point**, creating a **new, longer tail** for the next duet.
4.  **Chain of Duets:** Over time, this creates a linear chain where each duet builds on the previous one and always leaves new space for the next person.
5.  **Immutable Past:** No one can delete or overwrite previous takes; each contribution only **adds** to the chain.
6.  **Send:** When a player finishes their duet segment, the session syncs to the cloud and the other participant is notified that **a new tail is available**.

---

## 6. Detailed Feature Requirements

### 6.1. The Click Track (Metronome)

- Must be synthesized programmatically to remain crisp at low speeds.
- Never recorded into the final audio bounce.

### 6.2. Visualizing "Stretch" (The Pill Physics)

- **The Formula:** `RenderedWidth = AudioDuration * (1 / MasterSpeed) * ZoomFactor`.
- This gives the user physical confirmation of the time manipulation. Slowing down time makes the world "bigger."

### 6.3. Immutable Relative Data

- Tap Story uses non-destructive editing.
- We never "render" the time stretch into the file permanently. We only render the playback instructions. This preserves the highest audio quality and allows the next collaborator to speed it back up without artifacts.

---

## 7. Technical Implementation Plan

### Phase 1: The Engine & Canvas

- **Goal:** `AVAudioEngine` running with a scrolling SwiftUI canvas.
- **Key Task:** Implement the "Scrubbing" logic: Map `ScrollView` offset $\leftrightarrow$ `audioPlayerNode.scheduleSegment`.

### Phase 2: Variable Speed Logic

- **Goal:** Speed control without pitch shift.
- **Key Task:** Insert `AVAudioUnitTimePitch` into the graph. Implement the `NodeRate = Master / RecordedRate` math.

### Phase 3: The Gesture Workflow

- **Goal:** The "No Buttons" recording flow.
- **Key Task:** Implement `UILongPressGestureRecognizer` states: `Idle` $\rightarrow$ `Targeting` $\rightarrow$ `PreRolling` $\rightarrow$ `Recording`.

### Phase 4: Data Layer

- **Goal:** Save/Load Projects.
- **Key Task:** Create a `TrackModel` (SwiftData) that stores the `recordedAtRate` float for every file.
