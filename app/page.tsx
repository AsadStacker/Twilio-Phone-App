/**
 * Home page. A server component shell around the client-side dialler, which
 * owns the Twilio Voice SDK and all browser-only state.
 */

import Dialer from '@/components/phone/Dialer';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="mx-auto w-full max-w-5xl">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
          Twilio Call Dialer
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Make and receive calls from your browser. History stays on this device.
        </p>
      </header>

      <Dialer />
    </main>
  );
}
