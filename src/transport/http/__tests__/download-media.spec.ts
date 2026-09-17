import type { PersistedSession, SessionStore } from "../../../core/store.js";
import { downloadMediaResource } from "../media-download.js";
import { MegaHttpClient, SessionExpiredError } from "../mega-client.js";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup }));

const TEN_MIB = 10 * 1024 * 1024;
const AUTHENTICATED_HEADERS = {
  "x-auth-token": "synthetic-token",
  gtoken: "synthetic-gtoken",
  "app-name": "eufy_mega",
};

function sessionStore(): SessionStore {
  const session: PersistedSession = {
    userId: "synthetic-user",
    accountUserId: "synthetic-user",
    authToken: "synthetic-token",
    region: "us-pr",
    openudid: "0000000000000000",
    shareKey: "00000000000000000000000000000000",
    keyIdent: "synthetic-key",
    tokenExpiresAt: 0,
    savedAt: 0,
  };
  return {
    load: () => session,
    save: () => undefined,
    clear: () => undefined,
  };
}

function client(authenticated = true): MegaHttpClient {
  return new MegaHttpClient({
    email: "user@example.invalid",
    password: "unused",
    store: authenticated ? sessionStore() : undefined,
  });
}

function fetchMock(...responses: Response[]): ReturnType<typeof vi.fn<typeof fetch>> {
  const mock = vi.fn<typeof fetch>();
  for (const response of responses) mock.mockResolvedValueOnce(response);
  return mock;
}

function download(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  return downloadMediaResource(url, AUTHENTICATED_HEADERS, fetchImpl);
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  lookup.mockReset();
  lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
});

