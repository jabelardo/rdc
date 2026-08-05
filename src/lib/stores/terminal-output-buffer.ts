const DefaultTerminalOutputCapacity = 256 * 1024;

/**
 * A bounded, replaying view of one Git operation's terminal output.
 *
 * Capacity matches upstream's JavaScript character-count semantics. Rust
 * already guarantees every Channel item is valid UTF-8, so the frontend can
 * retain strings without a second byte-decoding layer.
 */
export class TerminalOutputBuffer {
  private chunks: string[] = [];
  private readonly listeners = new Set<(output: string) => void>();

  public constructor(private readonly capacity = DefaultTerminalOutputCapacity) {}

  public get value(): string {
    return this.chunks.join("");
  }

  public subscribe(listener: (output: string) => void): () => void {
    this.listeners.add(listener);
    listener(this.value);
    return () => this.listeners.delete(listener);
  }

  public push(chunk: string): void {
    this.chunks.push(chunk);
    let length = this.chunks.reduce((total, current) => total + current.length, 0);

    while (length > this.capacity && this.chunks.length > 0) {
      const first = this.chunks[0];
      const overrun = length - this.capacity;
      if (overrun >= first.length) {
        this.chunks.shift();
        length -= first.length;
      } else {
        this.chunks[0] = first.substring(overrun);
        length -= overrun;
      }
    }

    this.notify();
  }

  public clear(): void {
    this.chunks = [];
    this.notify();
  }

  private notify(): void {
    const output = this.value;
    for (const listener of this.listeners) {
      listener(output);
    }
  }
}
