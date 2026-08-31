/**
 * TwiML generation. Server-only: these documents tell Twilio how to bridge
 * calls, and building them requires the configured caller ID.
 */

import 'server-only';

import twilio from 'twilio';

import { BROWSER_IDENTITY } from '@/lib/twilio/server';
import { isClientIdentity, CLIENT_IDENTITY_PREFIX } from '@/lib/twilio/validation';

const VoiceResponse = twilio.twiml.VoiceResponse;

/** Seconds to ring before giving up. */
const DIAL_TIMEOUT = 30;

const STATUS_CALLBACK_EVENTS = [
  'initiated',
  'ringing',
  'answered',
  'completed',
] as const;

/**
 * Absolute URL for the status callback, or undefined when no public origin is
 * configured (Twilio rejects relative status callback URLs).
 */
function statusCallbackUrl(appUrl: string): string | undefined {
  if (!appUrl) return undefined;
  try {
    return new URL('/api/twilio/status', appUrl).toString();
  } catch {
    return undefined;
  }
}

function statusCallbackAttrs(appUrl: string) {
  const url = statusCallbackUrl(appUrl);
  if (!url) return {};

  return {
    statusCallback: url,
    statusCallbackEvent: [...STATUS_CALLBACK_EVENTS],
    statusCallbackMethod: 'POST' as const,
  };
}

/**
 * TwiML for a call placed *from* the browser.
 *
 * Twilio requests this from the TwiML Application when `device.connect()` runs.
 * `answerOnBridge` keeps the caller hearing real ringback until the far end
 * actually picks up, instead of Twilio answering immediately.
 */
export function buildOutboundTwiml(options: {
  to: string;
  callerId: string;
  appUrl: string;
}): string {
  const { to, callerId, appUrl } = options;
  const response = new VoiceResponse();

  if (!to) {
    response.say(
      { voice: 'alice' },
      'No destination number was provided. Goodbye.',
    );
    response.hangup();
    return response.toString();
  }

  const dial = response.dial({
    callerId,
    answerOnBridge: true,
    timeout: DIAL_TIMEOUT,
  });

  const callbacks = statusCallbackAttrs(appUrl);

  if (isClientIdentity(to)) {
    // Browser-to-browser call.
    dial.client(callbacks, to.slice(CLIENT_IDENTITY_PREFIX.length).trim());
  } else {
    dial.number(callbacks, to);
  }

  return response.toString();
}

/**
 * TwiML for a call arriving at the Twilio phone number.
 *
 * Routes the caller to the registered browser client. The inbound caller's
 * number is passed through as the caller ID so the browser can show who is
 * calling.
 */
export function buildIncomingTwiml(options: {
  from: string;
  identity?: string;
  appUrl: string;
}): string {
  const { from, identity = BROWSER_IDENTITY, appUrl } = options;
  const response = new VoiceResponse();

  const dial = response.dial({
    // Show the real caller in the browser's incoming-call UI.
    callerId: from || undefined,
    answerOnBridge: true,
    timeout: DIAL_TIMEOUT,
  });

  dial.client(statusCallbackAttrs(appUrl), identity);

  return response.toString();
}

/**
 * Fallback TwiML: a short spoken message then hangup. Used when the server is
 * misconfigured, so callers hear something intelligible instead of an error.
 */
export function buildErrorTwiml(
  message = 'Sorry, this application is not available right now. Goodbye.',
): string {
  const response = new VoiceResponse();
  response.say({ voice: 'alice' }, message);
  response.hangup();
  return response.toString();
}

/** Standard headers for a TwiML response. */
export const TWIML_HEADERS = {
  'Content-Type': 'text/xml; charset=utf-8',
  'Cache-Control': 'no-store',
} as const;
