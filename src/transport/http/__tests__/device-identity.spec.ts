import { describe, expect, it } from "vitest";

import { MemorySessionStore, type PersistedSession } from "../../../core/store.js";
import { MegaHttpClient } from "../mega-client.js";

const storedSession = (extra: Partial<PersistedSession>): PersistedSession => ({
  userId: "u",
  authToken: "t",
  region: "us-pr",
  openudid: "STORED-UDID",
  shareKey: "00".repeat(16),
  keyIdent: "00".repeat(16),
  tokenExpiresAt: 0,
  savedAt: Date.now(),
  ...extra,
});

describe("device identity resolution", () => {
  it("reuses a stored phoneModel / mediaUserAgent instead of regenerating", () => {
    const store = new MemorySessionStore();
    store.save(storedSession({ phoneModel: "STORED-Model", mediaUserAgent: "STORED-UA" }));
    const c = new MegaHttpClient({ email: "a@b.c", password: "x", store }) as unknown as {
      phoneModel: string;
      mediaUserAgent: string;
      openudid: string;
    };
    expect(c.phoneModel).toBe("STORED-Model");
    expect(c.mediaUserAgent).toBe("STORED-UA");
    expect(c.openudid).toBe("STORED-UDID");
  });

  it("generates a stable identity from openudid when nothing is stored", () => {
    const mk = () =>
      new MegaHttpClient({ email: "a@b.c", password: "x", store: new MemorySessionStore() }) as unknown as {
        phoneModel: string;
      };
    expect(mk().phoneModel).toBe(mk().phoneModel); // deterministic from the (email-derived) openudid
  });

  it("explicit config wins over both stored and generated", () => {
    const store = new MemorySessionStore();
    store.save(storedSession({ phoneModel: "STORED-Model", mediaUserAgent: "STORED-UA" }));
    const c = new MegaHttpClient({
      email: "a@b.c",
      password: "x",
      store,
      phoneModel: "EXPLICIT",
      mediaUserAgent: "EXPLICIT-UA",
    }) as unknown as { phoneModel: string; mediaUserAgent: string };
    expect(c.phoneModel).toBe("EXPLICIT");
    expect(c.mediaUserAgent).toBe("EXPLICIT-UA");
  });
});
