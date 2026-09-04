'use client';

/**
 * Owns the Twilio Voice Device lifecycle and exposes the whole phone as plain
 * React state: current call state, mute, duration, incoming call, microphone
 * selection, errors.
 *
 * The SDK is event-driven and its objects are mutable, so live Device/Call
 * instances are kept in refs and mirrored into state for rendering.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Call, Device } from '@twilio/voice-sdk';

import { describeTwilioError, fetchVoiceToken } from '@/lib/twilio/client';
import {
  MIC_CONSTRAINTS,
  ensureMicrophoneAccess,
  listMicrophones,
  quantiseLevel,
  readPreferredMicrophoneId,
  writePreferredMicrophoneId,
} from '@/lib/twilio/audio';
import {
  DEFAULT_TRANSCRIPTION_SETTINGS,
  readTranscriptionSettings,
  writeTranscriptionSettings,
  type TranscriptionSettings,
} from '@/lib/twilio/transcription-settings';
import { addCallRecord, createRecordId } from '@/lib/storage/call-history';
import type { CallDirection, CallState, CallStatus } from '@/lib/types';

/** How long the "Ended"/"Failed" state lingers before returning to Idle. */
const RESET_DELAY_MS = 3000;

/** Refresh the access token this many ms before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 30_000;

/**
 * How long setup waits for the microphone permission prompt to be answered
 * before building the Device anyway. Long enough for a deliberate click, short
 * enough that an ignored prompt does not leave the phone unregistered.
 */
const MIC_PERMISSION_WAIT_MS = 8000;

/**
 * Attempts, one per second, to start transcription while a call is still
 * connecting. Covers the 30-second dial timeout in lib/twilio/twiml.ts, which
 * is the longest a call can sit ringing before Twilio gives up.
 */
const TRANSCRIPTION_START_ATTEMPTS = 32;
const TRANSCRIPTION_RETRY_MS = 1000;

export type DeviceStatus = 'initializing' | 'ready' | 'offline' | 'error';

/** Bookkeeping for the in-flight call, used to build the history record. */
interface CallMeta {
  direction: CallDirection;
  from: string;
  to: string;
  startTime: Date;
  connectedAt: Date | null;
}

export interface UseTwilioPhone {
  deviceStatus: DeviceStatus;
  identity: string | null;
  callState: CallState;
  /** The other party on the current or most recent call, for display. */
  remoteNumber: string | null;
  incomingFrom: string | null;
  hasIncomingCall: boolean;
  isMuted: boolean;
  /** Connected duration in seconds; 0 until the call connects. */
  durationSeconds: number;
  error: string | null;
  /** Audio input devices, populated once microphone permission is granted. */
  microphones: MediaDeviceInfo[];
  /** The input device calls will use, or null while it is still unknown. */
  selectedMicrophoneId: string | null;
  /**
   * Live capture level, 0-1, while a call is connected. Stays 0 outside a
   * call. A connected call that sits at 0 is a microphone that is not working.
   */
  inputLevel: number;
  /** Set when the microphone looks dead, even though the call is otherwise fine. */
  micWarning: string | null;
  /** True while the idle microphone test is holding the input device open. */
  isTestingMic: boolean;
  /**
   * Twilio's SID for the current call, once Twilio has assigned one (shortly
   * after `ringing`). Needed to address the call over the REST API, and the key
   * the transcript stream is keyed on. Null before then and between calls.
   */
  callSid: string | null;
  transcription: TranscriptionSettings;
  /** True while transcription is actually running on the current call. */
  isTranscribing: boolean;
  startCall: (destination: string) => Promise<void>;
  hangUp: () => void;
  acceptIncoming: () => void;
  rejectIncoming: () => void;
  toggleMute: () => void;
  sendDigit: (digit: string) => void;
  selectMicrophone: (deviceId: string) => void;
  refreshMicrophones: () => void;
  /** Starts or stops the idle level meter, so the mic can be checked off-call. */
  toggleMicTest: () => void;
  /**
   * Flips one transcription toggle. Applied to the call in progress where that
   * is possible: captions can be turned on and off mid-call, but recording for
   * the post-call transcript only starts when switched on.
   */
  setTranscriptionOption: (
    option: keyof TranscriptionSettings,
    enabled: boolean,
  ) => void;
  dismissError: () => void;
  reinitialize: () => void;
}

