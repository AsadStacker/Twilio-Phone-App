'use client';

/** Renders elapsed connected time as mm:ss (or h:mm:ss past an hour). */
export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

interface CallTimerProps {
  seconds: number;
  /** Dim the timer once the call is over. */
  active?: boolean;
}

export default function CallTimer({ seconds, active = true }: CallTimerProps) {
  return (
    <span
      className={`tabular text-2xl font-light ${
        active ? 'text-emerald-300' : 'text-slate-500'
      }`}
      aria-label="Call duration"
      role="timer"
    >
      {formatDuration(seconds)}
    </span>
  );
}
