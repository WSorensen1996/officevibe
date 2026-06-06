import { useState } from 'react';
import { disposeTerminal } from '@/components/terminalPool';
import { buildSpawnCommand, type EffortLevel } from '@/store/config';
import { useStore, type Agent } from '@/store/store';

/** Owns the "which agent is mid-restart" flag and the kill→respawn sequence for
 *  re-launching an agent's pty under a (possibly new) model and/or effort level.
 *  Extracted from the Floor tab so the Agents tab can drive the per-agent pickers. */
export function useAgentRestart() {
  const updateAgent = useStore((s) => s.updateAgent);
  const [restartingId, setRestartingId] = useState<string | null>(null);

  // Restart `a` after applying `changes`, defaulting unspecified fields to the
  // agent's current values. The `in` check is deliberate: a present key with an
  // `undefined` value (picking "default") clears the override, vs an absent key
  // which preserves the current value.
  const restart = async (a: Agent, changes: { model?: string; effort?: EffortLevel }) => {
    if (!a.ptyId) return;
    const model = 'model' in changes ? changes.model : a.model;
    const effort = 'effort' in changes ? changes.effort : a.effort;
    setRestartingId(a.id);
    try {
      const cfg = await window.cth.getConfig();
      await window.cth.killPty(a.ptyId);
      disposeTerminal(a.ptyId);
      const command = buildSpawnCommand(cfg, model, effort);
      const [exe, ...args] = command.trim().split(/\s+/);
      const hive = a.isGod
        ? { id: a.id, name: a.name, cwd: a.cwd, isGod: true, role: 'orchestrator (god)' }
        : a.isAssistant
        ? { id: a.id, name: a.name, cwd: a.cwd, isAssistant: true, role: "Michael's co-orchestrator" }
        : { id: a.id, name: a.name, cwd: a.cwd, role: a.description };
      const res = await window.cth.spawnPty({ id: a.ptyId, cwd: a.cwd, command: exe, args, cols: 100, rows: 30, hive });
      if (res.ok) updateAgent(a.id, { command: command.trim(), model, effort, status: 'idle', action: 'restarting…' });
    } catch { /* noop */ } finally {
      setRestartingId(null);
    }
  };

  return { restartingId, restart };
}
