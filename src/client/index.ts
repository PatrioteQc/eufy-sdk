// Facade surface: the EufyMega client, its options/event types, and the
// freshestLanIp helper. The class + its declaration-merged event interface
// live together in eufy-mega.ts (declaration merging requires one module).
export * from "./eufy-mega.js";

// Anker Solix power-station cloud client (same-account login + device/site/MQTT reads).
export * from "./solix-client.js";
