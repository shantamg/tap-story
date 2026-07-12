# Tap Story — Deep Investigation Findings

_99-agent adversarial audit (map → find → 2-vote verify). 59 confirmed, 7 refuted, 56 low-severity unverified._

## Confirmed findings (verified)

### [CRITICAL] Recorded take vanishes permanently on upload/save failure — no retry, no recovery
`mobile/components/DuetRecorderWithTrackPlayer.tsx:564` · data-loss

Screen context: the app has exactly one route, '/' (mobile/app/index.tsx), which renders DuetRecorderWithTrackPlayer; that god component fakes two screens via viewMode: 'list' (story list, '+ New Story') and 'detail' (timeline + cassette transport). In the detail flow, stopDuetRecording (lines 440-577) uploads and saves inline after every take. On ANY failure (offline, flaky network, backend down, S3 error), the catch block at 555-573 removes the optimistic temp segment from the chain (line 564: setAudioChain(prev => prev.filter(node => !node.id.startsWith('temp-')))) and shows only a small red text line. The recorded WAV still exists at tempUri on disk, but no code path ever resurfaces it — there is no retry button, no offline queue, no draft state. A musician who records an idea with no signal loses the take from the UI forever. This is the single biggest violation of the 'get an idea down in seconds' goal: the app cannot capture ideas without a live backend.

**Fix:** Keep the temp segment in the chain in an 'upload failed' state with a tap-to-retry affordance; persist pending uploads (tempUri + metadata) so takes survive app restarts. Recording locally should never depend on the network.
**Verifier fix sketch:** At stop-time, immediately move the WAV from the temp/cache dir into documentDirectory (reuse saveRecordingLocally keyed by the temp id) and persist the pending segment metadata (localUri, durationMs, startTimeMs, parentId) to AsyncStorage before attempting upload. On failure, keep the temp node in the chain flagged 'upload failed' with a tap-to-retry affordance that re-runs uploadRecording + save from the persisted local file; on app launch, rehydrate any persisted pending segments so takes survive restarts.

### [CRITICAL→high] Upload/save failure permanently discards a finished take: no durable copy, no retry, no offline queue
`mobile/components/DuetRecorderWithTrackPlayer.tsx:509` · data-loss

stopDuetRecording gets the finalized WAV (tempUri) from the native engine, then immediately does uploadRecording(tempUri) (line 509) -> POST /api/audio/save (line 517) -> saveRecordingLocally (line 528). If ANY of those fail (device offline, server 500, presign expiry, S3 PUT failure), the catch block (lines 555-573) removes the temp segment from the chain and shows 'Failed to finalize recording'. There is no retry button, no pending-upload persistence, and no reference kept to tempUri. The WAV exists only in OS-purgeable storage (iOS FileManager.default.temporaryDirectory per TapStoryAudioModule.swift:353, Android context.cacheDir per TapStoryAudioEngine.kt:312), so the OS may delete it at any time. saveRecordingLocally — the only copy into durable documentDirectory — runs only AFTER the server save succeeds, so recording with no network = total loss of the take. Grep confirms zero retry/offline-queue code anywhere in mobile/.

**Fix:** Immediately after native stop(), copy the WAV into documentDirectory (saveRecordingLocally under the temp id) and persist a pending-upload record (AsyncStorage). Upload from the durable copy with retry; rename/relink after save succeeds; delete only after confirmed server save.
**Verifier fix sketch:** Immediately after native stop(), copy the WAV into documentDirectory keyed by the temp segment id and persist a pending-upload record (AsyncStorage) with that durable path. Drive uploadRecording/save from the durable copy with retry, relink to the real node id on success, and delete the durable copy plus pending record only after the server save is confirmed; surface a retry affordance instead of discarding the temp node in the catch block.

### [HIGH] iOS arm-stage rejection code RECORD_START_ERROR missing from JS recoverable-error list, defeating the record-path retry after route changes
`mobile/services/audio/NativeDuetPlayer.ts:65` · contract-mismatch

NativeDuetPlayer.startTransportWithRetry only rebuilds the engine and retries when the rejection code is in RECOVERABLE_START_ERROR_CODES = ['PLAY_START_ERROR','PLAY_RECORD_START_ERROR','PLAY_ERROR','PLAY_RECORD_ERROR'] (lines 65-70; the comment claims 'iOS rejects with *_START_ERROR codes'). But on iOS, playAndRecord arms capture BEFORE starting the transport: TapStoryAudioModule.swift:206-219 calls engine.startRecording(toPath:startFrame:) and maps its failure to code 'RECORD_START_ERROR'; only the subsequent engine.start() failure produces 'PLAY_RECORD_START_ERROR' (lines 222-233). AudioEngineIOS.mm:630-633 makes startRecordingToPath fail immediately when _routeInvalidated is set, and _routeInvalidated is set by every routeChange/interruption/mediaServices notification (TapStoryAudioModule.swift:459-506). Concrete failure: user unplugs headphones or takes a call between takes -> engine invalidated -> next record press -> playAndRecord rejects RECORD_START_ERROR at the arm step -> isRecoverableStartError() is false -> cleanupFailedSession + rethrow, and the record attempt surfaces an error to the user. The identical staleness on the playback-only path rejects PLAY_START_ERROR (AudioEngineIOS.mm:519-527) and IS transparently recovered. The recovery mechanism built for exactly this scenario can never trigger for recording on iOS.

