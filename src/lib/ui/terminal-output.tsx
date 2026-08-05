/**
 * Renders terminal output with monospace font.
 * Placeholder for future xterm.js integration.
 */
export function TerminalOutput({ output }: { readonly output: string }) {
  return (
    <pre className="commit-terminal-output overflow-x-auto max-h-[400px] rounded-[var(--radius-small)] border border-[var(--border)] p-3 font-mono text-sm">
      {output}
    </pre>
  );
}
