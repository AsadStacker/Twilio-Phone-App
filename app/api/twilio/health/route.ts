/**
 * GET /api/twilio/health
 *
 * Returns a marker unique to this running server process.
 *
 * Its only job is to let the server confirm that NEXT_PUBLIC_APP_URL actually
 * reaches *this* process. Twilio callbacks are delivered to that URL, so if it
 * points at a dead tunnel or at a different deployment, transcription starts
 * successfully and then silently produces nothing -- Twilio calls a URL that
 * 404s and the words never arrive. Comparing markers turns that into a clear
 * error instead of a mystery.
 *
 * Deliberately unauthenticated: it discloses only a random per-process id.
 */

import { NextResponse } from 'next/server';

import { getInstanceMarker } from '@/lib/twilio/reachability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(
    { ok: true, marker: getInstanceMarker() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
