# RTSP — publishing a camera to a recorder

How a host publishes a camera's stream over RTSP so a NAS or NVR can record it, and how to control
who may read it.

This is distinct from [consuming a live stream](/live-media): there the SDK pulls frames to your
process, here the device serves a stream on your local network and you point other software at it.

```ts
const dev = await eufy.getDevice(sn);
const rtsp = dev.rtsp?.(); // present only on a camera that reports the feature
```

The accessor is absent on a device that never advertises RTSP, so guard it (`dev.rtsp?.()`) or assert
once up front.

## Publishing

```ts
await rtsp?.publish(); // start serving this camera
await rtsp?.withdraw(); // stop
rtsp?.published; // boolean | undefined — current state
```

`published` is a typed read, present only when the device actually reports the backing state.

The device does not stream to your process here — it serves an RTSP endpoint on your LAN that any
recorder can open. Which host serves it depends on how the camera is installed:

| Camera            | Served by                                   |
| ----------------- | ------------------------------------------- |
| HomeBase-attached | the HomeBase, one URL per attached camera   |
| Standalone        | the camera itself, on its own local address |

## Three constraints worth knowing up front

**One camera at a time per HomeBase.** A station publishes for a single attached camera. Calling
`publish()` on a second one silently stops the first — the station has room for one, not a set. The
SDK cannot detect or prevent this, so a host driving several cameras owns the choice of which is
live.

**It will drain a battery camera.** A published stream encodes continuously, with none of the
budgeting the live-media path applies. The feature is meant for mains-powered cameras feeding a
recorder. Check `dev.has("battery")` before offering it, and prefer leaving it off.

**A published stream is readable by your whole local network** unless the camera enforces
authentication — see below. Treat publishing as making the camera available to anything on that
network.

## Authentication

```ts
await rtsp?.requireAuth("eufy", secret); // demand credentials
await rtsp?.allowAnonymous("eufy", secret); // serve without demanding them
```

`requireAuth()` makes the camera answer with a Digest challenge; `allowAnonymous()` returns it to
serving openly while keeping the credentials stored.

**Only a camera that serves its own stream enforces this.** On a HomeBase-attached camera the station
does the serving and ignores the camera's authentication setting, so `requireAuth()` **rejects**
rather than reporting a success that would not hold:

```ts
try {
  await rtsp?.requireAuth("eufy", secret);
} catch {
  // HomeBase-attached: the stream is open to the local network while published
}
```

That is deliberate. The credentials would store, and the device would even report them, while the
stream stayed readable by anyone — so the SDK refuses instead of letting a stored password pass for
access control. If you need an authenticated stream from a HomeBase-attached camera, you cannot get
one; restrict access at the network instead, or leave the camera unpublished and use
[live media](/live-media) instead.

## Choosing between RTSP and live media

| You want                                | Use                           |
| --------------------------------------- | ----------------------------- |
| Frames in your own process              | [live media](/live-media)     |
| Several cameras at once                 | [live media](/live-media)     |
| A battery camera, occasionally          | [live media](/live-media)     |
| A recorder (NAS/NVR) to pull the stream | RTSP                          |
| Continuous recording of a wired camera  | RTSP                          |
| An authenticated stream                 | RTSP, standalone cameras only |

Live media is the general answer. RTSP earns its place when the consumer is an existing recorder that
speaks RTSP and you would rather not proxy frames through your own application.
