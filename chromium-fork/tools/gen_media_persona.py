#!/usr/bin/env python3
"""Generate a measured `<name>.xrio-media.json` from two captures.

Same model as `tools/gen_gl_persona.py`, and deliberately the same shape so
there is one thing to learn: a capture of the GPU we CLAIM, a capture of the GPU
we PRODUCE, and an artifact carrying only the rows where they differ. A row that
already agrees is not overridden, because an override that changes nothing is a
hook with no measurement behind it.

WHAT THIS REFUSES, and each refusal is a defect that would otherwise ship:

  * A capture whose Chrome version is not the pin. decodingInfo answers move
    with the media stack, so a claim captured on another milestone is a claim
    about a browser this is not.
  * Two captures from the same GPU. That is not a persona, it is a copy, and it
    would read as one.
  * A capture with no WebGL renderer string. Without both, the copy refusal
    above cannot run and the artifact's own provenance would be null.
  * Two captures taken in DIFFERENT modes. This artifact is a GPU diff; a
    headed claim paired with a headless produce capture would fold the mode
    axis into it, and no reader downstream could tell which one moved a row.
  * A family whose `file` and `media-source` answers disagree in the claim
    capture. `base::xrio::MediaTable` stores ONE answer per family, so a claim
    the loader cannot express must not be written into an artifact that says it
    can.
  * A row that would move `powerEfficient` or `smooth` without `supported`
    agreeing across both, for the reason xrio_media_table.h gives: a triple, or
    nothing.

WHAT IT ONLY WARNS ABOUT: WebCodecs and WebRTC disagreement between the two
captures. Item 7.2 says to look at the capture before hooking those, and the
loader has nowhere to put them yet, so the generator reports the finding and
writes no row -- rather than silently implying that decodingInfo alone is the
whole surface. Those notes have THREE states, not two: agreeing, differing, and
NOT MEASURED. An absent reading is not an agreeing one, and since these notes
are the only record that 7.2 was examined, the third state has to say so.

    tools/gen_media_persona.py claim.json over.json [--out DIR]
"""

import argparse
import hashlib
import json
import pathlib
import sys

SCHEMA = "xrio-media-table/v1"
CAPTURE_SCHEMA = "xrio-media-capture/v1"
SUFFIX = ".xrio-media.json"
ROOT = pathlib.Path(__file__).resolve().parent.parent
PIN = dict(line.split("=", 1) for line in (ROOT / "VERSIONS").read_text().split())["CHROMIUM_VERSION"]

# The loader's own list; a family outside it cannot be stored.
FAMILIES = ("h264", "hevc", "vp8", "vp9", "av1")
TRIPLE = ("supported", "smooth", "powerEfficient")


