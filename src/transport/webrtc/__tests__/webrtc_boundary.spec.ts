import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createWebRtcPeer } from "../peer.js";
import type { WebRTCPeerHandle } from "../../../core/contracts.js";

describe("WebRTC engine boundary (Ask G)", () => {
  it("createWebRtcPeer returns an engine-free WebRTCPeerHandle", async () => {
    const peer: WebRTCPeerHandle = await createWebRtcPeer();
    try {
      // The handle exposes only signaling in / media out — no engine handle.
      expect(typeof peer.createOffer).toBe("function");
      expect(typeof peer.setRemoteDescription).toBe("function");
      expect(typeof peer.createAnswer).toBe("function");
      expect(typeof peer.addRemoteCandidate).toBe("function");
      expect(typeof peer.close).toBe("function");
      // The engine escape hatch (`pc` / `onTrack`) is sealed at the TYPE + .d.ts level: `peer` typed
      // as WebRTCPeerHandle has no `pc`, and the built peer.d.ts inlines no werift type (checked
      // below + in CI). @ts-expect-error asserts the type surface omits it.
      // @ts-expect-error — `pc` is not on the public WebRTCPeerHandle
      void peer.pc;
    } finally {
      await peer.close();
    }
  });

  it("builds a valid recvonly SDP offer", async () => {
    const peer = await createWebRtcPeer({ iceAdditionalHostAddresses: ["127.0.0.1"] });
    try {
      const offer = await peer.createOffer();
      expect(offer.type).toBe("offer");
      expect(offer.sdp).toContain("m=video");
      expect(offer.sdp).toContain("m=audio");
    } finally {
      await peer.close();
    }
  });

  // Belt-and-suspenders for the CI guard: the built peer .d.ts must not inline a werift type. Self-
  // skips when the lib hasn't been built (the authoritative check is the CI `.d.ts` grep step).
  it("does not leak werift types into the built peer .d.ts", () => {
    const dts = fileURLToPath(new URL("../../../../dist/transport/webrtc/peer.d.ts", import.meta.url));
    if (!existsSync(dts)) return; // no dist/ in this run — CI enforces the real check
    const src = readFileSync(dts, "utf8");
    // Real leaks emit an `import("werift")` reference or an inlined engine type annotation; a mention
    // inside a `*` doc-comment line is fine.
    const codeLines = src.split("\n").filter((l) => !l.trimStart().startsWith("*"));
    const code = codeLines.join("\n");
    expect(code).not.toContain('import("werift")');
    expect(code).not.toMatch(/:\s*(RtpPacket|MediaStreamTrack|RTCPeerConnection|RTCRtpCodecParameters)\b/);
  });
});
