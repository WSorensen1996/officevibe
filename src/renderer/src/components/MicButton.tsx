import { Icon } from './Icon';
import { useDictation } from '@/hooks/useDictation';

export interface MicButtonProps {
  /** Called with the transcribed text when a recording finishes. */
  onTranscript: (text: string) => void;
}

/**
 * Small "tap to speak" button. Tap to record, tap again to transcribe locally
 * (Whisper on CPU, fully offline) and feed the text to `onTranscript`. Drop it
 * next to any text input; see useDictation for the shared-worker model loading.
 */
export function MicButton({ onTranscript }: MicButtonProps) {
  const { state, error, toggle } = useDictation(onTranscript);
  const recording = state === 'recording';
  const busy = state === 'transcribing';

  const title = error
    ? `Speech-to-text error: ${error}`
    : recording
    ? 'Stop & transcribe'
    : busy
    ? 'Transcribing…'
    : 'Dictate — speak instead of typing';

  // A short hint shown beside the button so state/errors are visible without DevTools.
  const hint = error ? error : recording ? 'recording…' : busy ? 'transcribing…' : '';

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        title={title}
        aria-label={title}
        style={{
          flexShrink: 0,
          height: 30,
          width: 30,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          cursor: busy ? 'progress' : 'pointer',
          background: recording ? 'var(--cth-coral)' : error ? 'var(--cth-coral-light)' : 'var(--cth-cream-100)',
          boxShadow: recording
            ? 'inset 0 0 0 2px var(--cth-ink-900), 0 2px 0 var(--cth-ink-900)'
            : 'inset 0 0 0 2px var(--cth-ink-700), 0 2px 0 var(--cth-ink-700)',
          opacity: busy ? 0.6 : 1
        }}
      >
        <Icon name="mic" />
      </button>
      {hint && (
        <span
          title={title}
          style={{
            fontSize: 11,
            lineHeight: '14px',
            maxWidth: 160,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: error ? 'var(--cth-coral)' : 'var(--cth-ink-500)'
          }}
        >
          {hint}
        </span>
      )}
    </span>
  );
}
