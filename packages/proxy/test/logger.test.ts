import { PassThrough } from 'node:stream';
import { describe, it } from 'vitest';
import { createLogger } from '../src/logger.ts';

/** Read all buffered data from a PassThrough stream as a string. */
const drain = (stream: PassThrough): string => {
  const chunk: unknown = stream.read();
  return typeof chunk === 'string' ? chunk : (Buffer.isBuffer(chunk) ? chunk.toString() : '');
};

describe('createLogger', () => {
  it('writes formatted messages to the output stream', ({ expect }) => {
    const stream = new PassThrough();
    const log = createLogger(stream);
    log.info('hello', 'world');

    expect(drain(stream)).toMatch(/\[.*\] \[lsp-proxy\] \[INFO\] hello world\n/v);
  });

  it('formats Error instances with stack trace', ({ expect }) => {
    const stream = new PassThrough();
    const log = createLogger(stream);
    log.error('failed:', new Error('boom'));
    const output = drain(stream);

    expect(output).toContain('[ERROR]');
    expect(output).toMatch(/Error: boom\n\s+at /v);
  });

  describe('level filtering', () => {
    it('defaults to INFO level', ({ expect }) => {
      const stream = new PassThrough();
      const log = createLogger(stream);
      log.debug('should not appear');
      log.info('should appear');
      const output = drain(stream);

      expect(output).not.toContain('should not appear');
      expect(output).toContain('should appear');
    });

    it('respects initialLevel parameter', ({ expect }) => {
      const stream = new PassThrough();
      const log = createLogger(stream, 'ERROR');
      log.info('no');
      log.warn('no');
      log.error('yes');
      const output = drain(stream);

      expect(output).not.toContain('[INFO]');
      expect(output).not.toContain('[WARN]');
      expect(output).toContain('[ERROR]');
    });

    it('dEBUG level shows all messages', ({ expect }) => {
      const stream = new PassThrough();
      const log = createLogger(stream, 'DEBUG');
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');
      const output = drain(stream);

      expect(output).toContain('[DEBUG]');
      expect(output).toContain('[INFO]');
      expect(output).toContain('[WARN]');
      expect(output).toContain('[ERROR]');
    });
  });

  describe('setLevel', () => {
    it('changes the minimum level at runtime', ({ expect }) => {
      const stream = new PassThrough();
      const log = createLogger(stream);

      log.debug('hidden');
      log.setLevel('DEBUG');
      log.debug('visible');

      const output = drain(stream);

      expect(output).not.toContain('hidden');
      expect(output).toContain('visible');
    });

    it('logs the level change at INFO', ({ expect }) => {
      const stream = new PassThrough();
      const log = createLogger(stream);
      log.setLevel('DEBUG');
      const output = drain(stream);

      expect(output).toContain('Log level changed to DEBUG');
      expect(output).toContain('[INFO]');
    });

    it('is a no-op when level is unchanged', ({ expect }) => {
      const stream = new PassThrough();
      const log = createLogger(stream, 'INFO');
      log.setLevel('INFO');

      expect(drain(stream)).toBe('');
    });

    it('resets to initial level when called with undefined', ({ expect }) => {
      const stream = new PassThrough();
      const log = createLogger(stream, 'WARN');

      log.setLevel('DEBUG');
      drain(stream); // consume "changed to DEBUG"

      log.setLevel(undefined); // reset to WARN

      log.debug('should not appear');
      log.info('should not appear');
      log.warn('should appear');
      const output = drain(stream);

      expect(output).not.toContain('should not appear');
      expect(output).toContain('should appear');
    });
  });
});
