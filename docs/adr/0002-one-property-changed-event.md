# One `propertyChanged` Event, Derived from the Members Table

Status: accepted

Implementation: complete in PR for #95.

A host could not learn that most readable members had moved. 34 writable members across 9 capabilities
are readable via a cloud param and announced by nothing — a camera's status LED and night vision, a
floodlight's on/off and brightness, every audio and siren control. Re-reading was the only way, and
re-reading cannot say WHEN, so a host that reads only while its UI is open showed the previous value
indefinitely after a user changed the setting in the vendor app.

**The decision: one generic `propertyChanged` event, derived from each capability's `members` table, not
a named event per member.** A named event per member would add ~34 names to the typed surface and one
more for every future writable member. Worse, it would put an `events` row keyed by a param id beside a
`members` table that already declares that param, its type, its polarity and its decode — a second table
joined by name, which is the failure mode that makes one feature disagree with itself. `camera.ts`'s
`enablementReads()` helper existed solely to avoid that for one member, and said so in its own JSDoc;
that helper was the evidence the general form should be derivation, not repetition.

The mechanism was already built and thrown away at four call sites. `Device.applyParams` returns the
property names whose value changed, resolved through the family-gated param map with alias promotion,
per-model enums, `writeOnly` exclusion and per-id polarity applied, and structurally de-duplicated so a
re-ordered decoded object does not flap. Deriving per device also dissolved five of the six param ids
that a global param-keyed event index would have found contested.

**The changed thing is identified by property NAME and nothing else.** The name is unique per device, is
what `applyParams` already answers with, and is the key `getProperty` takes, so a caller can re-read
immediately. Rejected: capability + member key, which would need a join that does not exist. Rejected:
carrying the param id — resolving several ids to one property is the job the param map does, and handing
the id back out undoes it and gives a caller a second identifier to key on, which then breaks on the
family whose read alias is promoted. Wire ids stay available on `inspectDevice` and `Device.describe()`,
and `describe()` publishes the `{ accessor, property }` pair for a caller that wants the fluent accessor.

**The value is read out of live state through the same narrowing the getters use** — never re-converted
from the raw wire value, because a second conversion is a second answer and that is precisely how a
payload comes to disagree with the getter beside it. Rejected: invoking the installed getter, which
needs the property → accessor join and has read side effects an announcement must not trigger. A
property whose stored value is a payload, or whose stored value does not match its declared type, is
announced by name alone: "this moved, re-read it" beats shipping a config blob as if it were the value.
No previous value travels either — a caller that needs the delta already holds it, because it was told
last time.

**Eligibility is the device's resolved schema, minus members that opt out.** The schema is what the SDK
published and `getProperty` serves every entry of; a dictionary-named param and an `unknown_<pt>`
passthrough are things the SDK makes no claim about, and announcing either would promise a value it
never agreed to serve. Writability is not consulted — a caller equally cannot learn today that
`battery.temperature` or `storage.free` moved. A member opts out in its own table
(`ValueMember.unannounced`), and the default is to announce. Rejected: filtering centrally by `kind` in
`device.ts` or the client, which is the real ownership violation — the model floor or the facade
deciding which capability values matter, by a rule no capability wrote.

**Announced from the cloud poll and from a realtime report, and from nowhere else.** Not on first sight
of a device (discovery, not a transition), not on the read-through freshness refresh (whose timing says
only when a caller happened to read, which was the original complaint), and not inside a write's own
confirmation (already reported through that command's outcome). Echoes of the SDK's own writes are
announced rather than suppressed, because a poll pass cannot tell them from an external change and
suppressing on that guess loses a real one.

**Announced for a device a caller is holding**, because the value comes out of that device's own live
state. Resolving one on demand cannot help: a device created from the already-updated record has nothing
to diff against, so the pass that created it could never be the pass it announces.

The rule this produced is recorded in the repository's root `CONTEXT.md`: a semantic event earns its name by
carrying something a bare property change cannot. `batteryLevel` and `cameraEnabled` were retired
against it. `contactState` survives it, and its overlap with the generic announcement on the poll path is
accepted as idempotent.
