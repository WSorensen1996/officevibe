import { useCallback, useEffect, useRef, useState } from 'react';
import { PixelButton } from './PixelButton';
import { PixelBadge, type StatusKind } from './PixelBadge';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { Scroll, Section, Muted } from './CommandCenterPanel';
import { SkillEditorModal } from './SkillEditorModal';

/** Types derived from the IPC bridge so they never drift from the backend. */
type Skill = NonNullable<Awaited<ReturnType<typeof window.cth.knowledgeList>>['skills']>[number];
type Status = NonNullable<Awaited<ReturnType<typeof window.cth.knowledgeList>>['status']>;

const STATE_ORDER: Record<Skill['state'], number> = { active: 0, provisional: 1, stale: 2, archived: 3 };
const STATE_BADGE: Record<Skill['state'], StatusKind> = { active: 'success', provisional: 'thinking', stale: 'waiting', archived: 'ghost' };

const REFRESH_MS = 6000;

/** Command-center tab: see and administer the team's learned skill library
 *  (the "Project Brain"). Skills are captured by agents + curated in the
 *  background; here the user can view, edit, create, archive/restore, and
 *  delete them, and trigger a curator pass on demand. */
export function SkillsTab() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ slug: string } | 'new' | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [curating, setCurating] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await window.cth.knowledgeList();
      if (r.ok) { setSkills(r.skills ?? []); setStatus(r.status ?? null); setDisabled(null); }
      else { setSkills([]); setStatus(null); setDisabled(r.error ?? 'unavailable'); }
    } catch { /* noop */ } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    timer.current = setInterval(load, REFRESH_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load]);

  const archive = async (s: Skill) => { await window.cth.knowledgeArchive(s.slug); load(); };
  const restore = async (s: Skill) => { await window.cth.knowledgeRestore(s.slug); load(); };
  const del = async (s: Skill) => { await window.cth.knowledgeDelete(s.slug); load(); };
  const curateNow = async () => {
    setCurating(true);
    try { await window.cth.knowledgeCurateNow(); await load(); } finally { setCurating(false); }
  };

  const sorted = [...skills].sort((a, b) =>
    STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.title.localeCompare(b.title));

  return (
    <Scroll>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 13, color: 'var(--cth-ink-700)' }}>
          Reusable know-how the team has learned in this project. Agents draft these from experience; the curator keeps them tidy.
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <PixelButton variant="secondary" size="sm" onClick={curateNow} disabled={curating || !!disabled}>
            {curating ? 'curating…' : 'run curator now'}
          </PixelButton>
          <PixelButton variant="primary" size="sm" onClick={() => setEditing('new')} disabled={!!disabled}>
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><Icon name="plus" /> new skill</span>
          </PixelButton>
        </div>
      </div>

      {status && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, fontSize: 12, color: 'var(--cth-ink-500)' }}>
          <Stat n={status.total} label="total" />
          <Stat n={status.active} label="active" />
          <Stat n={status.provisional} label="provisional" />
          <Stat n={status.stale} label="stale" />
          <Stat n={status.archived} label="archived" />
        </div>
      )}

      <Section title="SKILLS">
        {loading && <Muted>Loading…</Muted>}
        {!loading && disabled && <Muted>Skill library unavailable: {disabled}. Enable it in config (skillLearning) with a project open.</Muted>}
        {!loading && !disabled && sorted.length === 0 && (
          <Muted>No skills yet. The team will add them as it works — or create one with “new skill”.</Muted>
        )}
        {sorted.map((s) => (
          <SkillRow
            key={s.slug}
            skill={s}
            onView={() => setViewing(s.slug)}
            onEdit={() => setEditing({ slug: s.slug })}
            onArchive={() => archive(s)}
            onRestore={() => restore(s)}
            onDelete={() => del(s)}
          />
        ))}
      </Section>

      {editing && (
        <SkillEditorModal
          initial={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {viewing && <SkillViewModal slug={viewing} onClose={() => setViewing(null)} onEdit={() => { setEditing({ slug: viewing }); setViewing(null); }} />}
    </Scroll>
  );
}

function SkillRow({ skill, onView, onEdit, onArchive, onRestore, onDelete }: {
  skill: Skill;
  onView: () => void; onEdit: () => void; onArchive: () => void; onRestore: () => void; onDelete: () => void;
}) {
  const [confirmDel, setConfirmDel] = useState(false);
  const archived = skill.state === 'archived';
  const used = skill.last_used_at ? new Date(skill.last_used_at).toLocaleDateString() : 'never';

  return (
    <div style={{ padding: 8, marginBottom: 8, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', opacity: archived ? 0.6 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 14, color: 'var(--cth-ink-900)', fontWeight: 600 }}>{skill.title}</span>
        <PixelBadge status={STATE_BADGE[skill.state]} label={skill.state} />
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)' }}>by {skill.created_by}</span>
      </div>

      <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', marginTop: 3 }}>{skill.desc}</div>

      <div style={{ display: 'flex', gap: 10, marginTop: 4, fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)' }}>
        <span>used {skill.use_count}× · injected {skill.inject_count}×{skill.patch_count > 0 ? ` · patched ${skill.patch_count}×` : ''}</span>
        <span>last used {used}</span>
        {skill.tags.length > 0 && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>#{skill.tags.join(' #')}</span>}
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <PixelButton variant="secondary" size="sm" onClick={onView}>view</PixelButton>
        <PixelButton variant="secondary" size="sm" onClick={onEdit}>edit</PixelButton>
        {archived
          ? <PixelButton variant="secondary" size="sm" onClick={onRestore}>restore</PixelButton>
          : <PixelButton variant="ghost" size="sm" onClick={onArchive}>archive</PixelButton>}
        <span style={{ flex: 1 }} />
        {confirmDel ? (
          <>
            <PixelButton variant="ghost" size="sm" onClick={() => setConfirmDel(false)}>cancel</PixelButton>
            <PixelButton variant="destructive" size="sm" onClick={onDelete}>delete?</PixelButton>
          </>
        ) : (
          <PixelButton variant="ghost" size="sm" onClick={() => setConfirmDel(true)}>
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><Icon name="x" /> delete</span>
          </PixelButton>
        )}
      </div>
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'baseline' }}>
      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 11, color: 'var(--cth-ink-900)' }}>{n}</span>
      <span>{label}</span>
    </span>
  );
}

