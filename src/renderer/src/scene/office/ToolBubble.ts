// Tool → glyph map for the speech bubble shown above a character (e.g. "> App.tsx").
// Icon set covers our ToolKind set; consumed by ThoughtBubble.

const TOOL_ICONS: Record<string, string> = {
  Read: '<',
  Edit: '>',
  Write: '>',
  Bash: '$',
  Grep: '?',
  Glob: '?',
  WebFetch: '@',
  WebSearch: '@',
  TodoWrite: '=',
  MCP: '*',
};

const DEFAULT_ICON = '*';

export function toolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] ?? DEFAULT_ICON;
}
