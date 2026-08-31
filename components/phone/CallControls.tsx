'use client';

import type { CallState } from '@/lib/types';

interface CallControlsProps {
  callState: CallState;
  isMuted: boolean;
  canCall: boolean;
  onCall: () => void;
  onHangUp: () => void;
  onToggleMute: () => void;
}

/** Green call button when idle; mute + red end button while a call is live. */
export default function CallControls({
  callState,
  isMuted,
  canCall,
  onCall,
  onHangUp,
  onToggleMute,
}: CallControlsProps) {
  const isActive =
    callState === 'calling' || callState === 'ringing' || callState === 'connected';

  if (!isActive) {
    return (
      <div className="flex justify-center">
        <button
          type="button"
          onClick={onCall}
          disabled={!canCall}
          aria-label="Start call"
          className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-400 active:scale-95 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500 disabled:shadow-none"
        >
          <PhoneIcon className="h-7 w-7" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center gap-6">
      <button
        type="button"
        onClick={onToggleMute}
        disabled={callState !== 'connected'}
        aria-pressed={isMuted}
        aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
        className={`flex h-14 w-14 items-center justify-center rounded-full border transition active:scale-95 disabled:opacity-40 ${
          isMuted
            ? 'border-amber-400/40 bg-amber-500/20 text-amber-300'
            : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'
        }`}
      >
        {isMuted ? (
          <MicOffIcon className="h-6 w-6" />
        ) : (
          <MicIcon className="h-6 w-6" />
        )}
      </button>

      <button
        type="button"
        onClick={onHangUp}
        aria-label="End call"
        className="flex h-16 w-16 items-center justify-center rounded-full bg-rose-500 text-white shadow-lg shadow-rose-500/20 transition hover:bg-rose-400 active:scale-95"
      >
        <PhoneIcon className="h-7 w-7 rotate-[135deg]" />
      </button>
    </div>
  );
}

function PhoneIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M6.6 10.8c1.3 2.6 3.5 4.7 6.1 6.1l2-2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.5.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.7c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.5.1.4 0 .8-.2 1l-2 2Z" />
    </svg>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function MicOffIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M9 9V6a3 3 0 0 1 5.6-1.5M15 12v-1M5 11a7 7 0 0 0 11.3 5.5M9.2 14.8A3 3 0 0 0 15 14M12 18v3M3 3l18 18" />
    </svg>
  );
}
