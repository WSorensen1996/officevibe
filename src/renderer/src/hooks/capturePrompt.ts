import type { BlockReason } from '@/store/store';

// --- post-answer guard (content-aware) ---------------------------------------
// When the user answers, the prompt lingers in the buffer for a beat before Claude
// repaints. We must suppress re-raising THAT prompt — but a DIFFERENT prompt that
// appears right after (e.g. approving one tool leads straight into another) must
// surface immediately. So we remember a signature of the answered prompt and only
// suppress while the freshly-classified prompt matches it.
const answered = new Map<string, { sig: string; ts: number }>();

export function signatureOf(r: BlockReason): string {
  return [r.promptKind ?? '', r.summary, r.command ?? '', (r.menuItems ?? []).map((m) => m.label).join(',')].join('|');
}
export function markAnswered(agentId: string, reason: BlockReason): void {
  answered.set(agentId, { sig: signatureOf(reason), ts: Date.now() });
}
