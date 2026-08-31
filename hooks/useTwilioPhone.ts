'use client';

/**
 * Owns the Twilio Voice Device lifecycle and exposes the whole phone as plain
 * React state: current call state, mute, duration, incoming call, errors.
 *
 * The SDK is event-driven and its objects are mutable, so live Device/Call
 * instances are kept in refs and mirrored into state for rendering.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Call, Device } from '@twilio/voice-sdk';

import {
  describeTwilioError,
  fetchVoiceToken,
  requestMicrophoneAccess,
} from '@/lib/twilio/client';
import { addCallRecord, createRecordId } from '@/lib/storage/call-history';
import type { CallDirection, CallState, CallStatus } from '@/lib/types';

/** How long the "Ended"/"Failed" state lingers before returning to Idle. */
const RESET_DELAY_MS = 3000;

/** Refresh the access token this many ms before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 30_000;

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
  startCall: (destination: string) => Promise<void>;
  hangUp: () => void;
  acceptIncoming: () => void;
  rejectIncoming: () => void;
  toggleMute: () => void;
  sendDigit: (digit: string) => void;
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
  const [initToken, setInitToken] = useState(0);

  const deviceRef = useRef<Device | null>(null);
  const activeCallRef = useRef<Call | null>(null);
  const incomingCallRef = useRef<Call | null>(null);
  const metaRef = useRef<CallMeta | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Guards against writing two history records for one call. */
  const recordedRef = useRef(false);

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
    }, RESET_DELAY_MS);
  }, [clearResetTimer]);

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
      call.on('accept', () => {
        if (metaRef.current) {
          metaRef.current.connectedAt = new Date();
        }
        setCallState('connected');
        setDurationSeconds(0);
        setIsMuted(call.isMuted());
      });

      call.on('ringing', () => {
        setCallState('ringing');
      });

      call.on('mute', (muted: boolean) => {
        setIsMuted(muted);
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
        scheduleReset();
      });

      call.on('cancel', () => {
        recordCall('missed', call);
        activeCallRef.current = null;
        incomingCallRef.current = null;
        setHasIncomingCall(false);
        setIncomingFrom(null);
        setCallState('ended');
        scheduleReset();
      });

      call.on('reject', () => {
        recordCall('rejected', call);
        activeCallRef.current = null;
        setCallState('ended');
        scheduleReset();
      });

      call.on('error', (twilioError: unknown) => {
        setError(describeTwilioError(twilioError));
        recordCall('failed', call);
        activeCallRef.current = null;
        setCallState('failed');
        scheduleReset();
      });
    },
    [recordCall, scheduleReset],
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
        current.removeAllListeners();
        current.destroy();
      }
      if (deviceRef.current === current) {
        deviceRef.current = null;
      }
      activeCallRef.current = null;
      incomingCallRef.current = null;
    };
  }, [initToken, refreshToken, scheduleRefresh, clearResetTimer]);

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

      clearResetTimer();
      setError(null);
      setCallState('calling');
      setRemoteNumber(destination);
      setDurationSeconds(0);
      setIsMuted(false);

      recordedRef.current = false;
      metaRef.current = {
        direction: 'outbound',
        from: identity ?? 'browser',
        to: destination,
        startTime: new Date(),
        connectedAt: null,
      };

      try {
        // Settle microphone permission before dialling, so a denial reads as a
        // clear message rather than a mid-call failure.
        await requestMicrophoneAccess();

        const call = await device.connect({ params: { To: destination } });
        activeCallRef.current = call;
        attachCallHandlers(call);
      } catch (err) {
        setError(describeTwilioError(err));
        recordCall('failed', activeCallRef.current);
        activeCallRef.current = null;
        setCallState('failed');
        scheduleReset();
      }
    },
    [attachCallHandlers, clearResetTimer, identity, recordCall, scheduleReset],
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
    if (!call) return;

    incomingCallRef.current = null;
    activeCallRef.current = call;
    setHasIncomingCall(false);
    setIncomingFrom(null);

    attachCallHandlers(call);

    try {
      call.accept();
    } catch (err) {
      setError(describeTwilioError(err));
      setCallState('failed');
      scheduleReset();
    }
  }, [attachCallHandlers, scheduleReset]);

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
    startCall,
    hangUp,
    acceptIncoming,
    rejectIncoming,
    toggleMute,
    sendDigit,
    dismissError,
    reinitialize,
  };
}
