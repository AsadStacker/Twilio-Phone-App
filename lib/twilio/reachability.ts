/**
 * Confirms that the public URL Twilio is told to call actually reaches this
 * server.
 *
 * This exists because of a failure that is invisible from the inside: starting
 * a transcription succeeds, Twilio accepts the `statusCallbackUrl`, and then
 * every callback 404s against a dead tunnel or lands on a different
 * deployment. The API calls all report success and no transcript ever appears.
 *
 * The check is a round trip to our own /api/twilio/health through the public
 * URL, comparing a per-process marker. That distinguishes the three cases that
 * matter: the URL is unreachable, the URL reaches a *different* server, or the
 * URL is correct.
 */

import 'server-only';

import { randomUUID } from 'node:crypto';

import { getTwilioConfig } from '@/lib/twilio/server';

/**
 * Identifies this process. Regenerated on every restart, which is fine -- the
 * comparison is always same-process.
 */
const INSTANCE_MARKER = randomUUID();

/** How long a result is trusted, so this is not a round trip per call. */
const CACHE_MS = 30_000;

/** Long enough for a tunnel hop, short enough not to delay a call. */
const TIMEOUT_MS = 4000;

export function getInstanceMarker(): string {
  return INSTANCE_MARKER;
}

export type Reachability =
  | { ok: true }
  | { ok: false; reason: string };

let cached: { at: number; result: Reachability } | null = null;

/**
 * Checks whether `NEXT_PUBLIC_APP_URL` resolves to this process.
 *
 * Never throws: a check that cannot run must not be the thing that stops a
 * call from being transcribed, so an unexpected failure is reported as a
 * reason string and the caller decides.
 */
export async function checkCallbackReachable(): Promise<Reachability> {
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.result;
  }

  const result = await probe();
  cached = { at: Date.now(), result };
  return result;
}

/** Clears the cache, for when configuration changes under us. */
export function resetReachabilityCache(): void {
  cached = null;
}

async function probe(): Promise<Reachability> {
  const { appUrl } = getTwilioConfig();

  if (!appUrl) {
    return {
      ok: false,
      reason:
        'NEXT_PUBLIC_APP_URL is not set, so Twilio has no address to send ' +
        'transcription callbacks to.',
    };
  }

  let target: string;
  try {
    target = new URL('/api/twilio/health', appUrl).toString();
  } catch {
    return { ok: false, reason: `NEXT_PUBLIC_APP_URL is not a valid URL: ${appUrl}` };
  }

  try {
    const response = await fetch(target, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        ok: false,
        reason:
          `${appUrl} returned HTTP ${response.status} for /api/twilio/health. ` +
          'Twilio callbacks will get the same, so no transcript will arrive. ' +
          'Is the tunnel running, and does NEXT_PUBLIC_APP_URL match it?',
      };
    }

    const body = (await response.json().catch(() => null)) as
      | { marker?: string }
      | null;

    if (body?.marker !== INSTANCE_MARKER) {
      return {
        ok: false,
        reason:
          `${appUrl} is reachable but is a different server from this one. ` +
          'Twilio would deliver transcription callbacks there, not here, so ' +
          'the transcript would never reach this browser. Point ' +
          'NEXT_PUBLIC_APP_URL at a tunnel to this process.',
      };
    }

    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    return {
      ok: false,
      reason:
        `${appUrl} could not be reached from this server (${detail}). ` +
        'Twilio callbacks will fail the same way, so no transcript will ' +
        'arrive. Start the tunnel, or update NEXT_PUBLIC_APP_URL.',
    };
  }
}
