/**
 * Shared PTY input helpers used by both the autonomous loop (useProject) and the
 * human-in-the-loop messages-tab card (ThreadsPanel). Keeping the paste-then-Enter
 * trick in one place means every "type into an agent" path behaves identically.
 */

/**
 * Type a line into an agent's Claude Code TUI and actually submit it.
 *
 * Writing the text and the carriage return in a single chunk makes the TUI treat
 * the whole thing as a paste, so the "\r" lands as a newline inside the input box
 * instead of submitting — the command just sits there as text. We send the text
 * first, then the Enter as a separate keystroke a tick later so the prompt is
 * registered and executed.
 */
export async function submitToPty(ptyId: string, text: string): Promise<void> {
  await window.cth.writePty(ptyId, text);
  await new Promise((r) => setTimeout(r, 140));
  await window.cth.writePty(ptyId, '\r');
}