**Fix:** Add 'RECORD_START_ERROR' to RECOVERABLE_START_ERROR_CODES, or change TapStoryAudioModule.swift to reject arm failures with 'PLAY_RECORD_START_ERROR' so both stages of playAndRecord share one recoverable code (matching Android's single PLAY_RECORD_ERROR).
**Verifier fix sketch:** Either add 'RECORD_START_ERROR' to RECOVERABLE_START_ERROR_CODES in mobile/services/audio/NativeDuetPlayer.ts, or (cleaner) change the arm-stage reject in TapStoryAudioModule.swift:214 to use 'PLAY_RECORD_START_ERROR' so both stages of the single playAndRecord operation share one recoverable code, matching Android's single PLAY_RECORD_ERROR. Update the mock in mobile/services/audio/__tests__/NativeDuetPlayer.test.ts to throw the arm-stage code so the overdub-recovery test exercises the real iOS contract.

### [HIGH] Engine-rebuild retry silently drops latency compensation, producing mis-synced overdubs on Android
`mobile/services/audio/NativeDuetPlayer.ts:272` · bug

rebuildEngineForSession (used by startTransportWithRetry at lines 381/403 when playAndRecord/play rejects with PLAY_ERROR/PLAY_RECORD_ERROR after a route change) does cleanup -> initialize -> loadTracks, then retries the transport start. Android cleanup deletes the C++ engine (TapStoryAudioModule.kt:294-299 -> TapStoryAudioEngine.cleanup -> nativeDeleteEngine) and the fresh AudioEngine starts with mLatencyCompensationFrames{0} (AudioEngine.h:150). The compensation the recorder applied via configureLatencyCompensation (DuetRecorderWithTrackPlayer.tsx:302) is never re-applied. The retried take gates capture at requested+0 frames (AudioEngine.cpp:347-352), onset-exactness validation compares against the same uncompensated punch and passes (PunchCapture.h:61-65), and shouldDrainCaptureTail is false so the tail is also skipped. Result: a take late by the full route round-trip (typically 40-150ms on Android) is silently validated, saved, and uploaded — exactly the sync-error class this engine exists to prevent. iOS degrades gracefully (0 = automatic mode); Android has no automatic fallback. The retry tests (NativeDuetPlayer.test.ts:126-166) assert cleanup/initialize/loadTracks counts but never assert compensation re-application.

**Fix:** Record the last compensation configuration (overdub adjustmentMs or capture-only mode) on the player and re-run configureLatencyCompensation / configureCaptureOnlyLatencyCompensation inside rebuildEngineForSession after initialize(), before loadTracks. Add a test asserting setLatencyCompensationMs is re-applied on the rebuilt engine.
**Verifier fix sketch:** Record the last-applied compensation mode on NativeDuetPlayer (overdub adjustmentMs from configureLatencyCompensation, or capture-only mode) and re-invoke the matching nativeAudio.configureLatencyCompensation/configureCaptureOnlyLatencyCompensation inside rebuildEngineForSession after initialize() and before the retried transport start. Add a retry test asserting setLatencyCompensationMs (via configureLatencyCompensation) is called again on the rebuilt engine.

### [HIGH] Route-change retry rebuilds the native engine without re-applying latency compensation - retried Android overdub is silently misaligned
`mobile/services/audio/NativeDuetPlayer.ts:274` · bug

rebuildEngineForSession (lines 274-285) does cleanup() -> initialize() -> loadTracks(prepareNativeTracks()) and then startTransportWithRetry re-issues playAndRecord. But capture latency compensation is configured only once, by the component before playFrom (DuetRecorderWithTrackPlayer.tsx:300-302 configureLatencyCompensation, or configureCaptureOnlyLatencyCompensation inside startRecordingOnly). nativeAudio.cleanup() destroys the engine on both platforms (TapStoryAudioModule.kt:283-299 releaseAudioEngine sets audioEngine=null; a fresh Android AudioEngine has mLatencyCompensationFrames{0}, AudioEngine.h:150). So on Android the retried overdub records with 0 compensation frames: the capture gate equals the raw punch frame, the take is offset by the full input/round-trip latency (~20-80ms), and Android's onset-exactness validation passes because it validates against the engine's own (now zero) compensation - the misaligned take is saved silently. On iOS a fresh engine falls back to automatic route compensation (AudioEngineIOS.mm:262,276), so the user's manual LatencyNudge adjustment is silently dropped for the retried take.

**Fix:** In rebuildEngineForSession (or startTransportWithRetry), after initialize() re-run the same compensation setup the session started with: configureLatencyCompensation(adjustmentMs) for overdubs (store the last adjustment on the player) or configureCaptureOnlyLatencyCompensation() for capture-only sessions. This is also more correct after a route change since the route latency itself changed.
**Verifier fix sketch:** Store the last-applied compensation configuration on NativeDuetPlayer (e.g. lastCompensation = {mode: 'overdub', adjustmentMs} set in configureLatencyCompensation, or {mode: 'captureOnly'} set in startRecordingOnly), and in rebuildEngineForSession after initialize() re-run the matching nativeAudio.configureLatencyCompensation(adjustmentMs) / configureCaptureOnlyLatencyCompensation() before loadTracks — re-measuring is also more correct since the route latency itself changed. (Note: startRecordingOnly currently bypasses startTransportWithRetry, so only the overdub playFrom path needs it today.)

### [HIGH] Playback completion never reaches the component - UI wedges in 'playing' state after every playback reaches the end
`mobile/components/DuetRecorderWithTrackPlayer.tsx:656` · ux

When native playback reaches end-of-timeline, NativeDuetPlayer's 50ms monitor (NativeDuetPlayer.ts:432-448) sets its internal isPlaying=false, cancels the session and stops the native transport - but nothing notifies the component (native onPlaybackComplete is declared but never emitted, and NativeDuetPlayer exposes no completion callback). The component's startPositionTracking interval (tsx:661-666) only calls setCurrentPosition and never compares against total duration, so React state isPlaying stays true forever: the play button stays hidden (CassettePlayerControls.tsx:95), the stop button stays shown, the playhead freezes at the end (getCurrentPosition returns the cached position once the player's internal flags are false), and the 100ms component interval polls indefinitely. The user must press Stop, which then also snaps the playhead to 0. Same wedge for the DuetTrackPlayer/expo-av path (DuetTrackPlayer.ts:456-462 sets internal isPlaying=false with no notification).

**Fix:** Either have the component's position interval detect pos >= player.getTotalDuration() and reset isPlaying/stop tracking, or add an onComplete callback parameter to playFrom/startPositionMonitoring and invoke it from the end-of-timeline branch.
**Verifier fix sketch:** Add an optional onComplete callback to NativeDuetPlayer.playFrom/startPositionMonitoring (and DuetTrackPlayer's equivalent), invoked from the end-of-timeline branch after the transport stops; in the component pass a handler that clears the position interval, sets isPlaying=false, and leaves currentPosition at the end (or 0 per desired UX). Alternatively/additionally, have startPositionTracking's interval detect pos >= player.getTotalDuration() (or poll getPlaybackState() === 'stopped') and perform the same state reset as a belt-and-suspenders guard.

### [HIGH] Take lost permanently when POST /api/audio/save (or upload) fails after recording
`mobile/components/DuetRecorderWithTrackPlayer.tsx:564` · data-loss

In stopDuetRecording, the recording is only persisted locally (saveRecordingLocally, line 528) AFTER both uploadRecording (line 509) and the /save fetch (line 517) succeed. On any failure (network blip, backend 500, parent deleted concurrently -> 404), the catch block (lines 555-573) removes the optimistic temp node from the chain (`prev.filter(node => !node.id.startsWith('temp-'))`) and offers no retry. The captured WAV stays only at the native engine's temp path, unreachable from the UI, so the user's take is gone. If the failure was at /save, the audio was already uploaded to S3 and is now an orphaned object with no DB row.

**Fix:** Keep the temp segment in an 'upload failed' state with a retry action instead of dropping it; persist the take with saveRecordingLocally before attempting upload; consider a backend cleanup for orphaned S3 keys.
**Verifier fix sketch:** In stopDuetRecording, call saveRecordingLocally(tempUri, tempSegmentId) immediately after creating the temp node (audioStorage already resolves cached files by nodeId prefix), then on successful /save re-key the local file to savedNode.id; on failure, keep the temp segment in the chain marked 'upload failed' with a retry action that re-runs the uploadRecording + /save sequence, instead of filtering temp- nodes out. Optionally add backend cleanup (or S3 lifecycle rule) for uploaded keys never referenced by an AudioNode row.

### [HIGH] UI stuck in 'playing' state forever when playback reaches the end of the story
`mobile/services/audio/NativeDuetPlayer.ts:434` · bug

NativeDuetPlayer's position monitor auto-stops the transport at end of timeline (lines 432-448) but there is no completion callback to the component. DuetRecorderWithTrackPlayer's positionInterval (lines 661-666) only updates currentPosition; nothing ever sets isPlaying=false when playback finishes. Consequence every single time a user listens to a story to the end: the Play button stays hidden (CassettePlayerControls.tsx line 95 renders play only when !isPlaying), the Stop button remains, and the playhead freezes at the end. The user must press Stop — which also rewinds to 0 — before they can play again. Instant repro: press Fast-Forward (seeks to getTotalDuration, DuetRecorderWithTrackPlayer.tsx 647-654) then Play: the end-check fires immediately and the transport UI wedges. Core listen flow is broken on every playthrough.

**Fix:** Add an onPlaybackComplete callback from NativeDuetPlayer to the component (or have the component compare position >= totalDuration in its own interval) and reset isPlaying + show the Play button.
**Verifier fix sketch:** Have NativeDuetPlayer (and DuetTrackPlayer for parity) accept or emit an onPlaybackComplete callback fired in the end-of-timeline branch of startPositionMonitoring; in DuetRecorderWithTrackPlayer, wire it to setIsPlaying(false) and stop the position interval (leaving currentPosition at the end or resetting per desired UX). Alternatively, the component's positionInterval can poll player.getPlaybackState() and clear isPlaying when the player reports Stopped.

### [HIGH→medium] Entire UI blocks on network round-trip after every take (record/play/seek/Back all disabled)
`mobile/components/DuetRecorderWithTrackPlayer.tsx:442` · ux

stopDuetRecording sets isLoading=true at line 442 and only clears it in the finally at 575 — after presigned-URL fetch, S3 PUT of an uncompressed mono WAV (~5.5 MB/min at 48 kHz), POST /save, and local copy all complete. isLoading disables record (getCassetteControlAvailability), play, seek, and even the '< Back' button (line 790). The optimistic temp-segment pattern (lines 496-507, orange 'processing' color) is therefore pointless: the user can see the segment but can do nothing. None of the fetches has a timeout, so a hung request locks the whole detail screen indefinitely with no cancel and no spinner on the transport controls. A storyteller trying to rattle off consecutive ideas must wait out a full upload between takes.

**Fix:** Clear isLoading as soon as the recording file is finalized locally; let upload/save run in the background keyed off processingSegmentIds (which already exists), and only block re-recording onto the same slot if strictly necessary. Add fetch timeouts.
**Verifier fix sketch:** Clear isLoading (or never set it) once the local recording file is finalized and the optimistic temp node is added, then run uploadRecording/save/saveRecordingLocally in the background keyed off processingSegmentIds; guard only re-recording onto the in-flight slot if needed. Add AbortController-based timeouts to the fetch calls in uploadRecording and the /api/audio/save POST, and surface a transport-level spinner/cancel while a segment is processing.

### [HIGH] Failed segment download silently bricks the detail view: Play looks enabled but is dead forever
`mobile/components/DuetRecorderWithTrackPlayer.tsx:266` · bug

In loadChain, a failed downloadAndCacheAudio deliberately leaves the segment ID in downloadingSegmentIds ('Keep in downloading set to show error state', lines 260-264) while setIsDownloadingAudio(false) still runs at 266. From then on audioInteractionLocked stays true (audioInteractionState.ts line 21: downloadingSegmentCount > 0), so playFromPlayhead (line 678), handleSeek (725), handleSegmentTap (712) all early-return silently. But getCassetteControlAvailability (CassettePlayerControls.tsx lines 29-43) checks only the isDownloadingAudio boolean, not the count — so the Play button renders as enabled. No error message is ever set (setAudioError is never called in this path); the only visual is a gray segment that is indistinguishable from an in-progress download (no spinner, the 'Downloading N segments...' banner is gone because isDownloadingAudio is false). The user taps Play repeatedly, nothing happens, and the only escape is navigating back. One dropped request permanently disables listening in that story.

**Fix:** Represent failed downloads as a distinct error state with a retry tap on the segment; surface setAudioError; make getCassetteControlAvailability and isAudioInteractionLocked consume the same inputs so button visuals match actual gating.
**Verifier fix sketch:** On download failure, remove the ID from downloadingSegmentIds and track it in a separate failedSegmentIds state (distinct red/error segment style with a tap-to-retry that re-invokes downloadAndCacheAudio), and call setAudioError with a user-visible message. Pass downloadingSegmentCount (and failed count) into getCassetteControlAvailability — or derive both it and isAudioInteractionLocked from one shared input object — so button enablement always matches the actual interaction gating.

### [HIGH→medium] Tapping a story that fails to load does nothing — no error, no loading indicator in list view
`mobile/components/DuetRecorderWithTrackPlayer.tsx:269` · ux

loadChain's catch (lines 269-275) only console.errors and resets download state; setViewMode('detail') at 242 is only reached on success, and setAudioError is never called. If GET /api/audio/tree/:id fails, the tap on a story in the list is a complete no-op from the user's perspective. Compounding this, the list view render (lines 760-784) uses only isLoadingChains — the isLoading flag set at line 209 during loadChain is not rendered anywhere in list view, so even the successful path gives zero feedback (no spinner, no pressed state beyond activeOpacity) between tap and the jump to detail. On a slow connection the app looks frozen/dead.

**Fix:** Show a loading overlay or per-row spinner while loadChain runs, and surface an error toast/banner with retry when it fails.
**Verifier fix sketch:** In loadChain's catch, call setAudioError('Failed to load story') and render an error banner (with retry) in the list-view branch; track the in-flight chain id (e.g., loadingChainId state) and pass it to SavedChainsList to show a per-row ActivityIndicator and disable row presses while loading. Severity downgraded to medium: silent and confusing, but no crash or data loss and retrying the tap recovers.

### [HIGH→medium] Network failure on the story list masquerades as 'No saved stories yet'
`mobile/components/DuetRecorderWithTrackPlayer.tsx:161` · ux

fetchSavedChains' catch (lines 161-165) only logs; savedChains remains [], and SavedChainsList renders the genuine empty state (SavedChainsList.tsx lines 141-148: 'No saved stories yet / Record your first story to get started!'). A user whose backend is unreachable — including anyone running a production build with no EXPO_PUBLIC_API_URL, where getApiUrl() silently falls back to http://localhost:3000 (mobile/utils/api.ts lines 27-39) — is told they have no stories. For a collaboration product this reads as 'my partner's recordings were deleted'. There is also no retry affordance (see the dead onRefresh finding).

**Fix:** Track a fetch-error state separately from an empty result; render an error message + Retry button. Fail loudly when the API URL falls back to localhost on a device build.
**Verifier fix sketch:** Add a distinct fetch-error state (e.g. chainsError) set in fetchSavedChains' catch and cleared on success; pass it to SavedChainsList so it can render an error message plus a Retry button wired to onRefresh (currently dead) instead of the empty state. Separately, make getApiUrl fail loudly (or surface a banner) when it falls back to localhost on a device build so misconfiguration is visible.

### [HIGH→medium] No way to cancel/discard a take, and no way to delete just the last segment
`mobile/components/DuetRecorderWithTrackPlayer.tsx:632` · ux

Once recording has started, both stop affordances save unconditionally: handleRecordPress (lines 579-586) toggles into stopDuetRecording, and handleStopButton (632-640) routes isRecording to the same stopDuetRecording, which always uploads and appends the take to the story. There is no 'discard take' path. The only deletion in the app is long-press on a whole story in the list (SavedChainsList.tsx line 201 → confirm modal), and the backend deletes the leaf-exclusive suffix — for a linear story that is the entire story. So a fumbled take permanently pollutes the story: the user's only options are to keep it or destroy everything. For rapid idea capture, one bad take should be a one-tap discard.

**Fix:** Make the Stop button during recording offer save/discard (or add an explicit 'undo last take' that deletes the leaf node — the backend DELETE /chain/:id already supports leaf deletion).
**Verifier fix sketch:** Add a client-side discard path in stopDuetRecording: on a "discard" action, skip uploadRecording/POST /save and drop the temp node rather than persisting it — no backend change needed. Present save-vs-discard on the Stop button while isRecording (or add an "undo last take" that removes the just-appended leaf), keeping in mind that DELETE /chain/:leafId on a linear story removes the whole suffix, so single-segment undo may need a dedicated single-node delete endpoint.

### [HIGH→medium] Disabled transport controls are visually identical to enabled ones; taps die silently
`mobile/components/CassettePlayerControls.tsx:106` · ux

All five transport TouchableOpacities (lines 75-126) receive disabled={...} but no disabled styling — React Native's TouchableOpacity applies no visual change when disabled. A disabled Play (no audio / loading / downloading) or Record (waiting/downloading) button looks exactly like an enabled one; the user taps and nothing happens with no feedback. Same pattern in LatencyNudge.tsx (lines 20-58: disabled prop, no style change). Additionally handleRecordPress (DuetRecorderWithTrackPlayer.tsx line 580) has its own silent early-return guard (isLoading || processingSegmentIds.size || isWaitingToRecord), so even taps that get through the Touchable can be dropped without any indication. The most important affordance in the app — 'can I record right now?' — is unreadable.

**Fix:** Add opacity/color changes for disabled states (e.g., 0.4 opacity) and consider a brief haptic/toast when a locked control is tapped explaining why.
**Verifier fix sketch:** Add disabled-conditional styling to the button style arrays in both components (e.g. push a { opacity: 0.4 } style when the corresponding *Disabled flag or the `disabled` prop is true), so locked controls read as unavailable. Optionally add a haptic or toast on a blocked tap explaining why, and convert the silent early-return in handleRecordPress into that same feedback path.

### [HIGH→medium] AnimatedSegment declared inside AudioTimeline render: segments remount 10x/sec during playback, swallowing taps and killing animations
`mobile/components/AudioTimeline.tsx:252` · bug

AnimatedSegment is a React.memo component defined inside the AudioTimeline function body (lines 252-354). Its type identity changes on every parent render, so React unmounts and remounts every segment subtree each render. AudioTimeline re-renders every 100ms during playback (currentTimelinePosition prop tick from the recorder's positionInterval), so all segments are torn down and rebuilt ~10 times per second: the 300ms withTiming glow (lines 280-283) never completes (the 'currently playing' highlight effectively never animates in), and an in-progress press on a segment's TouchableOpacity is destroyed mid-gesture — tap-to-play-a-segment during playback is unreliable. Also a per-frame perf drain (new shared values + styles per segment per tick).

**Fix:** Hoist AnimatedSegment to module scope and pass everything via props; memoize on stable props.
**Verifier fix sketch:** Hoist AnimatedSegment to module scope (outside AudioTimeline) so its type identity is stable, passing everything it needs via props (segment, width, left, isPlaying, onSegmentTap, processing/downloading flags, recordingDuration); keep the React.memo with a props-based comparator. Then React reconciles/updates segments in place instead of remounting, letting the withTiming glow run and preserving in-progress touches.

### [HIGH→medium] No punch-in affordance during overdub pre-roll: user can't tell when recording actually starts
`mobile/components/DuetRecorderWithTrackPlayer.tsx:319` · ux

Adding to an existing story starts playback 1.0s before the punch point (line 319: seekPosition = max(0, logicalStartTime - 1.0)) and arms recording. During isWaitingToRecord the ONLY cue is the record button turning orange, and at the punch the only cue is orange→red plus a small 'Recording...' text appearing. There is no count-in, no countdown, and no punch-in marker on the timeline: AudioTimeline receives isWaitingToRecord and recordingStartTime but renders no waiting indicator — isWaitingToRecord's only use is the dead clamp in calculatePosition (lines 143-145; unreachable because handleSeek/handleSeekPreview early-return on audioInteractionLocked upstream, DuetRecorderWithTrackPlayer.tsx 717/725, which includes isWaitingToRecord). A storyteller listening to the last second of the previous take can easily start speaking before the punch and lose their opening words — directly hitting the core capture flow.

**Fix:** Draw the punch-in point on the timeline while waiting, show a ghost 'recording will start here' segment, and consider a visual 3-2-1 or growing progress toward the punch.
**Verifier fix sketch:** In AudioTimeline, when isWaitingToRecord is true, draw a punch-in marker at recordingStartTime (a vertical line plus a ghost 'recording starts here' segment) using the props it already receives, and in DuetRecorderWithTrackPlayer's status block add an isWaitingToRecord branch showing a countdown or 'Get ready...' cue. Optionally add a 3-2-1 count-in derived from currentPosition approaching recordingStartTime.

### [HIGH] Android: any audio-device hotplug mid-take poisons the engine and deletes the recording
`mobile/android/app/src/main/java/com/tapstory/audio/TapStoryAudioModule.kt:327` · data-loss

AudioDeviceCallback (lines 35-43) fires invalidateIfDeviceSetChanged() on ANY change to GET_DEVICES_ALL (line 342) — including devices that are not part of the active route (e.g. a Bluetooth speaker in the room auto-connecting, or a USB-C accessory being plugged in while recording through the built-in mic). invalidateAudioRoute() -> AudioEngine::invalidateAudioRoute (AudioEngine.cpp:499) sets mLastStreamError=-1003; TapStoryAudioEngine.stopRecording then hits streamError != 0 (TapStoryAudioEngine.kt:253) and does rawFile.delete() + throw. A user 4 minutes into a story whose earbuds happen to connect loses the entire take with no salvage.

**Fix:** Only invalidate when the device set change actually affects the routed input/output device (compare routed device ids, not the full device set), and on invalidation finalize/salvage the raw PCM captured so far instead of deleting it.
**Verifier fix sketch:** Compare only the actively-routed input/output device ids (e.g. from the Oboe streams' getDeviceId, or the recording route) instead of the full GET_DEVICES_ALL set, so ambient device hotplugs that don't change the active route don't invalidate. And on a genuine mid-take invalidation, finalize the already-captured raw PCM to WAV (salvage) rather than deleting it; reserve delete-and-throw for cases where the captured buffer is truly unusable.

### [HIGH] iOS: every routeChange/interruption notification discards the in-flight take; notification reason never inspected
`mobile/ios/TapStory/TapStoryAudioModule.swift:459` · data-loss

startAudioSessionObservers subscribes to routeChangeNotification, interruptionNotification, and both mediaServices notifications (lines 459-469) and schedules invalidation unconditionally — the notification's reason/type payload is never examined. invalidateAudioSessionOnControlQueue (lines 501-506) calls engine.invalidateAudioRoute + stop + stopRecording; AudioEngineIOS.invalidateAudioRoute (AudioEngineIOS.mm:873-886) sets _captureRouteInvalidated whenever capture is armed, so the module's next stopRecording rejects CAPTURE_ROUTE_CHANGED and discardRawRecording() deletes the file (lines 288-295). An incoming call ringing (interruption began), a routeChange with reason .categoryChange caused by another app, or even the tail of the same take triggers total deletion of everything captured so far.

**Fix:** Inspect AVAudioSessionRouteChangeReason / interruption type and ignore changes that do not alter the active input/output ports; on genuine invalidation, finalize the raw PCM up to the event and return it flagged as degraded rather than deleting it.
**Verifier fix sketch:** In the notification closures, read the payload: for interruptionNotification act only on genuine begin/end transitions, and for routeChangeNotification read AVAudioSessionRouteChangeReasonKey and ignore reasons that don't alter the active input/output ports (compare against the previous route). On a genuine invalidation, finalize the raw PCM captured up to the event (truncate to the recorded span) and return it flagged as degraded instead of calling discardRawRecording().

### [MEDIUM→low] DuetTrackPlayer drops the punch callback when native compensation >= 100ms
`mobile/services/audio/DuetTrackPlayer.ts:373` · bug

The onRecordingStarted validity check is Math.abs(event.actualStartMs - this.pendingCallbackTimeMs) < 100. Both native engines report actualStartMs as the compensated capture-gate time (requested + latencyCompensation): Android TapStoryAudioEngine.kt:207, iOS TapStoryAudioModule.swift:187. The difference therefore equals the compensation exactly. With a manual override up to 1000ms (clamped [1,1000] in getAdjustedLatencyCompensationMs) or the +200ms Bluetooth path this same class enables, compensation >= 100ms makes the listener silently ignore the event, onReachTime() never fires, and the UI stays in 'waiting to record' forever while native capture is already running. Same latency as finding 1: dead in the current recorder wiring, live for any direct consumer of DuetTrackPlayer's native path.

**Fix:** Compare against the compensated expectation (pendingCallbackTimeMs + appliedCompensationMs) or drop the heuristic entirely and trust the one-shot listener like NativeDuetPlayer does.
**Verifier fix sketch:** In DuetTrackPlayer's onRecordingStarted listener, stop comparing the compensated actualStartMs against the raw requested time: either trust the one-shot listener unconditionally like NativeDuetPlayer does (remove the heuristic and just fire onReachTime once), or compare against the compensated expectation — e.g. use the iOS event's alignedStartMs / Android's requested punch time, or query the engine's applied compensation and check Math.abs(actualStartMs - (pendingCallbackTimeMs + compensationMs)) < tolerance.

### [MEDIUM] iOS loadTracks converts startTimeMs and sample count through trapping Int32 initializers - crash instead of rejection
`mobile/ios/TapStory/TapStoryAudioModule.swift:106` · bug

startFrame = Int32((startTimeMs * targetSampleRate / 1000).rounded()) and numSamples: Int32(pcm.count) use Swift's trapping Int32(Double)/Int32(Int) initializers, while every other timeline value in the module is Int64 (play:135, playAndRecord:178-179). The backend explicitly permits startTimeMs up to 2_147_483_647 ms (~24.8 days, audioRoutes.ts:141,165); at a 48kHz route any track whose canonical start exceeds ~12.43h (2^31 frames) makes the conversion overflow and fatalError - a hard app crash inside a promise-based bridge method rather than a TRACK_DECODE_ERROR rejection. The engine's own loadTrackWithId also takes int32 startFrame/numSamples (AudioEngineIOS.mm:484-487), so the narrowing is systemic on iOS; Android uses jlong/Int64 throughout.

**Fix:** Widen the ObjC loadTrackWithId signature to int64_t startFrame/numSamples and use Int64 conversions in Swift, or reject tracks whose computed startFrame exceeds Int32.max before converting.
**Verifier fix sketch:** Widen loadTrackWithId to int64_t startFrame (and int64_t numSamples, or keep int32 with a pre-check) in AudioEngineIOS.h/.mm — the engine already stores startFrame as int64_t so this is a signature-only change — and use Int64 conversions in Swift. Additionally guard in loadTracks that startTimeMs is finite, non-negative, and the computed frame fits the target type, rejecting the promise with TRACK_DECODE_ERROR (or a dedicated code) instead of trapping.

### [MEDIUM→low] pause/resume: JS calls native methods iOS never exports; resume silently no-ops and corrupts player state
`mobile/services/audio/TapStoryNativeAudio.ts:461` · contract-mismatch

TapStoryAudioModule.m exports no pause or resume method (10 methods total). TapStoryNativeAudio.pause() (lines 439-450) silently falls back to nativeModule.stop() -- a full transport stop, not a pause -- and resume() (lines 455-465) just console.warns and resolves successfully. NativeDuetPlayer.play() (NativeDuetPlayer.ts:478-490) then sets isPlaying = true and starts the 50ms position monitor against a stopped native transport: getCurrentPositionMs stays frozen, getPlaybackState() reports 'playing' forever, and the end-of-timeline auto-stop (currentPos >= totalDuration, line 434) never fires. Concrete failure: any caller doing pause() then play() (e.g. useDuetPlayback.ts:146) leaves the app claiming playback is running while audio is stopped, with no way to detect it. Not reached by DuetRecorderWithTrackPlayer today (it only uses playFrom/stop), so latent rather than main-flow.

**Fix:** Either export pause/resume from the iOS module (the engine's stop/start with preserved frame position already supports it), or make TapStoryNativeAudio.resume() reject when the native method is absent so NativeDuetPlayer.play() cannot mark itself playing.
**Verifier fix sketch:** Make TapStoryNativeAudio.resume() reject (instead of console.warn + resolve) when nativeModule.resume is absent, so NativeDuetPlayer.play() cannot mark isPlaying=true against a stopped transport; optionally do the same for pause()'s stop() fallback. Longer term, export pause/resume from both native modules — the iOS engine already preserves _currentFrame across stop/start, so pause = AudioOutputUnitStop and resume = restart at the preserved frame.

### [MEDIUM→low] seekTo: neither platform exports the native method; JS resolves a seek that never happened
`mobile/services/audio/NativeDuetPlayer.ts:553` · contract-mismatch

NativeDuetPlayer.seekTo (lines 549-554) awaits TapStoryNativeAudio.seekTo (TapStoryNativeAudio.ts:424-434), which finds nativeModule.seekTo undefined on iOS (TapStoryAudioModule.m exports no seekTo, even though the engine implements seekToFrame: per AudioEngineIOS.h:93), logs a console.warn, and resolves successfully. NativeDuetPlayer updates only its local currentPositionMs. Concrete failure: seekTo during active playback -- the native transport keeps playing from the old position and the 50ms position monitor (lines 427-429) overwrites the local value, so the seek silently evaporates while the caller's promise resolved as success. While stopped, the local value masks that native never moved (playFrom re-seeks via play(), which is why the shipped component -- which implements seeking through playFrom, not player.seekTo -- doesn't hit this). useDuetPlayback.ts:163-166 exposes seekTo publicly.

**Fix:** Export seekTo:(double) from the iOS module wired to engine.seekToFrame (engine allows seek only while stopped, so reject or stop first when running), or make TapStoryNativeAudio.seekTo reject when unimplemented instead of resolving.
**Verifier fix sketch:** Either implement the export on both platforms — iOS: add RCT_EXTERN_METHOD(seekTo:(double)positionMs resolver:rejecter:) plus a Swift @objc seekTo wired to engine.seek(toFrame:) that stops (or rejects) when the transport is running per AudioEngineIOS.mm:786; Android: add a @ReactMethod seekTo delegating to nativeSeekToFrame — or, minimally, make TapStoryNativeAudio.seekTo reject with an UNIMPLEMENTED error instead of warn-and-resolve, and remove the optional `seekTo?` from the module interface once implemented.

### [MEDIUM] startRecordingOnly bypasses startTransportWithRetry — first-take record press fails once after any route change
`mobile/services/audio/NativeDuetPlayer.ts:618` · contract-mismatch

startRecordingOnly calls this.nativeAudio.playAndRecord(0, 0, cb) directly instead of wrapping it in startTransportWithRetry like playFrom does (lines 381/403). After AudioDeviceCallback poisons the engine (-1003 via TapStoryAudioModule.kt:321-338 / AudioEngine.cpp:499-503), nativeStartRecording returns false, TapStoryAudioEngine.kt:161-163 throws 'Failed to arm native recording', the module rejects PLAY_RECORD_ERROR — a code explicitly listed in RECOVERABLE_START_ERROR_CODES (line 65-70) — but no rebuild/retry happens; cleanupFailedSession runs and the user sees an error. Plugging/unplugging headphones before recording the first segment makes the record button fail once, then work on the second press.

**Fix:** Wrap the playAndRecord call in startTransportWithRetry (the rebuild must also re-run configureCaptureOnlyLatencyCompensation, see the compensation-loss finding).
**Verifier fix sketch:** Wrap the playAndRecord call in startRecordingOnly with startTransportWithRetry, using a start closure that re-runs configureCaptureOnlyLatencyCompensation before playAndRecord (or extend rebuildEngineForSession to re-apply capture-only compensation for capture sessions), since rebuildEngineForSession only reloads tracks and a fresh engine has zero compensation. segments is [] in this path so the rebuild's prepareNativeTracks/loadTracks already does the right thing.

### [MEDIUM→low] Stale onRecordingStarted from an interrupted notifier thread can fire the next take's punch callback early
`mobile/android/app/src/main/java/com/tapstory/audio/TapStoryAudioEngine.kt:207` · race

startRecordingStartNotifier (lines 201-217) polls nativeGetRecordingStartFrame every 2ms and calls onRecordingStarted once it is >= 0. Thread.interrupt() (stopRecording:235, cleanup:386) only takes effect at the loop condition or sleep; a thread that already passed the '>= 0' check still emits the event. If take N's notifier is preempted between the check and sendEvent, the stale event can arrive at JS after take N+1 registered its one-shot listener (TapStoryNativeAudio.ts:244-255, which consumes the FIRST onRecordingStarted regardless of origin — the payload carries no take identifier). NativeDuetPlayer's callback (lines ~382-393) sees an active session, marks captureStarted, stores a stale recordingStartPositionMs, and fires onReachTime() — the recorder UI flips to 'recording' before the real punch, and the genuine event later finds no pending listener.

**Fix:** Include a take/generation counter in the onRecordingStarted payload (incremented per nativeStartRecording) and have JS discard events whose generation does not match the in-flight playAndRecord call.
**Verifier fix sketch:** Add a generation counter in TapStoryAudioEngine incremented on each playAndRecord, pass it into the notifier closure and include it in the onRecordingStarted payload (TapStoryAudioModule.kt); have playAndRecord resolve the current generation to JS (or expose it via the module) and make TapStoryNativeAudio's one-shot listener discard events whose generation does not match the in-flight call. While there, guard the notifier's emission against sampleRate == 0 (cleanup() zeroes it, making line 207 a potential divide-by-zero crash in the same window).

### [MEDIUM] Divide-by-zero crash race: notifier thread divides by sampleRate that cleanup() zeroes
`mobile/android/app/src/main/java/com/tapstory/audio/TapStoryAudioEngine.kt:207` · race

The notifier computes actualStartFrame * 1000L / sampleRate. cleanup() interrupts the notifier at line 386 and then sets sampleRate = 0 at line 389, but a notifier thread that read actualStartFrame >= 0 just before cleanup ran is immune to the interrupt (it is past the loop condition) and, when rescheduled after 'sampleRate = 0', throws ArithmeticException (Long division by zero) on a raw background thread. An uncaught exception on a plain Thread crashes the Android app. Trigger window: JS cleanup (goBackToList, component unmount, or cleanupFailedSession) landing within milliseconds of the punch instant. getCurrentPositionMs guards sampleRate <= 0 (line 220) but the notifier does not.

**Fix:** Snapshot sampleRate into a local val when the notifier thread is created, or guard the division with a sampleRate > 0 check and exit the thread otherwise.
**Verifier fix sketch:** Snapshot the rate into a local before spawning the thread — val rate = sampleRate — and use it in the division (it is immutable for the engine's initialized lifetime), or inside the loop read val rate = sampleRate and return@Thread if rate <= 0. Additionally, join the notifier thread (or guard native access) in cleanup() before nativeDeleteEngine(), since the same window lets the notifier call nativeGetRecordingStartFrame() on a deleted engine.

### [MEDIUM] No JS event on route invalidation — user keeps 'recording' into a dead engine and loses the take only at stop
`mobile/android/app/src/main/java/com/tapstory/audio/TapStoryAudioModule.kt:321` · ux

invalidateAudioRoute() (fed by AudioDeviceCallback on any device-set change, lines 35-43/327-338) poisons the native engine (-1003) and stops the streams, but emits no event to JS. During a take, NativeDuetPlayer keeps isRecording=true, the recorder's duration counter keeps incrementing (Date.now interval in DuetRecorderWithTrackPlayer.tsx actuallyStartRecording), and position polls return a frozen frame. Only when the user presses stop does stopRecording throw (streamError -1003 -> STOP_RECORD_ERROR) and the entire take is discarded. Unplugging headphones 30 seconds into a 3-minute take silently wastes the remaining performance with no immediate feedback. The take discard itself is by design (fail-closed); the missing immediate notification is the defect. Same gap exists on iOS per the ios-native map.

**Fix:** Emit an 'onRouteInvalidated' (or reuse onPlaybackComplete with an error payload) event from invalidateAudioRoute; have NativeDuetPlayer cancel the session and surface the error immediately.
**Verifier fix sketch:** In TapStoryAudioModule.kt, emit a new "onRouteInvalidated" event from invalidateAudioRoute() (and mirror in TapStoryAudioModule.swift's invalidateAudioSessionOnControlQueue, adding it to supportedEvents). Subscribe in TapStoryNativeAudio and expose a callback that NativeDuetPlayer uses to cancel the active session, clear isRecording/isPlaying, and reject/notify so DuetRecorderWithTrackPlayer can stop the duration counter and show the route-change error immediately.

### [MEDIUM] isBluetoothConnected checks only OUTPUT devices — Bluetooth-input routes pass the overdub gate
`mobile/android/app/src/main/java/com/tapstory/audio/TapStoryAudioModule.kt:435` · bug

The device scan uses AudioManager.GET_DEVICES_OUTPUTS plus isBluetoothA2dpOn (output-side). A route whose capture side is Bluetooth (BT/BLE microphone, hearing aid, SCO input while output is speaker) is not detected, so TapStoryNativeAudio.configureLatencyCompensation's Android BT rejection (lines 295-303) passes and an overdub records through a variable-latency BT mic — the exact variability the gate exists to reject. The compensated punch validation cannot catch this because the BT buffering is invisible to timeline-frame accounting. The method's own doc comment ('Bluetooth adds 150-300ms of transmission lag that must be compensated', line 422) also contradicts the reject-Bluetooth contract.

**Fix:** Scan GET_DEVICES_ALL (or additionally GET_DEVICES_INPUTS) and include TYPE_BLUETOOTH_SCO/TYPE_BLE_HEADSET input types; fix the comment to state BT is rejected, not compensated.
**Verifier fix sketch:** In TapStoryAudioModule.kt isBluetoothConnected, scan audioManager.getDevices(AudioManager.GET_DEVICES_ALL) (matching currentAudioDeviceIds at line 342) and add TYPE_HEARING_AID to the checked types alongside TYPE_BLUETOOTH_A2DP/SCO and TYPE_BLE_HEADSET/SPEAKER; update the doc comment at lines 420-423 to state that Bluetooth routes are rejected for synchronized overdubs (the compensation wording only applies to the legacy DuetTrackPlayer consumer).

### [MEDIUM→low] seekTo/pause/resume silently no-op on Android; pause then play() strands the player in a fake 'playing' state
`mobile/services/audio/TapStoryNativeAudio.ts:432` · contract-mismatch

The Android module exposes no seekTo, pause, or resume @ReactMethods. TapStoryNativeAudio.seekTo logs a warning and no-ops (line 432); pause() falls back to a full native stop (lines 447-449); resume() warns and no-ops (line 463). NativeDuetPlayer.pause() (line 467) therefore stops the native transport, and NativeDuetPlayer.play() (line 484) 'resumes' via the no-op, then sets isPlaying = true and starts position monitoring against a stopped engine — position freezes and the 50ms interval spins indefinitely (auto-stop requires currentPos >= totalDuration, which never advances). Currently latent: DuetRecorderWithTrackPlayer implements seek as stop()+playFrom() and never calls pause/play(resume)/seekTo — but these are exported public methods of the active player class (services/audio/index.ts).

**Fix:** Either implement seekTo/pause/resume as @ReactMethods on Android (the engine already supports nativeSeekToFrame and stop/start), or remove/throw from the JS methods so callers cannot silently diverge from native state.
**Verifier fix sketch:** Implement pause/resume/seekTo as real native methods on both platforms (Android already has nativeSeekToFrame and stop/start; pause = stop stream preserving mCurrentFrame, resume = restart from current frame), or implement them JS-side in NativeDuetPlayer as stop-remembering-position / playFrom(rememberedPosition), or make TapStoryNativeAudio throw when the native method is absent so callers cannot silently diverge. Note the fix must cover iOS too, not just Android as the report suggests.

### [MEDIUM] Upload/save failure permanently discards the recorded take - WAV never persisted locally and no retry path
`mobile/components/DuetRecorderWithTrackPlayer.tsx:555` · data-loss

stopDuetRecording only persists the recording via saveRecordingLocally after the network save succeeds (tsx:528). If uploadRecording (tsx:509) or the POST /api/audio/save (tsx:517-525) fails - a routine event on mobile networks - the catch block (tsx:555-573) removes the optimistic temp node from the chain and clears processing state, leaving only an error banner. The WAV still exists at the native temp path (tempUri) but nothing references it and there is no retry, so the user's take is unrecoverable from the UI; they must re-record the entire segment.

**Fix:** On failure, keep the temp node in a 'failed, tap to retry upload' state (the local tempUri is still playable), or at minimum copy the file into the audio cache before attempting upload.
**Verifier fix sketch:** On catch, keep the temp node in the chain with a 'failed' status (it already carries recordingUri: tempUri, which remains playable) and render a tap-to-retry affordance that re-runs the upload + save + saveRecordingLocally sequence for that node. Additionally, copy the take into the permanent audio directory (e.g., saveRecordingLocally(tempUri, tempSegmentId)) before starting the upload so the file survives OS temp-dir cleanup, then rename/re-key it to the server node id on success.

### [MEDIUM] A failed segment download locks all interactions forever while the Record button stays enabled - inconsistent gating matrix
`mobile/components/DuetRecorderWithTrackPlayer.tsx:260` · ux

In loadChain, a failed downloadAndCacheAudio deliberately leaves the segment id in downloadingSegmentIds (tsx:260-263 'Keep in downloading set to show error state') while setIsDownloadingAudio(false) still runs (tsx:266). isAudioInteractionLocked treats downloadingSegmentCount>0 as locked (audioInteractionState.ts:20), so play/seek/segment-tap/fast-forward silently no-op forever for that chain view, with no retry mechanism (only leaving to the list and reloading resets the set). Meanwhile getCassetteControlAvailability ignores downloadingSegmentCount and processingSegmentCount entirely (CassettePlayerControls.tsx:38-42), so the Record and Play buttons render enabled: Play taps do nothing (playFromPlayhead checks audioInteractionLocked, tsx:678), and Record bypasses download state completely (handleRecordPress checks neither, tsx:580) so recording can start over a chain with missing audio (loadChain will retry the download inside prepareNativeTracks and may throw mid-flow).

**Fix:** Clear the id from downloadingSegmentIds on failure and track failed ids separately with a retry affordance; make getCassetteControlAvailability and isAudioInteractionLocked consume the same inputs so button enablement matches handler guards.
**Verifier fix sketch:** On download failure, delete the id from downloadingSegmentIds and add it to a new failedSegmentIds set rendered as an error state with a tap-to-retry affordance (re-running downloadAndCacheAudio for just that segment). Unify the gating: have getCassetteControlAvailability accept downloadingSegmentCount and processingSegmentCount (or derive both button disabled-ness and handler guards from the same isAudioInteractionLocked result) so button enablement always matches the handler guards, and add the downloading/failed check to handleRecordPress.

### [MEDIUM] Stop pressed during startDuetRecording's 'already playing' branch is overtaken - recording starts despite the user cancelling
`mobile/components/DuetRecorderWithTrackPlayer.tsx:362` · race

Branch 3 of startDuetRecording sets setIsWaitingToRecord(true) and setIsLoading(false) (tsx:365-366) and then performs several awaited bridge calls (getCurrentPosition tsx:368, player.stop() tsx:372) BEFORE calling playFrom (tsx:373). During that window the UI shows the waiting state with the Stop button enabled (stopDisabled=isLoading only). If the user presses Stop then, stopPlayback runs player.stop() (cancelling only the old playback session) and resets isWaitingToRecord - but the in-flight startDuetRecording continues and its playFrom creates a NEW session afterwards, so preroll runs, the punch fires, and actuallyStartRecording flips the UI back into recording. The user's Stop is silently overridden. (Branches 1/2 are safe because beginSession runs synchronously inside playFrom in the same tick as the state updates.)

**Fix:** Track an intent-generation counter: stopPlayback increments it, and startDuetRecording re-checks it before each transport call (especially before playFrom), aborting if a stop superseded it.
**Verifier fix sketch:** Add a transport-epoch ref: stopPlayback increments it; startDuetRecording captures the epoch on entry and re-checks it after every await in branch 3 (at minimum immediately before player.current.playFrom at line 373), bailing out (leaving states reset by stopPlayback) if a stop superseded it. Alternatively keep isLoading=true (Stop disabled) until after the awaited getCurrentPosition/stop calls so the waiting UI only appears once playFrom has synchronously begun its session.

### [MEDIUM] Concurrent downloads of the same node collide on a shared .download temp path (double-tap a story)
`mobile/services/audioStorage.ts:152` · race

downloadAndCacheAudio uses a deterministic temp path `${localPath}.download` and does deleteAsync(temp) -> downloadAsync(temp) -> moveAsync(temp -> localPath) with only a TOCTOU findCachedAudioPath check (line 137). SavedChainsList story rows are never disabled (SavedChainsList.tsx lines 197-201) and loadChain (DuetRecorderWithTrackPlayer.tsx line 208) has no in-flight guard, so a double-tap on a story starts two overlapping loadChain runs that each call downloadAndCacheAudio for the same missing nodeIds (lines 247-265). The second call's deleteAsync removes the first call's partially-written file mid-download, both native download tasks then write to the same path, and the loser's moveAsync fails or a truncated file is promoted to the cache -- yielding a failed load or a corrupted cached backing track fed to the native mixer.

**Fix:** Guard loadChain against re-entry (or disable list rows while isLoading), and make downloadAndCacheAudio concurrency-safe: unique temp filename per invocation plus an in-memory per-nodeId in-flight promise map.
**Verifier fix sketch:** Make downloadAndCacheAudio concurrency-safe: keep a module-level Map&lt;nodeId, Promise&lt;string&gt;&gt; of in-flight downloads and return the existing promise on re-entry, and use a unique per-invocation temp name (e.g. `${localPath}.${Date.now()}-${Math.random()}.download`) so no two writers ever share a path. Additionally guard loadChain against re-entry (early-return if a load is in progress, or pass the load-related isLoading down to disable SavedChainsList rows).

### [MEDIUM] Failed segment download permanently locks play/seek while transport buttons look enabled
`mobile/components/DuetRecorderWithTrackPlayer.tsx:262` · ux

When a per-segment download fails in loadChain, the catch keeps the id in downloadingSegmentIds forever ('Keep in downloading set to show error state', lines 260-263) yet line 266 unconditionally runs setIsDownloadingAudio(false). isAudioInteractionLocked (audioInteractionState.ts line 20) counts downloadingSegmentCount>0, so playFromPlayhead (line 678), handleSegmentTap (line 712), handleSeek (line 725) and handleFastForward (line 648) silently early-return forever. But CassettePlayerControls.getCassetteControlAvailability (CassettePlayerControls.tsx lines 29-43) ignores downloadingSegmentCount and only checks isDownloadingAudio (now false), so play/seek buttons render enabled and do nothing. Meanwhile handleRecordPress (line 580) checks neither flag, so record stays live in the same state. There is no retry path; only navigating back and re-entering recovers.

**Fix:** On download failure, either clear the id and surface an explicit error with a retry button, or feed downloadingSegmentCount into getCassetteControlAvailability so UI and handlers agree; align handleRecordPress with the same gating.
**Verifier fix sketch:** In the per-segment catch, remove the id from downloadingSegmentIds and move it to a new failedSegmentIds set; surface setAudioError with a retry affordance that re-runs downloadAndCacheAudio for failed ids. Additionally pass downloadingSegmentCount into getCassetteControlAvailability so button disabled-state matches the handler gating, and gate handleRecordPress on the same isAudioInteractionLocked predicate.

### [MEDIUM→low] POST /save races DELETE /chain: FK ON DELETE SET NULL silently detaches a concurrent reply into a corrupt root
`backend/src/routes/audioRoutes.ts:148` · race

/save runs findUnique(parent) (line 149) and create (line 170) as two separate non-transactional statements at default isolation, while delete runs Serializable -- but Postgres SSI only protects serializable-vs-serializable. The FK from the init migration is ON DELETE SET NULL (20251124192453_init_audio_node/migration.sql line 19). If client A saves a reply to leaf X while client B deletes X's story: (a) if the create commits first, deleteMany still deletes X and the FK sets the new node's parentId to NULL -- the reply becomes a standalone 'root' whose persisted startTimeMs was derived from the now-deleted chain (non-zero at depth>=2), appearing in /chains as a corrupt one-segment story whose backing overdub context is gone; (b) if the delete commits between the two statements, the create fails with a P2003 FK error surfaced as a generic 500 instead of 404.

**Fix:** Change the relation to ON DELETE RESTRICT (delete route already deletes bottom-up so it still works), and wrap /save's parent lookup + create in one transaction; map P2003 to 404.
**Verifier fix sketch:** In /save's catch, detect Prisma P2003 (foreign key violation) on the create and return 404 'Parent audio node not found' instead of the generic 500; optionally wrap the parent lookup and create in a single transaction. Switching the FK to ON DELETE RESTRICT is optional defense-in-depth (the delete route's single deleteMany still passes since RI checks run after the statement), but it is not needed to prevent corruption -- Postgres already prevents it.

### [MEDIUM→low] Seed data stores full https URLs in audioUrl, but routes treat audioUrl as an S3 key
`backend/prisma/seed.ts:11` · bug

seed.ts writes audioUrl: 'https://example.com/audio/root.mp3' (lines 11, 23), but every route treats audioUrl as a bare S3 key: /tree and /save call generateDownloadUrl(node.audioUrl) (audioRoutes.ts lines 180, 297), producing a presigned URL for a literal key named 'https://example.com/...'; the mobile download then gets a non-200 and downloadAndCacheAudio throws, leaving the seeded stories in the permanent downloading-lock state. /calibrate and deleteAudioFile hit the same bogus keys. Seeded rows are structurally valid (startTimeMs 0/0 matches the rule) but unplayable end-to-end.

**Fix:** Seed with key-shaped values (e.g. 'audio/<uuid>-recording.wav') and ideally upload matching fixture objects, or skip seeding audio rows entirely.
**Verifier fix sketch:** Change seed.ts to write key-shaped audioUrl values matching generateUploadUrl's format (e.g. 'audio/<uuid>-seed-root.wav'), and either upload small fixture audio objects to the dev bucket as part of seeding or drop the audio-node seed rows entirely, since key-only seeds still produce 404s on download.

### [MEDIUM] GET /chains: unbounded N+1 ancestor walk, no pagination, and full-row leaf fetch
`backend/src/routes/audioRoutes.ts:201` · perf

The leaf findMany (lines 201-210) has no `select` (fetches audioUrl/timestamps only to use id/createdAt) and no take/cursor, then for every leaf walks ancestors one findUnique at a time (lines 224-242). Cost is O(leaves x chain depth) sequential queries per request, with shared ancestors re-fetched once per sibling leaf, and the JSON response is unbounded. The mobile list screen calls this on every mount, refresh, back-navigation, and after every delete (DuetRecorderWithTrackPlayer.tsx line 155), so latency grows quadratically with catalog size.

**Fix:** Fetch all nodes once (or use a recursive CTE via $queryRaw) and assemble chains in memory; add select on the leaf query and take/cursor pagination to the endpoint and client.
**Verifier fix sketch:** Replace the per-leaf walk with a single query: fetch all nodes once with select { id, parentId, durationMs, startTimeMs, createdAt } (or a recursive CTE via $queryRaw for large catalogs), build a parentId map in memory, and assemble each leaf's chain by pointer-walking the map. Add select to the leaf query and take/cursor pagination on the endpoint plus a page param in fetchSavedChains.

### [MEDIUM] POST /save accepts an arbitrary, unverified `key` and trusts client durationMs
`backend/src/routes/audioRoutes.ts:137` · bug

The only validation on `key` is truthiness (line 137). The server never checks that the object exists in S3, was uploaded via /upload-url, is string-typed, or lives under the 'audio/' prefix. A client that calls /save before the S3 PUT completes (or with a typo'd/foreign key) creates a DB node whose /tree presigned URL 403s/404s on download -- the mobile app then hits the permanent download-lock state. A key belonging to another node lets one story's DELETE remove the S3 object out from under the other. durationMs is also trusted without comparison to the actual audio, so timeline math (grandparent end) can diverge arbitrarily from real audio length. Non-string parentId/key values reach Prisma and surface as 500s instead of 400s.

**Fix:** Validate types, require key to match /^audio\/[A-Za-z0-9-]+-[\w.-]+$/, HEAD the S3 object (and optionally read its duration) before creating the row, and reject keys already referenced by another node.
**Verifier fix sketch:** In POST /save, validate that key and parentId are strings and key matches the /upload-url format (^audio/[uuid]-filename), then issue an S3 HeadObject before creating the row, returning 400/409 on missing objects. Add a @unique constraint on AudioNode.audioUrl (plus a migration) so a key can never be referenced by two nodes, and map Prisma validation errors to 400. Optionally derive or sanity-check durationMs server-side from the uploaded object rather than trusting the client.

### [MEDIUM] POST /upload-url: filename and contentType are completely unvalidated
`backend/src/routes/audioRoutes.ts:120` · bug

Only presence of filename is checked (line 120); it is embedded verbatim into the S3 key (s3Service.ts line 19: `audio/${uuidv4()}-${filename}`), so '/'-containing names nest pseudo-directories, and names over ~1000 chars produce keys that S3 rejects only at PUT time. contentType is passed through unchecked into the presigned PUT (s3Service.ts lines 16-27), so this unauthenticated endpoint mints presigned URLs for arbitrary content types (e.g. text/html) into the bucket, which are later re-served via presigned GETs. The mobile client only ever sends recording.{wav,m4a,aac,webm} with audio/* types (audioService.ts lines 39-53), so a strict allowlist costs nothing.

**Fix:** Allowlist filename to the four known values (or sanitize to basename + extension allowlist) and restrict contentType to audio/wav, audio/mp4, audio/aac, audio/webm.
**Verifier fix sketch:** In the /upload-url handler, validate filename against the four known client values (or sanitize to a basename and allowlist the .wav/.m4a/.aac/.webm extensions) and restrict contentType to audio/wav, audio/mp4, audio/aac, audio/webm, returning 400 otherwise; add route tests for rejected filenames (path separators, overlong names) and rejected content types.

### [MEDIUM] Android hardware back exits the app from detail view — even mid-recording — because 'navigation' is component state
`mobile/components/DuetRecorderWithTrackPlayer.tsx:60` · ux

Screen inventory: expo-router Stack (mobile/app/_layout.tsx) has exactly one screen, '/' (mobile/app/index.tsx). List vs detail is faked with useState viewMode ('list'|'detail', line 60), not routes. grep confirms zero BackHandler/router usage in app/ or components/. On Android, pressing the hardware/gesture back button therefore pops the only route and backgrounds/exits the app instead of returning to the list — including while recording, where unmount cleanup (lines 111-120) tears down the recorder and the take is lost without confirmation. The on-screen '< Back' Button is also disabled while isLoading/isRecording (line 790), so during an upload the hardware back is the only 'back' users can reach, and it kills the app.

**Fix:** Make detail a real route (e.g., app/story/[id].tsx) so back navigation works, or register a BackHandler that maps back to goBackToList and confirms when recording/uploading.
**Verifier fix sketch:** In the detail view, register a BackHandler via useEffect that, when viewMode==='detail', calls goBackToList() and returns true to swallow the default back; add a confirmation prompt when isRecording/isWaitingToRecord/isLoading so an in-progress take isn't discarded silently. Cleaner long-term fix: promote detail to a real route (e.g. app/story/[id].tsx) so stack back navigation works natively.

### [MEDIUM→low] Stop always rewinds to 0 and there is no pause, though pause is implemented in the player
`mobile/components/DuetRecorderWithTrackPlayer.tsx:674` · ux

stopPositionTracking has a hidden side effect: setCurrentPosition(0) at line 674, and stopPlayback additionally sets position 0 at line 627. Every stop — including after saving a take (line 488) — snaps the playhead to the beginning, losing the user's place in a long story. There is no pause button anywhere, yet NativeDuetPlayer fully implements pause()/play() resume (NativeDuetPlayer.ts lines 463-490) — an implemented feature unreachable from the UI. Reviewing a specific spot requires re-seeking by finger on the zoomable timeline each time.

**Fix:** Split 'stop tracking' from 'reset position'; keep the playhead where playback stopped, and expose the existing pause/resume as a pause button.
**Verifier fix sketch:** Remove the setCurrentPosition(0) side effect from stopPositionTracking (make it purely clear the interval) and drop the redundant reset in stopPlayback; instead capture the player's current position (via getCurrentPosition) before stopping and leave currentPosition there so play resumes in place. Add a pause button to CassettePlayerControls wired to the already-implemented NativeDuetPlayer.pause()/play() resume, toggling with the play/stop controls.

### [MEDIUM→low] Story names are unstable placeholders that renumber themselves ('Story N')
`mobile/components/SavedChainsList.tsx:158` · ux

getStoryName returns `Story ${visibleChains.length - index}` (lines 156-159, comment admits 'could be improved'). Names are derived from current list position: recording a new story or deleting one silently renames every other story in the list. Users cannot reliably identify or refer to a story ('listen to Story 3' changes meaning day to day), and there is no rename UI. The row also shows no date or duration even though chain.createdAt and chain.totalDurationMs are available on AudioChainSummary — the only identifying visual is the tiny timeline silhouette.

**Fix:** Persist a name (or at least display createdAt + duration) and add rename; never derive identity from list index.
**Verifier fix sketch:** Persist a story name on the backend model (add `name` to the chain and to AudioChainSummary), display it alongside createdAt (formatted date) and totalDurationMs in each row, and add a rename affordance (e.g., long-press menu already used for delete). At minimum, stop deriving the label from list index — even without rename, show createdAt + duration so identity is stable.

### [MEDIUM] Bluetooth/AirPods rejection surfaces only after pressing Record, with jargon pointing at an unreachable 'calibration'
`mobile/services/audio/TapStoryNativeAudio.ts:300` · ux

configureLatencyCompensation throws at record time: 'Bluetooth audio has variable latency and is not supported for synchronized overdubs...' (lines 300-303, Android-gated; iOS BT isn't even checked here — inconsistent), and on Android without a latency timestamp: 'Run a wired-route calibration before recording an overdub' (lines 312-315). These strings land verbatim in the detail view's error text via setAudioError. Problems: (1) the failure appears only after the user pressed Record expecting to capture an idea — there is no proactive route indicator; (2) 'wired-route calibration' is not something the user can do: grep confirms nothing in mobile/ calls the backend's POST /api/audio/calibrate — the calibration feature is referenced in a user-facing error but unreachable in the app; (3) a very common setup (AirPods) dead-ends the core overdub flow with no in-app remediation.

**Fix:** Detect the route up front and show a persistent banner ('AirPods connected — switch to speaker/wired to overdub') before Record is pressed; remove or implement the calibration reference.
**Verifier fix sketch:** Probe the output route up front (on mount / route-change) using the existing isBluetoothConnected native call and render a persistent banner before Record is pressed ('Bluetooth output detected — switch to speaker or wired headphones to overdub'), gating the Record button proactively instead of throwing at record time. Separately, remove the 'Run a wired-route calibration' instruction from the latency-timestamp error (or wire up an actual in-app calibration flow), since no such user action exists.

### [MEDIUM] Mic permission demanded at app launch with no context; denial error invisible on the list screen with no re-request path
`mobile/components/DuetRecorderWithTrackPlayer.tsx:824` · ux

initAudio runs on mount of the home screen (lines 106-121) and recorder.init() immediately calls Audio.requestPermissionsAsync() (audioService.ts line 73) — the OS mic prompt appears the instant the app opens, before the user has expressed any intent to record (a known cause of reflexive denials). If denied, setAudioError('Audio recording permission not granted') is set, but audioError is rendered only in the detail view (line 824); the list view renders nothing, so the user sees a normal-looking app whose Record will never work. init runs exactly once — there is no re-request, no link to system settings, and no recovery without restarting the app after changing settings.

**Fix:** Request the permission on first Record press; if denied, show an inline explanation with a 'Open Settings' link, and re-check permission on app foreground.
**Verifier fix sketch:** Defer the mic permission request out of initAudio and into the first Record press (startDuetRecording), so the OS prompt only appears when the user has expressed intent. On denial, surface the error in the list view too and add a Linking.openSettings() 'Open Settings' action, and add an AppState 'active' listener to re-check/re-init permission when the app returns to the foreground so users recover without a restart.

### [MEDIUM] onRefresh prop is dead: no pull-to-refresh or any manual refresh on the story list
`mobile/components/SavedChainsList.tsx:121` · dead-code

SavedChainsList destructures onRefresh (line 121) but never references it — the ScrollView (lines 189-193) has no RefreshControl and there is no refresh button. The parent wires fetchSavedChains into it (DuetRecorderWithTrackPlayer.tsx line 778) expecting it to work. For a collaboration app, a partner's new story only appears if the user navigates into a story and back (goBackToList refetches) or restarts the app; sitting on the list, the data is permanently stale with no affordance to update it.

**Fix:** Add RefreshControl wired to the existing onRefresh prop.
**Verifier fix sketch:** Import RefreshControl in SavedChainsList.tsx and pass refreshControl={<RefreshControl refreshing={isLoading} onRefresh={onRefresh} />} to the ScrollView, so the already-wired onRefresh (fetchSavedChains) drives pull-to-refresh. Optionally use a dedicated refreshing state to avoid conflating with the full-screen loading spinner.

### [MEDIUM] Zero accessibility support: unlabeled shape-only buttons, no roles, no state announcements
`mobile/components/CassettePlayerControls.tsx:75` · ux

grep across mobile/app/ and mobile/components/ finds zero accessibilityLabel/accessibilityRole/accessible props. Every transport control is a bare TouchableOpacity containing an unlabeled geometric View (CSS-border triangle, square, circle — lines 75-126, 199-225); LatencyNudge buttons are the text glyphs '<<', '<', '>', '>>'; timeline segments announce only a raw duration string. VoiceOver/TalkBack users get anonymous 'button' (or nothing) for every control, cannot tell whether recording is active (record state is conveyed purely by background color), and cannot operate the gesture-only timeline (pinch/pan/tap with no accessible fallback). Recording state for sighted users is also color-only (orange vs red circle button), with no shape/text redundancy — a WCAG use-of-color failure.

**Fix:** Add accessibilityRole="button", labels ('Record', 'Stop recording', 'Play from 0:12'), accessibilityState for disabled/selected, and a text or icon change (not just color) for the recording state.
**Verifier fix sketch:** Add accessibilityRole="button" plus descriptive accessibilityLabel to each transport control in CassettePlayerControls and LatencyNudge, and accessibilityState={{ disabled, selected/busy }} reflecting recording/waiting. Give timeline segments meaningful labels (e.g. "Play segment, 0:12") and an accessible seek alternative (accessibilityActions or a stepper). Add a non-color recording indicator (icon/text change, not just red-vs-orange) to satisfy WCAG use-of-color.

### [MEDIUM] loadChain called twice per overdub start, doubling the delay before pre-roll begins
`mobile/components/DuetRecorderWithTrackPlayer.tsx:325` · perf

startDuetRecording calls player.loadChain(audioChain) at line 304, then the seek-back branch calls it again at line 325 ('Seek and wait for it to complete' — it is not a seek, it's a full reload). Each native loadChain decodes and resamples every segment file (NativeDuetPlayer.prepareNativeTracks → loadTracks), so on a long story the time between pressing Record and hearing the pre-roll doubles — seconds of dead air added to the most latency-sensitive action in the app, with no progress indication beyond the generic isLoading flag.

**Fix:** Remove the second loadChain (the tracks are already loaded); longer-term, keep the chain loaded across transport ops instead of reloading on every record/play/seek.
**Verifier fix sketch:** Remove the redundant loadChain at line 325; the tracks loaded at line 304 survive the intervening stop() (native _tracks/segments are preserved), and playFrom already performs the seek. Longer term, keep the chain loaded across transport ops so record/play/seek don't re-decode.

### [MEDIUM→low] Inconsistent domain naming: 'stories' vs 'chains' vs 'duets' vs 'segments', plus a delete warning that overstates
`mobile/components/SavedChainsList.tsx:229` · contract-mismatch

User-facing copy says 'story' ('Your Stories', '+ New Story', 'Delete Story?', 'Tap record to add to the story'), while the entire code/API surface says 'chain' (fetchSavedChains, loadChain, deleteChain, /api/audio/chains, AudioChainSummary) and the components say 'Duet' (DuetRecorderWithTrackPlayer, NativeDuetPlayer) — three names for one concept, with 'segment' also surfacing in user copy ('Downloading 2 segments...', '3 segments'). Concretely wrong for users: the delete modal (lines 229-231) claims 'This will permanently delete all audio files' but the backend deletes only the leaf-exclusive suffix and retains ancestors shared with sibling stories (acknowledged in DuetRecorderWithTrackPlayer.tsx lines 172-174), so for branched stories the warning is false. Also '⚡ Native sync engine' (DuetRecorderWithTrackPlayer.tsx line 822) is engineering status leaked into the primary screen.

**Fix:** Standardize on 'story'/'take' in all user-facing strings; make the delete copy accurate ('takes shared with other stories are kept'); remove or demote the native-engine badge to a settings/debug screen.
**Verifier fix sketch:** Standardize user-facing copy on one term (e.g. "story"/"take"), keeping "chain" as an internal code/API name only. Make the delete modal accurate — drop the absolute "all audio files" and note that takes shared with other stories are kept. Move the "⚡ Native sync engine" badge to a debug/settings surface.

### [MEDIUM] Developer jargon shown as user-facing errors (Expo Go message, native error strings)
`mobile/components/DuetRecorderWithTrackPlayer.tsx:294` · ux

Overdubbing without the native module throws 'Synchronized overdubs require the Tap Story native audio engine. Open the app in an iOS/Android development build instead of Expo Go.' (lines 293-297) straight into the red error text a user sees. Other raw internals surfaced via setAudioError include 'No recording result from native player' (line 459) and 'Failed to save audio metadata' (line 524). Errors also persist indefinitely: setAudioError(null) happens only at the start of the next recording (line 285) — never on navigation (goBackToList/loadChain), so a stale failure message from one story reappears when opening the next.

**Fix:** Map internal errors to plain-language messages with a next step; clear audioError on navigation and successful actions.
**Verifier fix sketch:** Introduce a mapping layer that converts internal thrown errors into plain-language, actionable messages before calling setAudioError, and add setAudioError(null) to the navigation/entry paths (goBackToList, loadChain, startNewStory, resetChain) and after successful save so stale failures don't leak into the next story.

### [MEDIUM→low] Fast-Forward seeks to the absolute end (useless position) and is enabled on empty stories
`mobile/components/DuetRecorderWithTrackPlayer.tsx:647` · ux

handleFastForward (lines 647-654) does a redundant loadChain then seeks to getTotalDuration() — the exact end of the timeline. There is nothing to do there: Play from that position immediately triggers the end-of-timeline auto-stop and the stuck-playing bug. FF is also not disabled when there is no audio (seekDisabled in CassettePlayerControls.tsx line 40 omits hasAudio), so on a brand-new empty story the FF/rewind buttons look active but silently no-op (handleFastForward's length check, handleSeek's length check at 726). A cassette-style skip would more usefully jump to the start of the next/previous take.

**Fix:** Repurpose FF/rewind as next/previous segment boundary jumps; disable both when hasAudio is false.
**Verifier fix sketch:** Add !hasAudio to seekDisabled in getCassetteControlAvailability so rewind/FF disable on empty stories, mirroring playDisabled. Optionally repurpose FF/rewind to jump to the next/previous segment boundary (using audioChain startTimes) instead of the timeline start/end so the controls land on a useful playable position.

### [MEDIUM] Timeline visuals mislead: short segments overlap neighbors, playhead hidden behind playing segments, raw float duration labels
`mobile/components/AudioTimeline.tsx:100` · bug

Three verified rendering defects. (1) timeToWidth enforces MIN_WIDTH_PX=30 (lines 100-103) but timeToLeft (106-111) positions by true time, so a sub-minimum segment is drawn wider than its time span and visually overlaps the next same-row segment, and taps/playhead alignment no longer match audio time. (2) The playhead is zIndex 0 behind the zIndex-1 track rows (styles lines 494-507), and the playing-segment background animates to fully opaque purple rgba(147,51,234,1.0) (line 294) — so exactly while a segment plays, the position indicator is invisible inside it; there is also no numeric time readout anywhere. (3) Segment labels print the raw float `${segment.duration}s` (line 349), e.g. '12.345s', while the recording segment uses toFixed(1) — inconsistent and noisy.

**Fix:** Clamp left/width consistently (or enforce min width only via inner hit-slop), raise the playhead above segments (or render it inside each row), add a m:ss position/duration readout, and format durations with toFixed(1) everywhere.
**Verifier fix sketch:** Derive left and width from the same clamped mapping (or apply MIN_WIDTH only to an inner hit-slop while keeping the visual bar at true time), raise the playhead above segments or render it inside each row (and/or cap playing-segment opacity below 1.0), add an m:ss position/duration readout, and format all duration labels with toFixed(1).

### [MEDIUM→low] Dead re-arm-punch-after-seek branch: seeking during pre-roll is silently impossible
`mobile/components/DuetRecorderWithTrackPlayer.tsx:741` · dead-code

handleSeek early-returns on audioInteractionLocked (line 725), which includes isWaitingToRecord (audioInteractionState.ts line 23), so its `if (isWaitingToRecord)` branch at lines 741-747 — which would restart playback and re-arm the punch callback at the new position — is unreachable. AudioTimeline's waiting clamp in calculatePosition (lines 143-145) is likewise dead. Net UX: during the pre-roll a user who realizes they want to punch in from somewhere else taps the timeline and nothing happens (no feedback, no seek); the intended feature exists in code but can never run. Also related dead code: seek gestures in AudioTimeline check only !isRecording, so they fire callbacks that the parent then drops silently.

**Fix:** Either allow seek-while-waiting by exempting isWaitingToRecord from the lock for handleSeek (the re-arm code already exists), or visually disable the timeline during pre-roll.
**Verifier fix sketch:** Either exempt isWaitingToRecord from the lock in handleSeek (e.g. compute a seek-specific lock without the isWaitingToRecord term) so the already-written re-arm branch at 741-747 can run, or add `!isWaitingToRecord` to the AudioTimeline tap/pan gesture guards so the timeline is visibly inert during pre-roll instead of firing callbacks the parent silently drops. Removing the unreachable branch is the alternative if seeking-while-waiting is not desired.

### [MEDIUM] Stop tail-drain timeout converts a fully captured take into a rejected one (both platforms)
`mobile/ios/TapStory/AudioEngineIOS.mm:607` · data-loss

In AudioEngineIOS stop(), if render callbacks stop arriving within the 500ms mute deadline or the tail deadline (lines 588-612), _timelineDiscontinuityCount is incremented (lines 607-611) even though every frame up to the stop was captured and written correctly. stopRecording then rejects CAPTURE_TIMELINE_DISCONTINUITY and deletes the file (TapStoryAudioModule.swift:297-305). Android has the same shape: stopPlayback's tail-drain timeout sets mLastStreamError=-1004 (AudioEngine.cpp:246-254), which makes Kotlin stopRecording delete the take (TapStoryAudioEngine.kt:253). The only thing actually missing in this scenario is the compensated tail (tens of ms); the pre-stop audio is intact and internally consistent (captureTimelineEndFrame only advances with accepted writes), yet the entire take is destroyed.

**Fix:** Distinguish 'tail not drained' from a mid-take discontinuity: finalize the take at the last accepted captureTimelineEndFrame with a truncated-tail warning instead of counting it as a discontinuity.
**Verifier fix sketch:** Give the tail-drain timeout its own signal separate from the mid-take discontinuity/stream-error channel. On iOS, set a dedicated _tailTruncated flag (not _timelineDiscontinuityCount) and, in Swift finalize the take at the last accepted recordingTimelineEndFrame with a truncated-tail warning instead of discardRawRecording(). On Android, use a distinct sentinel rather than mLastStreamError for the drain timeout and finalize at the last accepted end frame instead of deleting the file.

### [MEDIUM] WAV conversion failure deletes the validated raw PCM — disk-full destroys a good take
`mobile/ios/TapStory/TapStoryAudioModule.swift:379` · data-loss

By the time conversion runs, the capture has passed every integrity check and the raw PCM file is a complete, valid take. iOS: the catch block (lines 378-384) calls discardRawRecording() and deletes the partial WAV on any conversion error. Android: convertRawToWav's catch (TapStoryAudioEngine.kt:321-325) does wavFile.delete(); rawFile.delete(); throw. Conversion doubles peak disk usage (WAV is same size as raw), so the most likely failure — disk full while writing the WAV — deletes both files and permanently destroys audio that was fully recoverable one line earlier.

**Fix:** On conversion failure, keep the raw file and include its path in the rejection so conversion can be retried (e.g., after freeing space); only delete raw after the WAV is fully written and synced.
**Verifier fix sketch:** On conversion failure, do not delete the raw PCM: keep it and return its path (or a retry token) in the rejection so JS can re-run conversion after freeing space. Only delete the raw after the WAV is fully written and synchronized. Optionally distinguish transient IO errors (disk full) from raw-corruption errors, deleting only in the latter case.

### [MEDIUM→low] Stop during pre-roll discards a take whose punch already happened natively; finalized WAV orphaned
`mobile/components/DuetRecorderWithTrackPlayer.tsx:618` · race

handleStopButton routes to stopPlayback() while isWaitingToRecord (line 633). stopPlayback calls player.current.stop() (line 618) and ignores the return value. isRecording/isWaitingToRecord flip only when the onRecordingStarted event crosses the RN bridge and React commits state, so there is a window (bridge latency + render) where native capture has already punched in and NativeDuetPlayer.stop() runs the full finalize path (tail drain, validation, WAV conversion) and returns a valid RecordingResult — which stopPlayback silently drops. The recorded audio is never uploaded and the finalized WAV is leaked in temp/cache with no reference.

**Fix:** Capture the result of player.current.stop() in stopPlayback; if non-null, either delete the file explicitly (confirmed cancel) or prompt/save it, so real audio is never silently orphaned.
**Verifier fix sketch:** In stopPlayback, capture the RecordingResult returned by player.current.stop(); if non-null, delete the temp URI (Stop-during-preroll is a cancel) via the same FileSystem.deleteAsync cleanup used elsewhere, or route it into the save/upload path. Alternatively gate handleStopButton on the player's imperative captureStarted state rather than the lagging React isWaitingToRecord so it falls through to stopDuetRecording once the punch has fired.

### [MEDIUM] saveRecordingLocally failure after successful server save rolls back the UI, orphaning the saved node
`mobile/components/DuetRecorderWithTrackPlayer.tsx:528` · contract-mismatch

The save sequence is: POST /api/audio/save succeeds (line 517-527) -> saveRecordingLocally(tempUri, savedNode.id) (line 528). If the local copy throws (e.g. copyAsync disk-full), the shared catch (line 555) removes the temp segment and shows 'Failed to finalize recording' even though the node is durably saved in DB+S3. currentNodeId is never updated to savedNode.id, so when the user 're-records' the take they believe failed, the new segment saves under the old parent, creating a sibling fork; the successfully saved segment appears only after reloading the chain list, in a divergent story branch.

**Fix:** Split error handling: failures after a 2xx from /save should keep the saved node in the chain (fall back to remote audioUrl when the local copy fails) instead of taking the generic rollback path.
**Verifier fix sketch:** Wrap the post-2xx local copy in its own try/catch: if saveRecordingLocally fails, still commit savedNode into the chain (replace the temp node using the remote audioUrl / lazy download instead of localUri) and call setCurrentNodeId(savedNode.id), rather than falling into the generic rollback that assumes the server save never happened.

### [MEDIUM] NativeDuetPlayer.stop() loses a successful RecordingResult when transport stop rejects
`mobile/services/audio/NativeDuetPlayer.ts:526` · bug

Lines 523-528: `try { await this.nativeAudio.stop(); } finally { if (wasRecording) result = await this.nativeAudio.stopRecording(); }`. If nativeAudio.stop() rejects (Android module wraps any exception from engine stop as STOP_ERROR, TapStoryAudioModule.kt:226-229) while stopRecording() in the finally block succeeds and finalizes a valid WAV, the original stop() exception propagates out of the try/finally, `return result` is never reached, and the outer catch (line 534) does cleanup + rethrow. stopDuetRecording's catch then discards the take even though a fully valid WAV was produced (and is leaked on disk).

**Fix:** Restructure so the stopRecording result survives a transport-stop error: run both calls, prefer returning a non-null result, and only rethrow when no recording was finalized.
**Verifier fix sketch:** Restructure stop() to capture the stop() rejection without letting it short-circuit finalization: run nativeAudio.stop() in a try/catch that stores the error, then always call stopRecording() (preserving its NO_RECORDING/preroll handling), and return a non-null result if one was finalized; only apply the cleanup+rethrow path using the stored stop error when no recording result was produced.

### [MEDIUM→low] Finalized WAVs are never cleaned up after successful save and live only in purgeable cache during upload
`mobile/components/DuetRecorderWithTrackPlayer.tsx:496` · data-loss

Two lifecycle problems with the native output file: (1) the success path (lines 509-554) copies tempUri to documentDirectory but never deletes the temp WAV, so every take leaks a full WAV in iOS tmp / Android cacheDir (native modules delete only the raw .pcm — TapStoryAudioModule.swift:362, TapStoryAudioEngine.kt:327). (2) Conversely, during the entire upload window the ONLY copy of the take sits in cacheDir/tmp, which Android may clear under storage pressure and iOS may purge — precisely when storage pressure is likely, since recording just wrote raw+wav. Cleaned too late in one sense, stored too precariously in the other.

**Fix:** Move (FileSystem.moveAsync) the WAV into the app's documentDirectory immediately after stop, upload from there, and delete after confirmed save; this fixes both the leak and the purgeable-only-copy problem together with the retry work.
**Verifier fix sketch:** In the native success path, immediately FileSystem.moveAsync the WAV out of tmp/cacheDir into a durable path under documentDirectory right after stop, upload from there, and delete it once the save succeeds (or move it straight to its final localUri once savedNode.id is known). This removes both the orphaned-WAV leak and the purgeable-only-copy window in one change.

### [MEDIUM] iOS RECORD_START_ERROR missing from recoverable-start codes — engine-rebuild retry never fires for record-arm failures
`mobile/services/audio/NativeDuetPlayer.ts:65` · bug

RECOVERABLE_START_ERROR_CODES lists PLAY_START_ERROR, PLAY_RECORD_START_ERROR, PLAY_ERROR, PLAY_RECORD_ERROR. But on iOS a stale engine (route invalidated while idle) fails at the ARM step: startRecordingToPath checks _routeInvalidated (AudioEngineIOS.mm:630-632) and playAndRecord rejects with RECORD_START_ERROR (TapStoryAudioModule.swift:213-218) before engine.start ever runs, so the recoverable PLAY_RECORD_START_ERROR is unreachable for this case. startTransportWithRetry therefore skips the rebuild and throws; the user's record press fails with an error. (The subsequent cleanupFailedSession resets initialized, so the SECOND press succeeds — the retry logic that exists specifically for this scenario is dead code on iOS.) Android is fine: its arm failure surfaces as PLAY_RECORD_ERROR, which is in the list.

**Fix:** Add 'RECORD_START_ERROR' to RECOVERABLE_START_ERROR_CODES (its only cause is a stale/invalidated engine or unopenable capture file, both fixed by the rebuild).
**Verifier fix sketch:** Add 'RECORD_START_ERROR' to RECOVERABLE_START_ERROR_CODES so startTransportWithRetry rebuilds the engine and retries the arm after a stale/invalidated-route record press. A fresh initialize clears _routeInvalidated and reloads tracks, letting the arm succeed; non-route causes (latency-too-large, punch-out-of-range) simply fail again on the single retry and then throw, so the change is safe.

### [MEDIUM] All backend routes are unauthenticated, including permanent story deletion (DB + S3)
`backend/src/routes/audioRoutes.ts:359` · data-loss

DELETE /api/audio/chain/:id has no authentication or ownership check; anyone who can reach the server (server.ts listens on 0.0.0.0) can enumerate stories via GET /api/audio/chains and permanently delete every leaf, which cascades DB row deletion plus S3 object deletion (lines 374-381) with no soft-delete or trash. The same applies to /save and /upload-url (arbitrary writes). For a product whose entire value is user recordings, this is a remote total-data-loss vector.

**Fix:** Add authentication/ownership before shipping beyond prototype; consider soft-delete (deletedAt) with delayed S3 reaping so accidental or malicious deletes are reversible.
**Verifier fix sketch:** Introduce authentication and per-node ownership (add a user/owner field to AudioNode) and enforce it on /save, /upload-url, /chains, /tree, and especially DELETE /chain/:id so callers can only act on their own stories. As a safety net against accidental/malicious deletes, replace the hard deleteMany + immediate S3 deletion with a soft-delete (deletedAt) and a delayed/background S3 reaper so deletions are reversible.

## Refuted (false positives — do not chase)

- **DuetTrackPlayer.stopRecording double-applies latency compensation to native startTimeMs** (`mobile/services/audio/DuetTrackPlayer.ts`) — The "double-apply" premise fails on both platforms. On Android, native latency compensation defaults to 0 frames (AudioEngine.h:150) and is only enabled via setLatencyCompensationMs, which is called solely from TapStoryNativeAudio.ts (the NativeDuetPlayer stack) — TapStoryAudio.ts, the wrapper DuetT
- **First-take capture gate silently degrades to 0 when latency diagnostics are unavailable, unlike the overdub path which throws** (`mobile/services/audio/TapStoryNativeAudio.ts`) — The code asymmetry exists as described, but the claimed failure cannot occur: on any device where inputLatencyMs is unavailable, TapStoryAudioModule.kt getEstimatedLatency also returns -1.0 (it requires both input AND output >= 0), so the overdub path throws on that same device — the "properly-compe
- **Failing route-change retry tests: retry helpers existed but playFrom never called them (fixed mid-audit; tests now pass 14/14)** (`mobile/services/audio/NativeDuetPlayer.ts`) — The current code at mobile/services/audio/NativeDuetPlayer.ts already wraps both playFrom transport starts in startTransportWithRetry (lines 381 and 403), which performs the cleanup->initialize->loadTracks->retry-once sequence via rebuildEngineForSession; running the suite yields 14/14 passing inclu
- **Double-tap Record races stale React state - can leave native capture armed while UI shows idle with the Stop button hidden** (`mobile/components/DuetRecorderWithTrackPlayer.tsx`) — The claimed terminal state requires call #1's SESSION_CANCELLED catch to land after call #2's actuallyStartRecording sets isRecording=true, but that ordering is impossible: tap #2 can only pass the stale-state guard while call #1 is parked at its first await (ensureInitialized), so tap #2's synchron
- **Transport buttons mount/unmount and re-center, shifting under the user's finger** (`mobile/components/CassettePlayerControls.tsx`) — Pressing Play flips isPlaying false→true, which swaps the Play button (70×70, styles.button+playButton) for the Stop button (70×70, styles.button+stopButton) at the same JSX index inside the row. Both states have exactly 4 buttons and identical row width (50+70+70+50+3×20 gaps = 300), so justifyCont
- **Take-rejection validators (xrun, onset-inexact, drift, overflow, span mismatch) delete the audio instead of salvaging** (`mobile/android/app/src/main/java/com/tapstory/audio/TapStoryAudioEngine.kt`) — The report's code reading is factually accurate — every cited branch in both TapStoryAudioEngine.kt (L253/269/277/285/293/302) and TapStoryAudioModule.swift (L288/297/311/320/329/334) does delete the raw file before rejecting. But this is deliberate, documented behavior, not a defect: the sync contr
- **Backend presigns the download URL after DB create — presign failure returns 500 post-commit** (`backend/src/routes/audioRoutes.ts`) — The report's failure trigger cannot occur: generateDownloadUrl (s3Service.ts:32-39) is a local SigV4 computation with no network call to S3, so a "network hiccup" can't make it throw. Credentials are a static object captured from env at module load, and by the time /save runs the same s3Client has a

## Low-severity (unverified, polish backlog)

- `backend/src/routes/audioRoutes.ts:343` — POST /calibrate has no consumer, discards confidence, and returns fractional milliseconds
- `backend/src/utils/audioTimeline.ts:10` — Backend imports nothing from shared/ and re-implements the timeline rule and request types
- `backend/src/utils/latencyCalibration.ts:56` — readPcmFromWav locates chunks by naive substring search
- `mobile/android/app/src/main/java/com/tapstory/audio/TapStoryAudioEngine.kt:207` — onRecordingStarted event reports the compensated gate time (with truncating division on Android), not the logical punch, contradicting its documented meaning
- `mobile/android/app/src/main/java/com/tapstory/audio/TapStoryAudioEngine.kt:616` — Android WAV header size fields wrap negative for takes with 2-4 GiB of PCM
- `mobile/android/app/src/main/java/com/tapstory/audio/TapStoryAudioEngine.kt:340` — onRecordingStarted reports the compensated (latency-shifted) time while RecordingResult.startTimeMs reports the requested time
- `mobile/android/app/src/main/java/com/tapstory/audio/TapStoryAudioEngine.kt:616` — WAV header sizes wrap negative for takes between 2 GiB and 4 GiB
- `mobile/android/app/src/main/java/com/tapstory/audio/TapStoryAudioEngine.kt:262` — Android stopRecording silently returns null for metadata-invalid takes after deleting real captured audio
- `mobile/android/app/src/main/java/com/tapstory/audio/TapStoryAudioEngine.kt:616` — Android WAV header wraps negative for takes between 2GiB and 4GiB, producing a corrupt/unplayable file
- `mobile/android/app/src/main/java/com/tapstory/audio/TapStoryAudioModule.kt:321` — Module lifecycle state read on the main thread without moduleLifecycleLock
- `mobile/components/AudioTimeline.tsx:102` — AudioTimeline: minimum segment width applied without adjusting neighbors, and recording playhead runs on a Date.now timer instead of the engine clock
- `mobile/components/CassettePlayerControls.tsx:38` — CassettePlayerControls availability ignores processing state - Record/Play render enabled but their handlers silently no-op
- `mobile/components/DuetRecorderWithTrackPlayer.tsx:325` — Recorder double-decodes the whole chain on every overdub punch-in (loadChain called twice)
- `mobile/components/DuetRecorderWithTrackPlayer.tsx:618` — Stop pressed during pre-roll races the native punch: a just-started take's RecordingResult is silently discarded and its WAV leaks
- `mobile/components/DuetRecorderWithTrackPlayer.tsx:614` — Stop at the punch instant discards a real RecordingResult - take dropped and WAV orphaned
- `mobile/components/DuetRecorderWithTrackPlayer.tsx:458` — Double-tap Stop while recording produces a spurious 'No recording result' error and races the optimistic-node bookkeeping
- `mobile/components/DuetRecorderWithTrackPlayer.tsx:111` — Unmount cleanup is fire-and-forget and races the next mount's initialize on the shared TapStoryNativeAudio singleton
- `mobile/components/DuetRecorderWithTrackPlayer.tsx:325` — Every play/seek/segment-tap re-runs loadChain (full native re-decode of the whole story); startDuetRecording branch 1 loads the chain twice back-to-back
- `mobile/components/DuetRecorderWithTrackPlayer.tsx:674` — stopPositionTracking resets the playhead to 0 as a side effect - position jumps to start after every stop and every saved take
- `mobile/components/DuetRecorderWithTrackPlayer.tsx:741` — handleSeek's isWaitingToRecord re-arm branch is unreachable dead code
- `mobile/components/DuetRecorderWithTrackPlayer.tsx:618` — Stop pressed during isWaitingToRecord discards a punched-in native take
- `mobile/components/DuetRecorderWithTrackPlayer.tsx:674` — stopPositionTracking resets the playhead to 0 on every stop and after every saved take
- `mobile/components/DuetRecorderWithTrackPlayer.tsx:325` — Record seek-back path loads and decodes the whole chain twice
- `mobile/components/DuetRecorderWithTrackPlayer.tsx:741` — handleSeek's isWaitingToRecord re-arm branch is unreachable
- `mobile/components/DuetRecorderWithTrackPlayer.tsx:769` — Inconsistent control styling: raw RN <Button> for '+ New Story' and '< Back' amid custom-styled controls
- `mobile/components/DuetRecorderWithTrackPlayer.tsx:859` — Stale hint text during the first recording: still says 'Tap the record button to start your first recording'
- `mobile/components/DuetRecorderWithTrackPlayer.tsx:112` — Component unmount / RN reload during an active take deletes the raw capture without any finalization attempt
- `mobile/components/LatencyNudge.tsx:18` — Latency nudge exposes jargon, unlabeled step buttons, and a silent clamp at ±250ms
- `mobile/components/RecordButton.tsx:1` — Dead UI code shipped: RecordButton.tsx unused, vim swap file, empty hooks/, dead selectedChainId filter
- `mobile/components/SavedChainsList.tsx:158` — Story names are derived from list position and silently renumber
- `mobile/components/SavedChainsList.tsx:177` — Delete failure uses native Alert while confirmation uses a custom modal
- `mobile/ios/TapStory/TapStoryAudioModule.swift:366` — iOS stopRecording resolves fractional startTimeMs/durationMs (non-integer ms) to JS
- `mobile/ios/TapStory/TapStoryAudioModule.swift:32` — onPositionUpdate and onPlaybackComplete declared in supportedEvents but never emitted; JS listener API is a dead trap
- `mobile/ios/TapStory/TapStoryAudioModule.swift:106` — loadTracks converts startFrame/numSamples through Int32(...), which traps (crashes) instead of rejecting for long timelines
- `mobile/ios/TapStory/TapStoryAudioModule.swift:366` — iOS resolves fractional-double milliseconds and platform-divergent startTimeMs semantics in stopRecording/onRecordingStarted payloads
- `mobile/ios/TapStory/TapStoryAudioModule.swift:191` — hasListeners written on the module control queue but read on the main queue without synchronization
- `mobile/services/audio/DuetTrackPlayer.ts:224` — DuetTrackPlayer passes unrounded float milliseconds across the native boundary, violating the integer-ms contract
- `mobile/services/audio/DuetTrackPlayer.ts:373` — DuetTrackPlayer's native branches are unreachable in the app and contain latent bugs (punch event dropped by 100ms tolerance with no fallback, double latency compensation, unrounded ms, pause/seek bypass the native engine)
- `mobile/services/audio/NativeDuetPlayer.ts:463` — NativeDuetPlayer pause/resume/seekTo depend on native methods that neither platform module exports; pause degrades to a full transport stop and resume no-ops while JS reports 'playing'
- `mobile/services/audio/NativeDuetPlayer.ts:523` — NativeDuetPlayer.stop(): a successfully finalized RecordingResult is discarded if the transport stop rejected
- `mobile/services/audio/NativeDuetPlayer.ts:463` — NativeDuetPlayer.pause()/play()/seekTo() are broken: neither native module implements pause/resume/seekTo - pause actually stops the transport, resume is a no-op that fakes 'playing'
- `mobile/services/audio/NativeDuetPlayer.ts:620` — startRecordingOnly lacks the route-change retry that playFrom now has
- `mobile/services/audio/NativeDuetPlayer.ts:537` — Android stopRecording rejects NOT_INITIALIZED (not NO_RECORDING) when the engine is gone, defeating NativeDuetPlayer's preroll-cancel handling
- `mobile/services/audio/TapStoryNativeAudio.ts:166` — getConfig() fabricates SAMPLE_RATE=44100 - neither native module exports constants
- `mobile/services/audio/TapStoryNativeAudio.ts:166` — iOS exports no SAMPLE_RATE/CHANNELS constants; JS getConfig() fabricates 44100 on a typically-48000 route
- `mobile/services/audio/TapStoryNativeAudio.ts:405` — stopRecording never resolves null on iOS; JS null-branch is dead and stopAll() rejects whenever no take is armed
- `mobile/services/audio/TapStoryNativeAudio.ts:405` — Android never resolves stopRecording() with null — the JS null branch is unreachable and stopAll() always rejects when idle
- `mobile/services/audio/TapStoryNativeAudio.ts:550` — onPositionUpdate and onPlaybackComplete are subscribed in JS but never emitted by the Android module
- `mobile/services/audio/TapStoryNativeAudio.ts:166` — Android module exports no constants; getConfig() fabricates SAMPLE_RATE 44100 while the engine negotiates the device rate
- `mobile/services/audio/trackPlayerSetup.ts:19` — Third, contradictory latency model still exported: LATENCY_OFFSET_MS=250 and getCorrectedRecordingStartTime
- `mobile/services/audioService.ts:267` — audioService dead code: unused imports/fields, unreachable prepareRecording call, and AudioRecorder.cleanup() never releases preparedRecording
- `mobile/services/audioService.ts:3` — audioService.ts carries unused native-engine imports and vestigial state
- `mobile/services/audioService.ts:208` — expo-av fallback stopRecording throws away the take when duration is unmeasurable; cleanup abandons in-flight recordings
- `mobile/services/audioStorage.ts:57` — getLocalAudioPath Android fallback extension is 'webm' though the native engine records WAV
- `mobile/services/duetPlayer.ts:15` — services/duetPlayer.ts (legacy DuetPlayer) is dead code with zero production importers
- `shared/src/types/api.ts:12` — shared/src/types/api.ts describes an API that does not exist and is imported nowhere