/**
 * One-time setup for the Conversational Intelligence service that produces
 * post-call transcripts.
 *
 *   npm run setup:intelligence
 *
 * Idempotent: finds the service by unique name and updates its webhook, or
 * creates it. Prints the SID to put in .env.local as
 * TWILIO_INTELLIGENCE_SERVICE_SID.
 *
 * Plain .mjs rather than TypeScript so it runs with nothing but Node and
 * --env-file; it deliberately shares no code with the app, because the app
 * must never create Twilio resources on its own.
 *
 * NOTE: languageCode cannot be changed after the service is created. To
 * transcribe a different language you need a new service.
 */

import twilio from 'twilio';

/** Change only if you want a second, separate service alongside the first. */
const UNIQUE_NAME = 'twilio-call-dialer';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name}. Run with: node --env-file=.env.local ${process.argv[1]}`);
    process.exit(1);
  }
  return value;
}

const accountSid = required('TWILIO_ACCOUNT_SID');
const apiKey = required('TWILIO_API_KEY');
const apiSecret = required('TWILIO_API_SECRET');
const appUrl = required('NEXT_PUBLIC_APP_URL');
const languageCode = process.env.TWILIO_TRANSCRIPTION_LANGUAGE?.trim() || 'en-US';

const webhookUrl = new URL('/api/twilio/intelligence', appUrl).toString();
const client = twilio(apiKey, apiSecret, { accountSid });

const services = await client.intelligence.v2.services.list({ limit: 100 });
const existing = services.find((service) => service.uniqueName === UNIQUE_NAME);

let service;

if (existing) {
  console.log(`Found existing service ${existing.sid} (${UNIQUE_NAME}).`);

  if (existing.languageCode !== languageCode) {
    console.warn(
      `  ! Service language is ${existing.languageCode}, but ` +
        `TWILIO_TRANSCRIPTION_LANGUAGE is ${languageCode}. Language is fixed at ` +
        'creation; change UNIQUE_NAME in this script to make a new service.',
    );
  }

  service = await client.intelligence.v2.services(existing.sid).update({
    webhookUrl,
    webhookHttpMethod: 'POST',
    // Transcripts are requested per recording by
    // /api/twilio/recording-complete, so this must stay off -- on, it would
    // transcribe and bill every recording on the account.
    autoTranscribe: false,
  });
  console.log('Updated webhook.');
} else {
  service = await client.intelligence.v2.services.create({
    uniqueName: UNIQUE_NAME,
    friendlyName: 'Twilio Call Dialer',
    languageCode,
    webhookUrl,
    webhookHttpMethod: 'POST',
    autoTranscribe: false,
  });
  console.log(`Created service ${service.sid}.`);
}

console.log('');
console.log('Add this to .env.local:');
console.log('');
console.log(`  TWILIO_INTELLIGENCE_SERVICE_SID=${service.sid}`);
console.log('');
console.log(`Webhook: ${webhookUrl}`);
console.log(`Language: ${service.languageCode} (fixed)`);
