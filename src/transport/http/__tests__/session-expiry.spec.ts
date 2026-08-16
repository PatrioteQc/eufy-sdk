import { describe, expect, it, vi } from "vitest";

import { MegaHttpClient, SessionExpiredError } from "../mega-client.js";

describe("mega authenticated session rejection", () => {
  it("classifies vendor code 26084 as an expired session without message parsing", async () => {
    const client = new MegaHttpClient({ email: "synthetic@example.invalid", password: "synthetic" });
    const internals = client as unknown as {
      ensureSessionKey: (host: string) => Promise<{ shareKey: string; keyIdent: string }>;
      httpPost: () => Promise<{ status: number; data: unknown }>;
      clearSession: () => void;
    };
    internals.ensureSessionKey = vi.fn(async () => ({ shareKey: "00".repeat(32), keyIdent: "00".repeat(16) }));
    internals.httpPost = vi.fn(async () => ({
      status: 401,
      data: { code: 26084, msg: "synthetic wording that carries no token keywords" },
    }));
    const clearSession = vi.spyOn(internals, "clearSession");

    await expect(client.postSigned("app-mega-us-pr.eufy.com", "/synthetic", {}, true)).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
    expect(clearSession).toHaveBeenCalledOnce();
  });
});
