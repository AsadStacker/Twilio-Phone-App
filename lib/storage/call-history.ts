/**
 * Call history persistence. Browser localStorage only -- there is no database
 * and nothing here ever leaves the device.
 *
 * Also exposes a `useSyncExternalStore`-compatible contract
 * (`subscribeToCallHistory` + `getCallHistorySnapshot`) so components can read
 * history without a state-syncing effect.
 */

import type { CallRecord } from '@/lib/types';

export const CALL_HISTORY_KEY = 'twilio_call_history';

/** Cap the stored history so localStorage cannot grow without bound. */
const MAX_RECORDS = 100;

/** Fired on the window whenever history changes in this same tab. */
export const CALL_HISTORY_EVENT = 'twilio-call-history-change';

/** Shared empty snapshot, so an empty history keeps a stable identity. */
const EMPTY: readonly CallRecord[] = Object.freeze([]);

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function isCallRecord(value: unknown): value is CallRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<CallRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.fromNumber === 'string' &&
    typeof record.toNumber === 'string' &&
    (record.direction === 'inbound' || record.direction === 'outbound') &&
    typeof record.startTime === 'string' &&
    typeof record.duration === 'number'
  );
}

function readRaw(): string | null {
  if (!isBrowser()) return null;
  try {
    return window.localStorage.getItem(CALL_HISTORY_KEY);
  } catch {
    // Storage disabled (private browsing, blocked site data).
    return null;
  }
}

function parseRecords(raw: string | null): readonly CallRecord[] {
  if (!raw) return EMPTY;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY;

    const records = parsed.filter(isCallRecord);
    return records.length > 0 ? records : EMPTY;
  } catch {
    // Corrupt value: behave as if there is no history rather than throwing.
    return EMPTY;
  }
}

/**
 * Memoised snapshot. `useSyncExternalStore` re-renders in a loop unless
 * `getSnapshot` returns the identical reference for unchanged data, so the
 * parsed array is cached against the raw string it came from.
 */
let cachedRaw: string | null = null;
let cachedRecords: readonly CallRecord[] = EMPTY;
let cachePrimed = false;

/** Current history, newest first. Stable reference while storage is unchanged. */
export function getCallHistorySnapshot(): readonly CallRecord[] {
  const raw = readRaw();

  if (cachePrimed && raw === cachedRaw) return cachedRecords;

  cachedRaw = raw;
  cachedRecords = parseRecords(raw);
  cachePrimed = true;
  return cachedRecords;
}

/** Snapshot used during SSR and hydration, where localStorage does not exist. */
export function getCallHistoryServerSnapshot(): readonly CallRecord[] {
  return EMPTY;
}

/**
 * Subscribes to history changes: the custom event for this tab, and the native
 * `storage` event for changes made in other tabs.
 */
export function subscribeToCallHistory(onChange: () => void): () => void {
  if (!isBrowser()) return () => {};

  const handleStorage = (event: StorageEvent) => {
    // A null key means the whole store was cleared.
    if (event.key === null || event.key === CALL_HISTORY_KEY) onChange();
  };

  window.addEventListener(CALL_HISTORY_EVENT, onChange);
  window.addEventListener('storage', handleStorage);

  return () => {
    window.removeEventListener(CALL_HISTORY_EVENT, onChange);
    window.removeEventListener('storage', handleStorage);
  };
}

/** Reads the stored history as a mutable array, newest first. */
export function getCallHistory(): CallRecord[] {
  return [...getCallHistorySnapshot()];
}

function writeHistory(records: CallRecord[]): void {
  if (!isBrowser()) return;

  try {
    window.localStorage.setItem(
      CALL_HISTORY_KEY,
      JSON.stringify(records.slice(0, MAX_RECORDS)),
    );
  } catch {
    // Quota exceeded or storage disabled. History is a convenience, so failing
    // to persist it must not surface as an error.
    return;
  }

  window.dispatchEvent(new Event(CALL_HISTORY_EVENT));
}

/** Prepends a record to the history and returns the updated list. */
export function addCallRecord(record: CallRecord): CallRecord[] {
  const next = [record, ...getCallHistory().filter((r) => r.id !== record.id)];
  writeHistory(next);
  return next;
}

/** Removes every stored record. */
export function clearCallHistory(): void {
  if (!isBrowser()) return;

  try {
    window.localStorage.removeItem(CALL_HISTORY_KEY);
  } catch {
    return;
  }

  window.dispatchEvent(new Event(CALL_HISTORY_EVENT));
}

/** Deletes a single record by id and returns the updated list. */
export function removeCallRecord(id: string): CallRecord[] {
  const next = getCallHistory().filter((record) => record.id !== id);
  writeHistory(next);
  return next;
}

/** Generates an id for a new record, falling back when crypto is unavailable. */
export function createRecordId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
