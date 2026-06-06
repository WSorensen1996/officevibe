import { useState } from 'react';
import { disposeTerminal } from '@/components/terminalPool';
import { buildSpawnCommand } from '@/store/config';
import { useStore, type Agent } from '@/store/store';

/** Owns the "which agent is mid-restart" flag and the kill→respawn sequence for
 *  re-launching an agent's pty under a (possibly new) model. Extracted from the
 *  Floor tab so the Agents tab can drive the same per-agent model picker. */
export function useAgentRestart() {
  const updateAgent = useStore((s) => s.updateAgent);
  const [restartingId, setRestartingId] = useState<string | null>(null);

  const restartWithModel = async (a: Agent, model: string | undefined) => {
    if (!a.ptyId) return;
    setRestartingId(a.id);
    try {
      const cfg = await window.cth.getConfig();
      await window.cth.killPty(a.ptyId);
      disposeTerminal(a.ptyId);
      const command = buildSpawnCommand(cfg, model);
      const [exe, ...args] = command.trim().split(/\s+/);
      const hive = a.isGod
        ? { id: a.id, name: a.name, cwd: a.cwd, isGod: true, role: 'orchestrator (god)' }
        : a.isAssistant
        ? { id: a.id, name: a.name, cwd: a.cwd, isAssistant: true, role: "Michael's prep assistant" }
        : { id: a.id, name: a.name, cwd: a.cwd, role: a.description };
      const res = await window.cth.spawnPty({ id: a.ptyId, cwd: a.cwd, command: exe, args, cols: 100, rows: 30, hive });
      if (res.ok) updateAgent(a.id, { command: command.trim(), model, status: 'idle', action: 'restarting…' });
    } catch { /* noop */ } finally {
      setRestartingId(null);
    }
  };

  return { restartingId, restartWithModel };
}
