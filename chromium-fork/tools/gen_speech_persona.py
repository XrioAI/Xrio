#!/usr/bin/env python3
"""Emit an ordered speech persona from Chromium's network speech manifest.

    tools/gen_speech_persona.py stock-linux-speech \
        --reference personas/reference/surfaces-xorg.json

The optional surface capture is a shipping guard, not another data source. Its
web-visible voice list must match the manifest-derived list exactly or the
generator refuses before writing anything.
"""
import argparse
import hashlib
import json
import pathlib
import re
import sys


ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_MANIFEST = (
    ROOT / "src/chrome/browser/resources/network_speech_synthesis/manifest.json"
)
DEFAULT_IMPLEMENTATION = (
    ROOT / "src/chrome/browser/resources/network_speech_synthesis/tts_extension.js"
)
SCHEMA = "xrio-speech-table/v1"
SUFFIX = ".xrio-speech.json"
EVENT_TYPES = {"start", "end", "error"}


def canonical(body):
    return json.dumps(
        {key: value for key, value in body.items() if key != "digest"},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def digest(body):
    return "sha256:" + hashlib.sha256(canonical(body)).hexdigest()


def voices_from_manifest(manifest):
    try:
        source = manifest["tts_engine"]["voices"]
    except (KeyError, TypeError) as exc:
        raise ValueError("manifest has no tts_engine.voices list") from exc
    if not isinstance(source, list) or not source:
        raise ValueError("manifest tts_engine.voices must be a non-empty list")

    voices = []
    identities = set()
    for index, item in enumerate(source):
        if not isinstance(item, dict):
            raise ValueError(f"manifest voice {index} is not an object")
        try:
            name = item["voice_name"]
            lang = item["lang"]
            remote = item["remote"]
            event_types = item["event_types"]
        except KeyError as exc:
            raise ValueError(
                f"manifest voice {index} is missing {exc.args[0]}"
            ) from exc
        if not isinstance(name, str) or not name:
            raise ValueError(f"manifest voice {index} has an invalid voice_name")
        if not isinstance(lang, str) or not lang:
            raise ValueError(f"manifest voice {index} has an invalid lang")
        if remote is not True:
            raise ValueError(f"manifest voice {index} is not a remote voice")
        if name in identities:
            raise ValueError(f"manifest has duplicate voice identity: {name}")
        identities.add(name)
        if not isinstance(event_types, list) or any(
            not isinstance(event, str) or event not in EVENT_TYPES
            for event in event_types
        ):
            raise ValueError(
                f"manifest voice {index} event_types contains unsupported values"
            )
        if len(event_types) != len(set(event_types)):
            raise ValueError(f"manifest voice {index} has duplicate event_types")
        if set(event_types) != EVENT_TYPES:
            raise ValueError(
                f"manifest voice {index} must declare start, end, and error"
            )
        voices.append(
            {
                # Chromium 152 exposes VoiceData.name as both name and voiceURI.
                "voice_uri": name,
                "name": name,
                "lang": lang,
                "local_service": not remote,
                "is_default": index == 0,
                "event_types": event_types,
            }
        )
    return voices


def reference_voices(capture):
    if isinstance(capture, list):
        if not capture:
            raise ValueError("reference capture is empty")
        snapshots = [reference_voices(snapshot) for snapshot in capture]
        if any(snapshot != snapshots[0] for snapshot in snapshots[1:]):
            raise ValueError("reference snapshots differ from each other")
        return snapshots[0]
    if not isinstance(capture, dict):
        raise ValueError("reference capture is not an object or snapshot list")
    values = capture.get("voices")
    if not isinstance(values, list):
        raise ValueError("reference capture has no voices list")
    result = []
    for index, value in enumerate(values):
        if not isinstance(value, str):
            raise ValueError(f"reference voice {index} is not a string")
        parts = value.split("|")
        if len(parts) != 4 or parts[2] not in ("true", "false") or parts[3] not in (
            "true",
            "false",
        ):
            raise ValueError(f"reference voice {index} has an invalid capture shape")
        result.append(
            {
                "name": parts[0],
                "lang": parts[1],
                "local_service": parts[2] == "true",
                "is_default": parts[3] == "true",
            }
        )
    return result


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("name", help="speech persona name and artifact stem")
    parser.add_argument(
        "--manifest", type=pathlib.Path, default=DEFAULT_MANIFEST,
        help="network_speech_synthesis manifest (defaults to the pinned Chromium tree)",
    )
    parser.add_argument(
        "--reference", type=pathlib.Path,
        help="optional surface_probe capture that must match before writing",
    )
    parser.add_argument(
        "--reference-chrome-version",
        help="exact branded Chrome version that produced --reference",
    )
    parser.add_argument(
        "--implementation", type=pathlib.Path, default=DEFAULT_IMPLEMENTATION,
        help="network TTS implementation whose no-egress behavior was measured",
    )
    parser.add_argument(
        "--chrome-version",
        help="Chrome version; defaults to CHROMIUM_VERSION",
    )
    parser.add_argument(
        "--out", type=pathlib.Path, default=None,
        help="artifact directory; defaults to personas/",
    )
    args = parser.parse_args()

    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", args.name):
        sys.exit("REFUSING TO WRITE: persona name is not a safe file stem")

    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        implementation_digest = hashlib.sha256(
            args.implementation.read_bytes()
        ).hexdigest()
        voices = voices_from_manifest(manifest)
        if len(voices) != 19:
            raise ValueError(
                f"network speech manifest has {len(voices)} voices, expected exactly 19"
            )
        if args.reference:
            capture = json.loads(args.reference.read_text(encoding="utf-8"))
            measured = reference_voices(capture)
            visible = [
                {key: voice[key] for key in
                 ("name", "lang", "local_service", "is_default")}
                for voice in voices
            ]
            if measured != visible:
                raise ValueError(
                    "reference speech surface differs from the manifest-derived voices"
                )
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        sys.exit(f"REFUSING TO WRITE: {exc}")

    version = args.chrome_version or dict(line.split("=", 1) for line in (ROOT / "VERSIONS").read_text().split())["CHROMIUM_VERSION"]
    if not version:
        sys.exit("REFUSING TO WRITE: no Chrome version")
    if args.reference and not args.reference_chrome_version:
        sys.exit("REFUSING TO WRITE: --reference-chrome-version is required with --reference")
    if args.reference_chrome_version:
        if args.reference_chrome_version.split(".", 1)[0] != version.split(".", 1)[0]:
            sys.exit("REFUSING TO WRITE: reference and Chromium milestones differ")

    body = {
        "schema": SCHEMA,
        "name": args.name,
        "chrome_version": version,
        "manifest": args.manifest.name,
        "implementation": args.implementation.name,
        "implementation_sha256": "sha256:" + implementation_digest,
        "reference": args.reference.name if args.reference else "unverified",
        "reference_chrome_version": args.reference_chrome_version or "unverified",
        "voices": voices,
    }
    body["digest"] = digest(body)
    output = (args.out or ROOT / "personas") / (args.name + SUFFIX)
    output.write_text(
        json.dumps(body, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"{output}: {len(voices)} voices")
    print(f"  chrome {version}  {body['digest']}")


if __name__ == "__main__":
    main()
