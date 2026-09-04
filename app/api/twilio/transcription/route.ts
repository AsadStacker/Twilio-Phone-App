/**
 * POST /api/twilio/transcription
 *
 * `statusCallbackUrl` for Real-Time Transcription. Twilio POSTs here as it
 * recognises speech; each event is normalised into a cue and fanned out to the
 * browser's SSE stream.
 *
 * PRIVACY: transcript text is never logged. Only event names, SIDs and error
 * codes go to the console, so turning on debug logging cannot spill the
 * contents of a call into the server log.
 */

import { NextResponse } from 'next/server';

import { validateTwilioWebhook } from '@/lib/twilio/server';
import {
  parseTranscriptionCallback,
  toTranscriptCue,
} from '@/lib/twilio/transcription';
import {
  countContentEvent,
  getCallOptions,
  publish,
  recordTrackLabels,
  resolveSpeaker,
} from '@/lib/server/transcript-broker';
import { appendLiveCue } from '@/lib/server/transcript-files';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const result = await validateTwilioWebhook(request, '/api/twilio/transcription');

  if (!result.valid) {
    // Worth spelling out: a rejected callback is indistinguishable from
    // transcription "not working" at the UI, because the words simply never
    // arrive. Twilio does not document whether it signs this particular
    // callback, so if this line is what shows up during a call, that is the
    // answer -- and the tunnel URL in NEXT_PUBLIC_APP_URL is the first thing
    // to check, since the signature is computed over it.
    console.warn(
      '[twilio/transcription] Rejected callback (%s). No captions will appear. ' +
        'Check NEXT_PUBLIC_APP_URL matches the URL Twilio is calling.',
      result.reason,
    );
    return new NextResponse('Forbidden', { status: 403 });
  }

  const callback = parseTranscriptionCallback(result.params);

  switch (callback.event) {
    case 'started':
      recordTrackLabels(
        callback.callSid,
        callback.transcriptionSid,
        callback.labels,
      );
      publish(callback.callSid, { type: 'status', status: 'started' });
      console.log('[twilio/transcription] started', {
        callSid: callback.callSid,
        transcriptionSid: callback.transcriptionSid,
        languageCode: callback.languageCode,
      });
      break;

    case 'content': {
      const speaker = resolveSpeaker(
        callback.callSid,
        callback.transcriptionSid,
        callback.track,
      );
      const cue = toTranscriptCue(callback, speaker);

      publish(callback.callSid, { type: 'cue', cue });

      // Only the first one. Twilio sends interim results several times a
      // second, so logging every event would drown the console -- but knowing
      // that speech is arriving at all is exactly what you need when captions
      // do not show up. Counts and speakers only; never the words.
      if (countContentEvent(callback.callSid) === 1) {
        console.log('[twilio/transcription] receiving speech', {
          callSid: callback.callSid,
          firstSpeaker: speaker,
        });
      }

      // Interim cues are superseded, so only finals are worth a file line.
      if (cue.isFinal && getCallOptions(callback.callSid).saveToFile) {
        void appendLiveCue(cue);
      }
      break;
    }

    case 'stopped':
      publish(callback.callSid, { type: 'status', status: 'stopped' });
      console.log('[twilio/transcription] stopped', {
        callSid: callback.callSid,
      });
      break;

    case 'error':
      console.warn('[twilio/transcription] Engine error', {
        callSid: callback.callSid,
        code: callback.code,
      });
      publish(callback.callSid, {
        type: 'status',
        status: 'error',
        message: 'Twilio stopped transcribing this call.',
      });
      break;

    case 'unknown':
      // Nothing actionable, but answer 2xx: a retry of an unusable body would
      // only arrive unusable again. Logged without values, because an
      // unrecognised payload is worth knowing about when captions are missing.
      console.warn('[twilio/transcription] Ignored callback:', callback.reason);
      break;
  }

  // Twilio ignores the body of a status callback.
  return new NextResponse(null, { status: 204 });
}
