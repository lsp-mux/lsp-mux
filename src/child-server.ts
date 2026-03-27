import { spawn, type ChildProcess } from 'node:child_process';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import type { Message, ServerConfig } from './types.js';
import { noop } from './types.js';
import { log } from './logger.js';

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
  private proc: ChildProcess | null = null;
  private reader: StreamMessageReader | null = null;
  private writer: StreamMessageWriter | null = null;
  private disposed = false;
  private exited = false;

  constructor(
    readonly name: string,
    private readonly config: ServerConfig,
    private readonly events: ChildServerEvents,
  ) {}

  start(): void {
    if (this.disposed) return;

    log.info(`Spawning ${this.name}: ${this.config.command} ${this.config.args.join(' ')}`);

    const proc = spawn(this.config.command, [...this.config.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        log.debug(`[${this.name}] ${line}`);
      }
    });

    // Guard against both error and exit firing for the same process
    proc.on('error', (err) => {
      log.error(`${this.name} spawn error:`, err);
      if (!this.exited && !this.disposed) {
        this.exited = true;
        this.events.onError(err);
      }
    });

    proc.on('exit', (code, signal) => {
      log.warn(`${this.name} exited (code=${String(code)}, signal=${String(signal)})`);
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
      log.error(`${this.name} reader error:`, err);
    });

    this.proc = proc;
    this.reader = reader;
    this.writer = writer;
  }

  write(msg: Message): void {
    if (!this.disposed && this.writer) {
      // Stream may already be destroyed — safe to ignore
      this.writer.write(msg).catch(noop);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reader?.dispose();
    this.reader = null;
    this.writer = null;
    if (this.proc?.exitCode === null) {
      this.proc.kill();
    }
    this.proc = null;
  }
}
