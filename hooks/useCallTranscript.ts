'use client';

/**
 * Subscribes to the live transcript for a call and keeps it as ordered React
 * state.
 *
 * Twilio sends interim guesses and then a final version of each utterance. The
 * merge rule here is what makes the display stable: an interim cue is held
 * separately per speaker and replaced wholesale by the next interim, while a
 * final cue is appended to the settled transcript and clears that speaker's
 * interim. So the settled lines never rewrite themselves, and at most one
 * in-progress line per speaker flickers.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  TranscriptCue,
  TranscriptSpeaker,
  TranscriptStreamEvent,
} from '@/lib/types';

/**
 * Polling for the post-call transcript: a short first look in case it already
 * exists, then every few seconds for up to about three minutes. Conversational
 * Intelligence usually finishes a short call inside a minute; giving up after
 * three leaves the retry button rather than polling all day.
 */
const BATCH_FIRST_DELAY_MS = 1500;
const BATCH_POLL_INTERVAL_MS = 10_000;
const BATCH_POLL_ATTEMPTS = 18;

/**
 * Where Twilio's post-call transcript has got to.
 *
 * `processing` is the normal state for the first minute or two after a call:
 * Conversational Intelligence transcribes the recording in the background, so
 * there is a real wait between hanging up and the transcript existing.
 */
export type BatchStatus =
  | 'idle'
  | 'processing'
  | 'ready'
  | 'none'
  | 'failed'
  | 'error';

export interface UseCallTranscript {
  /** Settled lines, oldest first, followed by any in-progress line. */
  cues: TranscriptCue[];
  /** Twilio's post-call transcript, once it arrives. Empty until then. */
  batchCues: TranscriptCue[];
  batchStatus: BatchStatus;
  /** Why the post-call transcript is unavailable, when it is. */
  batchMessage: string | null;
  /** True once a local copy has been written on the server. */
  batchSavedLocally: boolean;
  /** True while the SSE connection is open. */
  isStreaming: boolean;
  error: string | null;
  clear: () => void;
  /** Asks for the post-call transcript again, for the retry button. */
  refetchBatch: () => void;
}

/**
 * All transcript state for one call, carrying the CallSid it belongs to.
 *
 * Held as a single object so switching calls is one state replacement during
 * render -- React's documented way to reset state when a prop changes -- rather
 * than a burst of setState calls from inside an effect.
 */
interface TranscriptState {
  callSid: string | null;
  finalCues: TranscriptCue[];
  interim: Partial<Record<TranscriptSpeaker, TranscriptCue>>;
  batchCues: TranscriptCue[];
  batchStatus: BatchStatus;
  batchMessage: string | null;
  batchSavedLocally: boolean;
  isStreaming: boolean;
  error: string | null;
}

function emptyState(callSid: string | null): TranscriptState {
  return {
    callSid,
    finalCues: [],
    interim: {},
    batchCues: [],
    batchStatus: 'idle',
    batchMessage: null,
    batchSavedLocally: false,
    isStreaming: false,
    error: null,
  };
}

/**
 * @param callSid       the call to follow, or null between calls
 * @param wantBatch     start asking Twilio for the post-call transcript. The
 *                      caller decides when: it only makes sense once the call
 *                      has ended and the post-call toggle was on for it.
 */