def canonical(body):
    return json.dumps({k: v for k, v in body.items() if k != "digest"},
                      sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


def digest(body):
    return "sha256:" + hashlib.sha256(canonical(body)).hexdigest()


def load(path):
    body = json.loads(path.read_text(encoding="utf-8"))
    if body.get("schema") != CAPTURE_SCHEMA:
        raise ValueError(f"{path.name}: not a {CAPTURE_SCHEMA} capture")
    version = body.get("browser", "")
    if PIN not in version:
        raise ValueError(
            f"{path.name} was captured on {version!r} and the pin is {PIN}. "
            "decodingInfo answers move with the media stack, so this is a "
            "claim about a browser this is not.")
    return body


# The two 7.2 surfaces and the exact note each one writes. Kept as literal
# strings, and unchanged from what they were, so re-running this generator over
# the same captures still reproduces the checked-in artifact byte for byte.
NOTES_72 = {
    "webcodecs": (
        "webcodecs: identical on both GPUs, nothing to hook",
        "webcodecs: the two GPUs answer DIFFERENTLY. Item 7.2 says the "
        "artifact grows a section and the acceptance matrix grows rows before "
        "anything hooks it; this generator writes neither."),
    "webrtc": (
        "webrtc: identical on both GPUs",
        "webrtc: DIFFERENT between the two GPUs, see 7.2"),
}


def reading(capture, key):
    """A comparable reading for `key`, or None when nothing was measured.

    THE THIRD STATE IS THE POINT. capture_media.py catches every probe failure
    into errors[] and still exits 0 with `webcodecs: {}` and `webrtc: null`, so
    on a host where VideoDecoder or RTCRtpReceiver is undefined BOTH captures
    come back empty and therefore EQUAL. These notes are the only record that
    item 7.2 was ever examined, so equality-by-absence used to write an
    unmeasured surface down as a cleared one. None means nobody looked.
    """
    value = capture.get(key)
    if key == "webrtc":
        value = (value or {}).get("codecs")
    return None if not value else json.dumps(value, sort_keys=True)


def triple(row):
    """The decodingInfo triple for one family, or None when unusable."""
    if not row or "error" in row:
        return None
    if any(key not in row for key in TRIPLE):
        return None
    return tuple(bool(row[key]) for key in TRIPLE)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("claim", type=pathlib.Path,
                    help="capture from the GPU we claim (the reference)")
    ap.add_argument("over", type=pathlib.Path,
                    help="capture from the GPU we produce (SwiftShader)")
    ap.add_argument("--name", default=None,
                    help="persona name; defaults to the claim capture's label")
    ap.add_argument("--out", type=pathlib.Path, default=ROOT / "personas")
    args = ap.parse_args()

    try:
        claim = load(args.claim)
        over = load(args.over)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"REFUSING: {error}", file=sys.stderr)
        return 1

    # THE MODE HAS TO MATCH, because the mode is not the axis this artifact is
    # about. The tree already holds a headed claim capture and a HEADLESS
    # SwiftShader capture, which look like a natural pair for the sx4jo render
    # host; pairing them would put the mode axis inside the GPU diff, and any
    # decode difference headless caused -- those two already disagree on the
    # widevine row -- would be written into the artifact the browser reads as
    # though the GPU had caused it.
    if not claim.get("mode") or not over.get("mode"):
        print("REFUSING: a capture does not say which mode it was taken in, so "
              "the two cannot be shown to share one. Re-capture with a "
              "capture_media.py that records the mode.", file=sys.stderr)
        return 1
    if claim.get("mode") != over.get("mode"):
        print(f"REFUSING: the claim capture is {claim['mode']!r} and the over "
              f"capture is {over['mode']!r}. This artifact is a GPU diff; two "
              "modes would make it a mode diff as well, and nothing "
              "downstream could tell which axis moved a row.", file=sys.stderr)
        return 1

    claim_gl = (claim.get("gl") or {}).get("renderer")
    over_gl = (over.get("gl") or {}).get("renderer")
    # BOTH renderer strings are REQUIRED, not merely compared. capture_media.py
    # sets `gl: null` and appends to errors[] when the WebGL context or
    # WEBGL_debug_renderer_info fails, and a bare `if claim_gl and ...` let that
    # case skip the copy refusal altogether: the same capture passed twice was
    # accepted and written out with null/null provenance.
    absent_gl = [label for label, value in (("claim", claim_gl),
                                            ("over", over_gl)) if not value]
    if absent_gl:
        print(f"REFUSING: the {' and '.join(absent_gl)} capture carries no "
              "WebGL renderer string, so the two GPUs cannot be told apart and "
              "this artifact's provenance would be null. Re-capture -- the "
              "reason is in errors[] there.", file=sys.stderr)
        return 1
    if claim_gl == over_gl:
        print(f"REFUSING: both captures report the same GPU ({claim_gl!r}). "
              "That is a copy, not a persona.", file=sys.stderr)
        return 1

    name = args.name or claim.get("label")
    if not name:
        print("REFUSING: no --name and the claim capture has no label",
              file=sys.stderr)
        return 1

    rows, notes = [], []
    for family in FAMILIES:
        claim_file = triple((claim.get("decoding", {}).get(family) or {})
                            .get("file"))
        claim_ms = triple((claim.get("decoding", {}).get(family) or {})
                          .get("media-source"))
        over_file = triple((over.get("decoding", {}).get(family) or {})
                           .get("file"))
        if claim_file is None or over_file is None:
            notes.append(f"{family}: not measured on both sides, no row")
            continue
        if claim_ms is not None and claim_ms != claim_file:
            print(f"REFUSING: {family} answers differently for 'file' "
                  f"{claim_file} and 'media-source' {claim_ms} on the claimed "
                  "GPU. MediaTable stores one answer per family, so this claim "
                  "cannot be expressed and must not be written as though it "
                  "could.", file=sys.stderr)
            return 1
        if claim_file == over_file:
            notes.append(f"{family}: already agrees {claim_file}, no row")
            continue
        supported, smooth, power_efficient = claim_file
        if not supported and (smooth or power_efficient):
            print(f"REFUSING: {family} claims smooth/powerEfficient while "
                  "unsupported; that is not a triple any decoder reports.",
                  file=sys.stderr)
            return 1
        rows.append({"family": family, "supported": supported,
                     "smooth": smooth, "power_efficient": power_efficient})

    # 7.2: reported, never written. The loader has nowhere to put these.
    for key, (same, different) in NOTES_72.items():
        seen = {label: reading(capture, key)
                for label, capture in (("claim", claim), ("over", over))}
        absent = [label for label, value in seen.items() if value is None]
        if absent:
            notes.append(
                f"{key}: NOT MEASURED in the {' and '.join(absent)} capture -- "
                "the API is absent or the probe failed, and the reason is in "
                "errors[] there. Item 7.2 is UNEXAMINED for this surface, not "
                "cleared.")
        else:
            notes.append(same if seen["claim"] == seen["over"] else different)

    body = {
        "schema": SCHEMA,
        "name": name,
        "chrome_version": PIN,
        "claim": args.claim.name,
        "over": args.over.name,
        "claim_gl": claim_gl,
        "over_gl": over_gl,
        "decode": rows,
        "notes": notes,
    }
    body["digest"] = digest(body)

    args.out.mkdir(parents=True, exist_ok=True)
    out = args.out / (name + SUFFIX)
    out.write_text(json.dumps(body, indent=2, sort_keys=True,
                              ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{out}: {len(rows)} decode row(s) from {len(FAMILIES)} families")
    for note in notes:
        print(f"  - {note}")
    print("  SHIPS INERT: media-persona defaults false; turn it on per launch.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
