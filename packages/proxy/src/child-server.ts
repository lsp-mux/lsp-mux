import { type ChildProcess, spawn } from 'node:child_process';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import type { Logger } from './logger.ts';
import { noop } from './types.ts';
import type { Message, ServerConfig } from './types.ts';

/**
 * How long a child gets to act on the `exit` it was sent before the proxy
 * kills it. Long enough for a server to stop what it started — vtsls runs
 * tsserver as its own child, and killing vtsls orphans it — and short
 * enough that a wedged server cannot hold the proxy's own exit open.
 *
 * It sits here rather than beside the request timeouts in
 * `proxy-request-channel.ts`: nothing answers an `exit`, so this budgets a
 * process going away rather than a reply coming back.
 */
export const defaultExitGracePeriodMs = 5000;

/**
 * How long the `exit` gets to reach the pipe before the grace period starts.
 * Bytes either go onto a pipe quickly or not at all: a child that has stopped
 * reading its stdin leaves the write pending for good, and awaiting that alone
 * would hold the whole teardown open behind one wedged server.
 */
const writeFlushTimeoutMs = 1000;

/**
 * Resolve when the write settles or when its budget runs out, whichever comes
 * first.
 */
const flushWithin = async (pendingWrite: Promise<void>, timeoutMs: number): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    pendingWrite,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
};

/**
 * Resolve when the process exits, or when the grace period runs out.
 */
const waitForExit = (proc: ChildProcess, gracePeriodMs: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve();
    }, gracePeriodMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });

export interface ChildServerEvents {
  readonly onMessage: (msg: Message) => void;
  readonly onExit: (code: number | null, signal: string | null) => void;
  readonly onError: (err: Error) => void;
}

/**
 * Manages a single child LSP server process.
 * Handles spawning, stdio wiring via vscode-jsonrpc, and cleanup.
 * Does NOT handle restart logic — that belongs to the proxy.
 */
export class ChildServer {
  private proc: ChildProcess | undefined;
  private reader: StreamMessageReader | undefined;
  private writer: StreamMessageWriter | undefined;
  private disposed = false;
  private exited = false;
  /**
   * The most recent write, which `stop` waits on so the last message sent —
   * the `exit` — is on the pipe before the grace period starts. The writer
   * serializes writes, so the latest one covers those before it.
   */
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(
    readonly name: string,
    private readonly config: ServerConfig,
    private readonly events: ChildServerEvents,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (this.disposed) return;

    this.log.info(`Spawning ${this.name}: ${this.config.command} ${this.config.args.join(' ')}`);

    const proc = spawn(this.config.command, [...this.config.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line) continue;
        this.log.debug(`[${this.name}] ${line}`);
      }
    });

    // Guard against both error and exit firing for the same process
    proc.on('error', (err) => {
      this.log.error(`${this.name} spawn error:`, err);
      if (!this.exited && !this.disposed) {
        this.exited = true;
        this.events.onError(err);
      }
    });

    proc.on('exit', (code, signal) => {
      this.log.warn(`${this.name} exited (code=${String(code)}, signal=${String(signal)})`);
      if (!this.exited && !this.disposed) {
        this.exited = true;
        this.events.onExit(code, signal);
      }
    });

    const reader = new StreamMessageReader(proc.stdout);
    const writer = new StreamMessageWriter(proc.stdin);

    reader.listen((msg) => {
      if (!this.disposed) this.events.onMessage(msg);
    });
    reader.onError((err) => {
      this.log.error(`${this.name} reader error:`, err);
    });

    this.proc = proc;
    this.reader = reader;
    this.writer = writer;
  }

  write(msg: Message): void {
    if (!this.disposed && this.writer) {
      /* eslint-disable-next-line unicorn/prefer-await --
         Fire-and-forget write to the child's stdin; not awaited so the
         caller isn't blocked on flush. Ignore failures — the stream may
         already be destroyed. */
      this.pendingWrite = this.writer.write(msg).catch(noop);
    }
  }

  /**
   * Let the process leave on its own before taking it down: flush what was
   * written to it, wait out the grace period, then dispose — which kills
   * whatever is still alive.
   */
  async stop(gracePeriodMs: number): Promise<void> {
    const proc = this.proc;
    if (!this.disposed && proc?.exitCode === null) {
      await flushWithin(this.pendingWrite, writeFlushTimeoutMs);
      await waitForExit(proc, gracePeriodMs);
    }
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reader?.dispose();
    this.reader = undefined;
    this.writer = undefined;
    if (this.proc?.exitCode === null) {
      this.proc.kill();
    }
    this.proc = undefined;
  }
}
