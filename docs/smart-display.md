# Smart Display

The eufy Smart Display (T87A0, "Smart Display E10") is the smallest surface in this SDK, and the
reason is worth stating before the API: **almost nothing about it is on a wire anyone here has read.**

```ts
const display = dev.display();

display?.modelCode; // "T87A0" — the device's own model code
display?.modelName; // "Smart Display E10" — its retail name, as it reports it
display?.softwareVersion; // "2.9.05" — version-shaped; see the warning below
```

That is the whole capability. There is no screen control, no volume, no assistant — not because they
are unimplemented, but because the one captured unit reported no parameter for any of them.

## What the device actually reported

One T87A0, captured 2026-09-04. It connects over **secure MQTT with no `p2p_did`**, so it never speaks
P2P at all, and it reported six parameters in the ids `8001`-`8006` — an id range no other eufy line
uses.

| Param | Value on the capture   | Modelled as                             |
| ----- | ---------------------- | --------------------------------------- |
| 8001  | `"100"`                | —                                       |
| 8002  | `"1"`                  | —                                       |
| 8003  | `"2.9.05"`             | `softwareVersion` (a guess — see below) |
| 8004  | a serial-shaped string | —                                       |
| 8005  | `"Smart Display E10"`  | `modelName`                             |
| 8006  | `"T87A0"`              | `modelCode`                             |

**Three of the six are deliberately unnamed.** `100` fits a percentage of brightness, volume or battery
equally well; `1` fits any enum or flag; and a serial-shaped value could be the display's own or the
station it is bound to. One value does not settle any of them, and a name here would be read downstream
as a fact — on a screen device, a misread `100` rendered as a battery level is exactly the kind of wrong
that looks right. They are reported as raw ids instead.

::: warning `softwareVersion` is an inference
Its provenance is `guessed`, alone among the three. The device sent a dotted version-shaped string and
nothing corroborates what the id means. `modelName` and `modelCode` are `mega` for a different reason:
their VALUES were facts already known from elsewhere — the retail name and the model code — so the match
is evidence about the id, not a shape that suggests one.

Where the cloud record carries a firmware version, `dev.info()?.firmwareVersion` is the field to trust.
This device's record did not.
:::

## Why it is not part of the security line

A Smart Display shares a cloud account with the cameras and nothing else. It used to be grouped into
the `security` product line and param namespace anyway, which left two doors open:

- **A future security parameter assigned in the 8000s** would have been decoded off a Smart Display as
  whatever that id means on a camera.
- **Any security capability detected by a NAME regex** became attachable to it. eufy's retail vocabulary
  collides across ecosystems, and detection evidence is OR-ed, so this was measured rather than
  hypothetical: with an adversarial device name, six security capabilities attached — light, doorbell,
  leak, smoke, CO, lock — none of which this device could ever answer for, because it has no P2P path.

Both are shut. `display` is its own product line with its own parameter dictionary, and the adversarial
case is pinned in `line-partition.spec.ts`.

## Nothing is writable

No write is offered for any display parameter, and none is guessed. An AIoT data-point write is
fire-and-forget — the device acknowledges nothing — so a wrong frame to a device that cannot contradict
you looks exactly like success. The reads have to arrive before a control can be honest about what it
moves.

## What would open this up

A capture of the vendor app driving the display's own settings, **one control at a time, with the
reported parameters diffed after each change.** That is what would name 8001, 8002 and 8004, confirm or
correct `softwareVersion`, and reveal whichever ids carry the screen, the volume and the assistant —
none of which appeared in the capture at all, which suggests they arrive on a channel this SDK has not
yet looked at rather than as parameters it simply failed to name.

See [Devices & capabilities](/devices) for how capability resolution works.
