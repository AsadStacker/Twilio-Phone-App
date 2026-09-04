'use client';

import type { TranscriptionSettings } from '@/lib/twilio/transcription-settings';

interface TranscriptionControlsProps {
  settings: TranscriptionSettings;
  /** True while Twilio is actually transcribing the current call. */
  isTranscribing: boolean;
  /** True while a call is connected, which changes what a toggle can affect. */
  inCall: boolean;
  onChange: (option: keyof TranscriptionSettings, enabled: boolean) => void;
}

interface ToggleSpec {
  key: keyof TranscriptionSettings;
  label: string;
  /** What it does, and what it costs, in one line. */
  hint: string;
  /** Shown instead of `hint` while a call is up, when that changes. */
  inCallHint?: string;
}

const TOGGLES: readonly ToggleSpec[] = [
  {
    key: 'liveCaptions',
    label: 'Live captions',
    hint: 'Twilio transcribes both sides as you talk. Billed per minute.',
    inCallHint: 'Can be turned on and off during this call.',
  },
  {
    key: 'saveCaptions',
    label: 'Save captions to file',
    hint: 'Writes the live transcript to the server, for testing. Needs live captions on.',
  },
  {
    key: 'postCallTranscript',
    label: "Twilio's post-call transcript",
    hint: 'Records the call and fetches Twilio’s own transcript afterwards, to compare.',
    inCallHint: 'Switching this on now starts recording; switching it off applies to the next call.',
  },
];

/**
 * The three transcription toggles.
 *
 * All default off and each is a separate decision, because they differ in what
 * they cost and where the words end up: captions are transient, the file writer
 * puts them on disk, and the post-call transcript records the call and hands
 * the audio to Twilio for a second pass.
 */
export default function TranscriptionControls({
  settings,
  isTranscribing,
  inCall,
  onChange,
}: TranscriptionControlsProps) {
  return (
    <section
      className="rounded-2xl border border-white/10 bg-white/[0.02] p-4"
      aria-label="Transcription"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-slate-400">
          Transcription
        </h2>
        {isTranscribing ? (
          <span className="flex items-center gap-1.5 text-[11px] text-emerald-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            Transcribing
          </span>
        ) : null}
      </div>

      <div className="mt-3 space-y-3">
        {TOGGLES.map((toggle) => {
          // Saving is meaningless without something to save.
          const disabled = toggle.key === 'saveCaptions' && !settings.liveCaptions;
          const checked = settings[toggle.key] && !disabled;

          return (
            <label
              key={toggle.key}
              className={`flex cursor-pointer items-start gap-3 ${
                disabled ? 'cursor-not-allowed opacity-50' : ''
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event) => onChange(toggle.key, event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-white/20 bg-slate-900/60 accent-emerald-500 disabled:cursor-not-allowed"
              />
              <span className="min-w-0">
                <span className="block text-sm text-slate-200">{toggle.label}</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">
                  {inCall && toggle.inCallHint ? toggle.inCallHint : toggle.hint}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}
