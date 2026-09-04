/**
 * Writes transcripts to local files, so the live Twilio transcript and the
 * post-call Conversational Intelligence transcript for the same call can be
 * read side by side.
 *
 * This is a testing aid. It is off unless `TRANSCRIPT_SAVE_DIR` is set, which
 * is a hard switch independent of the per-call toggle in the UI: without the
 * env var nothing here touches the disk, so the feature cannot be left on by
 * accident in a deployment.
 *
 * Per call, up to four files land in that directory:
 *   <CallSid>.live.jsonl     one JSON cue per line, as Twilio finalised it
 *   <CallSid>.live.txt       the same, readable
 *   <CallSid>.batch.jsonl    Conversational Intelligence sentences
 *   <CallSid>.compare.txt    both transcripts, one after the other
 */

import 'server-only';

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { TranscriptCue } from '@/lib/types';

/** Twilio SIDs are 34 chars of `[A-Za-z0-9]`; anything else is not a SID. */
const SID_PATTERN = /^[A-Za-z0-9]{34}$/;

function saveDir(): string | null {
  const configured = process.env.TRANSCRIPT_SAVE_DIR?.trim();
  if (!configured) return null;
  return path.resolve(process.cwd(), configured);
}

/**
 * Resolves the path for one of a call's transcript files.
 *
 * The CallSid is validated rather than escaped: it arrives from a webhook body
 * and is about to become a filename, so anything that is not literally a SID is
 * refused instead of being sanitised into something plausible.
 */
function filePath(callSid: string, suffix: string): string | null {
  const dir = saveDir();
  if (!dir || !SID_PATTERN.test(callSid)) return null;
  return path.join(dir, `${callSid}.${suffix}`);
}

async function ensureDir(): Promise<boolean> {
  const dir = saveDir();
  if (!dir) return false;

  try {
    await mkdir(dir, { recursive: true });
    return true;
  } catch (error) {
    console.warn('[transcript-files] Could not create save directory', error);
    return false;
  }
}

function speakerLabel(cue: TranscriptCue): string {
  return cue.speaker === 'user' ? 'You' : 'Caller';
}

function readableLine(cue: TranscriptCue): string {
  const time = cue.at.slice(11, 19) || '--:--:--';
  const confidence =
    typeof cue.confidence === 'number'
      ? ` (${Math.round(cue.confidence * 100)}%)`
      : '';
  return `[${time}] ${speakerLabel(cue)}${confidence}: ${cue.text}`;
}

/**
 * Appends one finalised live cue. Fire-and-forget by design: a disk problem
 * must never delay or fail the webhook response, so failures are logged and
 * swallowed.
 */
export async function appendLiveCue(cue: TranscriptCue): Promise<void> {
  const jsonl = filePath(cue.callSid, 'live.jsonl');
  const txt = filePath(cue.callSid, 'live.txt');
  if (!jsonl || !txt) return;
  if (!(await ensureDir())) return;

  try {
    await appendFile(jsonl, `${JSON.stringify(cue)}\n`, 'utf8');
    await appendFile(txt, `${readableLine(cue)}\n`, 'utf8');
  } catch (error) {
    console.warn('[transcript-files] Could not append live cue', error);
  }
}

/**
 * Reads back the live cues written during a call.
 *
 * The live transcript is only ever streamed and appended, never held in full in
 * memory, so the file is the record of it by the time the batch transcript
 * arrives minutes later. Returns empty when saving was off for that call.
 */
export async function readLiveCues(callSid: string): Promise<TranscriptCue[]> {
  const jsonl = filePath(callSid, 'live.jsonl');
  if (!jsonl) return [];

  try {
    const raw = await readFile(jsonl, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as TranscriptCue];
        } catch {
          // A torn last line from a process killed mid-append.
          return [];
        }
      });
  } catch {
    // No file: saving was off, or the call had no speech.
    return [];
  }
}

/** Writes the Conversational Intelligence transcript for a call. */
export async function writeBatchTranscript(
  callSid: string,
  cues: readonly TranscriptCue[],
): Promise<void> {
  const jsonl = filePath(callSid, 'batch.jsonl');
  if (!jsonl) return;
  if (!(await ensureDir())) return;

  try {
    await writeFile(
      jsonl,
      cues.map((cue) => JSON.stringify(cue)).join('\n') + (cues.length ? '\n' : ''),
      'utf8',
    );
  } catch (error) {
    console.warn('[transcript-files] Could not write batch transcript', error);
  }
}

/**
 * Renders both transcripts into one file. Deliberately sequential rather than
 * interleaved: the two engines disagree on utterance boundaries, so aligning
 * them line by line would imply a correspondence that is not there. Reading
 * them one after the other is the honest comparison.
 */
export async function writeComparison(
  callSid: string,
  live: readonly TranscriptCue[],
  batch: readonly TranscriptCue[],
): Promise<void> {
  const target = filePath(callSid, 'compare.txt');
  if (!target) return;
  if (!(await ensureDir())) return;

  const section = (title: string, cues: readonly TranscriptCue[]) =>
    [
      `=== ${title} (${cues.length} lines) ===`,
      ...(cues.length
        ? cues.map(readableLine)
        : ['(nothing recorded for this call)']),
      '',
    ].join('\n');

  const body = [
    `Call ${callSid}`,
    '',
    section('Live - Twilio Real-Time Transcription', live),
    section('Batch - Twilio Conversational Intelligence', batch),
  ].join('\n');

  try {
    await writeFile(target, body, 'utf8');
  } catch (error) {
    console.warn('[transcript-files] Could not write comparison', error);
  }
}
