/**
 * POST /api/twilio/incoming
 *
 * Voice webhook for the Twilio phone number. Routes inbound PSTN calls to the
 * registered browser client so they ring in the app.
 */

import { NextResponse } from 'next/server';

import {
  BROWSER_IDENTITY,
  getTwilioConfig,
  validateTwilioWebhook,
} from '@/lib/twilio/server';
import { buildErrorTwiml, buildIncomingTwiml, TWIML_HEADERS } from '@/lib/twilio/twiml';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const result = await validateTwilioWebhook(request, '/api/twilio/incoming');

  if (!result.valid) {
    console.warn('[twilio/incoming] Rejected request:', result.reason);
    return new NextResponse('Forbidden', { status: 403 });
  }

  const from = (result.params.From || '').trim();
  const callSid = result.params.CallSid || 'unknown';

  console.log(`[twilio/incoming] Call ${callSid} from ${from}`);

  try {
    const twiml = buildIncomingTwiml({
      from,
      identity: BROWSER_IDENTITY,
      appUrl: getTwilioConfig().appUrl,
    });

    return new NextResponse(twiml, { headers: TWIML_HEADERS });
  } catch (error) {
    console.error('[twilio/incoming] Failed to build TwiML', error);
    return new NextResponse(buildErrorTwiml(), { headers: TWIML_HEADERS });
  }
}
