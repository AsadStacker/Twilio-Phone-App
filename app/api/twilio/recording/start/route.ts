/**
 * POST /api/twilio/recording/start
 *
 * Starts the dual-channel recording that Conversational Intelligence needs.
 *
 * CI transcribes audio, not a live stream, so the post-call transcript requires
 * a recording. Recording the browser's own leg with `dual` channels puts the
 * dialler user on channel 1 and the far party on channel 2, matching the track
 * split used by live transcription -- so the two transcripts agree on who is
 * who, which is the point of being able to compare them.
 *
 * When the recording finishes, Twilio calls /api/twilio/recording-complete,
 * which is where the Conversational Intelligence transcript is requested.
 * Nothing here waits for any of that.
 */

import { NextResponse } from 'next/server';

import { checkCallbackReachable } from '@/lib/twilio/reachability';
import { getRestClient, isSid, webhookUrl } from '@/lib/twilio/rest';
import { getTwilioConfig } from '@/lib/twilio/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  let body: { callSid?: unknown };
  try {
    body = (await request.json()) as { callSid?: unknown };
  } catch {
    body = {};
  }

  if (!isSid(body.callSid, 'CA')) {
    return NextResponse.json({ error: 'A valid callSid is required.' }, { status: 400 });
  }
  const callSid = body.callSid;

  // Refuse rather than record: without a service there is nothing to turn the
  // audio into a transcript, so recording would bill storage for a file nobody
  // ever reads. Failing here is what makes the missing setup visible.
  if (!getTwilioConfig().intelligenceServiceSid) {
    console.error(
      '[twilio/recording/start] TWILIO_INTELLIGENCE_SERVICE_SID is not set. ' +
        'Run: npm run setup:intelligence',
    );
    return NextResponse.json(
      {
        error:
          'No Conversational Intelligence service is configured, so there would ' +
          'be no post-call transcript. Run "npm run setup:intelligence" and set ' +
          'TWILIO_INTELLIGENCE_SERVICE_SID.',
      },
      { status: 503 },
    );
  }

  // Without a reachable callback the recording still happens, but nothing
  // ever asks Conversational Intelligence to transcribe it -- storage billed
  // for a file no one reads.
  const reachable = await checkCallbackReachable();
  if (!reachable.ok) {
    console.error('[twilio/recording/start] Callback URL unusable:', reachable.reason);
    return NextResponse.json({ error: reachable.reason }, { status: 503 });
  }

  const statusCallback = webhookUrl('/api/twilio/recording-complete');
  if (!statusCallback) {
    console.error('[twilio/recording/start] NEXT_PUBLIC_APP_URL is not set.');
    return NextResponse.json(
      { error: 'The server has no public URL configured for recording callbacks.' },
      { status: 500 },
    );
  }

  try {
    const recording = await getRestClient()
      .calls(callSid)
      .recordings.create({
        recordingChannels: 'dual',
        recordingTrack: 'both',
        // `completed` is the only event that matters: it is when the audio is
        // available for Conversational Intelligence to transcribe.
        recordingStatusCallbackEvent: ['completed'],
        recordingStatusCallback: statusCallback,
        recordingStatusCallbackMethod: 'POST',
      });

    return NextResponse.json({ ok: true, recordingSid: recording.sid ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    // A call still ringing is "not eligible for recording". Like the
    // transcription case, that is a wait-and-retry, not a failure: this app
    // dials with `answerOnBridge`, so the leg is not recordable until the far
    // party picks up.
    if (/not eligible for recording|not in the expected state/i.test(message)) {
      return NextResponse.json(
        { error: 'The call is not connected yet.', retryable: true },
        { status: 409 },
      );
    }

    console.error('[twilio/recording/start] Could not start recording:', message);

    return NextResponse.json(
      { error: `Could not start recording: ${message}` },
      { status: 502 },
    );
  }
}
