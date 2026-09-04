import { describe, it, expect } from "vitest";
import tls from "node:tls";
import { bareIpTlsOptions } from "../bare-ip-tls.js";

/**
 * The bare-IP dial's server-identity policy, exercised against Node's real `tls.checkServerIdentity`.
 *
 * No socket and no fixtures: `checkServerIdentity` is a pure function of a hostname and a peer
 * certificate, so a hand-built certificate shape drives the actual matcher the TLS handshake would
 * call. That covers the part that is ours — WHICH name the certificate is verified against — while
 * chain verification stays Node's, enabled by `rejectUnauthorized`.
 */
const HOSTNAME = "aiot-mqtt-us.example.invalid";
const INSTANCE_IP = "198.51.100.7";

const IDENTITY = { hostname: HOSTNAME, cert: "client-cert", key: "client-key", ca: "server-ca" };

/** A peer certificate naming `names` in its SAN list, in the shape `checkServerIdentity` reads. */
function certFor(...names: string[]): tls.PeerCertificate {
  return {
    subject: { CN: names[0] },
    subjectaltname: names.map((n) => (/^\d+\.\d+\.\d+\.\d+$/.test(n) ? `IP Address:${n}` : `DNS:${n}`)).join(", "),
  } as unknown as tls.PeerCertificate;
}

describe("bareIpTlsOptions", () => {
  it("verifies the server, rather than trusting whatever certificate it presents", () => {
    const o = bareIpTlsOptions(IDENTITY);
    expect(o.rejectUnauthorized).toBe(true);
    expect(o.ca).toBe("server-ca");
  });

  it("keeps SNI on the real hostname so the instance answers with its own certificate", () => {
    expect(bareIpTlsOptions(IDENTITY).servername).toBe(HOSTNAME);
  });

  it("accepts the broker's certificate for the hostname even though the socket dialled an IP", () => {
    const { checkServerIdentity } = bareIpTlsOptions(IDENTITY);
    expect(checkServerIdentity(INSTANCE_IP, certFor(HOSTNAME))).toBeUndefined();
  });

  it("is why the check cannot be left to Node's default: the dialled IP does not match that certificate", () => {
    expect(tls.checkServerIdentity(INSTANCE_IP, certFor(HOSTNAME))).toBeInstanceOf(Error);
  });

  it("rejects a certificate for any other name, whatever the socket dialled", () => {
    const { checkServerIdentity } = bareIpTlsOptions(IDENTITY);
    const wrong = checkServerIdentity(INSTANCE_IP, certFor("attacker.example.invalid"));
    expect(wrong).toBeInstanceOf(Error);
    expect((wrong as Error).message).toMatch(/does not match/);
  });

  it("rejects a certificate that only names the instance IP, so holding one for the address is not enough", () => {
    const { checkServerIdentity } = bareIpTlsOptions(IDENTITY);
    expect(checkServerIdentity(INSTANCE_IP, certFor(INSTANCE_IP))).toBeInstanceOf(Error);
  });

  it("ignores the hostname the TLS stack passes in, matching only the identity it was built with", () => {
    const { checkServerIdentity } = bareIpTlsOptions(IDENTITY);
    expect(checkServerIdentity("attacker.example.invalid", certFor("attacker.example.invalid"))).toBeInstanceOf(Error);
    expect(checkServerIdentity("attacker.example.invalid", certFor(HOSTNAME))).toBeUndefined();
  });

  it("passes the client certificate and key through for the mutual-TLS half of the handshake", () => {
    const o = bareIpTlsOptions(IDENTITY);
    expect(o.cert).toBe("client-cert");
    expect(o.key).toBe("client-key");
  });
});
