/**
 * Per-camera WebRTC parameters extracted from a `get_device_list` record. These seed the
 * signaling DISCOVER/LOGIN (signaling servers + the PPCS identity fields) and identify the
 * target camera (`deviceSn` + `channel`). The RTC token / `contact_id` / `aesKey` come from the
 * webrtc-token cloud call the app makes at live-view time on WebRTC-class devices (still needs one
 * capture from such a device to pin the endpoint).
 */

export interface WebRTCDeviceParams {
  /** Camera serial, e.g. `T8170T0000000000`. */
  deviceSn: string;
  /** Per-camera channel index on the station (from `device_channel`). */
  channel: number;
  /** Signaling servers to DISCOVER, in order, e.g. `["https://webrtc-signal-eu.eufylife.com", ...]`. */
  signalingServers: string[];
  /** ThroughTek PPCS device id, e.g. `EUPRCAM-000000-XXXXX` (station-level; shared by its cameras). */
  p2pDid?: string;
  /** PPCS init/connection string (obfuscated). */
  p2pConn?: string;
  /** PPCS license, e.g. `XXXXXX`. */
  p2pLicense?: string;
  /** Parent station serial, if this is a child camera. */
  parentSn?: string;
}

/** Pull WebRTC params from a device's raw `get_device_list` record. Returns undefined if absent. */
export function extractWebrtcParams(raw: Record<string, unknown> | undefined): WebRTCDeviceParams | undefined {
  if (!raw) return undefined;
  const servers = raw["signaling_servers"];
  const sn = raw["device_sn"];
  if (!Array.isArray(servers) || servers.length === 0 || typeof sn !== "string") return undefined;
  return {
    deviceSn: sn,
    channel: typeof raw["device_channel"] === "number" ? (raw["device_channel"] as number) : 0,
    signalingServers: servers.filter((s): s is string => typeof s === "string"),
    p2pDid: typeof raw["p2p_did"] === "string" ? (raw["p2p_did"] as string) : undefined,
    p2pConn: typeof raw["p2p_conn"] === "string" ? (raw["p2p_conn"] as string) : undefined,
    p2pLicense: typeof raw["p2p_license"] === "string" ? (raw["p2p_license"] as string) : undefined,
    parentSn: typeof raw["parent_sn"] === "string" ? (raw["parent_sn"] as string) : undefined,
  };
}
