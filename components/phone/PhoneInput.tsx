'use client';

import { formatPhoneNumber } from '@/lib/twilio/validation';

interface PhoneInputProps {
  value: string;
  onChange: (value: string) => void;
  onBackspace: () => void;
  onSubmit: () => void;
  disabled?: boolean;
  /** E.164 preview of the current input, shown when it differs from the raw text. */
  preview?: string | null;
}

export default function PhoneInput({
  value,
  onChange,
  onBackspace,
  onSubmit,
  disabled = false,
  preview,
}: PhoneInputProps) {
  const showPreview = Boolean(preview) && preview !== value;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={value}
          disabled={disabled}
          placeholder="+1 415 555 2671"
          aria-label="Phone number to call"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onSubmit();
            }
          }}
          className="tabular w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-center text-2xl font-light tracking-wide text-slate-50 placeholder:text-slate-600 focus:border-sky-400/60 focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={onBackspace}
          disabled={disabled || value.length === 0}
          aria-label="Delete last digit"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/5 bg-white/5 text-slate-300 transition hover:bg-white/10 active:scale-95 disabled:opacity-30"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            className="h-5 w-5"
            aria-hidden="true"
          >
            <path
              d="M20 5H9.5L3 12l6.5 7H20a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1Z"
              strokeLinejoin="round"
            />
            <path d="m12 9.5 5 5m0-5-5 5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <p className="h-4 text-center text-xs text-slate-500">
        {showPreview ? `Will dial ${formatPhoneNumber(preview)}` : ''}
      </p>
    </div>
  );
}
