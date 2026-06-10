import { useEffect } from 'react';
import { create } from 'zustand';
import {
  listAudioInputs, startCapture, stopCapture, isCapturing,
  type AudioInputDevice
} from '@/lib/meeting/capture';
import type { MeetingMeta, MeetingInsight, TranscriptSegment } from '@/lib/meeting/types';
import { useStore } from '@/store/store';

/**
 * The meeting feature's renderer state machine. The capture engine itself is a
 * module-scoped singleton (lib/meeting/capture.ts) so recording survives tab
 * switches; this store mirrors its lifecycle for the UI and owns everything
 * around it: device lists, the live transcript/insight feeds, history, and the
 * start/stop orchestration against the main process (meeting:* IPC).
 */

export type MeetingStatus = 'idle' | 'starting' | 'recording' | 'stopping';

/** Cap the LIVE feeds in memory — the full record is on disk (transcript.jsonl). */
const FEED_CAP = 300;

interface MeetingSetup {
  title: string;
  micOn: boolean;
  /** Selected system-audio (monitor) device id, or null = no system audio. */
  systemDeviceId: string | null;
  screenOn: boolean;
}

interface MeetingStore {
  status: MeetingStatus;
  /** The live meeting's metadata while recording (or just-stopped). */
  active: MeetingMeta | null;
  /** Seconds since recording started (1s ticker while recording). */
  elapsedSec: number;
  error: string | null;
  /** Why the meeting auto-stopped (OS stop-share etc.), surfaced once. */
  notice: string | null;

  devices: AudioInputDevice[];
  setup: MeetingSetup;

  transcript: TranscriptSegment[];
  insights: MeetingInsight[];
  /** Pending STT segments not yet transcribed — drives the "lagging" badge. */
  sttBacklog: number;
  levels: { mic: number; system: number };

  /** Past meetings (newest first) for the history view. */
  meetings: MeetingMeta[];

  refreshDevices: () => Promise<void>;
  setSetup: (patch: Partial<MeetingSetup>) => void;
  start: () => Promise<void>;
  stop: (reason?: string) => Promise<void>;
  loadMeetings: () => Promise<void>;
  clearError: () => void;
}

