import { useEffect } from 'react';
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

  // Keyboard shortcut: ⌘/Ctrl+Shift+M starts/stops recording (mirrors tapping the
  // button) so you can dictate without reaching for the mouse. The modifiers mean
  // it never types a character, so it's safe to fire even while the target textarea
  // is focused — that's exactly when you'd dictate into it. Ignored mid-transcribe
  // (matches the button's disabled state). Assumes a single mounted MicButton (the
  // new-task form is the only place it's used today).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        if (state !== 'transcribing') toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, state]);

  const title = error
    ? `Speech-to-text error: ${error}`
    : recording
    ? 'Stop & transcribe (⌘/Ctrl+Shift+M)'
    : busy
    ? 'Transcribing…'
    : 'Dictate — speak instead of typing (⌘/Ctrl+Shift+M)';

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
