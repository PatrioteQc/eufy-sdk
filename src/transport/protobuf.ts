/**
 * `protobufjs`, loaded on first use and its documents parsed once.
 *
 * Two costs, both paid at import time until now and both measured one fresh process per module (RSS,
 * not heapUsed — a memory-limited host kills a process for resident pages): the module itself is
 * **+10 MB**, and the push subtree that parses its `.proto` documents at module scope is **+17 MB**
 * all in. Every consumer paid both to
 * import this package, including one that never registers for push and owns no device speaking raw
 * data-points.
 *
 * **Loaded with `createRequire`, not `await import()`, and that is the whole design decision.** The
 * call sites are synchronous — a wire parser driven by socket data, a data-point decoder called from a
 * message handler — and none of them has an `await` to hide a module load behind. An async loader
 * would have meant either making those paths async, which changes contracts a consumer depends on, or
 * a "load it first" rule enforced by throwing at runtime in exactly the paths that used to work. A
 * synchronous require defers the cost without either.
 *
 * Node-only, which this package already is (it opens UDP sockets and reads TLS certificates).
 */
import { createRequire } from "node:module";
import type protobufTypes from "protobufjs";
import type { Root } from "protobufjs";

/** The `protobufjs` module shape, loaded on demand. */
type Protobuf = typeof protobufTypes;

const requireFrom = createRequire(import.meta.url);
let cached: Protobuf | undefined;

/** The engine, loading it on the first call. The ONLY runtime reference to `protobufjs` here. */
export function protobufjs(): Protobuf {
  cached ??= requireFrom("protobufjs") as Protobuf;
  return cached;
}

/**
 * A `.proto` document's parsed root, parsed once per document.
 *
 * Keyed by the document text rather than by a name because these documents are module constants: the
 * same string is always the same schema, and there is no name to key on that would not have to be
 * invented and then kept in step with it.
 */
const roots = new Map<string, Root>();
export function protoRoot(document: string): Root {
  let root = roots.get(document);
  if (!root) {
    root = protobufjs().parse(document).root;
    roots.set(document, root);
  }
  return root;
}
