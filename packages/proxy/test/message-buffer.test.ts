import { describe, it } from 'vitest';
import { faker } from '@faker-js/faker';
import { createMessageBuffer } from '../src/message-buffer.js';
import { createRequest, createNotification } from '../src/types.js';

describe('MessageBuffer', () => {
  it('buffers and flushes messages in order', ({ expect }) => {
    const buf = createMessageBuffer(10);
    const r1 = createRequest(faker.number.int(), faker.string.alpha(8));
    const r2 = createRequest(faker.number.int(), faker.string.alpha(8));
    expect(buf.push(r1)).toBe(true);
    expect(buf.push(r2)).toBe(true);
    expect(buf.length).toBe(2);

    const flushed = buf.flush();
    expect(flushed).toEqual([r1, r2]);
    expect(buf.length).toBe(0);
  });

  it('rejects when full', ({ expect }) => {
    const buf = createMessageBuffer(2);
    expect(buf.push(createRequest(faker.number.int(), faker.string.alpha(8)))).toBe(true);
    expect(buf.push(createRequest(faker.number.int(), faker.string.alpha(8)))).toBe(true);
    expect(buf.push(createRequest(faker.number.int(), faker.string.alpha(8)))).toBe(false);
    expect(buf.length).toBe(2);
  });

  it('cancels a buffered request by ID', ({ expect }) => {
    const buf = createMessageBuffer(10);
    const id1 = faker.number.int();
    const id2 = faker.number.int();
    const id3 = faker.number.int();
    buf.push(createRequest(id1, faker.string.alpha(8)));
    buf.push(createRequest(id2, faker.string.alpha(8)));
    buf.push(createRequest(id3, faker.string.alpha(8)));

    expect(buf.cancel(id2)).toBe(true);
    expect(buf.length).toBe(2);

    const flushed = buf.flush();
    expect(flushed.map(m => 'id' in m ? m.id : undefined)).toEqual([id1, id3]);
  });

  it('returns false when cancelling non-existent ID', ({ expect }) => {
    const buf = createMessageBuffer(10);
    const id = faker.number.int();
    buf.push(createRequest(id, faker.string.alpha(8)));
    expect(buf.cancel(id + 1)).toBe(false);
    expect(buf.length).toBe(1);
  });

  it('does not cancel notifications (only requests)', ({ expect }) => {
    const buf = createMessageBuffer(10);
    const id = faker.number.int();
    buf.push(createNotification(faker.string.alpha(10)));
    buf.push(createRequest(id, faker.string.alpha(8)));

    // notifications have no id — cancel(id) should only match the request
    expect(buf.cancel(id)).toBe(true);
    expect(buf.length).toBe(1);
  });

  it('flush returns empty array when buffer is empty', ({ expect }) => {
    const buf = createMessageBuffer(10);
    expect(buf.flush()).toEqual([]);
  });
});
