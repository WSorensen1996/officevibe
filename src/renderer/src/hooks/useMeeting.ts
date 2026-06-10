import { useEffect } from 'react';
import { create } from 'zustand';
import {
  listAudioInputs, startCapture, stopCapture, isCapturing,
  type AudioInputDevice
} from '@/lib/meeting/capture';
import type { MeetingMeta, MeetingInsight, TranscriptSegment } from '@/lib/meeting/types';
import { useStore, type Agent } from '@/store/store';
import { buildSpawnCommand } from '@/store/config';
import { submitToPty } from '@/hooks/ptyInput';

/** The analyst's fixed identity (mirrors ANALYST_AGENT_ID in main/meeting.ts).
 *  Pam — the office's note-taker — sits in on every meeting. */
const ANALYST_ID = 'analyst';
const ANALYST_PTY = `pty-${ANALYST_ID}`;

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
  /** The analysis driver reported the analyst's PTY dead — offer a respawn. */
  analystDown: boolean;

  /** Past meetings (newest first) for the history view. */
  meetings: MeetingMeta[];

  refreshDevices: () => Promise<void>;
  setSetup: (patch: Partial<MeetingSetup>) => void;
  start: () => Promise<void>;
  stop: (reason?: string) => Promise<void>;
  /** (Re)spawn the analyst agent ("Pam") — used at meeting start and from the
   *  analyst-down banner. Resolves once the PTY is live. */
  ensureAnalyst: () => Promise<void>;
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
  analystDown: false,
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
    set({ status: 'starting', error: null, notice: null, transcript: [], insights: [], elapsedSec: 0, analystDown: false });
    try {
      const cfg = await window.cth.getConfig();
      const platform = window.cth.platform;

      // The analyst sits in on every meeting: spawn Pam if she isn't live, and
      // give a returning Pam a fresh context window (/clear) — a 2h meeting is
      // the real context bound. Best-effort: a failed spawn degrades to
      // record+transcribe-only and the analystDown banner offers a retry.
      try { await get().ensureAnalyst(); }
      catch (e) { set({ analystDown: true, notice: `meeting analyst unavailable: ${e instanceof Error ? e.message : e}` }); }
      // Let the wake-nudge loop deliver analyst ticks even with auto-pilot off.
      useStore.getState().startFloor();
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
        sttModel: cfg.meetingSttModel ?? 'whisper-base',
        language: cfg.meetingLanguage ?? 'auto',
        onLevel: (source, rms) => set({ levels: { ...get().levels, [source]: rms } }),
        onBacklog: (depth) => set({ sttBacklog: depth }),
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

  ensureAnalyst: async () => {
    const cfg = await window.cth.getConfig();
    const cwd = cfg.activeProjectPath;
    if (!cwd) throw new Error('no active project');
    const live = await window.cth.listPtys().catch(() => []);
    if (live.some((p) => p.id === ANALYST_PTY)) {
      // Returning analyst → fresh context window for the new meeting. Only when
      // idle: /clear typed into a mid-turn session would be eaten as text.
      const a = useStore.getState().agents.find((x) => x.id === ANALYST_ID);
      if (!a || a.status === 'idle' || a.status === 'waiting') {
        await submitToPty(ANALYST_PTY, '/clear').catch(() => { /* best-effort */ });
      }
      set({ analystDown: false });
      return;
    }
    const command = buildSpawnCommand(cfg, cfg.analystModel ?? cfg.defaultModel, cfg.defaultEffort);
    const [exe, ...args] = command.trim().split(/\s+/);
    const res = await window.cth.spawnPty({
      id: ANALYST_PTY,
      cwd,
      command: exe,
      args,
      cols: 100,
      rows: 30,
      hive: { id: ANALYST_ID, name: 'Pam', cwd, isAnalyst: true, role: 'meeting analyst — listens to live meetings, surfaces insights + action items' }
    });
    if (!res.ok) throw new Error(res.error ?? 'analyst spawn failed');
    const projectLabel = cfg.projects?.find((p) => p.path === cwd)?.name ?? 'project';
    const pam: Agent = {
      id: ANALYST_ID,
      name: 'Pam',
      character: 'pam',
      accent: 'mint',
      description: 'meeting analyst — listens to live meetings, surfaces insights + action items',
      project: projectLabel,
      cwd,
      status: 'idle',
      action: 'listening in',
      progress: 0,
      currentStation: 'desk',
      ptyId: ANALYST_PTY,
      command: command.trim(),
      model: cfg.analystModel ?? cfg.defaultModel,
      effort: cfg.defaultEffort,
      isAnalyst: true,
      recentTextTs: Date.now()
    };
    // addAgent auto-selects; keep the user's selection where it was.
    const prevSel = useStore.getState().selectedId;
    useStore.getState().addAgent(pam);
    if (prevSel) useStore.getState().select(prevSel);
    set({ analystDown: false });
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
let unsubs: Array<() => void> = [];

function startLifecycle(): void {
  void useMeetingStore.getState().refreshDevices();
  void useMeetingStore.getState().loadMeetings();
  unsubs = [
    window.cth.meeting.onTranscript(({ meetingId, segments }) => {
      const s = useMeetingStore.getState();
      if (s.active?.id !== meetingId) return;
      useMeetingStore.setState({ transcript: [...s.transcript, ...segments].slice(-FEED_CAP) });
    }),
    window.cth.meeting.onInsight((insight) => {
      const s = useMeetingStore.getState();
      if (s.active?.id !== insight.meetingId) return;
      useMeetingStore.setState({ insights: [...s.insights, insight].slice(-FEED_CAP) });
    }),
    window.cth.meeting.onAnalystDown(({ meetingId }) => {
      const s = useMeetingStore.getState();
      if (s.active?.id !== meetingId) return;
      useMeetingStore.setState({ analystDown: true });
    }),
    window.cth.meeting.onAnalysisPaused(({ meetingId, reason }) => {
      const s = useMeetingStore.getState();
      if (s.active?.id !== meetingId) return;
      useMeetingStore.setState({ notice: reason });
    })
  ];
}
function stopLifecycle(): void {
  for (const u of unsubs) { try { u(); } catch { /* noop */ } }
  unsubs = [];
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
