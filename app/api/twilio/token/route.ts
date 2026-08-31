/**
 * POST /api/twilio/token
 *
 * Mints a short-lived Twilio Voice access token for the browser SDK. This is
 * the only Twilio credential the client ever sees, and it is scoped to Voice.
 */

import { NextResponse } from 'next/server';

import { createVoiceToken, TwilioConfigError } from '@/lib/twilio/server';

// Tokens are per-request and time-sensitive; never cache or prerender.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  try {
    const { token, identity, expiresIn } = createVoiceToken();

    return NextResponse.json(
      { token, identity, expiresIn },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof TwilioConfigError) {
      // Log the specific missing variables server-side only.
      console.error('[twilio/token]', error.message);
      return NextResponse.json(
        { error: 'Twilio is not configured on the server.' },
        { status: 500 },
      );
    }

    console.error('[twilio/token] Unexpected error', error);
    return NextResponse.json(
      { error: 'Unable to create an access token.' },
      { status: 500 },
    );
  }
}

/** GET is not allowed -- token minting is a POST-only action. */
export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 });
}
