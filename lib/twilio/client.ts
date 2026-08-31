/**
 * Browser-side Twilio helpers: token fetching and error translation.
 * Contains no credentials -- the token is minted server-side.
 */

export interface VoiceTokenResponse {
  token: string;
  identity: string;
  expiresIn: number;
}

/** Requests a Voice access token from our own API route. */
export async function fetchVoiceToken(): Promise<VoiceTokenResponse> {
  const response = await fetch('/api/twilio/token', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    let message = 'Could not reach the server to set up calling.';
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // Non-JSON error response; keep the generic message.
    }
    throw new Error(message);
  }

  const data = (await response.json()) as Partial<VoiceTokenResponse>;

  if (!data.token || !data.identity) {
    throw new Error('The server returned an invalid access token.');
  }

  return {
    token: data.token,
    identity: data.identity,
    expiresIn: data.expiresIn ?? 3600,
  };
}

/**
 * Maps Twilio Voice error codes to short, user-facing messages.
 * Codes are documented at twilio.com/docs/api/errors.
 */
const ERROR_MESSAGES: Record<number, string> = {
  // Authorization / token
  20101: 'Twilio authentication failed. Check your API key and secret.',
  20103: 'Twilio authentication failed. Invalid issuer or subject.',
  20104: 'Your calling session expired. Reconnecting…',
  31201: 'Twilio authentication failed.',
  31202: 'Twilio authentication failed.',
  31204: 'Twilio authentication failed. The access token is invalid.',
  31205: 'Your calling session expired. Reconnecting…',
  31207: 'Your calling session expired. Reconnecting…',

  // Microphone / media
  31208: 'Microphone permission denied. Allow microphone access and try again.',
  31401: 'Microphone permission denied. Allow microphone access and try again.',
  31402: 'No microphone was found. Connect a microphone and try again.',

  // Connection / transport
  31000: 'Unable to connect the call. Please try again.',
  31003: 'Network connection lost. Check your internet connection.',
  31005: 'The call was disconnected because of a connection problem.',
  31009: 'Network connection lost. Check your internet connection.',
  // 53000 is Twilio's catch-all signaling error, and its message ("connection
  // error") misdirects. Verified cause: a client identity containing a space or
  // other non-URL-safe character makes the gateway refuse registration. Name
  // that first so nobody goes hunting through firewall rules.
  53000:
    'Twilio refused the connection. Check TWILIO_CLIENT_IDENTITY has no spaces ' +
    'or quotes, then check your network.',
  53001: 'Network connection lost. Reconnecting…',
  53405: 'Unable to establish audio. Check your network or firewall.',

  // Call setup
  31404: 'Unable to connect the call. Please try again.',
  31480: 'The person you called is unavailable.',
  31486: 'The line is busy.',
  31603: 'The call was declined.',
};

/** Shape of a Twilio Voice SDK error, without importing the SDK types. */
interface TwilioLikeError {
  code?: number;
  message?: string;
  description?: string;
  causes?: string[];
  explanation?: string;
}

/**
 * Turns any thrown value into a message safe to show the user. Unknown Twilio
 * codes fall back to a generic message so internal details never surface.
 */
export function describeTwilioError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const err = error as TwilioLikeError;

    if (typeof err.code === 'number' && ERROR_MESSAGES[err.code]) {
      return ERROR_MESSAGES[err.code];
    }

    // Browser getUserMedia rejections arrive as DOMException.
    const name = (error as { name?: string }).name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'Microphone permission denied. Allow microphone access and try again.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No microphone was found. Connect a microphone and try again.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'Your microphone is already in use by another application.';
    }

    if (typeof err.code === 'number') {
      return `Unable to complete the call (Twilio error ${err.code}).`;
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Something went wrong. Please try again.';
}

/**
 * Prompts for microphone access up front so permission is settled before a
 * call starts, and so the failure is reportable as a clear message.
 */
export async function requestMicrophoneAccess(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser does not support microphone access.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  // Release the probe stream immediately; the SDK acquires its own.
  stream.getTracks().forEach((track) => track.stop());
}
