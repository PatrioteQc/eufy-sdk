# Context

The project's domain vocabulary — the nouns this codebase reasons in, and the distinctions the words
are carrying. Code practice and the hard rules live in [AGENTS.md](./AGENTS.md); durable decisions and
the alternatives they rejected live in [`docs/adr/`](./docs/adr/).

Use these terms as defined. A synonym looks harmless in a commit message and then shows up as a second
name for one thing in the code.

## The device

**Capability** — a composable feature a device exposes (`camera`, `battery`, `vacuum_clean`), granted on
evidence the device reports and owning one self-contained module under `src/model/capabilities/`. Not a
device kind, and not a class: there are no subclasses, and `dev.has("battery")` is the question, never
`instanceof`.

**Codec** — which wire protocol family a device speaks (`camera`, `station`, `lock`, `vacuum`, …). A
separate axis from capability, and the two vocabularies collide by accident: `camera` and `light` and
`lock` are each both a codec and a capability, meaning different things.

**Product line** — one of the vendor's ecosystems (`security`, `life`, `clean`). They share a cloud
account and nothing else, and their retail vocabulary overlaps, which is why a capability declares its
line.

**Member** — one entry in a capability's `members` table: one thing a device exposes. The single
declaration everything about that thing is derived from — the property schema, the typed getter, the
setter beside it, the intent route, the description, and the surface type. "A table per concern, joined
by name" is the failure this word exists to prevent.

**Schema property** — a member's entry in the device's flat property namespace, keyed by NAME. The name
is what `getProperty` takes and what a capability getter answers. Distinct from a **param** (a wire id):
several params can carry one property across device families, which is the whole reason the property has
a name of its own.

**Live state** — the map of current property values a `Device` holds, and the one every capability getter
reads through. Distinct from the **cloud record's params** (a server-side snapshot) and from a device's
**realtime report**: both are inbound sources that get APPLIED to live state, and neither is it.

**Evidence** — a param the device actually reported. It gates capabilities and getters, so a device
advertises what it has and no phantom sub-features. Evidence only ever widens: a param a device stops
reporting does not retract anything.

## Being told about a change

**Inbound path** — a route by which the SDK learns something: an FCM push, a P2P frame, a secure-MQTT
report, a Tuya data point, or a cloud poll. A property arrives on the paths its wire uses, and most
readable properties have only the poll.

**Announcement** — telling a host that a property's value moved, as `propertyChanged`, identified by
property name and carrying the value `getProperty` now serves, narrowed the way the capability getter
narrows it. Generic: derived from the members table for every schema property, so a member needs no
declaration to be announced. A member opts OUT with `unannounced: true`, for a value that moves on
essentially every report and therefore carries no news. Announced against a `Device` the caller holds,
because that is where live state is.

**Semantic event** — a NAMED device event (`motion`, `contactState`, `batteryAlert`, `lockState`). The
rule:

> **A semantic event earns its name by carrying something a bare property change cannot** — an inbound
> source the property path does not reach, a threshold crossing, or a dedupe across transports. A name
> that only restates "this param moved" is not one.

`batteryLevel` and `cameraEnabled` were retired against that rule; `contactState` survives it (three
transports, deduped, and its push carries no param at all). See
[ADR-0002](./docs/adr/0002-one-property-changed-event.md).

**Liveness** — that a device is still reporting, published as `deviceState` and read off `lastSeenMs`.
Deliberately not an `online` verdict: the healthy silence of a mains camera and of a battery sensor are
nothing alike, so the threshold is the caller's. A property whose only content is liveness (a sensor's
own check-in timestamp) is `unannounced`, because this already says it.

**Observation** — confirming that a write the SDK issued actually landed, by bounded readback of the
param the device reports it under. A different fact from an announcement: an announcement says a value
moved for any reason, an observation says _this write_ took effect. A write the device acknowledged and
never applied surfaces as `commandUnconfirmed`.

**Echo** — a change the SDK's own write caused, arriving back on an inbound path. Announced, not
suppressed: a poll pass cannot tell an echo from a change someone made in the vendor app, and
suppressing on that guess loses the real external change in exchange for one redundant re-read.

## Talking to a device

**Intent** — a transport-neutral `Command` a capability emits. Its `kind` names the WIRE ACTION, never
the capability that emits it.

**Provider** — an interface in `core/contracts.ts`, implemented in `transport/` and injected where a
capability is bound, for work only a transport can do. Named for the technical job, never for the
feature that motivated it. Reach for one only when a capability has to PULL something mid-read; if the
data already arrives on an inbound path, decode it there and let it flow in as state.

**Verified / unverified** — whether a wire claim is grounded in the current app's own behaviour. Per
DIRECTION: a read may ship ahead of its write. An unverified write is declared but not installed, so a
caller learns at compile time, because a fire-and-forget write that is wrong looks exactly like success.

## Words this project avoids

- **"the lib"** — it is **the SDK**.
- **"online" / "offline"** for a device — say what is known: when it last reported. See _liveness_.
- **"property changed event" per member** — there is one `propertyChanged`. A per-member name is a
  _semantic event_ and has to earn it.
- **A host's vocabulary** for what a value means — the SDK says the value's `kind`; which entity class,
  characteristic or topic that maps to is the caller's table.
