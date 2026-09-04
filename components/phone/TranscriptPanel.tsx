'use client';

import { useEffect, useRef, useState } from 'react';

import type { TranscriptCue } from '@/lib/types';

interface TranscriptPanelProps {
  liveCues: TranscriptCue[];
  /** Twilio's post-call transcript. Empty until it arrives. */
  batchCues: TranscriptCue[];
  isStreaming: boolean;
  error: string | null;
  /** False when the captions toggle is off, so the panel can explain itself. */
  enabled: boolean;
  callSid: string | null;
}

type Tab = 'live' | 'batch';

/**
 * The transcript, with a tab for Twilio's post-call version once it lands.
 *
 * Two tabs rather than one merged view because the two engines disagree on
 * where one utterance ends and the next begins. Interleaving them would invent
 * a correspondence that is not in the data; reading them separately is what
 * makes them comparable.
 */
export default function TranscriptPanel({
  liveCues,
  batchCues,
  isStreaming,
  error,
  enabled,
  callSid,
}: TranscriptPanelProps) {
  const [tab, setTab] = useState<Tab>('live');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** False once the reader scrolls up, so autoscroll cannot fight them. */
  const pinnedRef = useRef(true);

  const cues = tab === 'live' ? liveCues : batchCues;

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinnedRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [cues]);

  return (
    <section
      className="flex min-h-0 flex-col rounded-3xl border border-white/10 bg-white/[0.03] p-6 shadow-xl"
      aria-label="Transcript"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-slate-200">Transcript</h2>

        <div className="flex items-center gap-3">
          {tab === 'live' && enabled ? (
            <span className="text-[11px] text-slate-500">
              {isStreaming ? 'Connected' : 'Waiting for Twilio…'}
            </span>
          ) : null}

          <div
            className="flex rounded-lg border border-white/10 bg-white/5 p-0.5"
            role="tablist"
            aria-label="Transcript source"
          >
            <TabButton
              active={tab === 'live'}
              onClick={() => setTab('live')}
              label="Live"
              count={liveCues.length}
            />
            <TabButton
              active={tab === 'batch'}
              onClick={() => setTab('batch')}
              label="Post-call"
              count={batchCues.length}
            />
          </div>
        </div>
      </div>

      {error ? (
        <p
          className="mt-3 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
          role="status"
        >
          {error}
        </p>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          // A small slack so a near-bottom position still counts as pinned.
          pinnedRef.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 40;
        }}
        className="mt-4 min-h-64 flex-1 space-y-3 overflow-y-auto pr-1"
        aria-live={tab === 'live' ? 'polite' : 'off'}
      >
        {cues.length > 0 ? (
          cues.map((cue) => <CueLine key={cue.id} cue={cue} />)
        ) : (
          <EmptyState tab={tab} enabled={enabled} callSid={callSid} />
        )}
      </div>
    </section>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-xs transition ${
        active ? 'bg-white/10 text-slate-100' : 'text-slate-400 hover:text-slate-200'
      }`}
    >
      {label}
      {count > 0 ? (
        <span className="ml-1.5 text-[10px] text-slate-500">{count}</span>
      ) : null}
    </button>
  );
}

function CueLine({ cue }: { cue: TranscriptCue }) {
  const isUser = cue.speaker === 'user';

  return (
    <div className="flex gap-3">
      <span
        className={`mt-0.5 w-14 shrink-0 text-[11px] font-medium uppercase tracking-wide ${
          isUser ? 'text-emerald-300/80' : 'text-sky-300/80'
        }`}
      >
        {isUser ? 'You' : 'Caller'}
      </span>
      <p
        className={`min-w-0 flex-1 text-sm leading-relaxed ${
          // An interim guess is dimmed and italic: it is about to be replaced,
          // and it should not read as settled text.
          cue.isFinal ? 'text-slate-200' : 'italic text-slate-500'
        }`}
      >
        {cue.text}
      </p>
    </div>
  );
}

function EmptyState({
  tab,
  enabled,
  callSid,
}: {
  tab: Tab;
  enabled: boolean;
  callSid: string | null;
}) {
  let message: string;

  if (tab === 'batch') {
    message = callSid
      ? 'Twilio’s post-call transcript appears here a minute or two after the call ends, if that toggle was on.'
      : 'No call yet.';
  } else if (!enabled) {
    message = 'Turn on live captions to transcribe a call.';
  } else if (!callSid) {
    message = 'Start a call and the transcript will appear here.';
  } else {
    message = 'Listening…';
  }

  return <p className="text-sm text-slate-500">{message}</p>;
}
