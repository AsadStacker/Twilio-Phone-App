/**
 * GET /api/twilio/transcript-stream?callSid=CA...
 *
 * Server-sent events carrying the live transcript for one call. Twilio's
 * webhook writes into the broker; this streams it out to the browser.
 *
 * SSE rather than WebSockets because a Next route handler can return a
 * `ReadableStream` directly, and rather than polling because interim results
 * arrive several times a second and would be shredded by any poll interval
 * worth running.
 */

import { subscribe } from '@/lib/server/transcript-broker';
import type { TranscriptStreamEvent } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Twilio SIDs are 34 alphanumeric characters. */
const SID_PATTERN = /^[A-Za-z0-9]{34}$/;

/**
 * Comment frames keep the connection warm. Proxies -- and the ngrok tunnel used
 * in development -- close an idle response, and a silent call can easily go a
 * minute without a word.
 */
const HEARTBEAT_MS = 15_000;

export async function GET(request: Request) {
  const callSid = new URL(request.url).searchParams.get('callSid')?.trim();

  if (!callSid || !SID_PATTERN.test(callSid)) {
    return new Response('A valid callSid is required.', { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (payload: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // The client went away between the check and the write.
          closed = true;
        }
      };

      const sendEvent = (event: TranscriptStreamEvent) => {
        send(`data: ${JSON.stringify(event)}\n\n`);
      };

      // Replays the call so far, then stays subscribed.
      const unsubscribe = subscribe(callSid, sendEvent);

      const heartbeat = setInterval(() => send(': keep-alive\n\n'), HEARTBEAT_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      // Fires when the browser closes the EventSource or navigates away.
      request.signal.addEventListener('abort', cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      // Stops nginx-style proxies from buffering the stream into uselessness.
      'X-Accel-Buffering': 'no',
    },
  });
}
