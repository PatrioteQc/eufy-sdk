import {
  deriveTuyaAccount,
  deriveTuyaPassword,
  tuyaUsername,
  resolveCountryCode,
  TUYA_PASSWORD_KEY,
  TUYA_PASSWORD_IV,
} from "../account.js";

describe("Tuya account derivation", () => {
  it("prefixes the eufy user id for the username", () => {
    expect(tuyaUsername("12345")).toBe("eufyhome-12345");
  });

  it("key and iv are the fixed 16-byte AES vectors", () => {
    expect(TUYA_PASSWORD_KEY).toHaveLength(16);
    expect(TUYA_PASSWORD_IV).toHaveLength(16);
    expect(TUYA_PASSWORD_KEY.toString("hex")).toBe("244e6d8a56ac879124432d8b6cbca2c4");
    expect(TUYA_PASSWORD_IV.toString("hex")).toBe("772456f2a7664cf3392c3597e93e5747");
  });

  it("derives the password as uppercase-hex AES-128-CBC-NoPadding (golden vectors)", () => {
    // "eufyhome-12345" is 14 chars → leading-zero-padded to 16 before the cipher.
    expect(deriveTuyaPassword("12345")).toBe("1774D45DA407A2B5D2D60C7AEDA64A74");
    // "eufyhome-1234567890abcdef" is 25 chars → padded to 32 (two blocks).
    expect(deriveTuyaPassword("1234567890abcdef")).toBe(
      "0B5B68B67CF1306129DE56149207CACE29B490F564822213D48A2D3AC426E969",
    );
  });

  it("password is deterministic (same id → same password)", () => {
    expect(deriveTuyaPassword("42")).toBe(deriveTuyaPassword("42"));
  });

  it("password length is a multiple of 32 hex chars (16-byte blocks)", () => {
    expect(deriveTuyaPassword("12345").length % 32).toBe(0);
    expect(deriveTuyaPassword("1234567890abcdef").length % 32).toBe(0);
  });

  it("resolveCountryCode prefers phoneCode, else region fallback, else '1'", () => {
    expect(resolveCountryCode("49")).toBe("49");
    expect(resolveCountryCode("  33 ")).toBe("33");
    expect(resolveCountryCode(undefined, "EU")).toBe("44");
    expect(resolveCountryCode("", "CN")).toBe("86");
    expect(resolveCountryCode(undefined, "US")).toBe("1");
    expect(resolveCountryCode()).toBe("1");
  });

  it("deriveTuyaAccount assembles username + password + countryCode", () => {
    const acct = deriveTuyaAccount("12345", "44");
    expect(acct).toEqual({
      username: "eufyhome-12345",
      password: "1774D45DA407A2B5D2D60C7AEDA64A74",
      countryCode: "44",
    });
  });

  it("deriveTuyaAccount defaults countryCode to '1' without a phoneCode", () => {
    expect(deriveTuyaAccount("12345").countryCode).toBe("1");
  });
});
