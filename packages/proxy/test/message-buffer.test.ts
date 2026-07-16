import { faker } from '@faker-js/faker';
import { describe, it } from 'vitest';
import { createMessageBuffer } from '../src/message-buffer.ts';
import { createNotification, createRequest } from '../src/types.ts';

const randomRequest = () => createRequest(faker.number.int(), faker.string.alpha(8));

describe('MessageBuffer', () => {
  it('buffers and flushes messages in order', ({ expect }) => {
    const buf = createMessageBuffer(10);
    const r1 = createRequest(faker.number.int(), faker.string.alpha(8));
    const r2 = createRequest(faker.number.int(), faker.string.alpha(8));

    expect(buf.offer(r1)).toBe(true);
    expect(buf.offer(r2)).toBe(true);
    expect(buf).toHaveLength(2);

    const flushed = buf.flush();

    expect(flushed).toStrictEqual([r1, r2]);
    expect(buf).toHaveLength(0);
  });

  it('rejects when full', ({ expect }) => {
    const buf = createMessageBuffer(2);

    expect(buf.offer(randomRequest())).toBe(true);
    expect(buf.offer(randomRequest())).toBe(true);
    expect(buf.offer(randomRequest())).toBe(false);
    expect(buf).toHaveLength(2);
  });

  it('cancels a buffered request by ID', ({ expect }) => {
    const buf = createMessageBuffer(10);
    const id1 = faker.number.int();
    const id2 = faker.number.int();
    const id3 = faker.number.int();
    buf.offer(createRequest(id1, faker.string.alpha(8)));
    buf.offer(createRequest(id2, faker.string.alpha(8)));
    buf.offer(createRequest(id3, faker.string.alpha(8)));

    expect(buf.cancel(id2)).toBe(true);
    expect(buf).toHaveLength(2);

    const flushed = buf.flush();

    expect(flushed.map(msg => 'id' in msg ? msg.id : undefined)).toStrictEqual([id1, id3]);
  });

  it('returns false when cancelling non-existent ID', ({ expect }) => {
    const buf = createMessageBuffer(10);
    const id = faker.number.int();
    buf.offer(createRequest(id, faker.string.alpha(8)));

    expect(buf.cancel(id + 1)).toBe(false);
    expect(buf).toHaveLength(1);
  });

  it('does not cancel notifications (only requests)', ({ expect }) => {
    const buf = createMessageBuffer(10);
    const id = faker.number.int();
    buf.offer(createNotification(faker.string.alpha(10)));
    buf.offer(createRequest(id, faker.string.alpha(8)));

    // notifications have no id — cancel(id) should only match the request
    expect(buf.cancel(id)).toBe(true);
    expect(buf).toHaveLength(1);
  });

  it('flush returns empty array when buffer is empty', ({ expect }) => {
    const buf = createMessageBuffer(10);

    expect(buf.flush()).toStrictEqual([]);
  });
});
