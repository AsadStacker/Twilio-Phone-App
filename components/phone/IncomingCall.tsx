'use client';

import { formatPhoneNumber } from '@/lib/twilio/validation';

interface IncomingCallProps {
  from: string | null;
  onAccept: () => void;
  onReject: () => void;
}

/** Full-screen modal shown while an inbound call is ringing. */
export default function IncomingCall({ from, onAccept, onReject }: IncomingCallProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="incoming-call-title"
    >
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-slate-900/95 p-8 text-center shadow-2xl">
        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
          Incoming call
        </p>

        <div className="mt-6 flex justify-center">
          <span className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300">
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-9 w-9 animate-pulse"
              aria-hidden="true"
            >
              <path d="M6.6 10.8c1.3 2.6 3.5 4.7 6.1 6.1l2-2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.5.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.7c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.5.1.4 0 .8-.2 1l-2 2Z" />
            </svg>
          </span>
        </div>

        <h2
          id="incoming-call-title"
          className="mt-5 text-xl font-medium text-slate-50"
        >
          {formatPhoneNumber(from)}
        </h2>
        <p className="mt-1 text-sm text-slate-400">is calling you</p>

        <div className="mt-8 flex items-center justify-center gap-8">
          <button
            type="button"
            onClick={onReject}
            aria-label="Reject call"
            className="flex flex-col items-center gap-2"
          >
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-rose-500 text-white shadow-lg shadow-rose-500/25 transition hover:bg-rose-400 active:scale-95">
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                className="h-7 w-7 rotate-[135deg]"
                aria-hidden="true"
              >
                <path d="M6.6 10.8c1.3 2.6 3.5 4.7 6.1 6.1l2-2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.5.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.7c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.5.1.4 0 .8-.2 1l-2 2Z" />
              </svg>
            </span>
            <span className="text-xs text-slate-400">Decline</span>
          </button>

          <button
            type="button"
            onClick={onAccept}
            aria-label="Accept call"
            className="flex flex-col items-center gap-2"
          >
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/25 transition hover:bg-emerald-400 active:scale-95">
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                className="h-7 w-7"
                aria-hidden="true"
              >
                <path d="M6.6 10.8c1.3 2.6 3.5 4.7 6.1 6.1l2-2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.5.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.7c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.5.1.4 0 .8-.2 1l-2 2Z" />
              </svg>
            </span>
            <span className="text-xs text-slate-400">Accept</span>
          </button>
        </div>
      </div>
    </div>
  );
}
