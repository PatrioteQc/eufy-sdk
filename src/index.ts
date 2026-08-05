/**
 * Public entry point of the SDK.
 *
 * The library is split into four layers, each behind its own barrel. `model/` and `transport/` are
 * decorrelated by design — neither imports the other, and anything genuinely shared between them is
 * a contract in `core/`. `client/` is the facade a caller actually holds.
 *
 * The layers are empty in this scaffold commit; the implementation lands with the source move.
 */
export * from "./core/index.js";
export * from "./transport/index.js";
export * from "./model/index.js";
export * from "./client/index.js";
