/**
 * POST /api/twilio/intelligence
 *
 * Conversational Intelligence completion webhook (the Service's `webhook_url`).
 * Fetches the finished transcript's sentences, writes them next to the live
 * transcript for comparison, and pushes them to the browser if it is still
 * open on that call.
 *
 * DEFENSIVE PARSING, deliberately: Twilio's public reference documents that
 * `CustomerKey` is "included in webhook callback when the results for
 * Transcripts and Operators are available", but does not publish the field
 * names, the body encoding, or whether the request is signed. So this route
 * accepts either JSON or form encoding, looks for the transcript SID under
 * several spellings, and -- rather than trusting any of it -- confirms the SID
 * by fetching the transcript from the API with our own credentials. On the
 * first callback it logs the *key names* it received (never the values) so the
 * real shape can be read off the console and this loosened parsing tightened.
 */

import { NextResponse } from 'next/server';

import { publish } from '@/lib/server/transcript-broker';
import {
  readLiveCues,
  writeBatchTranscript,
  writeComparison,
} from '@/lib/server/transcript-files';
import { getRestClient, isSid } from '@/lib/twilio/rest';
import { batchCueFromSentence } from '@/lib/twilio/transcription';
import { getTwilioConfig, validateTwilioWebhook } from '@/lib/twilio/server';
import type { TranscriptCue } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Spellings seen across Twilio's own examples and SDK field casings. */
const TRANSCRIPT_SID_KEYS = [
  'transcript_sid',
  'TranscriptSid',
  'transcriptSid',
  'sid',
  'Sid',
] as const;

const STATUS_KEYS = ['status', 'Status', 'event_type', 'EventType'] as const;

/** Reads the body as JSON or form-encoded, whichever it turns out to be. */
async function readPayload(request: Request): Promise<Record<string, string>> {
  const raw = await request.text();
  if (!raw) return {};

  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return {};
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
          key,
          typeof value === 'string' ? value : JSON.stringify(value),
        ]),
      );
    } catch {
      return {};
    }
  }

  return Object.fromEntries(new URLSearchParams(raw));
}

function pick(
  payload: Record<string, string>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = payload[key]?.trim();
    if (value) return value;
  }
  return null;
}

export async function POST(request: Request) {
  // Signature validation consumes the body, so it is only attempted when
  // Twilio actually signed the request. `validateTwilioWebhook` reads
  // `formData()`, which would reject a JSON body outright.
  const signature = request.headers.get('x-twilio-signature');
  let payload: Record<string, string>;

  if (signature) {
    const result = await validateTwilioWebhook(request, '/api/twilio/intelligence');
    if (!result.valid) {
      console.warn('[twilio/intelligence] Rejected signed request:', result.reason);
      return new NextResponse('Forbidden', { status: 403 });
    }
    payload = result.params;
  } else {
    payload = await readPayload(request);
  }

  // Key names only. The values are transcript metadata and must not be logged.
  console.log('[twilio/intelligence] Callback fields:', Object.keys(payload).sort());

  const transcriptSid = pick(payload, TRANSCRIPT_SID_KEYS);
  const status = pick(payload, STATUS_KEYS);

  if (!isSid(transcriptSid, 'GT')) {
    console.warn('[twilio/intelligence] No usable transcript SID in callback.');
    return new NextResponse(null, { status: 204 });
  }

  const { intelligenceServiceSid } = getTwilioConfig();
  const client = getRestClient();

  try {
    // Fetching with our own credentials is what makes an unsigned callback
    // safe to act on: an unknown SID, or one on another account, fails here.
    const transcript = await client.intelligence.v2.transcripts(transcriptSid).fetch();

    if (intelligenceServiceSid && transcript.serviceSid !== intelligenceServiceSid) {
      console.warn('[twilio/intelligence] Transcript belongs to another service.');
      return new NextResponse(null, { status: 204 });
    }

    if (transcript.status !== 'completed') {
      console.log('[twilio/intelligence] Transcript not ready', {
        transcriptSid,
        status: transcript.status ?? status,
      });
      return new NextResponse(null, { status: 204 });
    }

    // `customerKey` is the CallSid set when the transcript was requested in
    // /api/twilio/recording-complete.
    const callSid = transcript.customerKey?.trim();
    if (!isSid(callSid, 'CA')) {
      console.warn('[twilio/intelligence] Transcript has no CallSid in customerKey.');
      return new NextResponse(null, { status: 204 });
    }

    const sentences = await client.intelligence.v2
      .transcripts(transcriptSid)
      .sentences.list({ limit: 1000 });

    const cues: TranscriptCue[] = sentences
      .map((sentence, index) => batchCueFromSentence(sentence, callSid, index))
      .filter((cue): cue is TranscriptCue => cue !== null);

    await writeBatchTranscript(callSid, cues);
    // The live transcript was written line by line as the call happened; the
    // comparison file is rendered from what is on disk for it.
    await writeComparison(callSid, await readLiveCues(callSid), cues);

    publish(callSid, { type: 'batch', callSid, cues });

    console.log('[twilio/intelligence] Stored transcript', {
      callSid,
      transcriptSid,
      lines: cues.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[twilio/intelligence] Could not process transcript:', message);
  }

  return new NextResponse(null, { status: 204 });
}
