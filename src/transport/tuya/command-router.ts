/**
 * `TuyaCommandRouter` — the transport-side command router for legacy-Tuya vacuum devices (G-series
 * and other RoboVacs that use the ThingClips / Tuya IoT SDK rather than Anker AIoT MQTT).
 *
 * SCAFFOLDING: the Tuya REST path is proven at the request/sign layer (transport-confirmed against
 * `a1.tuyaeu.com`), but the end-to-end write path is NOT yet live. Two things are needed before
 * `dispatchCommand` can send:
 *   1. `TuyaClient.login()` — the `token.create` response is an RSA-encrypted envelope whose decrypt
 *      is not implemented, so no session id (`sid`) can be minted yet.
 *   2. G-series DP IDs confirmed from a live V6 APK capture — the capability layer throws for legacy
 *      vacuums until those are known.
 *
 * When both are done: add a `TuyaClient` field, wire a Tuya-devId/gwId resolver (maps eufy SN →
 * Tuya device ids), call `this.client.publishDps(devId, gwId, { [cmd.dp]: cmd.value })` for
 * `aiot-dp` commands, and drop the stub throw here.
 *
 * Layering: imports `../../core` only — no `model/` import, consistent with the capability↔transport
 * decorrelation invariant.
 */
import type { Command } from "../../core/contracts.js";

export class TuyaCommandRouter {
  /**
   * Route a `Command` to the Tuya REST API. Only `aiot-dp` is meaningful here; any other kind is a
   * routing bug from the facade and fails loud.
   *
   * STUB — always throws. The login round-trip (`token.create` RSA envelope decrypt) is not
   * implemented, so no `sid` is available and `publishDps` cannot complete. Once login is proven and
   * G-series DP IDs are confirmed from a live V6 capture, replace the stub throw with the real
   * `TuyaClient.publishDps` call (see module doc).
   */
  async dispatchCommand(_sn: string, cmd: Command): Promise<void> {
    if (cmd.kind !== "aiot-dp") {
      throw new Error(`TuyaCommandRouter received an unroutable command (${cmd.kind}) — only aiot-dp belongs here`);
    }
    throw new Error(
      "legacy Tuya command path is a STUB: token.create returns an RSA-encrypted envelope " +
        "(decrypt not implemented) so login cannot complete and dp.publish cannot be sent — " +
        "see transport/tuya/client.ts TuyaClient.login() for remaining work",
    );
  }
}