/** Read-only full-text view of a skill's SKILL.md body. */
function SkillViewModal({ slug, onClose, onEdit }: { slug: string; onClose: () => void; onEdit: () => void }) {
  const [data, setData] = useState<{ title: string; description: string; tags: string[]; body: string } | null>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let alive = true;
    window.cth.knowledgeGet(slug).then((r) => {
      if (!alive) return;
      if (r.ok && r.skill) setData(r.skill); else setError(r.error ?? 'could not load skill');
    }).catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [slug]);

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(26, 19, 32, 0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 640, maxWidth: '94vw', maxHeight: '92vh', overflowY: 'auto' }}>
        <PixelPanelDialog title={data ? data.title : slug}>
          {error && <div style={{ color: 'var(--cth-coral)', fontSize: 13 }}>{error}</div>}
          {data && (
            <>
              <div style={{ fontSize: 13, color: 'var(--cth-ink-700)', marginBottom: 4 }}>{data.description}</div>
              {data.tags.length > 0 && (
                <div style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)', marginBottom: 10 }}>#{data.tags.join(' #')}</div>
              )}
              <div style={{ padding: 10, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
                <Markdown>{data.body}</Markdown>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                <PixelButton variant="ghost" size="md" onClick={onClose}>close</PixelButton>
                <PixelButton variant="primary" size="md" onClick={onEdit}>edit</PixelButton>
              </div>
            </>
          )}
        </PixelPanelDialog>
      </div>
    </div>
  );
}

/** Thin wrapper so the view modal matches the editor's dialog chrome. */
function PixelPanelDialog({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--cth-cream-50, var(--cth-cream-100))', boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)' }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--cth-ink-700)', fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-900)', textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  );
}
