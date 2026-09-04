/** Shared types used by both the UI and the storage layer. */

/** The lifecycle of a single call, driven by Twilio Voice SDK events. */
export type CallState =
  | 'idle'
  | 'calling'
  | 'ringing'
  | 'connected'
  | 'ended'
  | 'failed';

export type CallDirection = 'inbound' | 'outbound';

/** Final disposition of a call, stored in history. */
export type CallStatus =
  | 'completed'
  | 'missed'
  | 'rejected'
  | 'canceled'
  | 'failed';

/** One entry in the localStorage call history. */
export interface CallRecord {
  id: string;
  callSid: string | null;
  fromNumber: string;
  toNumber: string;
  direction: CallDirection;
  status: CallStatus;
  /** ISO 8601 timestamp of when the call was initiated or received. */
  startTime: string;
  /** ISO 8601 timestamp of when the call ended. */
  endTime: string;
  /** Connected duration in whole seconds. 0 for calls that never connected. */
  duration: number;
}

/**
 * Who said a line of transcript.
 *
 * `user` is whoever is at the dialler, `remote` is the other party. Resolved
 * from the track labels the app itself attaches, never from Twilio's
 * direction-dependent inbound/outbound track names.
 */
export type TranscriptSpeaker = 'user' | 'remote';

/** Where a transcript line came from. */
export type TranscriptSource = 'live' | 'batch';

/** One utterance of transcript. */
export interface TranscriptCue {
  /** Stable per (transcription, sequence, track), so re-sends dedupe. */
  id: string;
  callSid: string;
  speaker: TranscriptSpeaker;
  text: string;
  /**
   * False for an interim guess that Twilio will revise. A final cue replaces
   * the interim ones that preceded it on the same track.
   */
  isFinal: boolean;
  /** Twilio's per-transcription counter, used for ordering. */
  sequence: number;
  /** ISO 8601, from Twilio's own event timestamp. */
  at: string;
  source: TranscriptSource;
  /** 0-1, present on final live cues and on batch cues. */
  confidence?: number;
}

/** What the transcript SSE stream carries. */
export type TranscriptStreamEvent =
  | { type: 'cue'; cue: TranscriptCue }
  | {
      type: 'status';
      status: 'started' | 'stopped' | 'error';
      /** Safe to show the user; never contains transcript text. */
      message?: string;
    }
  | { type: 'batch'; callSid: string; cues: TranscriptCue[] };
