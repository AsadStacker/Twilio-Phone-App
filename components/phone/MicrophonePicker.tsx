'use client';

import {
  LEVEL_METER_SEGMENTS,
  levelToSegments,
  microphoneLabel,
} from '@/lib/twilio/audio';

interface MicrophonePickerProps {
  microphones: MediaDeviceInfo[];
  selectedId: string | null;
  /** 0-1 capture level, from the live call or the idle test. */
  level: number;
  /** True while a call is connected, so the meter is driven by the call. */
  live: boolean;
  isTesting: boolean;
  warning: string | null;
  onSelect: (deviceId: string) => void;
  onToggleTest: () => void;
}

/**
 * Microphone selection plus a level meter.
 *
 * The meter is the point of this component. A browser phone can play audio
 * perfectly in both directions while capturing from the wrong device, and
 * nothing on screen would say so -- the only symptom is the other side saying
 * "I cannot hear you". Showing the live capture level makes that visible
 * before, and during, a call.
 */
export default function MicrophonePicker({
  microphones,
  selectedId,
  level,
  live,
  isTesting,
  warning,
  onSelect,
  onToggleTest,
}: MicrophonePickerProps) {
  const metering = live || isTesting;
  const filled = metering ? levelToSegments(level) : 0;

  return (
    <section
      className="rounded-2xl border border-white/10 bg-white/[0.02] p-4"
      aria-label="Microphone"
    >
      <div className="flex items-center justify-between gap-3">
        <label
          htmlFor="microphone-select"
          className="text-xs font-medium uppercase tracking-wider text-slate-400"
        >
          Microphone
        </label>
        <button
          type="button"
          onClick={onToggleTest}
          disabled={live}
          aria-pressed={isTesting}
          className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isTesting ? 'Stop test' : 'Test mic'}
        </button>
      </div>

      <select
        id="microphone-select"
        value={selectedId ?? ''}
        onChange={(event) => onSelect(event.target.value)}
        disabled={microphones.length === 0}
        className="mt-2 w-full rounded-xl border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-emerald-400/50 disabled:opacity-50"
      >
        {microphones.length === 0 ? (
          <option value="">Waiting for microphone access...</option>
        ) : null}
        {selectedId && !microphones.some((d) => d.deviceId === selectedId) ? (
          <option value={selectedId}>Selected device (unavailable)</option>
        ) : null}
        {microphones.map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>
            {microphoneLabel(device, index)}
          </option>
        ))}
      </select>

      {/* Level meter */}
      <div className="mt-3 flex items-center gap-2">
        <div
          className="flex h-2.5 flex-1 gap-[3px]"
          role="meter"
          aria-label="Microphone input level"
          aria-valuemin={0}
          aria-valuemax={LEVEL_METER_SEGMENTS}
          aria-valuenow={filled}
        >
          {Array.from({ length: LEVEL_METER_SEGMENTS }, (_, index) => (
            <span
              key={index}
              className={`flex-1 rounded-sm transition-colors duration-75 ${
                index < filled
                  ? index > LEVEL_METER_SEGMENTS - 3
                    ? 'bg-amber-400'
                    : 'bg-emerald-400'
                  : 'bg-white/10'
              }`}
            />
          ))}
        </div>
        <span className="w-24 shrink-0 text-right text-[11px] text-slate-500">
          {metering ? (filled > 0 ? 'Picking up' : 'No sound') : 'Not measuring'}
        </span>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        {isTesting
          ? 'Speak now -- the bar should move. If it stays flat, choose a different device.'
          : live
            ? 'The bar shows what the other side is receiving from you.'
            : 'Headsets often expose more than one input. Test before you call.'}
      </p>

      {warning ? (
        <p
          className="mt-3 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200"
          role="status"
        >
          {warning}
        </p>
      ) : null}
    </section>
  );
}
