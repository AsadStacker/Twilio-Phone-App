/**
 * In-process fan-out from Twilio's transcription webhook to the browser's SSE
 * connection, keyed by CallSid.
 *
 * SCOPE: this lives in the Node process, so it requires one long-lived server
 * -- `next dev` or a single `next start`, which is how this app runs. It does
 * not survive a serverless cold start and does not span instances. If the app
 * is ever deployed multi-instance, the replacement is a Twilio Sync Stream the
 * browser subscribes to directly (the access token in lib/twilio/server.ts
 * would gain a SyncGrant); nothing outside this module would change.
 *
 * Also the place where speaker attribution is remembered: Twilio sends track
 * labels with `transcription-started` and then omits them from every event that
 * carries words, so the mapping has to be held here between the two.
 */

import 'server-only';

import { speakerForLabel, type TranscriptionTrack, type TrackLabels } from '@/lib/twilio/transcription';
import type { TranscriptSpeaker, TranscriptStreamEvent } from '@/lib/types';

type Listener = (event: TranscriptStreamEvent) => void;

/**
 * Cues retained per call so a browser that connects mid-call, or reconnects
 * after a dropped stream, still sees what has been said.
 */
const BUFFER_LIMIT = 400;

/** A channel with no webhook traffic and no listeners for this long is dropped. */
const IDLE_TTL_MS = 30 * 60 * 1000;

/** Per-call choices the browser made when it started transcription. */
export interface CallTranscriptOptions {
  /** Write final cues to disk for this call. */
  saveToFile: boolean;
}

const DEFAULT_OPTIONS: CallTranscriptOptions = { saveToFile: false };

interface Channel {
  listeners: Set<Listener>;
  buffer: TranscriptStreamEvent[];
  /** Track labels per TranscriptionSid, learned from `transcription-started`. */
  labels: Map<string, TrackLabels>;
  options: CallTranscriptOptions;
  /** SID of the transcription we started, so it can be stopped again. */
  transcriptionSid: string | null;
  /** Content events seen, so the first one can be logged and the rest not. */
  contentCount: number;
  lastActivity: number;
}

/**
 * Module state deliberately hangs off `globalThis`: Next's dev server reloads
 * modules on edit, and a plain module-level Map would be replaced mid-call,
 * silently dropping the listeners the SSE route is holding.
 */
const globalStore = globalThis as typeof globalThis & {
  __transcriptChannels?: Map<string, Channel>;
};

const channels: Map<string, Channel> = (globalStore.__transcriptChannels ??=
  new Map());

function touch(channel: Channel): void {
  channel.lastActivity = Date.now();
}

/** Drops idle channels. Called on access rather than on a timer, so there is no interval to leak across dev reloads. */
function sweep(): void {
  const cutoff = Date.now() - IDLE_TTL_MS;
  for (const [callSid, channel] of channels) {
    if (channel.listeners.size === 0 && channel.lastActivity < cutoff) {
      channels.delete(callSid);
    }
  }
}

function getOrCreate(callSid: string): Channel {
  let channel = channels.get(callSid);
  if (!channel) {
    sweep();
    channel = {
      listeners: new Set(),
      buffer: [],
      labels: new Map(),
      options: { ...DEFAULT_OPTIONS },
      transcriptionSid: null,
      contentCount: 0,
      lastActivity: Date.now(),
    };
    channels.set(callSid, channel);
  }
  return channel;
}

/**
 * Records what the browser asked for when it started transcription. Called
 * from the start route, read by the webhook -- the webhook has no other way to
 * know, since Twilio echoes back only what it was configured with.
 */
export function setCallOptions(
  callSid: string,
  options: CallTranscriptOptions,
): void {
  const channel = getOrCreate(callSid);
  channel.options = { ...options };
  touch(channel);
}

export function getCallOptions(callSid: string): CallTranscriptOptions {
  return channels.get(callSid)?.options ?? DEFAULT_OPTIONS;
}

/** Remembers the transcription we started on a call, for stopping it later. */
export function setTranscriptionSid(callSid: string, sid: string | null): void {
  const channel = getOrCreate(callSid);
  channel.transcriptionSid = sid;
  touch(channel);
}

export function getTranscriptionSid(callSid: string): string | null {
  return channels.get(callSid)?.transcriptionSid ?? null;
}

/** Counts a content event and returns the new total for this call. */
export function countContentEvent(callSid: string): number {
  const channel = getOrCreate(callSid);
  channel.contentCount += 1;
  touch(channel);
  return channel.contentCount;
}

/** Records the track labels that arrived with `transcription-started`. */
export function recordTrackLabels(
  callSid: string,
  transcriptionSid: string,
  labels: TrackLabels,
): void {
  const channel = getOrCreate(callSid);
  channel.labels.set(transcriptionSid, labels);
  touch(channel);
}

/**
 * Resolves who is speaking on a track.
 *
 * Falls back to the track itself when the start event was missed -- webhooks
 * can arrive out of order, and a call is better transcribed with a guessed
 * speaker than not at all.
 */
export function resolveSpeaker(
  callSid: string,
  transcriptionSid: string,
  track: TranscriptionTrack,
): TranscriptSpeaker {
  const labels = channels.get(callSid)?.labels.get(transcriptionSid);
  if (!labels) {
    return track === 'inbound_track' ? 'user' : 'remote';
  }

  return speakerForLabel(
    track === 'inbound_track' ? labels.inbound : labels.outbound,
    track,
  );
}

/** Publishes to every live listener and retains the event for late subscribers. */
export function publish(callSid: string, event: TranscriptStreamEvent): void {
  const channel = getOrCreate(callSid);
  touch(channel);

  channel.buffer.push(event);
  if (channel.buffer.length > BUFFER_LIMIT) {
    channel.buffer.splice(0, channel.buffer.length - BUFFER_LIMIT);
  }

  for (const listener of channel.listeners) {
    try {
      listener(event);
    } catch {
      // A failed listener (closed stream mid-write) must not stop the others.
    }
  }
}

/**
 * Subscribes to a call, replaying what has already been said before adding the
 * listener so nothing can slip through between the two.
 */
export function subscribe(callSid: string, listener: Listener): () => void {
  const channel = getOrCreate(callSid);
  touch(channel);

  for (const event of channel.buffer) {
    try {
      listener(event);
    } catch {
      // Replay failure means the stream is already gone; the caller will see it.
    }
  }

  channel.listeners.add(listener);

  return () => {
    channel.listeners.delete(listener);
    touch(channel);
    if (channel.listeners.size === 0) sweep();
  };
}

/** Forgets a call outright. Used when a call ends and its transcript is done with. */
export function closeChannel(callSid: string): void {
  channels.delete(callSid);
}
