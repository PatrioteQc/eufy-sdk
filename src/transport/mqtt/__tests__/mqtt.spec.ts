import { secureTopic } from "../topics.js";
import { classifyDevice, type EufyDevice } from "../../../core/types.js";

const light: EufyDevice = {
  sn: "T1234X00099",
  model: "T1234",
  category: "eufy_mega",
  deviceClass: "other",
  api: "mega",
  realtime: "smqtt",
};

describe("secure MQTT (Anker mTLS) topics", () => {
  it("builds cmd/{category}/{model}/{sn}/res for subscribe", () => {
    expect(secureTopic(light, "res")).toBe("cmd/eufy_mega/T1234/T1234X00099/res");
    expect(secureTopic(light, "req")).toBe("cmd/eufy_mega/T1234/T1234X00099/req");
  });
});

describe("device classification (API + realtime routing)", () => {
  it("eufy_security → mega API + p2p realtime (v6 uses mega for all devices)", () => {
    const c = classifyDevice({ category: "eufy_security", device_model: "T8214" });
    expect(c).toMatchObject({ api: "mega", realtime: "p2p" });
  });
  it("a populated p2p_did forces p2p regardless of category", () => {
    const c = classifyDevice({ category: "eufy_mega", device_model: "T8030", p2p_did: "ABC123" });
    expect(c.realtime).toBe("p2p");
  });
  it("mega appliance → mega API + smqtt realtime", () => {
    const c = classifyDevice({ category: "eufy_mega", device_model: "T1234" });
    expect(c).toMatchObject({ api: "mega", realtime: "smqtt" });
  });
});
