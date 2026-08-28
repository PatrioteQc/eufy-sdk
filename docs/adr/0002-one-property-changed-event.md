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

**Eligibility is the device's resolved schema, and all of it.** The schema is what the SDK published and
`getProperty` serves every entry of; a dictionary-named param and an `unknown_<pt>` passthrough are things
the SDK makes no claim about, and announcing either would promise a value it never agreed to serve.
Writability is not consulted — a caller equally cannot learn today that `battery.temperature` or
`storage.free` moved.

**Nothing is withheld for being uninteresting.** Rejected: filtering centrally by `kind` in `device.ts` or
the client, which is the real ownership violation — the model floor or the facade deciding which capability
values matter, by a rule no capability wrote. Also rejected, after first being built: a per-member opt-out
flag in the capability's own table. It fixed the ownership objection and still had two problems the
noise argument does not survive.

The first is that it is presentation policy wearing a semantics hat. "This value moves on every report, so
a caller will not care" is a judgement about a host's UI, and this SDK's own hard rule reserves those to the
caller. A robot's session counter is the case that settles it: it advances throughout a clean, nothing else
reports it, and a host drawing clean progress is precisely the caller that wants each tick. Silenced here,
that caller cannot get it back; announced, a caller who does not want it spends one comparison on the name.
The strongest candidate for the flag — a sensor's own check-in timestamp, which genuinely duplicates
`deviceState` — is by the same token the one whose announcement costs a caller nothing to ignore.

The second is that the flag's cost is fixed rather than per-use: a field on `ValueMember`, a second on the
PUBLISHED `PropertySpec` that every consumer of the manifest then has to interpret, a branch on the
announcement path, and a judgement every future member's author has to make. Seven declarations did not
pay for that. Three of them also interacted non-locally — silencing the member that owns the
`CleanStatistics` payload silenced the two that read fields out of it — which is the join-by-name coupling
the members table exists to prevent, reappearing inside the mechanism meant to respect it.

So a member declares nothing to be announced, and nothing to be silent. The half of the original decision
that survives is the one that mattered: the default is to announce, so no member has to opt in.

**Announced from the cloud poll, from a realtime report, and from the read-through cache's own background
re-read.** Not on first sight of a device (discovery, not a transition), and not inside a write's own
confirmation (already reported through that command's outcome). The freshness refresh was originally
excluded too, on the grounds that it fires when a caller happened to read so its timing says nothing about
the device. The timing argument holds; the conclusion does not, because that path applies its fetch into the
same live state the announcement's edge is computed from — so for a host that reads often it is where most
fresh cloud values arrive, and silence there loses the announcement rather than deferring it. Echoes of the
SDK's own writes are announced rather than suppressed, because an inbound path cannot tell them from an
external change and suppressing on that guess loses a real one.

**Announced for a device a caller is holding**, because the value comes out of that device's own live
state. Resolving one on demand cannot help: a device created from the already-updated record has nothing
to diff against, so the pass that created it could never be the pass it announces.

The rule this produced is recorded in the repository's root `CONTEXT.md`: a semantic event earns its name by
carrying something a bare property change cannot. `batteryLevel` and `cameraEnabled` were retired
against it. `contactState` survives it, and its overlap with the generic announcement on the poll path is
accepted as idempotent.