describe("downloadMediaResource", () => {
  it.each([
    "http://security-app.eufylife.com/media",
    "https://security-app.eufylife.com.evil.example/media",
    "https://security-app-1.eufylife.com/media",
    "https://user:password@security-app.eufylife.com/media",
    "https://security-app.eufylife.com:8443/media",
    "https://127.0.0.1/media",
    "https://[::1]/media",
    "https://localhost/media",
    "https://10.0.0.1/media",
    "https://169.254.1.1/media",
  ])("rejects a disallowed original URL without making a request: %s", async (url) => {
    const fetch = fetchMock();

    await expect(download(url, fetch)).rejects.toThrow("Media download rejected");

    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an allowlisted redirect host resolving privately", async () => {
    lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]);
    lookup.mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    const target = "https://zhixin-security-eu.s3.eu-central-1.amazonaws.com/object";
    const fetch = fetchMock(redirect(target));

    await expect(download("https://security-app.eufylife.com/media", fetch)).rejects.toThrow("Media download rejected");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["https://security-app.eufylife.com/media", "https://security-app-eu.eufylife.com/media"])(
    "accepts an allowlisted original host: %s",
    async (url) => {
      const fetch = fetchMock(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

      await expect(download(url, fetch)).resolves.toEqual(Buffer.from([1, 2, 3]));

      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { address: "127.0.0.1", family: 4 },
    { address: "10.0.0.1", family: 4 },
    { address: "169.254.1.1", family: 4 },
    { address: "::1", family: 6 },
    { address: "fd00::1", family: 6 },
    { address: "fe80::1", family: 6 },
  ])("rejects an allowlisted host resolving to $address", async (resolved) => {
    lookup.mockResolvedValueOnce([resolved]);
    const fetch = fetchMock();

    await expect(download("https://security-app.eufylife.com/media", fetch)).rejects.toThrow("Media download rejected");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends Eufy authentication only to the original request", async () => {
    const target = "https://zhixin-security-eu.s3.eu-central-1.amazonaws.com/object?signature=secret";
    const fetch = fetchMock(redirect(target), new Response(new Uint8Array([4, 5, 6]), { status: 200 }));

    await expect(download("https://security-app-eu.eufylife.com/media", fetch)).resolves.toEqual(
      Buffer.from([4, 5, 6]),
    );

    const firstHeaders = new Headers(fetch.mock.calls[0]![1]?.headers);
    expect(firstHeaders.get("x-auth-token")).toBe("synthetic-token");
    expect(firstHeaders.get("gtoken")).toBeTruthy();
    expect(firstHeaders.get("app-name")).toBe("eufy_mega");
    expect(fetch.mock.calls[0]![1]?.redirect).toBe("manual");

    const secondHeaders = new Headers(fetch.mock.calls[1]![1]?.headers);
    expect([...secondHeaders]).toEqual([]);
    expect(fetch.mock.calls[1]![1]?.redirect).toBe("manual");
  });

  it.each([
    "http://zhixin-security-eu.s3.eu-central-1.amazonaws.com/object",
    "https://user:password@zhixin-security-eu.s3.eu-central-1.amazonaws.com/object",
    "https://zhixin-security-eu.s3.eu-central-1.amazonaws.com:8443/object",
    "https://127.0.0.1/object",
    "https://[::1]/object",
    "https://localhost/object",
    "https://10.0.0.1/object",
    "https://169.254.1.1/object",
    "https://unrelated-bucket.s3.eu-central-1.amazonaws.com/object",
    "https://zhixin-security-eu.s3.evil.example/object",
  ])("rejects a disallowed redirect target: %s", async (target) => {
    const fetch = fetchMock(redirect(target));

    await expect(download("https://security-app.eufylife.com/media", fetch)).rejects.toThrow("Media download rejected");

    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    "https://zhixin-security-eu.s3.eu-central-1.amazonaws.com/object",
    "https://zhixin-security-us.s3.amazonaws.com/object",
  ])("accepts an evidence-backed object host: %s", async (target) => {
    const fetch = fetchMock(redirect(target), new Response(new Uint8Array([7]), { status: 200 }));

    await expect(download("https://security-app.eufylife.com/media", fetch)).resolves.toEqual(Buffer.from([7]));

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a second redirect", async () => {
    const firstTarget = "https://zhixin-security-eu.s3.eu-central-1.amazonaws.com/first";
    const secondTarget = "https://zhixin-security-eu.s3.eu-central-1.amazonaws.com/second";
    const fetch = fetchMock(redirect(firstTarget), redirect(secondTarget));

    await expect(download("https://security-app.eufylife.com/media", fetch)).rejects.toThrow("Media download rejected");

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a declared body larger than 10 MiB before reading it", async () => {
    const response = new Response("must-not-be-read", {
      status: 200,
      headers: { "content-length": String(TEN_MIB + 1) },
    });
    const fetch = fetchMock(response);

    await expect(download("https://security-app.eufylife.com/media", fetch)).rejects.toThrow("Media download rejected");

    expect(response.bodyUsed).toBe(false);
  });

  it("rejects a streamed body once it exceeds 10 MiB", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(TEN_MIB));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const fetch = fetchMock(new Response(body, { status: 200 }));

    await expect(download("https://security-app.eufylife.com/media", fetch)).rejects.toThrow("Media download rejected");
  });

  it("bounds the complete original and redirected attempt to 15 seconds", async () => {
    vi.useFakeTimers();
    const target = "https://zhixin-security-eu.s3.eu-central-1.amazonaws.com/object";
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch.mockResolvedValueOnce(redirect(target));
    fetch.mockImplementationOnce((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const result = download("https://security-app.eufylife.com/media", fetch);
    const rejection = expect(result).rejects.toThrow("Media download timed out");
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![1]?.signal).toBe(fetch.mock.calls[1]![1]?.signal);
  });

  it("includes stalled DNS resolution in the 15-second timeout", async () => {
    vi.useFakeTimers();
    lookup.mockImplementationOnce(() => new Promise(() => undefined));
    const result = download("https://security-app.eufylife.com/media", fetchMock());
    const rejection = expect(result).rejects.toThrow("Media download timed out");
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
  });

  it("does not expose URLs, response bodies, identifiers, or tokens in errors", async () => {
    const url = "https://security-app.eufylife.com/media/private-device-id";
    const fetch = fetchMock(new Response("private-response-body synthetic-token", { status: 403 }));

    let error: Error | undefined;
    try {
      await download(url, fetch);
    } catch (caught) {
      if (caught instanceof Error) error = caught;
    }

    expect(error?.message).toBe("Media authentication failed");
    expect(error?.message).not.toContain(url);
    expect(error?.message).not.toContain("private-device-id");
    expect(error?.message).not.toContain("private-response-body");
    expect(error?.message).not.toContain("synthetic-token");
  });
});

describe("MegaHttpClient.downloadMedia", () => {
  it("preserves the login lifecycle error", async () => {
    await expect(client(false).downloadMedia("https://security-app.eufylife.com/media")).rejects.toThrow(
      "login() first",
    );
  });

  it("delegates with authentication headers from the active session", async () => {
    const fetch = fetchMock(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(client().downloadMedia("https://security-app.eufylife.com/media")).resolves.toEqual(
      Buffer.from([1, 2, 3]),
    );

    const headers = new Headers(fetch.mock.calls[0]![1]?.headers);
    expect(headers.get("x-auth-token")).toBe("synthetic-token");
    expect(headers.get("gtoken")).toBeTruthy();
    expect(headers.get("app-name")).toBe("eufy_mega");
    expect(headers.get("model-type")).toBe("PHONE");
  });

  it("preserves rejection of the active session as a lifecycle error", async () => {
    vi.stubGlobal("fetch", fetchMock(new Response(null, { status: 401 })));

    await expect(client().downloadMedia("https://security-app.eufylife.com/media")).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });
});