export function useTwilioPhone(): UseTwilioPhone {
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus>('initializing');
  const [identity, setIdentity] = useState<string | null>(null);
  const [callState, setCallState] = useState<CallState>('idle');
  const [remoteNumber, setRemoteNumber] = useState<string | null>(null);
  const [incomingFrom, setIncomingFrom] = useState<string | null>(null);
  const [hasIncomingCall, setHasIncomingCall] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState<string | null>(
    null,
  );
  const [inputLevel, setInputLevel] = useState(0);
  const [micWarning, setMicWarning] = useState<string | null>(null);
  const [isTestingMic, setIsTestingMic] = useState(false);
  const [callSid, setCallSid] = useState<string | null>(null);
  const [transcription, setTranscription] = useState<TranscriptionSettings>(
    DEFAULT_TRANSCRIPTION_SETTINGS,
  );
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [initToken, setInitToken] = useState(0);

  const deviceRef = useRef<Device | null>(null);
  const activeCallRef = useRef<Call | null>(null);
  const incomingCallRef = useRef<Call | null>(null);
  const metaRef = useRef<CallMeta | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Guards against writing two history records for one call. */
  const recordedRef = useRef(false);
  /** Latest device choice, readable from SDK callbacks without re-subscribing. */
  const selectedMicRef = useRef<string | null>(null);
  /** The `inputVolume` listener installed by the idle microphone test. */
  const micTestListenerRef = useRef<((volume: number) => void) | null>(null);
  /** Latest toggles, readable from SDK callbacks without re-subscribing. */
  const transcriptionRef = useRef<TranscriptionSettings>(
    DEFAULT_TRANSCRIPTION_SETTINGS,
  );
  /**
   * The call each operation has been started for, tracked separately because
   * they succeed and fail independently -- a captions failure must not cause
   * the recording to be started a second time.
   */
  const captionsSidRef = useRef<string | null>(null);
  const recordingSidRef = useRef<string | null>(null);

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, []);

  /** Returns to Idle after briefly showing the terminal state. */
  const scheduleReset = useCallback(() => {
    clearResetTimer();
    resetTimerRef.current = setTimeout(() => {
      setCallState('idle');
      setRemoteNumber(null);
      setDurationSeconds(0);
      setIsMuted(false);
      setInputLevel(0);
      setMicWarning(null);
    }, RESET_DELAY_MS);
  }, [clearResetTimer]);

  /** Re-reads the device list. Labels only appear after permission is granted. */
  const refreshMicrophones = useCallback(() => {
    void listMicrophones().then((devices) => {
      setMicrophones(devices);

      // Drop a stored preference for hardware that is no longer attached, so
      // the UI never shows a selection that cannot be honoured.
      const current = selectedMicRef.current;
      if (current && !devices.some((device) => device.deviceId === current)) {
        selectedMicRef.current = null;
        setSelectedMicrophoneId(null);
        writePreferredMicrophoneId(null);
      }
    });
  }, []);

  /**
   * Acquires the microphone and pins it on the Device *before* the call starts.
   *
   * This is the fix for "they cannot hear me". Without an explicit
   * `setInputDevice`, the SDK falls back to `getUserMedia({ audio: true })` at
   * connect time and captures the browser's default input, which on a headset
   * is regularly the wrong endpoint -- the headset's stereo-output profile that
   * carries no microphone, or the laptop's built-in array mic. Resolving the
   * device here means the stream handed to the peer connection is one we
   * verified we could open, on hardware the user picked.
   */
  const prepareInputDevice = useCallback(async (device: Device) => {
    const audio = device.audio;
    const preferred = selectedMicRef.current;

    // Device already known and known to the SDK: let it acquire the hardware
    // directly. Running the probe first would open the microphone, close it,
    // and reopen it a moment later, and that release-then-reacquire churn is
    // itself a way to end up with a capture track that is live but silent.
    // `setInputDevice` is a no-op when the same device is already open.
    if (audio && preferred && audio.availableInputDevices.has(preferred)) {
      try {
        await audio.setInputDevice(preferred);
        setMicWarning(null);
        return;
      } catch {
        // Fall through to the probe, which also clears a stale preference.
      }
    }

    const granted = await ensureMicrophoneAccess(preferred);

    // Remember whichever device we actually got, so the next call and the next
    // session reuse it instead of re-resolving "default".
    if (granted) {
      selectedMicRef.current = granted;
      setSelectedMicrophoneId(granted);
      writePreferredMicrophoneId(granted);
    }

    if (!audio || !granted) {
      // No AudioHelper, or the browser withheld the device ID: the SDK's own
      // default acquisition is the only option left.
      return;
    }

    try {
      await audio.setInputDevice(granted);
      setMicWarning(null);
    } catch (err) {
      // Selection failed but permission held, so the call can still go ahead
      // on the browser default. Say so rather than failing the call outright.
      setMicWarning(
        `Could not use the selected microphone (${describeTwilioError(err)}). ` +
          'The call will use your default input.',
      );
    }
  }, []);

  /**
   * Releases the input device after a call. `setInputDevice` deliberately holds
   * the stream open, which keeps the browser tab's recording indicator lit, so
   * it has to be handed back once the call is over.
   */
  const releaseInputDevice = useCallback(() => {
    const audio = deviceRef.current?.audio;
    if (!audio) return;
    // Rejects if a call is somehow still up; that is harmless here.
    void audio.unsetInputDevice().catch(() => undefined);
  }, []);

  /**
   * Detaches the level meter but keeps the microphone open. Used when a call
   * takes over the input device: releasing and immediately reacquiring the same
   * hardware is exactly the churn that leaves a track live but silent on
   * Windows, so the stream is handed straight to the call instead.
   */
  const detachMicTestListener = useCallback(() => {
    const audio = deviceRef.current?.audio;
    const listener = micTestListenerRef.current;
    if (audio && listener) {
      audio.off('inputVolume', listener);
    }
    micTestListenerRef.current = null;
    setIsTestingMic(false);
  }, []);

  /** Stops the idle level meter and lets go of the microphone. */
  const stopMicTest = useCallback(() => {
    detachMicTestListener();
    if (!activeCallRef.current) {
      setInputLevel(0);
      releaseInputDevice();
    }
  }, [detachMicTestListener, releaseInputDevice]);

  /**
   * Opens the chosen microphone off-call and reports its level, so a silent
   * device can be spotted and swapped *before* dialling rather than being
   * discovered by the person on the other end.
   *
   * The SDK only emits `inputVolume` while it holds an input stream, which is
   * precisely what `prepareInputDevice` establishes, so this reuses the call
   * path's own capture rather than opening a second stream of its own.
   */
  const startMicTest = useCallback(async () => {
    const device = deviceRef.current;
    if (!device) {
      setError('Calling is not ready yet. Please wait a moment.');
      return;
    }

    try {
      await prepareInputDevice(device);
    } catch (err) {
      setError(describeTwilioError(err));
      return;
    }

    const audio = device.audio;
    if (!audio?.isVolumeSupported) {
      setError('This browser cannot measure the microphone level.');
      return;
    }

    const listener = (volume: number) => setInputLevel(quantiseLevel(volume));
    micTestListenerRef.current = listener;
    audio.on('inputVolume', listener);
    setIsTestingMic(true);
  }, [prepareInputDevice]);

  /**
   * Starts Twilio's transcription on a call, retrying until the call is
   * actually bridged.
   *
   * The retry is the important part. This app dials with `answerOnBridge`, so
   * the browser's own leg stays `ringing` on Twilio's side until the far party
   * picks up, and Twilio refuses to transcribe a call that is not
   * `in-progress`. There is no SDK event that fires exactly at the bridge for
   * an outbound call, so rather than guess at one, this asks until Twilio says
   * yes -- and stops the moment the call is answered, hung up, or the toggle is
   * switched off.
   */
  const startCaptions = useCallback(async (sid: string) => {
    for (let attempt = 0; attempt < TRANSCRIPTION_START_ATTEMPTS; attempt += 1) {
      // Switched off, or a different call took over, while we were waiting.
      if (captionsSidRef.current !== sid) return;
      // The call went away. `activeCallRef` is cleared by every terminal event.
      if (activeCallRef.current?.parameters?.CallSid !== sid) {
        captionsSidRef.current = null;
        return;
      }

      let retryable = false;
      let message = 'Could not start live captions for this call.';

      try {
        const response = await fetch('/api/twilio/transcription/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callSid: sid,
            saveToFile: transcriptionRef.current.saveCaptions,
          }),
        });

        if (response.ok) {
          setIsTranscribing(true);
          return;
        }

        const body = (await response.json().catch(() => null)) as
          | { error?: string; retryable?: boolean }
          | null;
        retryable = body?.retryable === true;
        if (body?.error) message = body.error;
      } catch {
        // A network failure is worth another go too; the tunnel may be
        // reconnecting.
        retryable = true;
      }

      if (!retryable) {
        captionsSidRef.current = null;
        setError(message);
        return;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, TRANSCRIPTION_RETRY_MS),
      );
    }

    captionsSidRef.current = null;
    setError('Live captions could not be started before the call connected.');
  }, []);

  /** Starts the dual-channel recording behind the post-call transcript. */
  const startRecording = useCallback(async (sid: string) => {
    for (let attempt = 0; attempt < TRANSCRIPTION_START_ATTEMPTS; attempt += 1) {
      if (recordingSidRef.current !== sid) return;
      if (activeCallRef.current?.parameters?.CallSid !== sid) {
        recordingSidRef.current = null;
        return;
      }

      try {
        const response = await fetch('/api/twilio/recording/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callSid: sid }),
        });

        if (response.ok) return;

        const body = (await response.json().catch(() => null)) as
          | { error?: string; retryable?: boolean }
          | null;

        if (body?.retryable !== true) {
          recordingSidRef.current = null;
          setError(
            body?.error ??
              'Could not start recording, so there will be no post-call transcript.',
          );
          return;
        }
      } catch {
        // Retry a network failure.
      }

      await new Promise((resolve) =>
        setTimeout(resolve, TRANSCRIPTION_RETRY_MS),
      );
    }

    recordingSidRef.current = null;
  }, []);

  /**
   * Kicks off whichever operations are switched on for this call. Safe to call
   * more than once: each operation is claimed by CallSid before it starts.
   */
  const startTranscription = useCallback(
    (sid: string) => {
      const settings = transcriptionRef.current;

      if (settings.liveCaptions && captionsSidRef.current !== sid) {
        captionsSidRef.current = sid;
        void startCaptions(sid);
      }

      if (settings.postCallTranscript && recordingSidRef.current !== sid) {
        recordingSidRef.current = sid;
        void startRecording(sid);
      }
    },
    [startCaptions, startRecording],
  );

  /**
   * Drops local transcription state when a call ends.
   *
   * Deliberately does not call Twilio: a transcription ends with its call, and
   * asking to stop one on a finished call just returns "call is not in the
   * expected state". The transcript itself is left on screen.
   */
  const forgetTranscription = useCallback(() => {
    captionsSidRef.current = null;
    recordingSidRef.current = null;
    setIsTranscribing(false);
  }, []);

  /** Stops a running transcription, for when the user switches captions off. */
  const stopTranscription = useCallback(
    (sid: string | null) => {
      forgetTranscription();
      if (!sid) return;

      void fetch('/api/twilio/transcription/start', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callSid: sid }),
      }).catch(() => undefined);
    },
    [forgetTranscription],
  );

  /**
   * Writes the finished call to localStorage. Idempotent per call, because
   * Twilio can emit both `error` and `disconnect` for a single failure.
   */
  const recordCall = useCallback((status: CallStatus, call: Call | null) => {
    const meta = metaRef.current;
    if (!meta || recordedRef.current) return;
    recordedRef.current = true;

    const endTime = new Date();
    const duration = meta.connectedAt
      ? Math.max(
          0,
          Math.round((endTime.getTime() - meta.connectedAt.getTime()) / 1000),
        )
      : 0;

    const callSid = call?.parameters?.CallSid || call?.outboundConnectionId || null;

    addCallRecord({
      id: createRecordId(),
      callSid,
      fromNumber: meta.from,
      toNumber: meta.to,
      direction: meta.direction,
      status,
      startTime: meta.startTime.toISOString(),
      endTime: endTime.toISOString(),
      duration,
    });

    metaRef.current = null;
  }, []);

  /**
   * Wires the shared lifecycle listeners onto a Call. Used for both outbound
   * calls and accepted incoming calls.
   */
  const attachCallHandlers = useCallback(
    (call: Call) => {
      /**
       * Publishes the call's SID as soon as Twilio assigns one.
       *
       * The SDK fills `parameters.CallSid` in from the signalling payload on
       * `ringing` and again on `answer`. `outboundConnectionId` is documented
       * as a *temporary* SID and is not accepted by the REST API, so it must
       * not be used here even though it is available sooner.
       */
      const publishCallSid = () => {
        const sid = call.parameters?.CallSid;
        if (!sid) return;
        setCallSid(sid);
        void startTranscription(sid);
      };

      call.on('accept', () => {
        if (metaRef.current) {
          metaRef.current.connectedAt = new Date();
        }
        setCallState('connected');
        setDurationSeconds(0);
        setIsMuted(call.isMuted());
        publishCallSid();
      });

      call.on('ringing', () => {
        setCallState('ringing');
        publishCallSid();
      });

      call.on('mute', (muted: boolean) => {
        setIsMuted(muted);
      });

      // Capture level, so the UI can show that the microphone really is picking
      // something up rather than leaving the user to guess.
      call.on('volume', (input: number) => {
        setInputLevel(quantiseLevel(input));
      });

      // The SDK raises `constant-audio-input-level` when the input level does
      // not change for ten consecutive samples -- a frozen or dead capture
      // track. It suppresses the warning while muted, so it will not fire just
      // because the user pressed mute.
      call.on('warning', (name: string) => {
        if (name === 'constant-audio-input-level') {
          setMicWarning(
            'Your microphone is not picking up any sound, so the other side ' +
              'cannot hear you. Check that the right microphone is selected ' +
              'below, and that your headset is not muted on the headset itself.',
          );
        }
      });

      call.on('warning-cleared', (name: string) => {
        if (name === 'constant-audio-input-level') {
          setMicWarning(null);
        }
      });

      call.on('reconnecting', () => {
        setError('Connection unstable. Reconnecting...');
      });

      call.on('reconnected', () => {
        setError(null);
      });

      call.on('disconnect', () => {
        // Connected then hung up -> completed. Never connected -> canceled.
        const connected = Boolean(metaRef.current?.connectedAt);
        recordCall(connected ? 'completed' : 'canceled', call);
        activeCallRef.current = null;
        setCallState('ended');
        setInputLevel(0);
        // The CallSid is deliberately left in place: the transcript panel keeps
        // showing the finished call, and the post-call transcript arrives on
        // that same SID minutes later.
        forgetTranscription();
        releaseInputDevice();
        scheduleReset();
      });

      call.on('cancel', () => {
        recordCall('missed', call);
        activeCallRef.current = null;
        incomingCallRef.current = null;
        setHasIncomingCall(false);
        setIncomingFrom(null);
        setCallState('ended');
        setInputLevel(0);
        forgetTranscription();
        releaseInputDevice();
        scheduleReset();
      });

      call.on('reject', () => {
        recordCall('rejected', call);
        activeCallRef.current = null;
        setCallState('ended');
        setInputLevel(0);
        forgetTranscription();
        releaseInputDevice();
        scheduleReset();
      });

      call.on('error', (twilioError: unknown) => {
        setError(describeTwilioError(twilioError));
        recordCall('failed', call);
        activeCallRef.current = null;
        setCallState('failed');
        setInputLevel(0);
        forgetTranscription();
        releaseInputDevice();
        scheduleReset();
      });
    },
    [
      forgetTranscription,
      recordCall,
      releaseInputDevice,
      scheduleReset,
      startTranscription,
    ],
  );

  /** Queues the next token refresh a little before the current one expires. */
  const scheduleRefresh = useCallback(
    (device: Device, expiresIn: number, refresh: (device: Device) => void) => {
      if (tokenTimerRef.current) clearTimeout(tokenTimerRef.current);
      tokenTimerRef.current = setTimeout(
        () => refresh(device),
        Math.max(30_000, expiresIn * 1000 - TOKEN_REFRESH_MARGIN_MS),
      );
    },
    [],
  );

  /**
   * Fetches a fresh token, hands it to the Device, and schedules the next
   * refresh. Declared as a named function expression so it can recurse on its
   * own name rather than the enclosing `const`.
   */
  const refreshToken = useCallback(
    async function refresh(device: Device): Promise<void> {
      try {
        const { token, expiresIn } = await fetchVoiceToken();
        device.updateToken(token);
        scheduleRefresh(device, expiresIn, refresh);
      } catch (err) {
        setError(describeTwilioError(err));
      }
    },
    [scheduleRefresh],
  );

  // Restore the remembered microphone before the Device is built, so the first
  // call already uses it.
  useEffect(() => {
    const stored = readPreferredMicrophoneId();
    if (stored) {
      selectedMicRef.current = stored;
      setSelectedMicrophoneId(stored);
    }
  }, []);

  // Restore the transcription toggles. Read in an effect rather than in
  // `useState`'s initialiser so the server-rendered markup and the first client
  // render agree -- localStorage does not exist on the server.
  useEffect(() => {
    const stored = readTranscriptionSettings();
    transcriptionRef.current = stored;
    setTranscription(stored);
  }, []);

  // Device lifecycle. Re-runs when `reinitialize` bumps `initToken`.
  useEffect(() => {
    let cancelled = false;
    let device: Device | null = null;

    /**
     * Set once the Device's own `error` event has reported something specific.
     * `register()` rejects with no argument, so without this a precise message
     * (for example "authentication failed") would be replaced by a generic one.
     */
    let deviceErrorReported = false;

    async function initialize() {
      setDeviceStatus('initializing');
      setError(null);

      try {
        const {
          token,
          identity: grantedIdentity,
          expiresIn,
        } = await fetchVoiceToken();
        if (cancelled) return;

        // Settle microphone permission *before* constructing the Device.
        //
        // The SDK snapshots the input-device list when its AudioHelper is
        // built, and `enumerateDevices` returns entries with blank IDs and
        // labels until the user has granted access at least once. Build the
        // Device on that blank list and `setInputDevice` rejects with "Device
        // not found", which silently drops the first call back to capturing
        // the browser default -- the very failure being fixed here.
        //
        // The wait is bounded so a user who ignores the prompt still ends up
        // with a registered phone; if the answer arrives later the SDK
        // refreshes its list from the Permissions API.
        const micPromise = ensureMicrophoneAccess(selectedMicRef.current).then(
          (granted) => {
            if (cancelled || !granted) return;
            selectedMicRef.current = granted;
            setSelectedMicrophoneId(granted);
            writePreferredMicrophoneId(granted);
            refreshMicrophones();
          },
          (micError: unknown) => {
            if (cancelled) return;
            // Calls stay possible -- they re-prompt -- so report this without
            // knocking the Device out of `ready`.
            setError(describeTwilioError(micError));
          },
        );
        await Promise.race([
          micPromise,
          new Promise((resolve) =>
            setTimeout(resolve, MIC_PERMISSION_WAIT_MS),
          ),
        ]);
        if (cancelled) return;

        device = new Device(token, {
          // Opus first for quality, PCMU as the interoperable fallback.
          codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
          // Keep the browser console quiet in production.
          logLevel: process.env.NODE_ENV === 'development' ? 'warn' : 'error',
        });

        device.on('registered', () => {
          if (cancelled) return;
          setDeviceStatus('ready');
        });

        device.on('unregistered', () => {
          if (cancelled) return;
          setDeviceStatus('offline');
        });

        device.on('error', (twilioError: unknown) => {
          if (cancelled) return;
          deviceErrorReported = true;
          setError(describeTwilioError(twilioError));
          setDeviceStatus('error');
        });

        device.on('tokenWillExpire', () => {
          if (cancelled || !device) return;
          void refreshToken(device);
        });

        device.on('incoming', (call: Call) => {
          if (cancelled) return;

          // Already busy: politely decline instead of stacking calls.
          if (activeCallRef.current) {
            call.reject();
            return;
          }

          const from = call.parameters.From || 'Unknown';
          incomingCallRef.current = call;
          recordedRef.current = false;
          metaRef.current = {
            direction: 'inbound',
            from,
            to: call.parameters.To || grantedIdentity,
            startTime: new Date(),
            connectedAt: null,
          };

          clearResetTimer();
          setIncomingFrom(from);
          setHasIncomingCall(true);
          setRemoteNumber(from);
          setCallState('ringing');

          // If the caller gives up before we answer, clear the incoming UI.
          call.on('cancel', () => {
            incomingCallRef.current = null;
            setHasIncomingCall(false);
            setIncomingFrom(null);
          });
        });

        // Apply the same capture processing the SDK uses when it acquires media
        // itself, so switching devices cannot silently change the processing.
        try {
          await device.audio?.setAudioConstraints(MIC_CONSTRAINTS);
        } catch {
          // Constraints are an optimisation; a rejection must not stop setup.
        }

        // Keep the device list current when a headset is plugged or unplugged.
        device.audio?.on('deviceChange', () => {
          if (cancelled) return;
          refreshMicrophones();
        });

        deviceRef.current = device;
        setIdentity(grantedIdentity);

        try {
          await device.register();
        } catch (registerError) {
          if (cancelled) return;
          // The `error` event above carries the real reason when there is one;
          // only fall back to a generic message when it stayed silent.
          if (!deviceErrorReported) {
            setError(
              registerError == null
                ? 'Could not register for incoming calls. Check your connection and retry.'
                : describeTwilioError(registerError),
            );
          }
          setDeviceStatus('error');
          return;
        }
        if (cancelled) return;

        scheduleRefresh(device, expiresIn, refreshToken);
        refreshMicrophones();
      } catch (err) {
        if (cancelled) return;
        if (!deviceErrorReported) {
          setError(describeTwilioError(err));
        }
        setDeviceStatus('error');
      }
    }

    void initialize();

    return () => {
      cancelled = true;
      if (tokenTimerRef.current) {
        clearTimeout(tokenTimerRef.current);
        tokenTimerRef.current = null;
      }
      // Tear down fully so React Strict Mode's double-mount cannot leave two
      // devices registered on the same identity.
      const current = device ?? deviceRef.current;
      if (current) {
        current.audio?.removeAllListeners();
        current.removeAllListeners();
        current.destroy();
      }
      if (deviceRef.current === current) {
        deviceRef.current = null;
      }
      activeCallRef.current = null;
      incomingCallRef.current = null;
      // `removeAllListeners` above took the meter's listener with it.
      micTestListenerRef.current = null;
      setIsTestingMic(false);
    };
  }, [
    initToken,
    refreshToken,
    scheduleRefresh,
    clearResetTimer,
    refreshMicrophones,
  ]);

  // Call timer. Recomputed from the connect timestamp so it cannot drift.
  useEffect(() => {
    if (callState !== 'connected') return;

    const tick = () => {
      const connectedAt = metaRef.current?.connectedAt;
      if (!connectedAt) return;
      setDurationSeconds(
        Math.max(0, Math.floor((Date.now() - connectedAt.getTime()) / 1000)),
      );
    };

    tick();
    const interval = setInterval(tick, 500);
    return () => clearInterval(interval);
  }, [callState]);

  // Clean up the reset timer on unmount.
  useEffect(() => clearResetTimer, [clearResetTimer]);

  const startCall = useCallback(
    async (destination: string) => {
      const device = deviceRef.current;

      if (!device) {
        setError('Calling is not ready yet. Please wait a moment.');
        return;
      }
      if (activeCallRef.current) {
        setError('A call is already in progress.');
        return;
      }

      // The call takes over the input device from here.
      detachMicTestListener();

      clearResetTimer();
      setError(null);
      setMicWarning(null);
      setCallState('calling');
      setRemoteNumber(destination);
      setDurationSeconds(0);
      setIsMuted(false);
      setInputLevel(0);
      // A new call gets a new transcript; clearing the SID resets the panel.
      setCallSid(null);

      recordedRef.current = false;
      metaRef.current = {
        direction: 'outbound',
        from: identity ?? 'browser',
        to: destination,
        startTime: new Date(),
        connectedAt: null,
      };

      try {
        // Pin the microphone before dialling. A denial then reads as a clear
        // message instead of a mid-call failure, and the call gets the device
        // the user chose rather than the browser's guess.
        await prepareInputDevice(device);

        const call = await device.connect({ params: { To: destination } });
        activeCallRef.current = call;
        attachCallHandlers(call);
      } catch (err) {
        setError(describeTwilioError(err));
        recordCall('failed', activeCallRef.current);
        activeCallRef.current = null;
        setCallState('failed');
        releaseInputDevice();
        scheduleReset();
      }
    },
    [
      attachCallHandlers,
      clearResetTimer,
      detachMicTestListener,
      identity,
      prepareInputDevice,
      recordCall,
      releaseInputDevice,
      scheduleReset,
    ],
  );

  const hangUp = useCallback(() => {
    const call = activeCallRef.current;
    if (call) {
      call.disconnect();
      return;
    }
    // No active call: just clear a lingering terminal state.
    setCallState('idle');
    setRemoteNumber(null);
  }, []);

  const acceptIncoming = useCallback(() => {
    const call = incomingCallRef.current;
    const device = deviceRef.current;
    if (!call) return;

    // The call takes over the input device from here.
    detachMicTestListener();

    incomingCallRef.current = null;
    activeCallRef.current = call;
    setHasIncomingCall(false);
    setIncomingFrom(null);
    setMicWarning(null);
    setInputLevel(0);
    setCallSid(null);

    attachCallHandlers(call);

    // Acquire the chosen microphone before answering, exactly as for an
    // outbound call. The inbound path previously did neither, so an answered
    // call captured whatever `getUserMedia({ audio: true })` happened to
    // return -- the same silent-microphone failure, with no permission prompt
    // at all if access had never been granted.
    void (async () => {
      try {
        if (device) {
          await prepareInputDevice(device);
        }
        call.accept();
      } catch (err) {
        setError(describeTwilioError(err));
        activeCallRef.current = null;
        setCallState('failed');
        try {
          call.reject();
        } catch {
          // The caller may already be gone.
        }
        scheduleReset();
      }
    })();
  }, [
    attachCallHandlers,
    detachMicTestListener,
    prepareInputDevice,
    scheduleReset,
  ]);

  const rejectIncoming = useCallback(() => {
    const call = incomingCallRef.current;
    if (!call) return;

    incomingCallRef.current = null;
    setHasIncomingCall(false);
    setIncomingFrom(null);

    try {
      call.reject();
    } catch {
      // The caller may have already hung up; nothing to report.
    }

    recordCall('rejected', call);
    setCallState('ended');
    scheduleReset();
  }, [recordCall, scheduleReset]);

  const toggleMute = useCallback(() => {
    const call = activeCallRef.current;
    if (!call) return;

    const next = !call.isMuted();
    call.mute(next);
    setIsMuted(next);
  }, []);

  const sendDigit = useCallback((digit: string) => {
    const call = activeCallRef.current;
    if (!call) return;
    if (!/^[0-9*#]$/.test(digit)) return;
    call.sendDigits(digit);
  }, []);

  /**
   * Switches the capture device. Applied immediately when a call is live --
   * `setInputDevice` replaces the outgoing track on the peer connection -- so a
   * call that started on the wrong microphone can be rescued without hanging
   * up.
   */
  const selectMicrophone = useCallback((deviceId: string) => {
    selectedMicRef.current = deviceId;
    setSelectedMicrophoneId(deviceId);
    writePreferredMicrophoneId(deviceId);
    setMicWarning(null);

    const audio = deviceRef.current?.audio;
    if (!audio) return;

    void audio.setInputDevice(deviceId).catch((err: unknown) => {
      setError(describeTwilioError(err));
    });
  }, []);

  const setTranscriptionOption = useCallback(
    (option: keyof TranscriptionSettings, enabled: boolean) => {
      const next: TranscriptionSettings = {
        ...transcriptionRef.current,
        [option]: enabled,
      };
      transcriptionRef.current = next;
      setTranscription(next);
      writeTranscriptionSettings(next);

      const sid = activeCallRef.current?.parameters?.CallSid;
      if (!sid) return;

      // Captions can be turned on and off during a call. Recording cannot be
      // un-started, so switching the post-call transcript off mid-call only
      // affects the next call -- the toggle text says so.
      if (option === 'liveCaptions') {
        if (enabled) {
          void startTranscription(sid);
        } else {
          stopTranscription(sid);
        }
        return;
      }

      if (option === 'postCallTranscript' && enabled) {
        void startTranscription(sid);
      }
    },
    [startTranscription, stopTranscription],
  );

  const toggleMicTest = useCallback(() => {
    if (isTestingMic) {
      stopMicTest();
      return;
    }
    void startMicTest();
  }, [isTestingMic, startMicTest, stopMicTest]);

  const dismissError = useCallback(() => setError(null), []);

  const reinitialize = useCallback(() => {
    setInitToken((n) => n + 1);
  }, []);

  return {
    deviceStatus,
    identity,
    callState,
    remoteNumber,
    incomingFrom,
    hasIncomingCall,
    isMuted,
    durationSeconds,
    error,
    microphones,
    selectedMicrophoneId,
    inputLevel,
    micWarning,
    isTestingMic,
    callSid,
    transcription,
    isTranscribing,
    startCall,
    hangUp,
    acceptIncoming,
    rejectIncoming,
    toggleMute,
    sendDigit,
    selectMicrophone,
    refreshMicrophones,
    toggleMicTest,
    setTranscriptionOption,
    dismissError,
    reinitialize,
  };
}
