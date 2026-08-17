#!/usr/bin/env python3
"""Generate a FULLY SYNTHETIC `v2_eufysecurity:` thumbnail fixture for decode_v2.spec.ts.

Repo policy is synthetic fixtures only (no captured device data / real serials). A v2 blob is just the
ascii `v2_eufysecurity:<serial>:<id>:` wrapper followed by a standard baseline JPEG — the decoder
ignores the (obfuscated, here plain) head and splices from the plaintext `FF C4 00 1F 01` tail. We
therefore build a synthetic image, encode it as a standard 4:4:4 baseline JPEG (Pillow/libjpeg emits
the separate DC/AC chroma DHT segments the decoder relies on), prepend a synthetic serial, and base64
it. Pillow is a dev-time tool only; it is NOT a runtime dependency of the SDK.

    python3 scripts/dev/gen_v2_fixture.py <width> <height> <out.b64>
"""
import base64
import sys

from PIL import Image

SYNTHETIC_SERIAL = b"v2_eufysecurity:T8000TEST00000002:0000000000:"


def synthetic_image(w: int, h: int) -> Image.Image:
    # Photo-like content with strong horizontal continuity so the width search (min row-shear) locks
    # onto the true width: a smooth diagonal luma gradient plus a few horizontal bands and a box.
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            r = (x * 255) // (w - 1)
            g = (y * 255) // (h - 1)
            b = ((x + y) * 255) // (w + h - 2)
            if (y // 12) % 4 == 0:
                r = min(255, r + 40)
            if 40 <= x < 120 and 30 <= y < 90:
                r, g, b = 200, 60, 60
            px[x, y] = (r, g, b)
    return img


def main() -> None:
    w, h, out = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    from io import BytesIO

    buf = BytesIO()
    # subsampling=0 → 4:4:4; keep standard Huffman/quant tables (no optimize) for the split DHT layout.
    synthetic_image(w, h).save(buf, format="JPEG", quality=85, subsampling=0)
    blob = SYNTHETIC_SERIAL + buf.getvalue()
    with open(out, "w") as f:
        f.write(base64.b64encode(blob).decode())
    print(f"wrote {out}: {len(blob)} bytes ({w}x{h}, synthetic)")


if __name__ == "__main__":
    main()
