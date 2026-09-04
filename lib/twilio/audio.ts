/**
 * Microphone plumbing for the browser phone.
 *
 * Left alone, the Voice SDK calls `getUserMedia({ audio: true })` at the moment
 * a call starts and captures whatever the browser considers the *default*
 * input. On a headset that default is often the wrong thing: Windows exposes a
 * USB or Bluetooth headset as several endpoints and only one of them carries a
 * microphone, and Chrome keeps its own per-site default that can still point at
 * the built-in array mic. The call then looks perfectly healthy -- audio plays
 * in both directions -- while the far end hears silence.
 *
 * So this module picks the input device explicitly, remembers the choice, and
 * hands the SDK a stream it acquired itself rather than letting it guess.
 */

/** localStorage key holding the user's chosen input device ID. */
export const PREFERRED_MIC_KEY = 'twilio_preferred_microphone';

/**
 * Processing applied to every captured stream. These are Chrome's defaults for
 * a bare `audio: true`, but naming them means the SDK's own
 * `setAudioConstraints` path uses the same settings as our probe, so switching
 * devices mid-session cannot silently change the processing.
 *
 * A `deviceId` must never appear here: `setAudioConstraints` ignores it, and
 * the device is chosen through `setInputDevice` instead.
 */
export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof navigator !== 'undefined';
}

/**
 * Whether this page can capture audio at all. `navigator.mediaDevices` is
 * undefined outside a secure context, so an app served over plain HTTP on
 * anything but localhost can play call audio but never capture any.
 */
export function isMicrophoneSupported(): boolean {
  return isBrowser() && Boolean(navigator.mediaDevices?.getUserMedia);
}

/** Explains an unsupported environment, distinguishing the HTTP case. */
export function microphoneSupportMessage(): string {
  if (isBrowser() && !window.isSecureContext) {
    return (
      'Microphone access is blocked because this page is not on a secure ' +
      'origin. Open the app over HTTPS or on localhost.'
    );
  }
  return 'This browser does not support microphone access.';
}

/** Reads the remembered input device ID, if any. */
export function readPreferredMicrophoneId(): string | null {
  if (!isBrowser()) return null;
  try {
    return window.localStorage.getItem(PREFERRED_MIC_KEY);
  } catch {
    // Storage disabled (private browsing, blocked site data).
    return null;
  }
}

/** Remembers an input device ID, or forgets it when passed null. */
export function writePreferredMicrophoneId(deviceId: string | null): void {
  if (!isBrowser()) return;
  try {
    if (deviceId) {
      window.localStorage.setItem(PREFERRED_MIC_KEY, deviceId);
    } else {
      window.localStorage.removeItem(PREFERRED_MIC_KEY);
    }
  } catch {
    // Non-fatal: the choice just will not survive a reload.
  }
}

/**
 * Lists the audio input devices. Labels are only populated once microphone
 * permission has been granted, so call this after `ensureMicrophoneAccess`.
 */
export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  if (!isBrowser() || !navigator.mediaDevices?.enumerateDevices) return [];

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'audioinput');
  } catch {
    return [];
  }
}

/**
 * Settles microphone permission and reports which device the browser actually
 * gave us.
 *
 * The returned ID matters: it is the difference between telling the SDK "use
 * device X" and letting it re-resolve "default" a second time, which is how a
 * headset ends up recording from the laptop lid. When `preferredDeviceId` is
 * gone -- headset unplugged since the last session -- the exact constraint is
 * dropped and the stored preference cleared rather than failing the call.
 */
export async function ensureMicrophoneAccess(
  preferredDeviceId?: string | null,
): Promise<string | null> {
  if (!isMicrophoneSupported()) {
    throw new Error(microphoneSupportMessage());
  }

  const constraints: MediaTrackConstraints = { ...MIC_CONSTRAINTS };
  if (preferredDeviceId) {
    constraints.deviceId = { exact: preferredDeviceId };
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    // The remembered device is no longer attached: forget it and retry with
    // whatever the browser has.
    if (
      preferredDeviceId &&
      (name === 'OverconstrainedError' || name === 'NotFoundError')
    ) {
      writePreferredMicrophoneId(null);
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...MIC_CONSTRAINTS },
      });
    } else {
      throw error;
    }
  }

  const track = stream.getAudioTracks()[0] ?? null;
  const grantedDeviceId = track?.getSettings().deviceId ?? null;

  // Release the probe. The SDK reacquires by ID through `setInputDevice`, so
  // nothing downstream depends on this stream staying open.
  stream.getTracks().forEach((t) => t.stop());

  return grantedDeviceId ?? null;
}

/** Segments in the on-screen input level meter. */
export const LEVEL_METER_SEGMENTS = 12;

/**
 * The SDK reports volume as 0-1 across -100dB to -30dB, so ordinary speech
 * sits low in that range. This gain spreads it across the meter rather than
 * leaving every normal voice pinned to the first two segments -- it changes
 * the display, never the measurement.
 */
const LEVEL_METER_GAIN = 2.5;

/** Meter position, 0 to LEVEL_METER_SEGMENTS, for a raw 0-1 volume. */
export function levelToSegments(volume: number): number {
  return Math.min(
    LEVEL_METER_SEGMENTS,
    Math.round(volume * LEVEL_METER_SEGMENTS * LEVEL_METER_GAIN),
  );
}

/**
 * Rounds a raw volume to the meter's own resolution.
 *
 * The SDK emits volume every 50ms. Quantising to what the meter can actually
 * show means a steady level -- silence above all -- stops producing React
 * state updates, instead of re-rendering the dialler twenty times a second to
 * draw the identical picture.
 */
export function quantiseLevel(volume: number): number {
  const steps = LEVEL_METER_SEGMENTS * LEVEL_METER_GAIN;
  return Math.round(volume * steps) / steps;
}

/** A short, human label for a device, falling back when labels are hidden. */
export function microphoneLabel(device: MediaDeviceInfo, index: number): string {
  if (device.label) return device.label;
  if (device.deviceId === 'default') return 'System default';
  return `Microphone ${index + 1}`;
}
