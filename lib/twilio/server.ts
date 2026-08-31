/**
 * Server-only Twilio helpers.
 *
 * SECURITY: this module reads TWILIO_AUTH_TOKEN and TWILIO_API_SECRET. It must
 * never be imported from a client component. The `server-only` guard below
 * turns an accidental client import into a build error rather than a leak.
 */

import 'server-only';

import twilio from 'twilio';

/** Identity registered by the browser client for incoming calls. */
export const BROWSER_IDENTITY = process.env.TWILIO_CLIENT_IDENTITY || 'browser-user';

/** Voice access tokens are short-lived; the client refreshes before expiry. */
export const TOKEN_TTL_SECONDS = 3600;

interface TwilioConfig {
  accountSid: string;
  authToken: string;
  apiKey: string;
  apiSecret: string;
  twimlAppSid: string;
  phoneNumber: string;
  appUrl: string;
}

function readEnv(name: string): string {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Returns the names of any required env vars that are missing, so routes can
 * report a clear setup problem without echoing secret values.
 */
export function getMissingEnvVars(required: readonly string[]): string[] {
  return required.filter((name) => !readEnv(name));
}

const TOKEN_ENV_VARS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY',
  'TWILIO_API_SECRET',
  'TWILIO_TWIML_APP_SID',
] as const;

/**
 * Loads and validates Twilio configuration. Throws if anything required is
 * absent -- callers turn that into a 500 with a generic message.
 */
export function getTwilioConfig(): TwilioConfig {
  const config: TwilioConfig = {
    accountSid: readEnv('TWILIO_ACCOUNT_SID'),
    authToken: readEnv('TWILIO_AUTH_TOKEN'),
    apiKey: readEnv('TWILIO_API_KEY'),
    apiSecret: readEnv('TWILIO_API_SECRET'),
    twimlAppSid: readEnv('TWILIO_TWIML_APP_SID'),
    phoneNumber: readEnv('TWILIO_PHONE_NUMBER'),
    appUrl: readEnv('NEXT_PUBLIC_APP_URL'),
  };

  return config;
}

/**
 * Twilio client identities must be URL-safe. A space or quote produces an
 * opaque signaling failure (ConnectionError 53000) rather than a clear
 * authorization error, so it is worth rejecting up front.
 */
const VALID_IDENTITY = /^[A-Za-z0-9_.-]{1,121}$/;

/**
 * Mints a Voice access token for the browser SDK.
 *
 * The token grants both outgoing calls (via the TwiML Application, which points
 * back at /api/twilio/voice) and incoming calls (by registering `identity`).
 */
export function createVoiceToken(identity: string = BROWSER_IDENTITY): {
  token: string;
  identity: string;
  expiresIn: number;
} {
  const missing = getMissingEnvVars(TOKEN_ENV_VARS);
  if (missing.length > 0) {
    throw new TwilioConfigError(
      `Missing Twilio environment variables: ${missing.join(', ')}`,
    );
  }

  if (!VALID_IDENTITY.test(identity)) {
    throw new TwilioConfigError(
      `Invalid client identity ${JSON.stringify(identity)}. ` +
        'TWILIO_CLIENT_IDENTITY may contain only letters, digits, "-", "_" and "." ' +
        '(no spaces or quotes).',
    );
  }

  const config = getTwilioConfig();
  const { AccessToken } = twilio.jwt;
  const { VoiceGrant } = AccessToken;

  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: config.twimlAppSid,
    incomingAllow: true,
  });

  const accessToken = new AccessToken(
    config.accountSid,
    config.apiKey,
    config.apiSecret,
    { identity, ttl: TOKEN_TTL_SECONDS },
  );

  accessToken.addGrant(voiceGrant);

  return {
    token: accessToken.toJwt(),
    identity,
    expiresIn: TOKEN_TTL_SECONDS,
  };
}

/** Thrown when required Twilio configuration is absent or malformed. */
export class TwilioConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TwilioConfigError';
  }
}

/**
 * Reconstructs the exact URL Twilio signed.
 *
 * Twilio computes its signature over the URL it requested. Behind a tunnel or
 * proxy the incoming request URL is often the internal one, so prefer the
 * configured public origin and fall back to forwarded headers.
 */
function getWebhookUrl(request: Request, pathname: string): string {
  const configured = readEnv('NEXT_PUBLIC_APP_URL');
  if (configured) {
    return new URL(pathname, configured).toString();
  }

  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedProto = request.headers.get('x-forwarded-proto') || 'https';
  if (forwardedHost) {
    return `${forwardedProto}://${forwardedHost}${pathname}`;
  }

  return new URL(request.url).toString();
}

/**
 * Verifies a Twilio webhook signature against the form-encoded body.
 *
 * Returns the parsed parameters when the request is authentic. Validation is
 * skipped only when TWILIO_VALIDATE_WEBHOOKS is explicitly set to "false",
 * which is intended for local testing with curl.
 */
export async function validateTwilioWebhook(
  request: Request,
  pathname: string,
): Promise<
  | { valid: true; params: Record<string, string> }
  | { valid: false; reason: string }
> {
  let params: Record<string, string> = {};

  try {
    const formData = await request.formData();
    for (const [key, value] of formData.entries()) {
      if (typeof value === 'string') {
        params[key] = value;
      }
    }
  } catch {
    return { valid: false, reason: 'Malformed request body' };
  }

  if (readEnv('TWILIO_VALIDATE_WEBHOOKS').toLowerCase() === 'false') {
    console.warn(
      '[twilio] Webhook signature validation is DISABLED. Do not run this way in production.',
    );
    return { valid: true, params };
  }

  const authToken = readEnv('TWILIO_AUTH_TOKEN');
  if (!authToken) {
    return { valid: false, reason: 'Server is missing TWILIO_AUTH_TOKEN' };
  }

  const signature = request.headers.get('x-twilio-signature');
  if (!signature) {
    return { valid: false, reason: 'Missing X-Twilio-Signature header' };
  }

  const url = getWebhookUrl(request, pathname);
  const valid = twilio.validateRequest(authToken, signature, url, params);

  if (!valid) {
    return { valid: false, reason: 'Signature did not match' };
  }

  return { valid: true, params };
}
