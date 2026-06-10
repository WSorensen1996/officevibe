// Renderer-side mirrors of the meeting types in src/main/meeting.ts (the same
// type-only mirroring pattern as store/config.ts ↔ main/config.ts). window.cth
// calls are already typed via the preload d.ts; these names exist so store and
// component state can be typed without importing from the preload package.

export interface MeetingSources {
  mic: boolean;
  systemAudio: boolean;
  systemAudioDeviceLabel?: string;
  screen: boolean;
}

export interface MeetingMeta {
  id: string;
  title: string;
  startedAt: string;
  endedAt?: string;
  durationSec?: number;
  status: 'recording' | 'ended' | 'interrupted';
  sources: MeetingSources;
  language: string;
  model: string;
  hasSummary?: boolean;
  hasRecording?: boolean;
  recordingBytes?: number;
  segmentCount?: number;
}

export interface TranscriptSegment {
  t0: number;
  t1: number;
  source: 'mic' | 'system';
  text: string;
}

export type InsightKind = 'recommendation' | 'proposal' | 'action-item' | 'note' | 'question';

export interface MeetingInsight {
  ts: string;
  by: string;
  meetingId: string;
  kind: InsightKind;
  text: string;
  quote?: string;
  suggestedTask?: { title: string; description?: string };
}

/** mm:ss (or h:mm:ss past an hour) for transcript timestamps + elapsed clocks. */
export function fmtClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
