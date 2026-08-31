'use client';

import type { CallState } from '@/lib/types';
import type { DeviceStatus } from '@/hooks/useTwilioPhone';
import { formatPhoneNumber } from '@/lib/twilio/validation';

const STATE_LABELS: Record<CallState, string> = {
  idle: 'Ready',
  calling: 'Calling...',
  ringing: 'Ringing...',
  connected: 'Connected',
  ended: 'Call ended',
  failed: 'Call failed',
};

const STATE_STYLES: Record<CallState, string> = {
  idle: 'bg-slate-700/40 text-slate-300',
  calling: 'bg-amber-500/15 text-amber-300',
  ringing: 'bg-amber-500/15 text-amber-300',
  connected: 'bg-emerald-500/15 text-emerald-300',
  ended: 'bg-slate-700/40 text-slate-400',
  failed: 'bg-rose-500/15 text-rose-300',
};

const DEVICE_LABELS: Record<DeviceStatus, string> = {
  initializing: 'Connecting to Twilio',
  ready: 'Registered',
  offline: 'Offline',
  error: 'Not connected',
};

const DEVICE_DOTS: Record<DeviceStatus, string> = {
  initializing: 'bg-amber-400 animate-pulse',
  ready: 'bg-emerald-400',
  offline: 'bg-slate-500',
  error: 'bg-rose-400',
};

interface CallStatusProps {
  callState: CallState;
  deviceStatus: DeviceStatus;
  identity: string | null;
  remoteNumber: string | null;
}

/** While idle the pill reflects the device, so it cannot read "Ready" offline. */
function idleLabel(deviceStatus: DeviceStatus): string {
  switch (deviceStatus) {
    case 'ready':
      return 'Ready';
    case 'initializing':
      return 'Starting up...';
    default:
      return 'Unavailable';
  }
}

export default function CallStatus({
  callState,
  deviceStatus,
  identity,
  remoteNumber,
}: CallStatusProps) {
  const inCall = callState !== 'idle';
  const pulsing = callState === 'calling' || callState === 'ringing';

  const label = callState === 'idle' ? idleLabel(deviceStatus) : STATE_LABELS[callState];
  const style =
    callState === 'idle' && deviceStatus !== 'ready' && deviceStatus !== 'initializing'
      ? 'bg-rose-500/15 text-rose-300'
      : STATE_STYLES[callState];

  return (
    <div className="flex flex-col items-center gap-2">
      {/* Device registration -- separate from the per-call status. */}
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <span
          className={`h-2 w-2 rounded-full ${DEVICE_DOTS[deviceStatus]}`}
          aria-hidden="true"
        />
        <span>
          {DEVICE_LABELS[deviceStatus]}
          {deviceStatus === 'ready' && identity ? ` as ${identity}` : ''}
        </span>
      </div>

      <div
        className={`rounded-full px-4 py-1 text-sm font-medium ${style} ${
          pulsing ? 'animate-pulse' : ''
        }`}
        role="status"
        aria-live="polite"
      >
        {label}
      </div>

      {inCall && remoteNumber ? (
        <p className="text-lg font-medium text-slate-100">
          {formatPhoneNumber(remoteNumber)}
        </p>
      ) : null}
    </div>
  );
}
