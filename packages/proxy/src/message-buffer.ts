import type { Message } from './types.js';
import { Message as Msg } from './types.js';

export interface MessageBuffer {
  /** Buffer a message. Returns false if full. */
  push(msg: Message): boolean;
  /** Remove a buffered request by ID. Returns true if found. */
  cancel(targetId: number | string): boolean;
  /** Drain and return all buffered messages. */
  flush(): readonly Message[];
  readonly length: number;
}

export const createMessageBuffer = (maxSize: number): MessageBuffer => {
  const items: Message[] = [];

  return {
    push(msg) {
      if (items.length >= maxSize) return false;
      items.push(msg);
      return true;
    },

    cancel(targetId) {
      const idx = items.findIndex(m => Msg.isRequest(m) && m.id === targetId);
      if (idx === -1) return false;
      items.splice(idx, 1);
      return true;
    },

    flush() {
      const flushed = [...items];
      items.length = 0;
      return flushed;
    },

    get length() {
      return items.length;
    },
  };
};
