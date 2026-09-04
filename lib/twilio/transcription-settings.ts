/**
 * The three transcription toggles, persisted per browser.
 *
 * Kept beside the microphone preference in lib/twilio/audio.ts and read the
 * same way: localStorage, every access guarded, and a sane default whenever
 * storage is unavailable or holds something unexpected.
 *
 * All three default off. Each one costs money per minute and records what
 * people say, so neither should start happening because a page loaded.
 */

/** localStorage key holding the toggle state. */
export const TRANSCRIPTION_SETTINGS_KEY = 'twilio_transcription_settings';

export interface TranscriptionSettings {
  /** Live captions on screen, via Twilio Real-Time Transcription. */
  liveCaptions: boolean;
  /** Write the live transcript to a file on the server, for testing. */
  saveCaptions: boolean;
  /**
   * Record the call and fetch Twilio's own post-call transcript from
   * Conversational Intelligence, to compare against the live one.
   */
  postCallTranscript: boolean;
}

export const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionSettings = {
  liveCaptions: false,
  saveCaptions: false,
  postCallTranscript: false,
};

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function readTranscriptionSettings(): TranscriptionSettings {
  if (!isBrowser()) return DEFAULT_TRANSCRIPTION_SETTINGS;

  try {
    const raw = window.localStorage.getItem(TRANSCRIPTION_SETTINGS_KEY);
    if (!raw) return DEFAULT_TRANSCRIPTION_SETTINGS;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return DEFAULT_TRANSCRIPTION_SETTINGS;
    }

    const stored = parsed as Partial<Record<keyof TranscriptionSettings, unknown>>;

    // Each flag is read individually rather than spread, so a corrupt or
    // out-of-date value can only ever fail closed.
    return {
      liveCaptions: stored.liveCaptions === true,
      saveCaptions: stored.saveCaptions === true,
      postCallTranscript: stored.postCallTranscript === true,
    };
  } catch {
    return DEFAULT_TRANSCRIPTION_SETTINGS;
  }
}

export function writeTranscriptionSettings(settings: TranscriptionSettings): void {
  if (!isBrowser()) return;

  try {
    window.localStorage.setItem(
      TRANSCRIPTION_SETTINGS_KEY,
      JSON.stringify(settings),
    );
  } catch {
    // Non-fatal: the choice just will not survive a reload.
  }
}
