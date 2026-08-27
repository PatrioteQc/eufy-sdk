import { EventEmitter } from "node:events";
import { vi } from "vitest";

/**
 * A fake connected `P2PSession`, for the specs that drive `P2PCommandRouter` without a wire.
 *
 * Every one of them needs the same two answers before the router will send anything — connected, and
 * whether a level-2 key is available — and those two cannot be allowed to disagree: a fake that reports no
 * key while answering a wait for one with `true` tests a session that cannot exist. Building them together
 * here is what keeps the fakes honest and stops the next member added to the wait from having to be
 * remembered in every spec separately.
 *
 * A spec adds whatever send methods it asserts on; nothing here presumes which wire is under test.
 */
export interface FakeP2PSession extends EventEmitter {
  isConnected: boolean;
  hasLevel2Key: boolean;
  awaitLevel2Key: ReturnType<typeof vi.fn>;
  repromptLevel2Key: ReturnType<typeof vi.fn>;
  /** What a second ask would achieve: `true` = the key arrives on the retry. Default: nothing to be had. */
  keyArrivesOnReprompt: boolean;
}

/**
 * A connected session that either has a level-2 key or has settled that it will not get one.
 *
 * The re-prompt belongs to the same set of answers: a session that settled without a key may still be worth
 * asking once more, and a fake that refused the wait while claiming a productive re-prompt — or the reverse —
 * describes a session that cannot exist. `keyArrivesOnReprompt` moves BOTH, so the two cannot drift.
 */
export function connectedSession(hasLevel2Key = true): FakeP2PSession {
  const session = new EventEmitter() as FakeP2PSession;
  session.isConnected = true;
  session.hasLevel2Key = hasLevel2Key;
  session.keyArrivesOnReprompt = false;
  session.awaitLevel2Key = vi.fn(async () => session.hasLevel2Key);
  session.repromptLevel2Key = vi.fn(() => {
    if (session.hasLevel2Key || !session.keyArrivesOnReprompt) return false;
    session.hasLevel2Key = true; // the station answered the second ask
    return true;
  });
  return session;
}
