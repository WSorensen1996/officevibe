import { useEffect, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';

/** Create a new skill, or edit an existing one (pass `initial.slug`). On a
 *  successful save the parent refreshes the list. Mirrors AddMcpServerModal's
 *  overlay/form conventions. User-saved skills become human-owned (the curator
 *  then leaves them alone). */
export interface SkillEditorModalProps {
  /** When set, edit this skill (its body is fetched on open); omit to create new. */
  initial?: { slug: string };
  onClose: () => void;
  onSaved: () => void;
}

export function SkillEditorModal({ initial, onClose, onSaved }: SkillEditorModalProps) {
  const isEdit = !!initial?.slug;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(isEdit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let alive = true;
    if (!initial?.slug) return;
    window.cth.knowledgeGet(initial.slug).then((r) => {
      if (!alive) return;
      setLoading(false);
      if (r.ok && r.skill) {
        setTitle(r.skill.title);
        setDescription(r.skill.description);
        setTags((r.skill.tags ?? []).join(', '));
        setBody(r.skill.body);
      } else {
        setError(r.error ?? 'could not load skill');
      }
    }).catch((e) => { if (alive) { setLoading(false); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { alive = false; };
  }, [initial?.slug]);

  const save = async () => {
    setError(undefined);
    if (!title.trim()) { setError('Title is required'); return; }
    if (!body.trim()) { setError('Body is required'); return; }
    setBusy(true);
    try {
      const res = await window.cth.knowledgeSave({
        slug: initial?.slug,
        title: title.trim(),
        description: description.trim(),
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        body,
        isNew: !isEdit
      });
      if (!res.ok) { setError(res.error ?? 'save failed'); return; }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(26, 19, 32, 0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 640, maxWidth: '94vw', maxHeight: '92vh', overflowY: 'auto' }}>
        <PixelPanel variant="dialog" title={isEdit ? `EDIT SKILL — ${initial?.slug}` : 'NEW SKILL'} style={{ padding: 16 }} noPadding>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
            {loading ? (
              <div style={{ color: 'var(--cth-ink-500)', fontSize: 14 }}>loading…</div>
            ) : (
              <>
                <Row label="Title">
                  <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Run the test suite" style={inputStyle} />
                </Row>
                <Row label="Description (one line, ≤80 chars — drives the per-task relevance match)">
                  <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={120} placeholder="How to run and debug the project test suite." style={inputStyle} />
                </Row>
                <Row label="Tags (comma-separated)">
                  <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="testing, npm" style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)', fontSize: 13 }} />
                </Row>
                <Row label="Body (Markdown — the reusable procedure + gotchas)">
                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder={'# Run tests\n\n1. `npm test` from the repo root.\n2. A single file: `npm test -- path/to.test.ts`.\n\n## Gotchas\n- …'}
                    rows={14}
                    spellCheck={false}
                    style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)', fontSize: 13, lineHeight: '18px', resize: 'vertical', minHeight: 200 }}
                  />
                </Row>

                {error && (
                  <div style={{ padding: '6px 10px', background: 'var(--cth-coral-light)', boxShadow: 'inset 0 0 0 1px var(--cth-coral)', fontSize: 14, color: 'var(--cth-ink-900)' }}>
                    {error}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                  <PixelButton variant="ghost" size="md" onClick={onClose} disabled={busy}>cancel</PixelButton>
                  <PixelButton variant="primary" size="md" onClick={save} disabled={busy}>
                    {busy ? 'saving…' : isEdit ? 'save changes' : 'create skill'}
                  </PixelButton>
                </div>
              </>
            )}
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 15, color: 'var(--cth-ink-900)',
  outline: 'none', boxSizing: 'border-box'
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px', color: 'var(--cth-ink-700)', textTransform: 'uppercase' }}>{label}</span>
      {children}
    </label>
  );
}
