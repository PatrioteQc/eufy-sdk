# Events

Device events arrive from up to four transports (FCM **push**, **P2P frames**, cloud **poll**, secure
**MQTT**) and are normalized into one **typed semantic event** each — you listen without caring which
transport delivered it. Event names autocomplete and payloads are typed:

```ts
eufy.on("motion", (e) => console.log(e.deviceSn, e.thumbnailUrl));
eufy.on("doorbellPress", (e) => …);
eufy.on("personDetected", (e) => …);
eufy.on("lockState", (e) => …);
eufy.on("contactState", (e) => e.open); // entry sensor: true = open (station notify, push or poll)
eufy.on("batteryLevel", (e) => e.to); // new 0–100 level (cloud poll — see cadence below)
eufy.on("strangerDetected", (e) => …); // a person the device does NOT recognise
eufy.on("soundDetected", (e) => …); // also cryingDetected, vehicleDetected, dogDetected
eufy.on("armingModeChanged", (e) => …); // guard mode switched — re-read the mode
eufy.on("alarm", (e) => e.phase); // "triggered" | "delayed"
eufy.on("ptzNotify", (e) => e.kind); // "rotate" | "zoom" | "position"

// Catch-all: one listener for EVERY semantic event — payload tagged with `name` (a discriminated
// union, so `switch (e.eventName)` narrows the type). Ideal for fanning to a bus.
eufy.on("event", (e) => bus.emit(e.eventName, e));
```

## One change, announced once

A state can reach the SDK on more than one transport at a time. An entry sensor's contact is the clear
case: the station volunteers it over P2P roughly two seconds before the same value arrives as an FCM
push, and the cloud record catches up after that. All three are real reports of one door movement, and
a host wants to be told once.

So events that carry a **settled state** are edge-triggered: a realtime signal repeating the value the
SDK last announced for that device is dropped. A genuine open → close → open burst passes intact,
because every step differs from the one before — the suppression is on the value, not on a time window.

Two deliberate exceptions:

- **Events that are pulses are never suppressed.** `motion`, `doorbellPress` and the detections carry
  no settled state; two identical ones in a row are two real detections.
- **The cloud poll still re-announces an unchanged state**, so a host that missed a frame, or that
  reconnects after a drop, is resynchronised instead of waiting for the state to physically change.
  Tearing the connection down clears what the SDK remembers announcing, for the same reason.

For an entry sensor behind a station this means `contactState` now lands about two seconds earlier
than before, over the LAN, with no cloud involved — and still exactly once per movement.

## Detection level on a motion sensor

A sensor's detection level is a step, not a number: `dev.motion()?.setSensitivityStep(n)`, read back as
`dev.motion()?.sensitivityStep()`. Its five steps are detection distances — 3-5 m at the lowest up to
9-11 m at the highest — and the value behind them counts DOWN as the sensor gets more sensitive, so a
raw number would invite picking the wrong end. Cameras run their own scales, some rising and some
falling, which is why a step is what crosses them all — see
[When a setting means something different per device](/devices#when-a-setting-means-something-different-per-device).

A change lands after about a minute, or immediately if the sensor is triggered by walking in front of
it. So a read straight after a write returns the previous level until it catches up.

## A motion sensor reports only in test mode

A standalone PIR sensor is the exception to the paragraph above: outside the vendor app's **user test
mode** it is never notified over P2P at all. Its detections reach you as a push, or as a last-event
timestamp on the next cloud poll — there is no local path.

`dev.motion()?.setTestMode(true)` opens one, and `dev.motion()?.testMode` reads back what the station
reports. It is a diagnostic mode meant for aiming a sensor while installing it, not a transport — and
**while it is on that sensor's detections do not raise the alarm**, so leaving it on quietly disarms
it. Turn it back off. A sleeping sensor cannot enter it either: the station accepts the command while
the sensor only learns on its next wake, so trigger the sensor as you call.

Events start flowing on their own — a successful `login()` brings up the account-wide push channel
(and MQTT for appliances) automatically, so you register listeners and receive events without any extra
setup. Subscribe **before** logging in if you don't want to miss an early event. Which transport
carries each event, and how P2P opens on demand, is covered in [Realtime transports](/realtime) and
[Connectivity & battery](/connectivity).

Low-level escape hatches remain (`message`, `p2p`, `pushRaw`, connect/disconnect lifecycle, `error`)
for when you want the raw frame.

Detection kinds are **separate events**, not one `motion` with a flag — a host usually maps them to
distinct sensors. Note `personDetected` means a face or a _recognised_ person; someone the device does
not recognise arrives as `strangerDetected`.

**Not every event arrives at the same speed.** Push- and P2P-carried events (`motion`,
`doorbellPress`, `personDetected`, `lockState`, `contactState`) land within seconds of the device
acting. Anything the cloud reports instead of the device is bounded by the cloud's own refresh of that
device's params — minutes, not seconds. Treat those as a slowly-updating level, not a trigger.

> **MQTT semantic events are pending.** The `mqtt` source is wired end-to-end (messages already flow
> through the normalizer) but no capability maps it to a semantic event yet — the realtime state
> payload for vacuum / eufy_home appliances isn't decoded yet. Until then, consume MQTT via the raw
> `message` event; the semantic layer picks it up once a capability adds an `mqtt` mapping.

## Example

<<< @/../examples/02-listen-events.ts

Next: [Realtime transports](/realtime) · [Live media](/live-media).
