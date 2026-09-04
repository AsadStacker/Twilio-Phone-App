/**
 * POST /api/twilio/recording-complete
 *
 * Recording status callback. When the dual-channel recording of a call is
 * available, this asks Conversational Intelligence to transcribe it.
 *
 * Requesting the transcript explicitly per recording, rather than switching on
 * the Intelligence Service's `autoTranscribe`, keeps the billing to calls the
 * user actually asked to transcribe -- `autoTranscribe` applies to every
 * recording on the account.
 *
 * The CallSid travels to Conversational Intelligence as `customerKey`, which
 * Twilio echoes back in the completion webhook. That is the only thread tying
 * a finished transcript back to the call it came from.
 */

import { NextResponse } from 'next/server';

import { getRestClient } from '@/lib/twilio/rest';
import { getTwilioConfig, validateTwilioWebhook } from '@/lib/twilio/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const result = await validateTwilioWebhook(request, '/api/twilio/recording-complete');

  if (!result.valid) {
    console.warn('[twilio/recording-complete] Rejected request:', result.reason);
    return new NextResponse('Forbidden', { status: 403 });
  }

  const { RecordingSid, CallSid, RecordingStatus } = result.params;

  if (RecordingStatus !== 'completed' || !RecordingSid || !CallSid) {
    return new NextResponse(null, { status: 204 });
  }

  const { intelligenceServiceSid } = getTwilioConfig();
  if (!intelligenceServiceSid) {
    console.warn(
      '[twilio/recording-complete] TWILIO_INTELLIGENCE_SERVICE_SID is not set; ' +
        'skipping post-call transcript. Run scripts/setup-intelligence-service.ts.',
    );
    return new NextResponse(null, { status: 204 });
  }

  try {
    const transcript = await getRestClient().intelligence.v2.transcripts.create({
      serviceSid: intelligenceServiceSid,
      // Channel 1 is the dialler user, channel 2 the far party -- the default
      // mapping for a dual-channel recording, so no participant overrides.
      channel: { media_properties: { source_sid: RecordingSid } },
      customerKey: CallSid,
    });

    console.log('[twilio/recording-complete] Requested transcript', {
      callSid: CallSid,
      transcriptSid: transcript.sid,
      status: transcript.status,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[twilio/recording-complete] Could not request transcript:', message);
  }

  return new NextResponse(null, { status: 204 });
}
