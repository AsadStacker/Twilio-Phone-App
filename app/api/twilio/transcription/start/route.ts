/**
 * POST   /api/twilio/transcription/start   start transcribing a call
 * DELETE /api/twilio/transcription/start   stop transcribing it
 *
 * Called by the dialler when the user flips the captions toggle. Transcription
 * is attached to the browser's *own* call leg -- the CallSid the Voice SDK
 * reports -- which is what makes speaker attribution the same for outbound and
 * inbound calls. See lib/twilio/transcription.ts for why.
 */

import { NextResponse } from 'next/server';

import {
  setCallOptions,
  setTranscriptionSid,
  getTranscriptionSid,
} from '@/lib/server/transcript-broker';
import { checkCallbackReachable } from '@/lib/twilio/reachability';
import { getRestClient, isSid, webhookUrl } from '@/lib/twilio/rest';
import { getTwilioConfig } from '@/lib/twilio/server';
import { TRACK_LABELS } from '@/lib/twilio/transcription';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Names the transcription so it can also be stopped by name if a SID is lost. */
const TRANSCRIPTION_NAME = 'dialer-live';

/**
 * Twilio refuses to transcribe a call that is not `in-progress`.
 *
 * This app dials with `answerOnBridge`, so the browser's own leg stays in
 * `ringing` until the far party actually picks up -- which means the first
 * attempt to start captions almost always lands too early. That is a "try
 * again shortly", not a failure, so it is reported as 409 with
 * `retryable: true` and the caller waits for the bridge.
 */
function isNotReadyYet(error: unknown): boolean {
  const err = error as { code?: number; message?: string } | null;
  // 21220 is Twilio's invalid-call-state code; the message is matched too
  // because the code is not documented for this subresource.
  if (err?.code === 21220) return true;
  return /not in the expected state/i.test(err?.message ?? '');
}

interface StartBody {
  callSid?: unknown;
  saveToFile?: unknown;
}

async function readBody(request: Request): Promise<StartBody> {
  try {
    return (await request.json()) as StartBody;
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  const body = await readBody(request);

  if (!isSid(body.callSid, 'CA')) {
    return NextResponse.json({ error: 'A valid callSid is required.' }, { status: 400 });
  }
  const callSid = body.callSid;

  const statusCallbackUrl = webhookUrl('/api/twilio/transcription');
  if (!statusCallbackUrl) {
    console.error('[twilio/transcription/start] NEXT_PUBLIC_APP_URL is not set.');
    return NextResponse.json(
      { error: 'The server has no public URL configured for transcription callbacks.' },
      { status: 500 },
    );
  }

  // Starting a transcription whose callbacks cannot come back is worse than
  // not starting one: Twilio charges per minute and the transcript goes
  // nowhere. Checked here rather than left to fail silently.
  const reachable = await checkCallbackReachable();
  if (!reachable.ok) {
    console.error('[twilio/transcription/start] Callback URL unusable:', reachable.reason);
    return NextResponse.json({ error: reachable.reason }, { status: 503 });
  }

  const config = getTwilioConfig();

  // Recorded before the API call: Twilio can deliver the first content event
  // before `create()` resolves here.
  setCallOptions(callSid, { saveToFile: body.saveToFile === true });

  try {
    const transcription = await getRestClient()
      .calls(callSid)
      .transcriptions.create({
        name: TRANSCRIPTION_NAME,
        // Both sides of the bridged call, labelled so the webhook can tell
        // them apart without reading Twilio's direction-dependent track names.
        track: 'both_tracks',
        inboundTrackLabel: TRACK_LABELS.inbound,
        outboundTrackLabel: TRACK_LABELS.outbound,
        // Interim results, so captions appear while someone is still talking.
        partialResults: true,
        enableAutomaticPunctuation: true,
        statusCallbackUrl,
        statusCallbackMethod: 'POST',
        ...(config.transcriptionEngine
          ? { transcriptionEngine: config.transcriptionEngine }
          : {}),
        ...(config.transcriptionLanguage
          ? { languageCode: config.transcriptionLanguage }
          : {}),
      });

    setTranscriptionSid(callSid, transcription.sid ?? null);

    return NextResponse.json({ ok: true, transcriptionSid: transcription.sid ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    if (isNotReadyYet(error)) {
      // Left as-is rather than logged: this is the expected first response
      // while the call is still ringing, and logging it every second would
      // bury the failures that matter.
      return NextResponse.json(
        { error: 'The call is not connected yet.', retryable: true },
        { status: 409 },
      );
    }

    // Twilio's message names the real problem and contains no transcript
    // content, so it is safe to log and to hand back to the UI.
    console.error('[twilio/transcription/start] Could not start transcription:', message);
    setCallOptions(callSid, { saveToFile: false });

    return NextResponse.json(
      { error: `Could not start transcription: ${message}` },
      { status: 502 },
    );
  }
}

export async function DELETE(request: Request) {
  const body = await readBody(request);

  if (!isSid(body.callSid, 'CA')) {
    return NextResponse.json({ error: 'A valid callSid is required.' }, { status: 400 });
  }
  const callSid = body.callSid;

  // Prefer the SID from `create`; fall back to the name, which Twilio also
  // accepts, in case this process restarted mid-call.
  const target = getTranscriptionSid(callSid) ?? TRANSCRIPTION_NAME;

  try {
    await getRestClient()
      .calls(callSid)
      .transcriptions(target)
      .update({ status: 'stopped' });

    setTranscriptionSid(callSid, null);
    setCallOptions(callSid, { saveToFile: false });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    // A call that has already ended has no transcription left to stop, and
    // Twilio stops it with the call anyway. That is the ordinary outcome, so it
    // is not worth a log line; anything else is.
    if (!isNotReadyYet(error)) {
      console.warn('[twilio/transcription/start] Could not stop transcription:', message);
    }
    setTranscriptionSid(callSid, null);
    setCallOptions(callSid, { saveToFile: false });

    return NextResponse.json({ ok: true, alreadyStopped: true });
  }
}
