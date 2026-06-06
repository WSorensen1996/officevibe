import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PixelButton } from './PixelButton';
import { BlockedBanner } from './BlockedBanner';
import { useStore, type Agent } from '@/store/store';
import { submitToPty } from '@/hooks/ptyInput';
import { markAnswered } from '@/hooks/capturePrompt';

// Derive the shapes from the preload-exposed API so the renderer never reaches across
// project boundaries for a type (window.cth is globally typed).
type ProjectMessage = Awaited<ReturnType<Window['cth']['projectInbox']>>[number];
type AgentSay = Awaited<ReturnType<Window['cth']['projectSays']>>[number];

/**
 * The Messages tab — a single chat-like timeline for one agent. It interleaves, in
 * chronological order:
 *   - what the agent SAID while working (its natural-language output, captured from the
 *     Claude Code transcript on each Stop hook and stored in agents/<id>/says.jsonl), and
 *   - mail the agent RECEIVED (its hive inbox).
 * A composer at the bottom sends a message straight to this agent (as the human), so the
 * tab reads as "chat with this agent". Oldest at top, newest at the bottom; auto-scrolls
 * to the bottom as new activity arrives (unless you've scrolled up to read history).
 */
export interface ThreadsPanelProps {
  agentId: string;
  /** Display name shown on the agent's own utterances (defaults to "agent"). */
  agentName?: string;
  /** The agent's accent color name — tints its spoken bubbles (defaults to sky). */
  accent?: string;
}

const ACT_COLOR: Record<string, string> = {
  request: 'var(--cth-peach)', inform: 'var(--cth-sky)', propose: 'var(--cth-lilac)',
  query: 'var(--cth-lemon)', agree: 'var(--cth-mint)', refuse: 'var(--cth-coral)', done: 'var(--cth-mint)'
};

interface TimelineItem {
  key: string;
  ts: string;                 // ISO timestamp — the sort key
  kind: 'said' | 'received';
  who: string;                // display label
  text: string;
  act?: string;               // received only
}

function buildTimeline(messages: ProjectMessage[], says: AgentSay[], agentName: string): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const m of messages) {
    items.push({ key: `m-${m.id}`, ts: m.created_at, kind: 'received', who: m.from, text: m.body, act: m.act });
  }
  for (const s of says) {
    items.push({ key: `s-${s.id}`, ts: s.ts, kind: 'said', who: agentName, text: s.text });
  }
  // Oldest → newest (chat convention). Stable enough — ids only tiebreak equal timestamps.
  return items.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.key < b.key ? -1 : 1));
}

/**
 * Pinned "needs you" card at the top of the Messages tab, shown when the agent is
 * blocked on a Claude Code prompt. Permission menus / yes-no prompts get
 * Approve/Always/Deny buttons (via BlockedBanner), which write the exact keystroke
 * to the agent's pty; a free-text question gets a reply box that types the answer
 * in. Answering optimistically clears the card; the authoritative hook stream then
 * keeps status in sync (and the content-aware guard stops it re-raising).
 */
function NeedsYouCard({ agent }: { agent: Agent }) {
  const updateAgent = useStore((s) => s.updateAgent);
  const [reply, setReply] = useState('');
  const reason = agent.blockReason;
  const ptyId = agent.ptyId;
  if (!reason || !ptyId) return null;

  const clear = () => {
    markAnswered(agent.id, reason);
    updateAgent(agent.id, { status: 'working', blockReason: undefined });
  };
  const onAction = (action: { decision?: 'allow' | 'deny' }) => {
    // Hook-backed permission card: resolve the PreToolUse gate with a structured
    // verdict (deny carries the typed reply as the reason fed back to the model).
    if (reason.requestId && action.decision) {
      const note = action.decision === 'deny' ? (reply.trim() || undefined) : undefined;
      void window.cth.respondPermission(reason.requestId, action.decision, note);
      setReply('');
      clear();
    }
  };
  const sendReply = async () => {
    const t = reply.trim();
    if (!t) return;
    setReply('');
    // On a permission card, a typed reply = deny + tell the agent what to do instead.
    if (reason.requestId) {
      void window.cth.respondPermission(reason.requestId, 'deny', t);
      clear();
      return;
    }
    clear();
    try { await submitToPty(ptyId, t); } catch { /* pty may have died */ }
  };

  // A genuine free-text question gets the reply box; a hook-backed permission card
  // also offers it as an optional "deny & explain" note. A legacy numbered menu /
  // (y/n) is buttons-only (Claude's TUI menu doesn't accept typed text).
  const showReplyBox = reason.promptKind === 'text' || !!reason.requestId;
  const replyPlaceholder = reason.requestId ? 'Optional: deny and tell the agent what to do instead…' : 'Type your answer…';
  const replyButtonLabel = reason.requestId ? 'Deny with note' : 'Send answer';

  return (
    <div style={{
      flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6,
      padding: 'var(--cth-space-2)', borderBottom: '1px solid var(--cth-ink-700)',
      background: 'var(--cth-paper-100)'
    }}>
      <BlockedBanner reason={reason} onAction={onAction} />
      {showReplyBox && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendReply(); } }}
            placeholder={replyPlaceholder}
            rows={2}
            style={{
              resize: 'vertical', width: '100%', boxSizing: 'border-box', padding: '6px 8px',
              fontFamily: 'var(--cth-font-ui)', fontSize: 14, lineHeight: '18px',
              color: 'var(--cth-ink-900)', background: 'var(--cth-cream-50)',
              border: 'none', boxShadow: 'inset 0 0 0 2px var(--cth-ink-700)'
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <PixelButton size="sm" onClick={sendReply} disabled={!reply.trim()}>{replyButtonLabel}</PixelButton>
          </div>
        </div>
      )}
    </div>
  );
}

