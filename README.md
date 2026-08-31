# Twilio Call Dialer

A browser phone built with Next.js and the Twilio Voice JavaScript SDK. Make and
receive real phone calls from a web page: dial a number, talk through your
computer's microphone and speakers, mute, watch the call timer, hang up, and see
the call in your history.

Call history is stored in the browser's `localStorage`. There is no database.

- **Framework:** Next.js 16 (App Router) + TypeScript
- **Styling:** Tailwind CSS v4
- **Voice:** `@twilio/voice-sdk` v2 in the browser, `twilio` v6 on the server
- **Storage:** browser `localStorage` only

---

## 1. What you need from Twilio

Create a free account at [twilio.com/try-twilio](https://www.twilio.com/try-twilio)
if you do not have one, then collect five values.

### Account SID and Auth Token

Twilio Console home page → **Account Info**.

| Value | Looks like | Used for |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID` | `ACxxxxxxxx…` | Signing access tokens |
| `TWILIO_AUTH_TOKEN` | 32 hex characters | Validating webhook signatures |

### API Key and Secret

Console → **Account → API keys & tokens → Create API key**. Choose a
**Standard** key and your usual region.

| Value | Looks like |
| --- | --- |
| `TWILIO_API_KEY` | `SKxxxxxxxx…` |
| `TWILIO_API_SECRET` | random string |

> The secret is displayed **once**, at creation. Copy it immediately — if you
> lose it you must create a new key.

### A phone number

Console → **Phone Numbers → Manage → Buy a number**. Filter for **Voice**
capability. On a trial account the number is paid for with your trial credit.

Record it in E.164 format, e.g. `+14155552671` → `TWILIO_PHONE_NUMBER`.

> **Trial accounts** can only call numbers you have verified under
> **Phone Numbers → Verified Caller IDs**. Verify your own mobile first, then
> use that as your test destination.

### A TwiML App

This is the piece that lets the browser place outbound calls. Console →
**Voice → Manage → TwiML → TwiML Apps → Create new TwiML App**.

- **Friendly name:** `Twilio Call Dialer`
- **Voice → Request URL:** `https://<your-public-url>/api/twilio/voice` (`HTTP POST`)

Save it and copy the SID (`APxxxxxxxx…`) → `TWILIO_TWIML_APP_SID`.

When the browser calls `device.connect()`, Twilio fetches TwiML from this URL,
and the app responds with a `<Dial>` to the number you typed.

---

## 2. A public URL for webhooks

Twilio calls your app over the public internet, so `localhost` is not reachable
during development. Start a tunnel and use its HTTPS URL everywhere below.

```bash
# ngrok (https://ngrok.com/download)
ngrok http 3000

# or Cloudflare Tunnel
cloudflared tunnel --url http://localhost:3000
```

Copy the HTTPS forwarding URL, e.g. `https://a1b2c3d4.ngrok-free.app`.

> The free ngrok URL changes each restart. When it does, update
> `NEXT_PUBLIC_APP_URL` **and** the two Twilio webhook URLs, or signature
> validation will reject Twilio's requests.
>
> You do **not** need a tunnel just to place outbound calls if you skip
> incoming calls — but the TwiML App's Request URL must still be publicly
> reachable, so in practice you want the tunnel for both directions.

---

## 3. Configure the webhook URLs

With `https://<your-public-url>` in hand, set two things in the Twilio Console.

**a. The TwiML App** (Voice → TwiML → TwiML Apps → your app):

| Field | Value | Method |
| --- | --- | --- |
| Voice Request URL | `https://<your-public-url>/api/twilio/voice` | `HTTP POST` |

**b. The phone number** (Phone Numbers → Manage → Active numbers → your number
→ **Voice Configuration**):

| Field | Value | Method |
| --- | --- | --- |
| A call comes in → Webhook | `https://<your-public-url>/api/twilio/incoming` | `HTTP POST` |
| Call status changes | `https://<your-public-url>/api/twilio/status` | `HTTP POST` |

Leave the number's *Configure with* setting on **Webhooks, TwiML Bins,
Functions, Studio, Proxy**.

> **Rollback.** If this number previously pointed somewhere else, its earlier
> Voice configuration is saved in `twilio-number-previous-config.json`. To put
> it back, POST those values to
> `/2010-04-01/Accounts/<AccountSid>/IncomingPhoneNumbers/<NumberSid>.json`,
> or paste the old URL back into the Console.

---

## 4. Create `.env.local`

```bash
cp .env.local.example .env.local
```

Fill it in:

```env
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_API_KEY=SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_SECRET=your_api_secret
TWILIO_TWIML_APP_SID=APxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_NUMBER=+14155552671
TWILIO_CLIENT_IDENTITY=browser-user

NEXT_PUBLIC_APP_URL=https://a1b2c3d4.ngrok-free.app
```

`NEXT_PUBLIC_APP_URL` must match the origin Twilio requests, because webhook
signatures are computed over the full URL. A trailing slash is tolerated (paths
are resolved absolutely), but a different host or scheme is not.

`.env.local` is gitignored. `TWILIO_AUTH_TOKEN` and `TWILIO_API_SECRET` are read
only in server code and never reach the browser.

---

## 5. Run it

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. Under the heading you should see a green dot and
**Registered as browser-user**. That means the browser fetched an access token
and registered with Twilio for incoming calls.

Other scripts:

```bash
npm run build      # production build
npm start          # run the production build
npm run typecheck  # tsc --noEmit
npm run lint       # eslint (next lint was removed in Next 16)
```

---

## 6. Test an outbound call

1. Allow microphone access when the browser asks. Calling will not work without it.
2. Type a number — `4155552671`, `(415) 555-2671`, or `+14155552671` all work.
   Ten digits are assumed to be US/Canada; anything else needs its country code.
   The line under the input previews exactly what will be dialled.
3. Click the green call button.
4. Status goes **Calling → Ringing → Connected**, and the timer starts on connect.
5. Try **mute** — the mic button turns amber while muted.
6. During a connected call the keypad sends touch tones instead of editing the number.
7. Click the red button to hang up. The call appears under **Recent calls**.

On a trial account the destination must be a **verified** number, and Twilio
plays a short "trial account" message before connecting.

## 7. Test an incoming call

1. Keep the app open with the green **Registered** dot showing.
2. Call your Twilio number from a real phone.
3. An incoming-call modal appears with the caller's number and **Accept** /
   **Decline**.
4. Accept and talk; the timer starts. Decline and the caller is dropped.
5. Either way, the call is written to **Recent calls**.

If nothing rings, see the troubleshooting table below.

---

## 8. How it fits together

```
Browser (client components)                Next.js server (route handlers)
──────────────────────────                 ───────────────────────────────
useTwilioPhone
  POST /api/twilio/token  ───────────────►  mints a Voice access token
                                            (VoiceGrant: outgoing app + incoming)
  new Device(token).register()

  OUTBOUND
  device.connect({ params: { To } })
        │
        └─► Twilio ──POST──────────────►  /api/twilio/voice
                                            <Dial callerId=TWILIO_PHONE_NUMBER>
                                              <Number>To</Number>
            Twilio dials the number

  INBOUND
            caller ─► Twilio number
                   ──POST──────────────►  /api/twilio/incoming
                                            <Dial><Client>browser-user</Client>
        ┌─────────◄── device 'incoming'
  accept / reject

  ANY                Twilio ──POST─────►  /api/twilio/status  (logged only)

  call ends ──► localStorage['twilio_call_history']
```

### Project layout

```
app/
  layout.tsx                  root layout
  page.tsx                    server component shell
  icon.svg                    favicon
  globals.css                 Tailwind entry + theme
  api/twilio/
    token/route.ts            POST -> Voice access token
    voice/route.ts            outbound TwiML (TwiML App Request URL)
    incoming/route.ts         inbound TwiML (phone number webhook)
    status/route.ts           status callbacks (logs only)

components/phone/
  Dialer.tsx                  composes the UI, owns input + validation
  PhoneInput.tsx              number field, backspace, E.164 preview
  DialPad.tsx                 12-key keypad
  CallControls.tsx            call / end / mute buttons
  CallStatus.tsx              device + call status pills
  CallTimer.tsx               mm:ss timer, formatDuration()
  IncomingCall.tsx            incoming-call modal
  CallHistory.tsx             localStorage history list + clear

hooks/
  useTwilioPhone.ts           Device lifecycle, call state machine, timer

lib/
  twilio/client.ts            token fetch, error messages, mic permission
  twilio/server.ts            credentials, token minting, signature validation
  twilio/twiml.ts             TwiML builders
  twilio/validation.ts        phone parsing / E.164 / formatting
  storage/call-history.ts     localStorage read/write/clear
  types.ts                    CallState, CallRecord, ...
```

### Call states

`idle → calling → ringing → connected → ended`, with `failed` for errors.
Terminal states show for three seconds and then return to `idle`.

### History records

Stored under the `twilio_call_history` key, newest first, capped at 100 entries:

```json
{
  "id": "abc123",
  "callSid": "CAxxxxxxxx",
  "fromNumber": "+14155552671",
  "toNumber": "+12125551234",
  "direction": "outbound",
  "status": "completed",
  "startTime": "2026-08-31T14:20:00.000Z",
  "endTime": "2026-08-31T14:22:31.000Z",
  "duration": 151
}
```

`status` is one of `completed`, `missed`, `rejected`, `canceled`, `failed`.
`duration` counts **connected** seconds, so it is `0` for a call that never
connected. **Clear history** removes the key entirely.

Because this is `localStorage`, history is per browser and per device. It does
not sync, and clearing site data erases it.

---

## 9. Security notes

- `TWILIO_AUTH_TOKEN` and `TWILIO_API_SECRET` are read only inside
  `lib/twilio/server.ts` and `lib/twilio/twiml.ts`, both of which import
  `server-only`. An accidental client import becomes a build error.
- The browser receives only a short-lived (1 hour) Voice access token, scoped to
  Voice, refreshed automatically before expiry.
- `/api/twilio/voice`, `/incoming`, and `/status` verify `X-Twilio-Signature`
  against the auth token and reject mismatches with `403`.
- `/api/twilio/voice` re-validates the `To` parameter server-side, so a tampered
  client cannot make the server dial an arbitrary string.
- Error messages shown to the user are drawn from a fixed map; raw Twilio
  internals and credentials are logged server-side only.
- `.env.local` is gitignored. Do not commit it.

`TWILIO_VALIDATE_WEBHOOKS=false` disables signature checking so you can poke the
webhooks with `curl`. It logs a warning on every request. Never use it in
production.

---

## 10. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "Twilio is not configured on the server." | A required variable is missing from `.env.local`. The server log names it. Restart `npm run dev` after editing. |
| "Twilio authentication failed." | Wrong `TWILIO_API_KEY` / `TWILIO_API_SECRET`, or the key belongs to a different account than `TWILIO_ACCOUNT_SID`. |
| "Microphone permission denied." | Allow the mic in the browser's site settings and reload. Browsers only permit mic capture on `https://` or `http://localhost`. |
| Outbound call fails immediately | The TwiML App's Voice Request URL is wrong or unreachable. Check the tunnel is running and Twilio Console → **Monitor → Logs → Errors**. |
| Outbound call rings then drops (trial) | The destination is not a Verified Caller ID. |
| Incoming calls never ring the browser | The number's "A call comes in" webhook must point at `/api/twilio/incoming`; the green **Registered** dot must be showing; and `TWILIO_CLIENT_IDENTITY` must match on both sides (leave it at the default). |
| Twilio logs `403` on webhooks | `NEXT_PUBLIC_APP_URL` does not match the URL Twilio requested — usually a restarted tunnel with a new hostname, a trailing slash, or `http` vs `https`. |
| `ConnectionError (53000)` in the console | Almost always `TWILIO_CLIENT_IDENTITY` containing a **space or quotes**. Twilio client identities may use only letters, digits, `-`, `_` and `.`. Twilio reports this as a generic connection error, not an auth error, so it misleads. The token route now rejects a bad identity with a clear message instead. |
| No audio in either direction | Firewall blocking WebRTC media. Twilio needs UDP out on 10000–20000; corporate networks often block it. |
| History empty after a call | Private/incognito windows and "block site data" settings disable `localStorage`. |
