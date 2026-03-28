import { describe, it, expect } from 'vitest';
import { createMessageBuffer } from '../src/message-buffer.js';
import { createRequest, createNotification } from '../src/types.js';

describe('MessageBuffer', () => {
  it('buffers and flushes messages in order', () => {
    const buf = createMessageBuffer(10);
    const r1 = createRequest(1, 'a');
    const r2 = createRequest(2, 'b');
    expect(buf.push(r1)).toBe(true);
    expect(buf.push(r2)).toBe(true);
    expect(buf.length).toBe(2);

    const flushed = buf.flush();
    expect(flushed).toEqual([r1, r2]);
    expect(buf.length).toBe(0);
  });

  it('rejects when full', () => {
    const buf = createMessageBuffer(2);
    expect(buf.push(createRequest(1, 'a'))).toBe(true);
    expect(buf.push(createRequest(2, 'b'))).toBe(true);
    expect(buf.push(createRequest(3, 'c'))).toBe(false);
    expect(buf.length).toBe(2);
  });

  it('cancels a buffered request by ID', () => {
    const buf = createMessageBuffer(10);
    buf.push(createRequest(1, 'a'));
    buf.push(createRequest(2, 'b'));
    buf.push(createRequest(3, 'c'));

    expect(buf.cancel(2)).toBe(true);
    expect(buf.length).toBe(2);

    const flushed = buf.flush();
    expect(flushed.map(m => 'id' in m ? m.id : undefined)).toEqual([1, 3]);
  });

  it('returns false when cancelling non-existent ID', () => {
    const buf = createMessageBuffer(10);
    buf.push(createRequest(1, 'a'));
    expect(buf.cancel(99)).toBe(false);
    expect(buf.length).toBe(1);
  });

  it('does not cancel notifications (only requests)', () => {
    const buf = createMessageBuffer(10);
    buf.push(createNotification('textDocument/hover'));
    buf.push(createRequest(1, 'a'));

    // notifications have no id — cancel(1) should only match the request
    expect(buf.cancel(1)).toBe(true);
    expect(buf.length).toBe(1);
  });

  it('flush returns empty array when buffer is empty', () => {
    const buf = createMessageBuffer(10);
    expect(buf.flush()).toEqual([]);
  });
});
