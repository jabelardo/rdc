import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

type TerminalOutputProps = {
  readonly output: string;
  readonly rows?: number;
};

/**
 * Renders terminal output with ANSI color support using xterm.js.
 * Matches desktop-plus's Terminal component behavior.
 */
export function TerminalOutput({ output, rows = 15 }: TerminalOutputProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (containerRef.current === null) {
      return;
    }

    const terminal = new Terminal({
      rows,
      cols: 80,
      convertEol: true,
      fontFamily:
        "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
      fontSize: 12,
      screenReaderMode: true,
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: "block",
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();

    terminal.write(output);

    terminalRef.current = terminal;

    return () => {
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [output, rows]);

  return (
    <div
      ref={containerRef}
      className="commit-terminal-output rounded-[var(--radius-small)] border border-[var(--border)]"
      style={{ minHeight: `${rows * 1.2}em` }}
    />
  );
}
