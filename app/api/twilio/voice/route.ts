/**
 * POST /api/twilio/voice
 *
 * Voice URL of the TwiML Application. Twilio requests this when the browser
 * calls `device.connect()`, and the `To` parameter carries the dial target the
 * client passed in.
 */

import { NextResponse } from 'next/server';

import { getTwilioConfig, validateTwilioWebhook } from '@/lib/twilio/server';
import { buildErrorTwiml, buildOutboundTwiml, TWIML_HEADERS } from '@/lib/twilio/twiml';
import { isClientIdentity, isValidE164 } from '@/lib/twilio/validation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const result = await validateTwilioWebhook(request, '/api/twilio/voice');

  if (!result.valid) {
    console.warn('[twilio/voice] Rejected request:', result.reason);
    return new NextResponse('Forbidden', { status: 403 });
  }

  const config = getTwilioConfig();

  if (!config.phoneNumber) {
    console.error('[twilio/voice] TWILIO_PHONE_NUMBER is not set.');
    return new NextResponse(buildErrorTwiml(), { headers: TWIML_HEADERS });
  }

  const to = (result.params.To || '').trim();

  // Re-validate server-side: never dial an arbitrary string just because the
  // client sent it.
  if (!to || (!isValidE164(to) && !isClientIdentity(to))) {
    console.warn('[twilio/voice] Invalid To parameter.');
    return new NextResponse(
      buildErrorTwiml('The number you dialled is not valid. Goodbye.'),
      { headers: TWIML_HEADERS },
    );
  }

  const twiml = buildOutboundTwiml({
    to,
    callerId: config.phoneNumber,
    appUrl: config.appUrl,
  });

  return new NextResponse(twiml, { headers: TWIML_HEADERS });
}
