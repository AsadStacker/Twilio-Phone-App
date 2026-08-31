/** Shared types used by both the UI and the storage layer. */

/** The lifecycle of a single call, driven by Twilio Voice SDK events. */
export type CallState =
  | 'idle'
  | 'calling'
  | 'ringing'
  | 'connected'
  | 'ended'
  | 'failed';

export type CallDirection = 'inbound' | 'outbound';

/** Final disposition of a call, stored in history. */
export type CallStatus =
  | 'completed'
  | 'missed'
  | 'rejected'
  | 'canceled'
  | 'failed';

/** One entry in the localStorage call history. */
export interface CallRecord {
  id: string;
  callSid: string | null;
  fromNumber: string;
  toNumber: string;
  direction: CallDirection;
  status: CallStatus;
  /** ISO 8601 timestamp of when the call was initiated or received. */
  startTime: string;
  /** ISO 8601 timestamp of when the call ended. */
  endTime: string;
  /** Connected duration in whole seconds. 0 for calls that never connected. */
  duration: number;
}
