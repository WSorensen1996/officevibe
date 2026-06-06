import ReactMarkdown from 'react-markdown';

/**
 * Renders agent task text (descriptions + update bodies) as Markdown. Used only
 * in the roomy TaskDetailPanel — the small cards keep their plain truncated TLDR.
 *
 * Safety: default react-markdown config, NO rehype-raw, so any embedded HTML in
 * an agent's response is escaped (rendered as text), not executed. Styling is
 * handled by the scoped `.cth-md` rules in design/global.css so the pixel theme
 * tokens apply to the plain HTML output.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="cth-md">
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  );
}
