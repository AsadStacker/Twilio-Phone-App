'use client';

/**
 * Call history list, read straight from localStorage via useSyncExternalStore.
 * Updates on same-tab writes and on changes made in other tabs.
 */

import { useSyncExternalStore } from 'react';

import {
  clearCallHistory,
  getCallHistorySnapshot,
  getCallHistoryServerSnapshot,
  subscribeToCallHistory,
} from '@/lib/storage/call-history';
import { formatPhoneNumber } from '@/lib/twilio/validation';
import type { CallRecord } from '@/lib/types';
import { formatDuration } from '@/components/phone/CallTimer';

const STATUS_STYLES: Record<CallRecord['status'], string> = {
  completed: 'text-emerald-300',
  missed: 'text-amber-300',
  rejected: 'text-slate-400',
  canceled: 'text-slate-400',
  failed: 'text-rose-300',
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();

  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

interface CallHistoryProps {
  /** Tapping an entry loads its number back into the dialler. */
  onSelectNumber?: (number: string) => void;
}

export default function CallHistory({ onSelectNumber }: CallHistoryProps) {
  // Reads localStorage as an external store: no effect, no state duplication,
  // and SSR renders the empty snapshot before hydration swaps in real data.
  const records = useSyncExternalStore(
    subscribeToCallHistory,
    getCallHistorySnapshot,
    getCallHistoryServerSnapshot,
  );

  return (
    <section
      className="rounded-3xl border border-white/10 bg-white/[0.03] p-5"
      aria-labelledby="call-history-heading"
    >
      <header className="flex items-center justify-between">
        <h2
          id="call-history-heading"
          className="text-sm font-medium tracking-wide text-slate-300"
        >
          Recent calls
        </h2>

        {records.length > 0 ? (
          <button
            type="button"
            onClick={clearCallHistory}
            className="rounded-lg px-2 py-1 text-xs text-slate-400 transition hover:bg-white/5 hover:text-rose-300"
          >
            Clear history
          </button>
        ) : null}
      </header>

      {records.length === 0 ? (
        <p className="mt-6 text-center text-sm text-slate-500">
          No calls yet. Your call history is stored only in this browser.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-white/5">
          {records.map((record) => {
            const outbound = record.direction === 'outbound';
            const counterparty = outbound ? record.toNumber : record.fromNumber;

            return (
              <li key={record.id}>
                <button
                  type="button"
                  onClick={() => onSelectNumber?.(counterparty)}
                  disabled={!onSelectNumber}
                  className="flex w-full items-center gap-3 rounded-xl px-1 py-3 text-left transition enabled:hover:bg-white/5 disabled:cursor-default"
                >
                  <span
                    className={`shrink-0 ${
                      outbound ? 'text-sky-300' : STATUS_STYLES[record.status]
                    }`}
                    aria-hidden="true"
                  >
                    <ArrowIcon outbound={outbound} />
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-slate-100">
                      {formatPhoneNumber(counterparty)}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500">
                      <span className={STATUS_STYLES[record.status]}>
                        {record.status}
                      </span>
                      {' · '}
                      {outbound ? 'Outgoing' : 'Incoming'}
                      {record.duration > 0 ? ` · ${formatDuration(record.duration)}` : ''}
                    </span>
                  </span>

                  <span className="tabular shrink-0 text-xs text-slate-500">
                    {formatTimestamp(record.startTime)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ArrowIcon({ outbound }: { outbound: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      {outbound ? (
        <path d="M7 17 17 7M9 7h8v8" />
      ) : (
        <path d="M17 7 7 17M15 17H7V9" />
      )}
    </svg>
  );
}
