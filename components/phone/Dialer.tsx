'use client';

/**
 * Composes the phone UI: input, keypad, controls, status and history.
 * All Twilio state comes from `useTwilioPhone`; this component only renders it
 * and validates input before dialling.
 */

import { useCallback, useMemo, useState } from 'react';

import CallControls from '@/components/phone/CallControls';
import CallHistory from '@/components/phone/CallHistory';
import CallStatus from '@/components/phone/CallStatus';
import CallTimer from '@/components/phone/CallTimer';
import DialPad from '@/components/phone/DialPad';
import IncomingCall from '@/components/phone/IncomingCall';
import MicrophonePicker from '@/components/phone/MicrophonePicker';
import PhoneInput from '@/components/phone/PhoneInput';
import TranscriptPanel from '@/components/phone/TranscriptPanel';
import TranscriptionControls from '@/components/phone/TranscriptionControls';
import { useCallTranscript } from '@/hooks/useCallTranscript';
import { useTwilioPhone } from '@/hooks/useTwilioPhone';
import { toE164, validateDialTarget } from '@/lib/twilio/validation';

export default function Dialer() {
  const phone = useTwilioPhone();
  const [input, setInput] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const {
    callSid,
    callState,
    deviceStatus,
    durationSeconds,
    error,
    hasIncomingCall,
    identity,
    incomingFrom,
    inputLevel,
    isMuted,
    isTestingMic,
    isTranscribing,
    micWarning,
    microphones,
    remoteNumber,
    selectedMicrophoneId,
    transcription,
  } = phone;

  const inCall =
    callState === 'calling' || callState === 'ringing' || callState === 'connected';

  // Only subscribes once Twilio has assigned a CallSid, and only when captions
  // are actually wanted -- an idle EventSource would hold a server connection
  // open for nothing.
  //
  // The post-call transcript is only worth asking for once the call is over and
  // the recording exists, so polling starts when the call leaves the live
  // states rather than as soon as there is a CallSid.
  const transcript = useCallTranscript(
    transcription.liveCaptions || transcription.postCallTranscript
      ? callSid
      : null,
    transcription.postCallTranscript && !inCall && Boolean(callSid),
  );

  /** Once connected the keypad sends DTMF tones instead of editing the input. */
  const keypadSendsDtmf = callState === 'connected';

  const e164Preview = useMemo(() => (input ? toE164(input) : null), [input]);

  const handleKeyPress = useCallback(
    (digit: string) => {
      if (keypadSendsDtmf) {
        phone.sendDigit(digit);
        return;
      }
      setValidationError(null);
      setInput((current) => current + digit);
    },
    [keypadSendsDtmf, phone],
  );

  const handleCall = useCallback(() => {
    const result = validateDialTarget(input);

    if (!result.ok) {
      setValidationError(result.error);
      return;
    }

    setValidationError(null);
    void phone.startCall(result.e164);
  }, [input, phone]);

  const handleHangUp = useCallback(() => {
    phone.hangUp();
  }, [phone]);

  const visibleError = validationError ?? error;
  const canCall = deviceStatus === 'ready' && !inCall && input.trim().length > 0;

  return (
    <>
      {hasIncomingCall ? (
        <IncomingCall
          from={incomingFrom}
          onAccept={phone.acceptIncoming}
          onReject={phone.rejectIncoming}
        />
      ) : null}

      <div className="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        {/* Dialler */}
        <section
          className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 shadow-xl"
          aria-label="Dialler"
        >
          <div className="flex min-h-20 flex-col items-center justify-center gap-2">
            <CallStatus
              callState={callState}
              deviceStatus={deviceStatus}
              identity={identity}
              remoteNumber={remoteNumber}
            />
            {callState === 'connected' || (callState === 'ended' && durationSeconds > 0) ? (
              <CallTimer
                seconds={durationSeconds}
                active={callState === 'connected'}
              />
            ) : null}
          </div>

          <div className="mt-5">
            <PhoneInput
              value={input}
              onChange={(value) => {
                setValidationError(null);
                setInput(value);
              }}
              onBackspace={() => setInput((current) => current.slice(0, -1))}
              onSubmit={handleCall}
              disabled={inCall}
              preview={e164Preview}
            />
          </div>

          <div className="mt-4">
            <DialPad
              onPress={handleKeyPress}
              disabled={inCall && !keypadSendsDtmf}
            />
            {keypadSendsDtmf ? (
              <p className="mt-2 text-center text-xs text-slate-500">
                Keypad sends touch tones during the call
              </p>
            ) : null}
          </div>

          <div className="mt-6">
            <CallControls
              callState={callState}
              isMuted={isMuted}
              canCall={canCall}
              onCall={handleCall}
              onHangUp={handleHangUp}
              onToggleMute={phone.toggleMute}
            />
          </div>

          <div className="mt-5">
            <MicrophonePicker
              microphones={microphones}
              selectedId={selectedMicrophoneId}
              level={inputLevel}
              live={callState === 'connected'}
              isTesting={isTestingMic}
              warning={micWarning}
              onSelect={phone.selectMicrophone}
              onToggleTest={phone.toggleMicTest}
            />
          </div>

          <div className="mt-4">
            <TranscriptionControls
              settings={transcription}
              isTranscribing={isTranscribing}
              inCall={inCall}
              onChange={phone.setTranscriptionOption}
            />
          </div>

          {/* Reserve space so the layout does not jump when errors appear. */}
          <div className="mt-5 min-h-16">
            {visibleError ? (
              <div
                className="flex items-start gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3"
                role="alert"
              >
                <p className="flex-1 text-sm text-rose-200">{visibleError}</p>
                <div className="flex shrink-0 items-center gap-2">
                  {deviceStatus === 'error' ? (
                    <button
                      type="button"
                      onClick={phone.reinitialize}
                      className="rounded-lg bg-rose-500/20 px-2 py-1 text-xs text-rose-100 transition hover:bg-rose-500/30"
                    >
                      Retry
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setValidationError(null);
                      phone.dismissError();
                    }}
                    aria-label="Dismiss error"
                    className="rounded-lg px-2 py-1 text-xs text-rose-300 transition hover:bg-rose-500/20"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ) : deviceStatus === 'initializing' ? (
              <p className="text-center text-xs text-slate-500">
                Setting up your phone...
              </p>
            ) : null}
          </div>
        </section>

        {/* Transcript, then history */}
        <div className="flex min-w-0 flex-col gap-6">
          <TranscriptPanel
            liveCues={transcript.cues}
            batchCues={transcript.batchCues}
            batchStatus={transcript.batchStatus}
            batchMessage={transcript.batchMessage}
            batchSavedLocally={transcript.batchSavedLocally}
            onRetryBatch={transcript.refetchBatch}
            isStreaming={transcript.isStreaming}
            error={transcript.error}
            enabled={transcription.liveCaptions}
            callSid={callSid}
          />

          <CallHistory
            onSelectNumber={(number) => {
              if (inCall) return;
              setValidationError(null);
              setInput(number);
            }}
          />
        </div>
      </div>
    </>
  );
}
