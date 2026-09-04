/**
 * Shape of Twilio's Real-Time Transcription callbacks, and the rules for
 * turning one into a `TranscriptCue`.
 *
 * Twilio forks the call audio to its own speech engine and POSTs results to
 * `statusCallbackUrl`. The payload is form-encoded and its fields differ per
 * event, which is the whole reason this module exists: `transcription-started`
 * carries the track labels, and `transcription-content` -- every event that
 * actually has words in it -- does not. Speaker attribution therefore has to be
 * remembered from the start event and applied to the content events, which is
 * what `lib/server/transcript-broker.ts` does with `resolveSpeaker`.
 */

import type { TranscriptCue, TranscriptSpeaker } from '@/lib/types';

/**
 * Labels attached to each audio track when transcription starts.
 *
 * The app always transcribes the browser's *own* call leg, in both call
 * directions. On that leg the audio Twilio receives is the dialler user and the
 * audio Twilio sends is the far party, so this mapping holds whether the call
 * was placed or answered. Labelling both tracks explicitly means speaker
 * attribution never depends on reading Twilio's `inbound_track` /
 * `outbound_track` naming, which the docs describe as direction-dependent.
 */
export const TRACK_LABELS = {
  inbound: 'user',
  outbound: 'remote',
} as const satisfies Record<'inbound' | 'outbound', TranscriptSpeaker>;

/** Which track a content event came from. */
export type TranscriptionTrack = 'inbound_track' | 'outbound_track';

/** Track labels as reported back by the `transcription-started` event. */
export interface TrackLabels {
  inbound: string;
  outbound: string;
}

export type TranscriptionCallback =
  | {
      event: 'started';
      callSid: string;
      transcriptionSid: string;
      labels: TrackLabels;
      languageCode: string | null;
    }
  | {
      event: 'content';
      callSid: string;
      transcriptionSid: string;
      track: TranscriptionTrack;
      text: string;
      isFinal: boolean;
      sequence: number;
      at: string;
      confidence: number | null;
    }
  | { event: 'stopped'; callSid: string; transcriptionSid: string }
  | {
      event: 'error';
      callSid: string;
      transcriptionSid: string;
      /** Twilio's numeric code, or null when it did not send one. */
      code: number | null;
    }
  /** An event type we do not handle, or one missing required fields. */
  | { event: 'unknown'; reason: string };

/** Twilio sends booleans as the strings "true"/"false". */
function asBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function asTrack(value: string | undefined): TranscriptionTrack | null {
  if (value === 'inbound_track' || value === 'outbound_track') return value;
  return null;
}

/**
 * `TranscriptionData` is a JSON *string* inside the form body, shaped
 * `{"transcript": "...", "confidence": 0.9}`. Twilio omits `confidence` when
 * partial results are enabled and sends `stability` instead, so a missing
 * confidence is normal rather than an error.
 */
function parseTranscriptionData(raw: string | undefined): {
  transcript: string;
  confidence: number | null;
} | null {
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const data = parsed as { transcript?: unknown; confidence?: unknown };
    if (typeof data.transcript !== 'string') return null;

    return {
      transcript: data.transcript,
      confidence:
        typeof data.confidence === 'number' && Number.isFinite(data.confidence)
          ? data.confidence
          : null,
    };
  } catch {
    return null;
  }
}

/**
 * Normalises one callback body. Returns an `unknown` variant rather than
 * throwing, because a webhook must answer 2xx even for a payload it cannot use
 * -- Twilio retries otherwise, and a retry of a malformed body helps nobody.
 */