export const useMeetingStore = create<MeetingStore>((set, get) => ({
  status: 'idle',
  active: null,
  elapsedSec: 0,
  error: null,
  notice: null,
  devices: [],
  setup: { title: '', micOn: true, systemDeviceId: null, screenOn: true },
  transcript: [],
  insights: [],
  sttBacklog: 0,
  levels: { mic: 0, system: 0 },
  meetings: [],

  refreshDevices: async () => {
    try {
      const devices = await listAudioInputs();
      set({ devices });
      // Auto-suggest the first monitor source once, if none picked yet: that's the
      // Linux system-audio path and the most common "it just works" setup.
      const { setup } = get();
      if (setup.systemDeviceId === null) {
        const monitor = devices.find((d) => d.isMonitor);
        if (monitor) set({ setup: { ...get().setup, systemDeviceId: monitor.deviceId } });
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  setSetup: (patch) => set({ setup: { ...get().setup, ...patch } }),

  start: async () => {
    const { status, setup, devices } = get();
    if (status !== 'idle' || isCapturing()) return;
    set({ status: 'starting', error: null, notice: null, transcript: [], insights: [], elapsedSec: 0 });
    try {
      const cfg = await window.cth.getConfig();
      const platform = window.cth.platform;
      // System audio: Linux uses the picked monitor device; win/mac ride loopback
      // on the display stream (only available when the screen is captured).
      const monitorLabel = devices.find((d) => d.deviceId === setup.systemDeviceId)?.label;
      const displayLoopback = platform.os !== 'linux' && setup.screenOn;
      const systemAudio = !!setup.systemDeviceId || displayLoopback;

      const started = await window.cth.meeting.start({
        title: setup.title,
        sources: {
          mic: setup.micOn,
          systemAudio,
          systemAudioDeviceLabel: monitorLabel,
          screen: setup.screenOn
        },
        language: cfg.meetingLanguage ?? 'auto',
        model: cfg.meetingSttModel ?? 'whisper-base'
      });
      if (!started.ok) throw new Error(started.error);
      const meta = started.meta;

      const res = await startCapture({
        meetingId: meta.id,
        mic: setup.micOn,
        systemAudioDeviceId: setup.systemDeviceId,
        screen: setup.screenOn,
        displayLoopback,
        frameCapture: cfg.meetingFrameCapture !== false,
        frameIntervalSec: cfg.meetingFrameIntervalSec ?? 15,
        onLevel: (source, rms) => set({ levels: { ...get().levels, [source]: rms } }),
        onAutoStop: (reason) => { void get().stop(reason); },
        onError: (message) => set({ error: message })
      });
      if (!res.ok) {
        // Roll the meeting record back to an honest end state.
        await window.cth.meeting.stop(meta.id, 0).catch(() => { /* best-effort */ });
        throw new Error(res.error);
      }

      startTicker();
      set({ status: 'recording', active: meta });
    } catch (e) {
      stopTicker();
      set({ status: 'idle', active: null, error: e instanceof Error ? e.message : String(e) });
    }
  },

  stop: async (reason) => {
    const { status, active, elapsedSec } = get();
    if (status !== 'recording' && status !== 'starting') return;
    set({ status: 'stopping', notice: reason ?? null });
    stopTicker();
    try {
      const { durationSec } = await stopCapture();
      if (active) await window.cth.meeting.stop(active.id, durationSec || elapsedSec);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ status: 'idle', levels: { mic: 0, system: 0 }, sttBacklog: 0 });
      void get().loadMeetings();
    }
  },

  loadMeetings: async () => {
    try { set({ meetings: await window.cth.meeting.list() }); } catch { /* keep last good */ }
  },

  clearError: () => set({ error: null, notice: null })
}));

// ─── Module-scoped lifecycle (one ticker + one subscription set) ──────────────

let tickTimer: ReturnType<typeof setInterval> | null = null;
function startTicker(): void {
  stopTicker();
  const t0 = Date.now();
  tickTimer = setInterval(() => {
    useMeetingStore.setState({ elapsedSec: Math.floor((Date.now() - t0) / 1000) });
  }, 1000);
}
function stopTicker(): void {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

let refCount = 0;
let unsubTranscript: (() => void) | null = null;
let unsubInsight: (() => void) | null = null;

function startLifecycle(): void {
  void useMeetingStore.getState().refreshDevices();
  void useMeetingStore.getState().loadMeetings();
  unsubTranscript = window.cth.meeting.onTranscript(({ meetingId, segments }) => {
    const s = useMeetingStore.getState();
    if (s.active?.id !== meetingId) return;
    useMeetingStore.setState({ transcript: [...s.transcript, ...segments].slice(-FEED_CAP) });
  });
  unsubInsight = window.cth.meeting.onInsight((insight) => {
    const s = useMeetingStore.getState();
    if (s.active?.id !== insight.meetingId) return;
    useMeetingStore.setState({ insights: [...s.insights, insight].slice(-FEED_CAP) });
  });
}
function stopLifecycle(): void {
  unsubTranscript?.(); unsubTranscript = null;
  unsubInsight?.(); unsubInsight = null;
}

/** Subscribe a component to meeting state. Wires the IPC feeds on the first
 *  mounted consumer, unwires on the last (the capture engine itself is module-
 *  scoped and untouched by mounts). */
export function useMeeting() {
  useEffect(() => {
    refCount++;
    if (refCount === 1) startLifecycle();
    return () => {
      refCount--;
      if (refCount === 0) stopLifecycle();
    };
  }, []);
  return useMeetingStore();
}

/** Lightweight selector for the tab badge: is a meeting recording right now? */
export function useMeetingRecording(): boolean {
  return useMeetingStore((s) => s.status === 'recording' || s.status === 'stopping');
}

/** The meeting tab badge also wants the floor started so analyst nudges flow —
 *  exported here so MeetingPanel can flip it on start without importing useStore
 *  everywhere. */
export function markFloorStarted(): void {
  try { useStore.getState().startFloor(); } catch { /* store unavailable in tests */ }
}
