# MVP Audio Recording & Duet Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build minimum viable audio recording with duet functionality to test branching narrative concept

**Architecture:** Direct audio recording to S3, simple parent-child relationships in PostgreSQL, in-memory playback coordination

**Tech Stack:** React Native expo-av, AWS S3 Direct Upload, Express API, PostgreSQL with Prisma

---

## Prerequisites: Cloud Services Setup

### Task 0: AWS S3 Setup

**Manual Setup Required:**

1. **Create AWS Account** (if needed)
   - Go to https://aws.amazon.com
   - Create free tier account

2. **Create S3 Bucket**
   ```
   Bucket Name: tapstory-audio-dev
   Region: us-east-1 (or closest to you)
   Settings:
   - Block all public access: OFF (we'll use presigned URLs)
   - Versioning: Disabled (for MVP)
   - Encryption: Default
   ```

3. **Create IAM User for S3 Access**
   ```
   IAM User: tapstory-s3-user
   Permissions: AmazonS3FullAccess (for MVP, restrict later)
   Access Keys: Generate and save
   ```

4. **Set Environment Variables**

   Create `.env` in backend directory:
   ```
   DATABASE_URL="postgresql://user:password@localhost:5432/tapstory"
   AWS_ACCESS_KEY_ID="your-access-key"
   AWS_SECRET_ACCESS_KEY="your-secret-key"
   AWS_REGION="us-east-1"
   AWS_S3_BUCKET="tapstory-audio-dev"
   ```

---

## 🚀 PARALLEL EXECUTION OPPORTUNITIES

### Phase 1: Backend & Mobile Services (PARALLEL - 3 agents)
**These tasks have no dependencies on each other and can be executed simultaneously:**

- **Agent 1:** Task 1 (Backend S3 Upload Service)
- **Agent 2:** Task 3 (Mobile Audio Recording Service)
- **Agent 3:** Task 4 (Duet Playback Service)

### Phase 2: API Integration (SEQUENTIAL)
**Depends on Task 1 completion:**
- Task 2 (Audio Upload API Endpoint)

### Phase 3: UI Components (PARALLEL - 2 agents)
**After services are complete, these can be done in parallel:**
- **Agent 1:** RecordButton component
- **Agent 2:** DuetRecorder component & main app entry

### Phase 4: Testing & Integration (SEQUENTIAL)
- Task 6 (Database Migration & Testing)

**Time Savings:** Running Phase 1 in parallel saves ~66% of the time for those three tasks. Phase 3 parallel execution saves ~50% time.

---

## Task 1: Backend S3 Upload Service

**🤖 Can be executed in parallel with Tasks 3 & 4**

### Files:
- Create: `backend/src/services/s3Service.ts`
- Create: `backend/src/services/__tests__/s3Service.test.ts`
- Modify: `backend/src/server.ts`

**Step 1: Write the failing test**

File: `backend/src/services/__tests__/s3Service.test.ts`
```typescript
import { generateUploadUrl, generateDownloadUrl } from '../s3Service';

describe('S3Service', () => {
  it('should generate a presigned upload URL', async () => {
    const result = await generateUploadUrl('test.webm');

    expect(result.uploadUrl).toContain('https://');
    expect(result.uploadUrl).toContain('tapstory-audio-dev');
    expect(result.key).toBe('audio/test.webm');
  });

  it('should generate a presigned download URL', async () => {
    const url = await generateDownloadUrl('audio/test.webm');

    expect(url).toContain('https://');
    expect(url).toContain('tapstory-audio-dev');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test --workspace=backend -- s3Service.test.ts`
Expected: FAIL with "Cannot find module '../s3Service'"

**Step 3: Write minimal implementation**

File: `backend/src/services/s3Service.ts`
```typescript
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET_NAME = process.env.AWS_S3_BUCKET || 'tapstory-audio-dev';

export async function generateUploadUrl(filename: string): Promise<{ uploadUrl: string; key: string }> {
  const key = `audio/${uuidv4()}-${filename}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: 'audio/webm',
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

  return { uploadUrl, key };
}

