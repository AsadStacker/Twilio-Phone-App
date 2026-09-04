/**
 * Authenticated Twilio REST client.
 *
 * SECURITY: reads TWILIO_API_SECRET. Server-only, same as lib/twilio/server.ts.
 *
 * Authenticates with the API key and secret rather than the account auth token,
 * so the credential used for API calls is one that can be rotated or revoked
 * without invalidating webhook signature validation, which needs the auth
 * token. The key pair is already required for minting Voice access tokens, so
 * this adds no new configuration.
 */

import 'server-only';

import twilio, { type Twilio } from 'twilio';

import { getMissingEnvVars, getTwilioConfig, TwilioConfigError } from '@/lib/twilio/server';

const REST_ENV_VARS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY',
  'TWILIO_API_SECRET',
] as const;

let cached: Twilio | null = null;

/**
 * Returns a shared REST client, built on first use.
 *
 * Cached because the client holds a keep-alive HTTP agent; constructing one per
 * request would open a new connection pool for every webhook.
 */
export function getRestClient(): Twilio {
  if (cached) return cached;

  const missing = getMissingEnvVars(REST_ENV_VARS);
  if (missing.length > 0) {
    throw new TwilioConfigError(
      `Missing Twilio environment variables: ${missing.join(', ')}`,
    );
  }

  const config = getTwilioConfig();
  cached = twilio(config.apiKey, config.apiSecret, {
    accountSid: config.accountSid,
  });

  return cached;
}

/** Twilio SIDs are 34 alphanumeric characters. */
const SID_PATTERN = /^[A-Za-z0-9]{34}$/;

/**
 * Guards a SID arriving from the browser before it is interpolated into a
 * Twilio API path. The client is trusted to name its own call, but not to send
 * something that is not a SID at all.
 */
export function isSid(value: unknown, prefix?: string): value is string {
  if (typeof value !== 'string' || !SID_PATTERN.test(value)) return false;
  return prefix ? value.startsWith(prefix) : true;
}

/**
 * Absolute URL for a webhook, or null when no public origin is configured.
 * Twilio rejects relative callback URLs, so a missing origin has to be caught
 * before the API call rather than after.
 */
export function webhookUrl(pathname: string): string | null {
  const { appUrl } = getTwilioConfig();
  if (!appUrl) return null;

  try {
    return new URL(pathname, appUrl).toString();
  } catch {
    return null;
  }
}