export function useCallTranscript(
  callSid: string | null,
  wantBatch = false,
): UseCallTranscript {
  const [state, setState] = useState<TranscriptState>(() => emptyState(callSid));
  /** Bumped to ask again, for the retry button. */
  const [batchNonce, setBatchNonce] = useState(0);

  // A different call means a different transcript. Resetting here rather than
  // in an effect keeps the stale transcript from being painted for one frame.
  if (state.callSid !== callSid) {
    setState(emptyState(callSid));
  }

  const clear = useCallback(() => {
    setState((current) => ({
      ...emptyState(current.callSid),
      isStreaming: current.isStreaming,
    }));
  }, []);

  const refetchBatch = useCallback(() => setBatchNonce((n) => n + 1), []);

  /**
   * Polls for Twilio's post-call transcript.
   *
   * Conversational Intelligence transcribes the recording after the call, so
   * there is a genuine wait -- a minute or two is normal. Polling stops as soon
   * as the answer is final, and gives up rather than hammering the API forever.
   */
  useEffect(() => {
    if (!callSid || !wantBatch) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const apply = (update: Partial<TranscriptState>) => {
      setState((current) =>
        current.callSid === callSid ? { ...current, ...update } : current,
      );
    };

    const poll = async (attempt: number): Promise<void> => {
      if (cancelled) return;

      try {
        const response = await fetch(
          `/api/transcripts/${encodeURIComponent(callSid)}`,
          { cache: 'no-store' },
        );
        const body = (await response.json()) as {
          status?: BatchStatus;
          cues?: TranscriptCue[];
          reason?: string;
          error?: string;
          savedLocally?: boolean;
        };
        if (cancelled) return;

        switch (body.status) {
          case 'ready':
            apply({
              batchStatus: 'ready',
              batchCues: body.cues ?? [],
              batchMessage: null,
              batchSavedLocally: body.savedLocally === true,
            });
            return;

          case 'none':
            apply({ batchStatus: 'none', batchMessage: body.reason ?? null });
            return;

          case 'failed':
            apply({
              batchStatus: 'failed',
              batchMessage: 'Twilio could not transcribe this recording.',
            });
            return;

          case 'processing':
            apply({ batchStatus: 'processing', batchMessage: null });
            break;

          default:
            apply({
              batchStatus: 'error',
              batchMessage: body.error ?? 'Could not fetch the transcript.',
            });
            return;
        }
      } catch {
        if (cancelled) return;
        // A network blip is worth another go; the loop below decides.
        apply({ batchStatus: 'processing', batchMessage: null });
      }

      if (attempt + 1 >= BATCH_POLL_ATTEMPTS) {
        apply({
          batchStatus: 'processing',
          batchMessage:
            'Twilio is still working on this transcript. Try again in a moment.',
        });
        return;
      }

      timer = setTimeout(() => void poll(attempt + 1), BATCH_POLL_INTERVAL_MS);
    };

    // First attempt is quick: for an older call the transcript already exists.
    timer = setTimeout(() => void poll(0), BATCH_FIRST_DELAY_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [callSid, wantBatch, batchNonce]);

  useEffect(() => {
    if (!callSid) return;

    const source = new EventSource(
      `/api/twilio/transcript-stream?callSid=${encodeURIComponent(callSid)}`,
    );

    /** Ignores anything that arrives for a call we have already moved past. */
    const forThisCall = (
      update: (current: TranscriptState) => TranscriptState,
    ) => {
      setState((current) => (current.callSid === callSid ? update(current) : current));
    };

    source.onopen = () => {
      forThisCall((current) => ({ ...current, isStreaming: true, error: null }));
    };

    source.onmessage = (message) => {
      let event: TranscriptStreamEvent;
      try {
        event = JSON.parse(message.data) as TranscriptStreamEvent;
      } catch {
        return;
      }

      switch (event.type) {
        case 'cue': {
          const cue = event.cue;

          if (!cue.isFinal) {
            forThisCall((current) => ({
              ...current,
              interim: { ...current.interim, [cue.speaker]: cue },
            }));
            return;
          }

          forThisCall((current) => {
            // The broker replays its buffer to every new subscriber, so the
            // same final cue can arrive twice after a reconnect. Checking the
            // settled list is enough at one cue per second or so, and avoids
            // keeping a second index in sync with it.
            if (current.finalCues.some((existing) => existing.id === cue.id)) {
              return current;
            }

            const interim = { ...current.interim };
            // The final supersedes whatever this speaker had in progress.
            delete interim[cue.speaker];

            return {
              ...current,
              finalCues: [...current.finalCues, cue].sort(
                (a, b) => a.sequence - b.sequence,
              ),
              interim,
            };
          });
          break;
        }

        case 'status':
          forThisCall((current) => ({
            ...current,
            interim: event.status === 'stopped' ? {} : current.interim,
            error:
              event.status === 'error'
                ? (event.message ?? 'Transcription stopped unexpectedly.')
                : current.error,
          }));
          break;

        case 'batch':
          forThisCall((current) => ({ ...current, batchCues: event.cues }));
          break;
      }
    };

    source.onerror = () => {
      // EventSource reconnects on its own; report only that it is not live.
      forThisCall((current) => ({ ...current, isStreaming: false }));
    };

    return () => {
      source.close();
    };
  }, [callSid]);

  const cues = useMemo(() => {
    const pending = (['user', 'remote'] as const)
      .map((speaker) => state.interim[speaker])
      .filter((cue): cue is TranscriptCue => Boolean(cue));

    return [...state.finalCues, ...pending];
  }, [state.finalCues, state.interim]);

  return {
    cues,
    batchCues: state.batchCues,
    batchStatus: state.batchStatus,
    batchMessage: state.batchMessage,
    batchSavedLocally: state.batchSavedLocally,
    isStreaming: state.isStreaming,
    error: state.error,
    clear,
    refetchBatch,
  };
}
