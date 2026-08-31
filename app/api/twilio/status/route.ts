/**
 * POST /api/twilio/status
 *
 * Twilio status callbacks. Call history lives in the browser's localStorage, so
 * this endpoint only logs progress -- it deliberately persists nothing.
 */

import { NextResponse } from 'next/server';

import { validateTwilioWebhook } from '@/lib/twilio/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const result = await validateTwilioWebhook(request, '/api/twilio/status');

  if (!result.valid) {
    console.warn('[twilio/status] Rejected request:', result.reason);
    return new NextResponse('Forbidden', { status: 403 });
  }

  const { CallSid, CallStatus, CallDuration, From, To } = result.params;

  console.log('[twilio/status]', {
    callSid: CallSid,
    status: CallStatus,
    duration: CallDuration,
    from: From,
    to: To,
  });

  // Twilio ignores the body of a status callback; 204 keeps it quiet.
  return new NextResponse(null, { status: 204 });
}
