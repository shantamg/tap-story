# **Implementation Plan: Tap Story Social PoC**

**Objective:** Build a functional "Infinite Tape" prototype where users can record, share a link, and have others record over/past it. **Strategy:** Simplify the complexity. Instead of a complex Graph/Tree, we build a **Doubly Linked List**. We move the heavy audio processing to the backend ("The Bounce Down") to keep the client light.

---

## **Phase 1: Architecture & Data Model**

We will strip the schema down to the absolute essentials needed to link audio files together.

### **1.1 The Simplified Schema (Prisma/Postgres)**

We don't need user authentication for the PoC. We just need to track the chain of audio.

Code snippet

```
model AudioNode {
  id        String   @id @default(uuid()) // The "Share Code"
  audioUrl  String   // The URL of the FULL mixed audio (Parent + New)
  parentId  String?  // Null if this is a "Seed" (start of story)
  childId   String?  // The next node in the chain (optional for now)
  createdAt DateTime @default(now())
}
```

### **1.2 The "Bounce Down" Strategy**

To avoid syncing multiple files on the iPad, the server does the work:

1. **Client** uploads only the **new** recording (the "Overdub").
2. **Server** downloads the **Parent** audio.
3. **Server** mixes (overlays) the Parent \+ Overdub into one single file.
4. **Server** saves the new file and generates a new Link ID.

---

## **Phase 2: Parallel Work Streams**

To move fast, we split into two tracks that can work independently until integration.

### **Track A: Backend (The Mixer)**

_Focus: Receiving audio, mixing it with FFmpeg, and managing S3._

- **\[ \] A1. Setup Infrastructure**
  - Initialize Node.js/Express server.
  - Set up AWS S3 (or R2) bucket with public read access.
  - Set up local Postgres database.
- **\[ \] A2. The "Seed" Endpoint (`POST /start`)**
  - Accepts a single audio file (multipart/form-data).
  - Uploads to S3.
  - Creates a DB entry with `parentId: null`.
  - Returns `{ id: uuid }`.
- **\[ \] A3. The "Reply" Endpoint (`POST /reply`)**
  - **Input:** `parentId` \+ `newAudioFile`.
  - **Logic:**
    1. Fetch `parentAudioUrl` from DB.
    2. Download Parent Audio to temp disk.
    3. **FFmpeg Magic:** Use `fluent-ffmpeg` to mix inputs.
       - _Critical Flag:_ `amix=inputs=2:duration=longest`.
       - _Why:_ This ensures the output file length is whichever is longer (extending the tail).
    4. Upload result to S3.
    5. Create new DB entry pointing to `parentId`.
- **\[ \] A4. The "Fetch" Endpoint (`GET /node/:id`)**
  - Returns `{ audioUrl, parentId }`.

### **Track B: Frontend (The Recorder)**

_Focus: iPad Audio Session management and UI._

- **\[ \] B1. Expo Audio Config**
  - Configure `Audio.setAudioModeAsync`:
    - `allowsRecordingIOS: true`
    - `playsInSilentModeIOS: true`
    - `playThroughEarpieceAndroid: false`
  - _Goal:_ Ensure we can play a sound and record the mic simultaneously without the OS killing one of them.
- **\[ \] B2. The "Jam" Interface**
  - **State 1 (Load):** Input box to paste a UUID. Fetches audio.
  - **State 2 (Listen):** Playback controls for the fetched track.
  - **State 3 (Record):**
    - When User hits Record:
    - Start playing the `soundObject` (Parent track).
    - _Immediately_ start `recording.startAsync()`.
    - Visuals: Simple progress bar showing playback vs. recording duration.
- **\[ \] B3. Upload Logic**
  - Formulate the `FormData` request.
  - Handle the wait time while server processes the mix (show a spinner).
  - Display the returned UUID.

---

## **Phase 3: Integration & Testing (The "Handshake")**

Once Track A and Track B are complete, we connect them.

- **\[ \] Step 1: The Self-Loop**
  - Launch App. Record a 5-second "Beatbox" (Seed).
  - Get UUID.
  - Paste UUID into same App.
  - Record a "Rap" over the "Beatbox", extending it to 10 seconds.
  - _Success Criteria:_ The resulting file plays back as 10 seconds long, containing both the beatbox (0-5s) and the rap (0-10s).
- **\[ \] Step 2: The Two-Device Test**
  - User A records on iPad.
  - User A sends code to User B (on a different device/simulator).
  - User B records reply.
  - _Success Criteria:_ User B hears User A's audio clearly while recording.

---

## **Tech Constraints & Shortcuts for PoC**

1. **Format:** Use `.m4a` (AAC) for everything. It's native to iOS and small to upload.
2. **Latency:** Do not build a manual latency slider yet. Accept that the recording might be 20-50ms off. We can fix this later.
3. **Storage:** Don't delete old temp files on the server yet. Just let them pile up during the demo phase to save coding time.
4. **Error Handling:** Minimal. If FFmpeg fails, just crash the request. Focus on the "Happy Path."
