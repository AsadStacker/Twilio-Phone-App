/**
 * GET /api/transcripts/[callSid]
 *
 * Twilio's post-call transcript for one call, fetched on demand.
 *
 * There is deliberately no storage behind this. Conversational Intelligence
 * keeps the transcript, and `transcripts.list` accepts a `sourceSid` filter, so
 * a CallSid resolves to its transcript through Twilio alone:
 *
 *   CallSid -> recordings.list() -> RecordingSid
 *           -> transcripts.list({ sourceSid }) -> transcript
 *           -> sentences.list()
 *
 * That matters for where this app runs: fetching is an outbound call, so it
 * works from a local server even though Twilio's webhooks are delivered to the
 * deployed one. No database, no webhook, nothing to keep in sync.
 */

import { NextResponse } from 'next/server';

import { writeBatchTranscript } from '@/lib/server/transcript-files';
import { getRestClient, isSid } from '@/lib/twilio/rest';
import { getTwilioConfig } from '@/lib/twilio/server';
import { batchCueFromSentence } from '@/lib/twilio/transcription';
import type { TranscriptCue } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Twilio caps sentence pages at 1000, which is far more than a call produces. */
const SENTENCE_LIMIT = 1000;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ callSid: string }> },
) {
  const { callSid } = await params;

  if (!isSid(callSid, 'CA')) {
    return NextResponse.json(
      { status: 'error', error: 'A valid callSid is required.' },
      { status: 400 },
    );
  }

  const { intelligenceServiceSid } = getTwilioConfig();
  if (!intelligenceServiceSid) {
    return NextResponse.json(
      {
        status: 'error',
        error:
          'No Conversational Intelligence service is configured. Set ' +
          'TWILIO_INTELLIGENCE_SERVICE_SID.',
      },
      { status: 503 },
    );
  }

  const client = getRestClient();

  try {
    // 1. Confirm the call exists first.
    //
    //    `recordings.list()` returns an empty list for a CallSid that does not
    //    exist, which is indistinguishable from a real call that was never
    //    recorded -- and those need completely different fixes. One extra fetch
    //    buys an honest answer.
    const call = await client.calls(callSid).fetch();

    if (call.status !== 'completed' && call.status !== 'canceled') {
      return NextResponse.json({
        status: 'processing',
        transcriptStatus: `call-${call.status}`,
      });
    }

    // 2. The recording is the audio Conversational Intelligence works from.
    //    No recording means the post-call toggle was off for this call.
    const recordings = await client.calls(callSid).recordings.list({ limit: 5 });
    const recording = recordings.find((item) => item.status === 'completed');

    if (!recording) {
      return NextResponse.json({
        status: 'none',
        reason: recordings.length
          ? 'The recording for this call is still being processed.'
          : 'This call was not recorded, so Twilio has no transcript for it.',
      });
    }

    // 3. Find the transcript for that recording, or ask for one. Creating it
    //    here rather than from a webhook means Twilio only transcribes calls
    //    somebody actually looks at.
    let transcript = (
      await client.intelligence.v2.transcripts.list({
        sourceSid: recording.sid,
        limit: 5,
      })
    )[0];

    if (!transcript) {
      transcript = await client.intelligence.v2.transcripts.create({
        serviceSid: intelligenceServiceSid,
        channel: { media_properties: { source_sid: recording.sid } },
        // Lets a transcript be traced back to its call later.
        customerKey: callSid,
      });
    }

    if (transcript.status !== 'completed') {
      // `queued` and `in-progress` are worth waiting for; the rest are not.
      const terminal = ['failed', 'canceled', 'error'].includes(
        transcript.status ?? '',
      );

      return NextResponse.json({
        status: terminal ? 'failed' : 'processing',
        transcriptStatus: transcript.status ?? 'unknown',
      });
    }

    // 4. Sentences, mapped onto the same cue shape the live transcript uses so
    //    the two render identically and can be compared.
    const sentences = await client.intelligence.v2
      .transcripts(transcript.sid)
      .sentences.list({ limit: SENTENCE_LIMIT });

    const cues: TranscriptCue[] = sentences
      .map((sentence, index) => batchCueFromSentence(sentence, callSid, index))
      .filter((cue): cue is TranscriptCue => cue !== null);

    // Local copy, when a save directory is configured. Awaited so a failure
    // is reflected in `saved` rather than being lost in the background.
    const saved = await writeBatchTranscript(callSid, cues);

    console.log('[transcripts] Delivered post-call transcript', {
      callSid,
      transcriptSid: transcript.sid,
      lines: cues.length,
      savedLocally: saved,
    });

    return NextResponse.json({
      status: 'ready',
      transcriptSid: transcript.sid,
      cues,
      savedLocally: saved,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = (error as { status?: number } | null)?.status;

    // Twilio 404s a CallSid it has never seen. Saying so beats a generic
    // failure, because the usual cause is a stale or mistyped SID.
    if (status === 404) {
      return NextResponse.json(
        { status: 'error', error: 'Twilio has no record of this call.' },
        { status: 404 },
      );
    }

    console.error('[transcripts] Could not fetch transcript:', message);

    return NextResponse.json(
      { status: 'error', error: `Could not fetch the transcript: ${message}` },
      { status: 502 },
    );
  }
}