export async function generateDownloadUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });

  return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
}
```

**Step 4: Install required dependencies**

Run: `cd backend && npm install uuid @aws-sdk/s3-request-presigner && npm install -D @types/uuid`

**Step 5: Run test to verify it passes**

Run: `npm run test --workspace=backend -- s3Service.test.ts`
Expected: PASS (with mocked AWS credentials)

**Step 6: Commit**

```bash
git add backend/src/services/s3Service.ts backend/src/services/__tests__/s3Service.test.ts
git commit -m "feat: add S3 service for audio upload/download"
```

---

## Task 2: Audio Upload API Endpoint

**⚠️ SEQUENTIAL - Depends on Task 1 completion**

### Files:
- Create: `backend/src/routes/audioRoutes.ts`
- Create: `backend/src/routes/__tests__/audioRoutes.test.ts`
- Modify: `backend/src/server.ts`

**Step 1: Write the failing test**

File: `backend/src/routes/__tests__/audioRoutes.test.ts`
```typescript
import request from 'supertest';
import express from 'express';
import audioRoutes from '../audioRoutes';

const app = express();
app.use(express.json());
app.use('/api/audio', audioRoutes);

describe('Audio Routes', () => {
  describe('POST /api/audio/upload-url', () => {
    it('should return presigned upload URL', async () => {
      const response = await request(app)
        .post('/api/audio/upload-url')
        .send({ filename: 'recording.webm' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('uploadUrl');
      expect(response.body).toHaveProperty('key');
    });
  });

  describe('POST /api/audio/save', () => {
    it('should save audio node to database', async () => {
      const response = await request(app)
        .post('/api/audio/save')
        .send({
          key: 'audio/test.webm',
          duration: 10,
          parentId: null
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('audioUrl');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test --workspace=backend -- audioRoutes.test.ts`
Expected: FAIL with "Cannot find module '../audioRoutes'"

**Step 3: Write minimal implementation**

File: `backend/src/routes/audioRoutes.ts`
```typescript
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { generateUploadUrl, generateDownloadUrl } from '../services/s3Service';

const router = Router();
const prisma = new PrismaClient();

// Get presigned URL for upload
router.post('/upload-url', async (req, res) => {
  try {
    const { filename } = req.body;

    if (!filename) {
      return res.status(400).json({ error: 'Filename required' });
    }

    const result = await generateUploadUrl(filename);
    res.json(result);
  } catch (error) {
    console.error('Upload URL generation error:', error);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// Save audio metadata after successful upload
router.post('/save', async (req, res) => {
  try {
    const { key, duration, parentId } = req.body;

    if (!key || !duration) {
      return res.status(400).json({ error: 'Key and duration required' });
    }

    const audioNode = await prisma.audioNode.create({
      data: {
        audioUrl: key,
        duration,
        parentId: parentId || null,
      },
    });

    // Return with presigned download URL
    const downloadUrl = await generateDownloadUrl(audioNode.audioUrl);

    res.status(201).json({
      ...audioNode,
      audioUrl: downloadUrl,
    });
  } catch (error) {
    console.error('Save audio error:', error);
    res.status(500).json({ error: 'Failed to save audio' });
  }
});

// Get audio tree for playback
router.get('/tree/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get the node and all its ancestors
    const node = await prisma.audioNode.findUnique({
      where: { id },
      include: {
        parent: true,
      },
    });

    if (!node) {
      return res.status(404).json({ error: 'Audio node not found' });
    }

    // Build ancestor chain
    const ancestors = [];
    let current = node;

    while (current) {
      const downloadUrl = await generateDownloadUrl(current.audioUrl);
      ancestors.unshift({
        ...current,
        audioUrl: downloadUrl,
      });
      current = current.parent as any;
    }

    res.json({ ancestors });
  } catch (error) {
    console.error('Get tree error:', error);
    res.status(500).json({ error: 'Failed to get audio tree' });
  }
});

export default router;
```

**Step 4: Update server.ts**

File: `backend/src/server.ts` (add these lines)
```typescript
import audioRoutes from './routes/audioRoutes';

// Add after other middleware
app.use('/api/audio', audioRoutes);
```

**Step 5: Run test to verify it passes**

Run: `npm run test --workspace=backend -- audioRoutes.test.ts`
Expected: PASS (with mocked database)

**Step 6: Commit**

```bash
git add backend/src/routes/audioRoutes.ts backend/src/routes/__tests__/audioRoutes.test.ts
git commit -m "feat: add audio upload and save API endpoints"
```

---

## Task 3: Mobile Audio Recording Service

**🤖 Can be executed in parallel with Tasks 1 & 4**

### Files:
- Create: `mobile/services/audioService.ts`
- Create: `mobile/services/__tests__/audioService.test.ts`
- Create: `shared/src/types/audio.ts`

**Step 1: Create shared types**

File: `shared/src/types/audio.ts`
```typescript
export interface AudioNode {
  id: string;
  audioUrl: string;
  parentId: string | null;
  duration: number;
  createdAt: string;
  updatedAt: string;
}

export interface UploadUrlResponse {
  uploadUrl: string;
  key: string;
}

export interface SaveAudioRequest {
  key: string;
  duration: number;
  parentId: string | null;
}
```

**Step 2: Write the failing test**

File: `mobile/services/__tests__/audioService.test.ts`
```typescript
import { AudioRecorder } from '../audioService';

describe('AudioRecorder', () => {
  let recorder: AudioRecorder;

  beforeEach(() => {
    recorder = new AudioRecorder();
  });

  it('should initialize recording', async () => {
    await recorder.init();
    expect(recorder.isReady()).toBe(true);
  });

  it('should start and stop recording', async () => {
    await recorder.init();
    await recorder.startRecording();
    expect(recorder.isRecording()).toBe(true);

    const uri = await recorder.stopRecording();
    expect(uri).toBeTruthy();
    expect(recorder.isRecording()).toBe(false);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npm run test --workspace=mobile -- audioService.test.ts`
Expected: FAIL with "Cannot find module '../audioService'"

**Step 4: Write minimal implementation**

File: `mobile/services/audioService.ts`
```typescript
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';

export class AudioRecorder {
  private recording: Audio.Recording | null = null;
  private sound: Audio.Sound | null = null;
  private ready = false;

  async init(): Promise<void> {
    try {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        throw new Error('Audio recording permission not granted');
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
      });

      this.ready = true;
    } catch (error) {
      console.error('Failed to initialize audio:', error);
      throw error;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  isRecording(): boolean {
    return this.recording !== null;
  }

  async startRecording(): Promise<void> {
    if (!this.ready) {
      throw new Error('AudioRecorder not initialized');
    }

    try {
      this.recording = new Audio.Recording();

      await this.recording.prepareToRecordAsync({
        android: {
          extension: '.webm',
          outputFormat: Audio.AndroidOutputFormat.WEBM,
          audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
        },
        ios: {
          extension: '.m4a',
          outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
          audioQuality: Audio.IOSAudioQuality.HIGH,
        },
        web: {
          mimeType: 'audio/webm',
          bitsPerSecond: 128000,
        },
      });

      await this.recording.startAsync();
    } catch (error) {
      console.error('Failed to start recording:', error);
      this.recording = null;
      throw error;
    }
  }

  async stopRecording(): Promise<string> {
    if (!this.recording) {
      throw new Error('No recording in progress');
    }

    try {
      await this.recording.stopAndUnloadAsync();
      const uri = this.recording.getURI();
      this.recording = null;

      if (!uri) {
        throw new Error('Failed to get recording URI');
      }

      return uri;
    } catch (error) {
      console.error('Failed to stop recording:', error);
      throw error;
    }
  }

  async uploadRecording(uri: string, apiUrl: string): Promise<string> {
    try {
      // Get presigned URL
      const uploadUrlResponse = await fetch(`${apiUrl}/api/audio/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'recording.webm' }),
      });

      const { uploadUrl, key } = await uploadUrlResponse.json();

      // Upload file to S3
      const fileInfo = await FileSystem.getInfoAsync(uri);
      const fileBlob = await fetch(uri).then(r => r.blob());

      const uploadResponse = await fetch(uploadUrl, {
        method: 'PUT',
        body: fileBlob,
        headers: {
          'Content-Type': 'audio/webm',
        },
      });

      if (!uploadResponse.ok) {
        throw new Error('Failed to upload to S3');
      }

      return key;
    } catch (error) {
      console.error('Upload failed:', error);
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    if (this.recording) {
      try {
        await this.recording.stopAndUnloadAsync();
      } catch (e) {
        // Ignore cleanup errors
      }
      this.recording = null;
    }

    if (this.sound) {
      try {
        await this.sound.unloadAsync();
      } catch (e) {
        // Ignore cleanup errors
      }
      this.sound = null;
    }
  }
}
```

**Step 5: Install required dependencies**

Run: `cd mobile && npm install expo-file-system`

**Step 6: Run test to verify it passes**

Run: `npm run test --workspace=mobile -- audioService.test.ts`
Expected: PASS (with mocked expo modules)

**Step 7: Commit**

```bash
git add mobile/services/audioService.ts mobile/services/__tests__/audioService.test.ts shared/src/types/audio.ts
git commit -m "feat: add mobile audio recording service"
```

---

## Task 4: Duet Playback Service

**🤖 Can be executed in parallel with Tasks 1 & 3**

### Files:
- Create: `mobile/services/duetPlayer.ts`
- Create: `mobile/services/__tests__/duetPlayer.test.ts`

**Step 1: Write the failing test**

File: `mobile/services/__tests__/duetPlayer.test.ts`
```typescript
import { DuetPlayer } from '../duetPlayer';

describe('DuetPlayer', () => {
  let player: DuetPlayer;

  beforeEach(() => {
    player = new DuetPlayer();
  });

  it('should load audio chain', async () => {
    const mockChain = [
      { id: '1', audioUrl: 'http://test.com/1.webm', duration: 5 },
      { id: '2', audioUrl: 'http://test.com/2.webm', duration: 3 },
    ];

    await player.loadChain(mockChain);
    expect(player.getTotalDuration()).toBe(8);
  });

  it('should play from specific position', async () => {
    const mockChain = [
      { id: '1', audioUrl: 'http://test.com/1.webm', duration: 5 },
      { id: '2', audioUrl: 'http://test.com/2.webm', duration: 3 },
    ];

    await player.loadChain(mockChain);
    await player.playFrom(6); // Start from 1 second into second audio

    const position = await player.getCurrentPosition();
    expect(position).toBeGreaterThanOrEqual(6);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test --workspace=mobile -- duetPlayer.test.ts`
Expected: FAIL with "Cannot find module '../duetPlayer'"

**Step 3: Write minimal implementation**

File: `mobile/services/duetPlayer.ts`
```typescript
import { Audio, AVPlaybackStatus } from 'expo-av';

interface AudioSegment {
  id: string;
  audioUrl: string;
  duration: number;
  startTime?: number;
  sound?: Audio.Sound;
}

export class DuetPlayer {
  private segments: AudioSegment[] = [];
  private currentSegmentIndex = 0;
  private playbackStartTime = 0;
  private isPlaying = false;

  async loadChain(chain: Array<{ id: string; audioUrl: string; duration: number }>): Promise<void> {
    // Clean up existing sounds
    await this.cleanup();

    let cumulativeTime = 0;
    this.segments = chain.map(node => ({
      ...node,
      startTime: cumulativeTime,
      duration: node.duration,
    }));

    for (const segment of this.segments) {
      cumulativeTime += segment.duration;
    }
  }

  getTotalDuration(): number {
    return this.segments.reduce((sum, seg) => sum + seg.duration, 0);
  }

  async playFrom(position: number): Promise<void> {
    this.playbackStartTime = position;

    // Find which segment to start from
    let segmentIndex = 0;
    let segmentStartPosition = 0;

    for (let i = 0; i < this.segments.length; i++) {
      const segment = this.segments[i];
      if (position < (segment.startTime! + segment.duration)) {
        segmentIndex = i;
        segmentStartPosition = position - segment.startTime!;
        break;
      }
    }

    this.currentSegmentIndex = segmentIndex;
    await this.playSegmentChain(segmentIndex, segmentStartPosition);
  }

  private async playSegmentChain(startIndex: number, startPosition: number): Promise<void> {
    this.isPlaying = true;

    for (let i = startIndex; i < this.segments.length && this.isPlaying; i++) {
      const segment = this.segments[i];

      // Load the audio
      const { sound } = await Audio.Sound.createAsync(
        { uri: segment.audioUrl },
        {
          shouldPlay: true,
          positionMillis: i === startIndex ? startPosition * 1000 : 0,
        }
      );

      segment.sound = sound;

      // Set up completion listener for chaining
      sound.setOnPlaybackStatusUpdate((status: AVPlaybackStatus) => {
        if (status.isLoaded && status.didJustFinish) {
          // Move to next segment
          if (i < this.segments.length - 1) {
            this.currentSegmentIndex = i + 1;
          }
        }
      });

      // Wait for this segment to complete
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(async () => {
          const status = await sound.getStatusAsync();
          if (status.isLoaded && (status.didJustFinish || !this.isPlaying)) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
      });
    }

    this.isPlaying = false;
  }

  async getCurrentPosition(): Promise<number> {
    if (!this.isPlaying || this.currentSegmentIndex >= this.segments.length) {
      return 0;
    }

    const currentSegment = this.segments[this.currentSegmentIndex];
    if (currentSegment.sound) {
      const status = await currentSegment.sound.getStatusAsync();
      if (status.isLoaded) {
        return currentSegment.startTime! + (status.positionMillis / 1000);
      }
    }

    return currentSegment.startTime || 0;
  }

  async stop(): Promise<void> {
    this.isPlaying = false;

    for (const segment of this.segments) {
      if (segment.sound) {
        await segment.sound.stopAsync();
      }
    }
  }

  async cleanup(): Promise<void> {
    await this.stop();

    for (const segment of this.segments) {
      if (segment.sound) {
        await segment.sound.unloadAsync();
        segment.sound = undefined;
      }
    }

    this.segments = [];
  }

  getRecordingStartPoint(): number {
    // Return where the next recording should start (after all current segments)
    return this.getTotalDuration();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test --workspace=mobile -- duetPlayer.test.ts`
Expected: PASS (with mocked expo-av)

**Step 5: Commit**

```bash
git add mobile/services/duetPlayer.ts mobile/services/__tests__/duetPlayer.test.ts
git commit -m "feat: add duet playback service with audio chaining"
```

---

## Task 5: Simple Recording UI Components

**🤖 PARALLEL OPPORTUNITY - Can split into 2 agents after services complete:**
- **Agent 1:** Create RecordButton component
- **Agent 2:** Create DuetRecorder component and main app entry

### Files:
- Create: `mobile/components/RecordButton.tsx`
- Create: `mobile/components/DuetRecorder.tsx`
- Create: `mobile/app/index.tsx`

**Step 1: Create Record Button Component (Agent 1)**

File: `mobile/components/RecordButton.tsx`
```typescript
import React from 'react';
import { TouchableOpacity, Text, StyleSheet, ActivityIndicator } from 'react-native';

interface RecordButtonProps {
  isRecording: boolean;
  isLoading?: boolean;
  onPress: () => void;
}

export function RecordButton({ isRecording, isLoading, onPress }: RecordButtonProps) {
  return (
    <TouchableOpacity
      style={[styles.button, isRecording && styles.recording]}
      onPress={onPress}
      disabled={isLoading}
    >
      {isLoading ? (
        <ActivityIndicator color="white" />
      ) : (
        <Text style={styles.text}>
          {isRecording ? 'Stop' : 'Record'}
        </Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  recording: {
    backgroundColor: '#FF3B30',
  },
  text: {
    color: 'white',
    fontSize: 18,
    fontWeight: 'bold',
  },
});
```

**Step 2: Create Duet Recorder Component (Agent 2)**

File: `mobile/components/DuetRecorder.tsx`
```typescript
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Button, Alert } from 'react-native';
import { AudioRecorder } from '../services/audioService';
import { DuetPlayer } from '../services/duetPlayer';
import { RecordButton } from './RecordButton';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';

export function DuetRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [audioChain, setAudioChain] = useState<any[]>([]);
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);

  const recorder = useRef(new AudioRecorder());
  const player = useRef(new DuetPlayer());
  const recordingStartTime = useRef(0);

  useEffect(() => {
    initAudio();
    return () => {
      recorder.current.cleanup();
      player.current.cleanup();
    };
  }, []);

  async function initAudio() {
    try {
      await recorder.current.init();
    } catch (error) {
      Alert.alert('Error', 'Failed to initialize audio');
    }
  }

  async function startDuetRecording() {
    try {
      setIsLoading(true);

      // If we have a chain, start playback
      if (audioChain.length > 0) {
        await player.current.loadChain(audioChain);

        // Get where recording should start (end of current chain)
        recordingStartTime.current = player.current.getRecordingStartPoint();

        // Start playback from any point (for testing, start from beginning)
        player.current.playFrom(0);
        setIsPlaying(true);
      }

      // Start recording
      await recorder.current.startRecording();
      setIsRecording(true);
    } catch (error) {
      Alert.alert('Error', 'Failed to start recording');
    } finally {
      setIsLoading(false);
    }
  }

  async function stopDuetRecording() {
    try {
      setIsLoading(true);

      // Stop recording
      const uri = await recorder.current.stopRecording();
      setIsRecording(false);

      // Stop playback if playing
      if (isPlaying) {
        await player.current.stop();
        setIsPlaying(false);
      }

      // Calculate duration (approximate - in production use actual audio duration)
      const duration = Math.ceil((Date.now() - recordingStartTime.current) / 1000);

      // Upload to S3
      const key = await recorder.current.uploadRecording(uri, API_URL);

      // Save to database
      const saveResponse = await fetch(`${API_URL}/api/audio/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key,
          duration,
          parentId: currentNodeId,
        }),
      });

      const savedNode = await saveResponse.json();

      // Update chain and current node
      setAudioChain([...audioChain, savedNode]);
      setCurrentNodeId(savedNode.id);

      Alert.alert('Success', `Recording saved! Duration: ${duration}s`);
    } catch (error) {
      Alert.alert('Error', 'Failed to save recording');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRecordPress() {
    if (isRecording) {
      await stopDuetRecording();
    } else {
      await startDuetRecording();
    }
  }

  async function resetChain() {
    setAudioChain([]);
    setCurrentNodeId(null);
    await player.current.cleanup();
    Alert.alert('Reset', 'Starting fresh recording chain');
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Tap Story - Duet Mode</Text>

      <View style={styles.info}>
        <Text>Chain Length: {audioChain.length} segments</Text>
        {isPlaying && <Text style={styles.playing}>♫ Playing previous audio...</Text>}
      </View>

      <RecordButton
        isRecording={isRecording}
        isLoading={isLoading}
        onPress={handleRecordPress}
      />

      <View style={styles.controls}>
        <Button title="Reset Chain" onPress={resetChain} />
        {audioChain.length > 0 && (
          <Text style={styles.hint}>
            Recording will start at {player.current.getRecordingStartPoint()}s
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 30,
  },
  info: {
    marginBottom: 30,
    alignItems: 'center',
  },
  playing: {
    color: '#007AFF',
    marginTop: 10,
  },
  controls: {
    marginTop: 30,
    alignItems: 'center',
  },
  hint: {
    marginTop: 10,
    color: '#666',
    fontSize: 12,
  },
});
```

**Step 3: Create Main App Entry (Agent 2)**

File: `mobile/app/index.tsx`
```typescript
import React from 'react';
import { SafeAreaView, StyleSheet } from 'react-native';
import { DuetRecorder } from '../components/DuetRecorder';

export default function App() {
  return (
    <SafeAreaView style={styles.container}>
      <DuetRecorder />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
});
```

**Step 4: Add environment configuration**

File: `mobile/.env`
```
EXPO_PUBLIC_API_URL=http://localhost:3000
```

**Step 5: Commit**

```bash
git add mobile/components/RecordButton.tsx mobile/components/DuetRecorder.tsx mobile/app/index.tsx
git commit -m "feat: add MVP recording UI with duet functionality"
```

---

## Task 6: Database Migration & Testing

**⚠️ SEQUENTIAL - Final integration step**

### Files:
- Run migration
- Test the complete flow

**Step 1: Run database migration**

```bash
npm run migrate
```
Expected: Migration completes successfully

**Step 2: Start the backend server**

```bash
npm run dev:api
```
Expected: Server starts on port 3000

**Step 3: Start the mobile app**

```bash
npm run dev:mobile
```
Expected: Expo starts and shows QR code

**Step 4: Test the flow**

1. Open app on device/simulator
2. Press "Record" - should start recording
3. Press "Stop" - should save and show duration
4. Press "Record" again - previous audio should play while recording
5. Continue adding segments to test the chain

**Step 5: Verify in database**

```bash
npm run db:query
```
Expected: See AudioNode records with parent-child relationships

**Step 6: Final commit**

```bash
git add -A
git commit -m "feat: complete MVP audio recording with duet functionality"
```

---

## 🚀 PARALLEL AGENT EXECUTION SUMMARY

### Optimal Execution Strategy:

1. **Phase 1 (3 parallel agents):**
   - Agent 1: Task 1 - Backend S3 Service
   - Agent 2: Task 3 - Mobile Audio Recording Service
   - Agent 3: Task 4 - Duet Playback Service

2. **Phase 2 (sequential):**
   - Task 2 - Audio Upload API (depends on Task 1)

3. **Phase 3 (2 parallel agents):**
   - Agent 1: RecordButton component
   - Agent 2: DuetRecorder + App entry

4. **Phase 4 (sequential):**
   - Task 6 - Database Migration & Testing

**Total Time Savings:** ~40-50% compared to sequential execution

**Agent Dispatch Commands:**
```bash
# Phase 1 - Run in parallel
claude dispatch-agents \
  --agent1 "Implement Task 1: Backend S3 Upload Service" \
  --agent2 "Implement Task 3: Mobile Audio Recording Service" \
  --agent3 "Implement Task 4: Duet Playback Service"

# Phase 2 - Sequential
claude execute "Task 2: Audio Upload API Endpoint"

# Phase 3 - Run in parallel
claude dispatch-agents \
  --agent1 "Create RecordButton component" \
  --agent2 "Create DuetRecorder component and app entry"

# Phase 4 - Sequential
claude execute "Task 6: Database Migration & Testing"
```

---

## Testing Instructions

### Backend Testing
```bash
# Run all backend tests
npm run test --workspace=backend

# Test S3 integration (requires AWS credentials)
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test npm run test --workspace=backend -- s3Service
```

### Mobile Testing
```bash
# Run mobile tests
npm run test --workspace=mobile

# Test on iOS simulator
cd mobile && npm run ios

# Test on Android emulator
cd mobile && npm run android
```

### End-to-End Testing

1. **First Recording:**
   - Press Record
   - Speak for 5 seconds
   - Press Stop
   - Verify upload completes

2. **Duet Recording:**
   - Press Record again
   - Previous audio should play
   - Record beyond the first audio (create a "tail")
   - Press Stop
   - Verify chain saved

3. **Third Recording:**
   - Press Record
   - Both previous audios should play in sequence
   - Record from where first stopped
   - Verify branching works

---

## Production Considerations (Post-MVP)

1. **Security:**
   - Implement authentication
   - Restrict S3 bucket permissions
   - Add CORS configuration

2. **Performance:**
   - Implement audio compression
   - Add CDN for audio delivery
   - Cache presigned URLs

3. **Reliability:**
   - Add retry logic for uploads
   - Implement offline support
   - Add error recovery

4. **Features:**
   - Add waveform visualization
   - Implement proper audio duration detection
   - Add playback controls (pause, seek)
   - Support multiple branches from same parent