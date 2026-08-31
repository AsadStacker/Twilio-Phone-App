/**
 * Phone number helpers. Safe to import from both client and server code --
 * this module must never touch Twilio credentials.
 */

/** Twilio Voice SDK client identities look like `client:alice`. */
export const CLIENT_IDENTITY_PREFIX = 'client:';

/**
 * Strips everything except digits and a single leading `+`.
 * Useful for turning user keypad input into something checkable.
 */
export function normalizePhoneNumber(input: string): string {
  const trimmed = input.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  return hasPlus ? `+${digits}` : digits;
}

/**
 * Best-effort conversion to E.164. A bare 10-digit number is assumed to be
 * NANP (+1) since that is by far the most common case for a Twilio trial
 * number; anything else must already carry its country code.
 */
export function toE164(input: string): string | null {
  const normalized = normalizePhoneNumber(input);
  const digits = normalized.replace(/\D/g, '');

  if (digits.length === 0) return null;

  if (normalized.startsWith('+')) {
    return isValidE164(normalized) ? normalized : null;
  }

  // 10 digits -> assume US/Canada.
  if (digits.length === 10) {
    return `+1${digits}`;
  }

  // 11 digits starting with 1 -> US/Canada with country code, no plus.
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  const candidate = `+${digits}`;
  return isValidE164(candidate) ? candidate : null;
}

/**
 * E.164: a `+`, a non-zero country code digit, then up to 14 more digits.
 */
export function isValidE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

/** True when the dial target is another browser client rather than a PSTN number. */
export function isClientIdentity(value: string): boolean {
  return value.trim().toLowerCase().startsWith(CLIENT_IDENTITY_PREFIX);
}

export type PhoneValidationResult =
  | { ok: true; e164: string }
  | { ok: false; error: string };

/**
 * Validates user-entered dial input and returns either an E.164 number or a
 * short, user-facing error message.
 */
export function validateDialTarget(input: string): PhoneValidationResult {
  const raw = input.trim();

  if (!raw) {
    return { ok: false, error: 'Enter a phone number to call.' };
  }

  if (isClientIdentity(raw)) {
    const identity = raw.slice(CLIENT_IDENTITY_PREFIX.length).trim();
    if (!identity) {
      return { ok: false, error: 'Enter a client identity after "client:".' };
    }
    return { ok: true, e164: raw };
  }

  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7) {
    return { ok: false, error: 'That number looks too short.' };
  }
  if (digits.length > 15) {
    return { ok: false, error: 'That number looks too long.' };
  }

  const e164 = toE164(raw);
  if (!e164) {
    return {
      ok: false,
      error: 'Use international format, for example +14155552671.',
    };
  }

  return { ok: true, e164 };
}

/**
 * Formats a number for display. Renders NANP numbers as +1 (415) 555-2671 and
 * leaves everything else in plain E.164.
 */
export function formatPhoneNumber(value: string | null | undefined): string {
  if (!value) return 'Unknown';

  if (isClientIdentity(value)) {
    return value.slice(CLIENT_IDENTITY_PREFIX.length);
  }

  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(value);
  if (match) {
    return `+1 (${match[1]}) ${match[2]}-${match[3]}`;
  }

  return value;
}
