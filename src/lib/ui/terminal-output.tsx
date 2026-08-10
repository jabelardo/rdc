/**
 * Renders terminal output with monospace font.
 * Placeholder for future xterm.js integration.
 */
export function TerminalOutput({
  output,
  "aria-label": ariaLabel,
}: {
  readonly output: string;
  readonly "aria-label"?: string;
}) {
  return (
    <pre
      className="commit-terminal-output overflow-x-auto max-h-[450px] rounded-[var(--radius-small)] border border-[var(--border)] p-3 font-mono text-sm"
      aria-label={ariaLabel}
    >
      {output}
    </pre>
  );
}
