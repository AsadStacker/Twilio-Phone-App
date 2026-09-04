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

export interface UseCallTranscript {
  /** Settled lines, oldest first, followed by any in-progress line. */
  cues: TranscriptCue[];
  /** Twilio's post-call transcript, once it arrives. Empty until then. */
  batchCues: TranscriptCue[];
  /** True while the SSE connection is open. */
  isStreaming: boolean;
  error: string | null;
  clear: () => void;
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
  isStreaming: boolean;
  error: string | null;
}

function emptyState(callSid: string | null): TranscriptState {
  return {
    callSid,
    finalCues: [],
    interim: {},
    batchCues: [],
    isStreaming: false,
    error: null,
  };
}

export function useCallTranscript(callSid: string | null): UseCallTranscript {
  const [state, setState] = useState<TranscriptState>(() => emptyState(callSid));

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
    isStreaming: state.isStreaming,
    error: state.error,
    clear,
  };
}
