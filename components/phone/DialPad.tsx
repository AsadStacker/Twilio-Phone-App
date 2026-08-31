'use client';

/** Standard 12-key telephone keypad with letter sublabels. */
const KEYS: { digit: string; letters?: string }[] = [
  { digit: '1' },
  { digit: '2', letters: 'ABC' },
  { digit: '3', letters: 'DEF' },
  { digit: '4', letters: 'GHI' },
  { digit: '5', letters: 'JKL' },
  { digit: '6', letters: 'MNO' },
  { digit: '7', letters: 'PQRS' },
  { digit: '8', letters: 'TUV' },
  { digit: '9', letters: 'WXYZ' },
  { digit: '*' },
  { digit: '0', letters: '+' },
  { digit: '#' },
];

interface DialPadProps {
  onPress: (digit: string) => void;
  disabled?: boolean;
}

export default function DialPad({ onPress, disabled = false }: DialPadProps) {
  return (
    <div className="grid grid-cols-3 gap-3" role="group" aria-label="Keypad">
      {KEYS.map(({ digit, letters }) => (
        <button
          key={digit}
          type="button"
          onClick={() => onPress(digit)}
          disabled={disabled}
          aria-label={`Dial ${digit}`}
          className="flex h-16 flex-col items-center justify-center rounded-2xl border border-white/5 bg-white/5 transition active:scale-95 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="text-2xl font-light leading-none text-slate-50">
            {digit}
          </span>
          {letters ? (
            <span className="mt-1 text-[10px] tracking-widest text-slate-400">
              {letters}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
