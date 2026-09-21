import { faker } from '@faker-js/faker';
import { describe, it } from 'vitest';
import {
  createProxyRequestChannel,
  isInternalRequestId,
} from '../src/proxy-request-channel.ts';
import type { RequestMessage, ResponseMessage } from '../src/types.ts';

/**
 * Delivery that records what it was handed and reports success.
 */
const collectingDelivery = () => {
  const delivered: RequestMessage[] = [];
  return {
    delivered,
    deliver: (msg: RequestMessage) => {
      delivered.push(msg);
      return 'delivered' as const;
    },
  };
};

const refusingDelivery = () => 'undeliverable' as const;

/**
 * The request handed to delivery, or a clear failure if none was.
 */
const onlyDelivered = (delivered: readonly RequestMessage[]): RequestMessage => {
  const [sent] = delivered;
  if (!sent) throw new Error('nothing was delivered');
  return sent;
};

/*
 * A response carries a defined result: vscode-jsonrpc reads one with neither
 * result nor error as something other than a response.
 */
const responseFor = (msg: RequestMessage, result: string): ResponseMessage =>
  ({ jsonrpc: '2.0', id: msg.id, result });

describe('ProxyRequestChannel', () => {
  it('resolves with the response routed back for its request', async ({ expect }) => {
    const channel = createProxyRequestChannel('alpha');
    const { delivered, deliver } = collectingDelivery();
    const method = faker.string.alpha(8);

    const pending = channel.sendVia(deliver, method, { file: 'a.ts' });
    const sent = onlyDelivered(delivered);

    expect(sent.method).toBe(method);
    expect(sent.params).toStrictEqual({ file: 'a.ts' });

    const answer = faker.string.alpha(6);

    expect(channel.handleResponse(responseFor(sent, answer))).toBe(true);

    await expect(pending).resolves.toStrictEqual(
      expect.objectContaining({ result: answer }),
    );
  });

  it('namespaces request IDs so they never collide with the client\'s', ({ expect }) => {
    const channel = createProxyRequestChannel('alpha');
    const { delivered, deliver } = collectingDelivery();

    void channel.sendVia(deliver, faker.string.alpha(8), undefined);
    void channel.sendVia(deliver, faker.string.alpha(8), undefined);
    const ids = delivered.map(msg => msg.id);

    expect(ids.every(id => isInternalRequestId(id))).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it('resolves with an error when the request cannot be delivered', async ({ expect }) => {
    const channel = createProxyRequestChannel('alpha');

    const res = await channel.sendVia(refusingDelivery, faker.string.alpha(8), undefined);

    expect(res.error).toStrictEqual(
      expect.objectContaining({ message: 'Server not running' }),
    );
  });

  it('resolves with a timeout error when no response arrives', async ({ expect }) => {
    const channel = createProxyRequestChannel('alpha');
    const { deliver } = collectingDelivery();
    const method = faker.string.alpha(8);

    // Delivered but never answered, so only the timeout can settle it.
    const res = await channel.sendVia(deliver, method, undefined, 10);

    expect(res.error?.message).toBe(`Request ${method} timed out after 10ms`);
  });

  it('leaves a response belonging to another channel alone', ({ expect }) => {
    const alpha = createProxyRequestChannel('alpha');
    const beta = createProxyRequestChannel('beta');
    const { delivered, deliver } = collectingDelivery();

    void beta.sendVia(deliver, faker.string.alpha(8), undefined);
    const res = responseFor(onlyDelivered(delivered), faker.string.alpha(5));

    expect(alpha.handleResponse(res)).toBe(false);
    expect(beta.handleResponse(res)).toBe(true);
  });

  it('consumes a second response for a request it already settled', async ({ expect }) => {
    const channel = createProxyRequestChannel('alpha');
    const { delivered, deliver } = collectingDelivery();

    const pending = channel.sendVia(deliver, faker.string.alpha(8), undefined);
    const sent = onlyDelivered(delivered);
    channel.handleResponse(responseFor(sent, 'first'));
    await pending;

    /* Still claimed, so a duplicate never reaches the client as a stray
       response addressed to an id the client never sent. */
    expect(channel.handleResponse(responseFor(sent, 'second'))).toBe(true);
    await expect(pending).resolves.toStrictEqual(
      expect.objectContaining({ result: 'first' }),
    );
  });

  it('fails in-flight requests when the server goes away', async ({ expect }) => {
    const channel = createProxyRequestChannel('alpha');
    const { deliver } = collectingDelivery();

    const pending = channel.sendVia(deliver, faker.string.alpha(8), undefined);
    channel.rejectAll('Server exited');

    const res = await pending;

    expect(res.error?.message).toBe('Server exited');
  });
});