export function parseTranscriptionCallback(
  params: Record<string, string>,
): TranscriptionCallback {
  const callSid = params.CallSid?.trim();
  const transcriptionSid = params.TranscriptionSid?.trim();
  const event = params.TranscriptionEvent?.trim();

  if (!callSid || !transcriptionSid) {
    return { event: 'unknown', reason: 'Missing CallSid or TranscriptionSid' };
  }

  switch (event) {
    case 'transcription-started':
      return {
        event: 'started',
        callSid,
        transcriptionSid,
        labels: {
          inbound: params.InboundTrackLabel?.trim() || TRACK_LABELS.inbound,
          outbound: params.OutboundTrackLabel?.trim() || TRACK_LABELS.outbound,
        },
        languageCode: params.LanguageCode?.trim() || null,
      };

    case 'transcription-content': {
      const track = asTrack(params.Track?.trim());
      if (!track) {
        return { event: 'unknown', reason: 'Unrecognised Track' };
      }

      const data = parseTranscriptionData(params.TranscriptionData);
      if (!data) {
        return { event: 'unknown', reason: 'Unparseable TranscriptionData' };
      }

      // Twilio emits empty interim results while it waits for speech; they add
      // nothing to the display.
      if (!data.transcript.trim()) {
        return { event: 'unknown', reason: 'Empty transcript' };
      }

      const sequence = Number.parseInt(params.SequenceId ?? '', 10);

      return {
        event: 'content',
        callSid,
        transcriptionSid,
        track,
        text: data.transcript,
        isFinal: asBoolean(params.Final),
        sequence: Number.isFinite(sequence) ? sequence : 0,
        at: params.Timestamp?.trim() || new Date().toISOString(),
        confidence: data.confidence,
      };
    }

    case 'transcription-stopped':
      return { event: 'stopped', callSid, transcriptionSid };

    case 'transcription-error': {
      const code = Number.parseInt(params.TranscriptionErrorCode ?? '', 10);
      return {
        event: 'error',
        callSid,
        transcriptionSid,
        code: Number.isFinite(code) ? code : null,
      };
    }

    default:
      return { event: 'unknown', reason: `Unhandled event ${event ?? '(none)'}` };
  }
}

/**
 * Builds the cue for a content event.
 *
 * `speaker` is passed in rather than derived here, because only the broker
 * knows the labels that arrived with `transcription-started`.
 */
export function toTranscriptCue(
  callback: Extract<TranscriptionCallback, { event: 'content' }>,
  speaker: TranscriptSpeaker,
): TranscriptCue {
  return {
    // Interim cues on a track share an id with the final that replaces them
    // only if they share a sequence; Twilio increments SequenceId per event, so
    // the track is included to keep the two directions from colliding.
    id: `${callback.transcriptionSid}:${callback.track}:${callback.sequence}`,
    callSid: callback.callSid,
    speaker,
    text: callback.text,
    isFinal: callback.isFinal,
    sequence: callback.sequence,
    at: callback.at,
    source: 'live',
    ...(callback.confidence !== null ? { confidence: callback.confidence } : {}),
  };
}

/**
 * One sentence of a Conversational Intelligence transcript, as much of it as
 * this app needs. Declared structurally rather than importing the SDK's
 * `SentenceInstance`, so this module stays usable from client code.
 */
export interface IntelligenceSentence {
  sid?: string | null;
  transcript?: string | null;
  /** 1 or 2, from the dual-channel recording. */
  mediaChannel?: number | null;
  /** Twilio returns this as a string. */
  confidence?: string | number | null;
  /** Seconds from the start of the recording, as a string. */
  startTime?: string | null;
}

/**
 * Converts a Conversational Intelligence sentence into a cue.
 *
 * Channel 1 is the dialler user and channel 2 the far party, which is the
 * default mapping for the dual-channel recording started in
 * /api/twilio/recording/start -- the same split the live transcription's track
 * labels encode, so the two transcripts agree on who is speaking.
 *
 * Returns null for a sentence with no text, so empty rows do not reach the UI.
 */
export function batchCueFromSentence(
  sentence: IntelligenceSentence,
  callSid: string,
  index: number,
): TranscriptCue | null {
  const text = sentence.transcript?.trim();
  if (!text) return null;

  const confidence =
    sentence.confidence === null || sentence.confidence === undefined
      ? null
      : Number(sentence.confidence);

  // Offsets are relative to the recording, so there is no wall-clock time to
  // report. Encoding the offset keeps the readable rendering ordered and
  // honest about what it knows.
  const offsetSeconds = Number(sentence.startTime ?? Number.NaN);
  const at = Number.isFinite(offsetSeconds)
    ? new Date(offsetSeconds * 1000).toISOString()
    : new Date(0).toISOString();

  return {
    id: sentence.sid ?? `${callSid}:batch:${index}`,
    callSid,
    speaker: sentence.mediaChannel === 2 ? 'remote' : 'user',
    text,
    isFinal: true,
    sequence: index,
    at,
    source: 'batch',
    ...(confidence !== null && Number.isFinite(confidence) ? { confidence } : {}),
  };
}

/** Maps a track label back to a speaker, defaulting when a label is unfamiliar. */
export function speakerForLabel(
  label: string,
  track: TranscriptionTrack,
): TranscriptSpeaker {
  if (label === 'user' || label === 'remote') return label;
  // Unknown label: fall back to the track, which is what the labels encode.
  return track === 'inbound_track' ? 'user' : 'remote';
}