export function ThreadsPanel({ agentId, agentName = 'agent', accent = 'sky' }: ThreadsPanelProps) {
  const [messages, setMessages] = useState<ProjectMessage[]>([]);
  const [says, setSays] = useState<AgentSay[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  // Live agent state — drives the pinned "needs you" card when this agent is
  // blocked on a Claude Code prompt (read out of its terminal buffer).
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const needsYou = agent?.status === 'blocked' && !!agent?.blockReason;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);   // keep pinned to the bottom unless the user scrolls up

  // Poll both sources (authoritative) and live-append says via the event (snappy).
  useEffect(() => {
    let alive = true;
    setMessages([]); setSays([]);   // reset when switching agents
    stickRef.current = true;        // a freshly-selected agent starts pinned to newest
    const load = async () => {
      try {
        const [inbox, said] = await Promise.all([
          window.cth.projectInbox(agentId),
          window.cth.projectSays(agentId)
        ]);
        if (alive) { setMessages(inbox); setSays(said); }
      } catch { /* keep last good state */ }
    };
    load();
    const t = setInterval(load, 3000);
    const off = window.cth.onProjectAgentSaid((e) => {
      if (e.agentId !== agentId) return;
      setSays((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        const add = e.says.filter((s) => !seen.has(s.id));
        return add.length ? [...prev, ...add].slice(-200) : prev;
      });
    });
    return () => { alive = false; clearInterval(t); off(); };
  }, [agentId]);

  const items = useMemo(() => buildTimeline(messages, says, agentName), [messages, says, agentName]);

  // Track whether the user is pinned to the bottom (so new activity doesn't yank them up).
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  // After items render, snap to the bottom if we're meant to be stuck there.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await window.cth.projectSend(
        { to: agentId, act: 'inform', subject: 'Message from you', body }, 'human'
      );
      setDraft('');
      stickRef.current = true;
    } catch { /* surfaced by the floor log; keep the draft so it isn't lost */ }
    finally { setSending(false); }
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--cth-paper-200)' }}>
      {needsYou && agent && <NeedsYouCard agent={agent} />}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--cth-space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--cth-space-2)' }}
      >
        {items.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--cth-ink-700)', textAlign: 'center', maxWidth: 280 }}>
              No activity yet. What this agent says while working — and any messages it receives — will appear here.
            </p>
          </div>
        ) : (
          items.map((it) => {
            const isSaid = it.kind === 'said';
            const isExp = expanded[it.key];
            const long = it.text.length > 240;
            const shown = isExp || !long ? it.text : it.text.slice(0, 240) + '…';
            const edge = isSaid ? `var(--cth-${accent})` : (ACT_COLOR[it.act ?? ''] ?? 'var(--cth-ink-300)');
            return (
              <div
                key={it.key}
                style={{
                  borderLeft: `3px solid ${edge}`,
                  paddingLeft: 8,
                  background: isSaid ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                  padding: '6px 8px 6px 8px'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 14, fontWeight: 700, color: 'var(--cth-ink-900)' }}>
                    {it.who}
                  </span>
                  <span style={{
                    fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px', padding: '0 6px',
                    background: 'var(--cth-cream-50)',
                    boxShadow: `inset 0 0 0 1px ${edge}`, color: 'var(--cth-ink-900)'
                  }}>{isSaid ? 'says' : it.act}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--cth-ink-500)' }}>
                    {new Date(it.ts).toLocaleString()}
                  </span>
                </div>
                <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 14, lineHeight: '18px', color: 'var(--cth-ink-700)', marginTop: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {shown}
                  {long && (
                    <button
                      onClick={() => setExpanded((s) => ({ ...s, [it.key]: !isExp }))}
                      style={{ marginLeft: 6, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--cth-sky)', fontFamily: 'var(--cth-font-ui)', fontSize: 13, padding: 0 }}
                    >{isExp ? 'less' : 'more'}</button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Composer — sends a message straight to this agent (as the human). */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 'var(--cth-space-2)', borderTop: '1px solid var(--cth-ink-700)', background: 'var(--cth-cream-100)', flexShrink: 0 }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
          placeholder={`Message ${agentName}…  (⌘/Ctrl+Enter to send)`}
          rows={2}
          style={{
            resize: 'vertical', width: '100%', boxSizing: 'border-box', padding: '6px 8px',
            fontFamily: 'var(--cth-font-ui)', fontSize: 14, lineHeight: '18px',
            color: 'var(--cth-ink-900)', background: 'var(--cth-cream-50)',
            border: 'none', boxShadow: 'inset 0 0 0 2px var(--cth-ink-700)'
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <PixelButton size="sm" onClick={send} disabled={sending || !draft.trim()}>
            {sending ? 'Sending…' : 'Send'}
          </PixelButton>
        </div>
      </div>
    </div>
  );
}
