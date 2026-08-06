export * from "./mega-client.js";
export * from "./decodeImageV1.js";
// The account/region-scoped light-effect catalogue — browse helpers a host calls with the client from
// `eufy.api`. The internal `resolveLightEffect` (used by the MQTT router) is deliberately not re-exported.
export { listLightEffects, listAiSceneRecommendations, type LightEffectSummary } from "./light-catalog.js";
