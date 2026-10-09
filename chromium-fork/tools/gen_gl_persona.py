#!/usr/bin/env python3
"""Emit personas/<name>.xrio-gl.json from a measured persona pair.

The table is GENERATED, never hand-typed: it is a claim about what a real GPU
reports, and a transcription slip makes that claim false in a way no test would
catch. Regenerate after any re-capture:

    tools/gen_gl_persona.py personas/mybox-swiftshader.json \
                            personas/mybox-amd-renoir.json

This used to write chromium_src/base/xrio_gl_table.inc -- a block of constexpr
arrays compiled into base, with the selector as a single string constant. That
made a build carry exactly one persona and a second one cost a Chromium rebuild
and a 167 MB redeploy. The artifact below is the same computed delta, read by the
browser at startup instead of compiled into it.

Emits only the entries that actually DIFFER between the two. A persona that
restates values SwiftShader already gets right is larger, no more convincing,
and more to keep true across a Chrome pin bump.

It also WITHHOLDS four limits it could emit -- see WITHHELD below. A limit Blink
enforces from the real driver is refutable by the context's own behaviour, so
asserting it is worse than leaving it honest.

`chrome_version` is what makes the artifact refusable. A compiled table could not
outlive its Chrome -- it shipped inside the binary. A loose file survives a pin
bump and would go on claiming RENOIR numbers captured against a different ANGLE,
so the version travels with the table and both Python gates (xrio's
pre-launch check and tools/verify_probe.py) refuse a mismatch. The captures
themselves do not record which Chrome produced them, so it is taken from
CHROMIUM_VERSION -- the tree's pin, not proof about the capture -- and
--chrome-version overrides it for a capture taken elsewhere.

`--hide-only` is the SUPPORTED SHAPE OVER SWIFTSHADER, and it is a refusal
rather than a mode. The fork's policy is that a consumer-GPU persona may run
only on hardware that matches it; over SwiftShader the only artifact allowed is
one that claims exactly what SwiftShader already reports and removes
extensions. So `--hide-only` refuses to write unless source and claim carry
byte-equal vendor and renderer, no getParameter value differs at all (WITHHELD
and UNMAPPED included -- they are values the CLAIM got wrong, and the claim is
supposed to BE the source), `not_added` is empty, both precision blocks are
present and equal, the source names SwiftShader, and the computed hide list is
non-empty. There is deliberately no flag for the hide list itself: it stays
`source - claim`, because a hand-authored one is a claim nothing measured.

The classification is DERIVED, never declared. There is no `kind` field in the
artifact: `gl_backend_probe.artifact_kind()` reads the file the browser reads
and decides, and this generator refuses to write if its own rules and that
classifier ever disagree. xrio spells the same two kinds in
`xrio.browser.gl_table.GlArtifactKind` and derives them by the same rule.

It also GUARDS the `precision` block (getShaderPrecisionFormat). That surface has
no hook and no table today, on the measured finding that ANGLE reports it
byte-identically on both backends (README "getShaderPrecisionFormat is
byte-identical"). This script emits nothing for it -- it only checks the
assumption still holds, and REFUSES TO WRITE if a future capture breaks it. The
old script wrote the .inc anyway and exited 1, which was safe only because a
written .inc still needed a human to compile it. A written artifact is a
shippable artifact, so writing on failure would make the guard advisory.
"""
import argparse, hashlib, json, pathlib, sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
# ONE definition of what a hide-only artifact is, per repo. gl_backend_probe.py
# is where the fork's GL verdicts live and it already had the software-marker
# vocabulary; deriving the kind here from a second copy would let a generator
# write a file the probe then refuses, which is the failure both of them exist
# to make impossible.
SWIFTSHADER_MARKER = "swiftshader"
NUMERIC_FIELDS = ("ints", "floats", "float_arrays", "int_arrays")
HIDE_ONLY = "swiftshader_hide_only"
HARDWARE_PERSONA = "hardware_persona"


def names_swiftshader(renderer):
    return SWIFTSHADER_MARKER in (renderer or "").replace(" ", "").lower()


def artifact_kind(body):
    if not isinstance(body, dict) or not names_swiftshader(body.get("renderer") or ""):
        return HARDWARE_PERSONA
    if any(body.get(field) != [] for field in NUMERIC_FIELDS):
        return HARDWARE_PERSONA
    if body.get("not_added") != []:
        return HARDWARE_PERSONA
    hidden = body.get("hidden_extensions")
    if not isinstance(hidden, list) or not hidden:
        return HARDWARE_PERSONA
    return HIDE_ONLY

ROOT = pathlib.Path(__file__).resolve().parent.parent

SCHEMA = "xrio-gl-table/v2"
SUFFIX = ".xrio-gl.json"

# Stable GL ABI constants, and the getParameter helper each one reaches.
ENUMS = {
    "ALIASED_LINE_WIDTH_RANGE": (0x846E, "floatarray"),
    "ALIASED_POINT_SIZE_RANGE": (0x846D, "floatarray"),
    "MAX_COLOR_ATTACHMENTS":    (0x8CDF, "int"),
    "MAX_DRAW_BUFFERS":         (0x8824, "int"),
    "MAX_RENDERBUFFER_SIZE":    (0x84E8, "int"),
    "MAX_SAMPLES":              (0x8D57, "int"),
    "MAX_TEXTURE_LOD_BIAS":     (0x84FD, "float"),
    "MAX_TEXTURE_SIZE":         (0x0D33, "int"),
    "MAX_VARYING_VECTORS":      (0x8DFC, "int"),
    "MAX_VERTEX_UNIFORM_BLOCKS":(0x8A2B, "int"),
    "MAX_VIEWPORT_DIMS":        (0x0D3A, "intarray"),
    "SUBPIXEL_BITS":            (0x0D50, "int"),
    # ---- ADDED 2026-09-08, after the capture list was found to be 12 short ----
    # All nine route through GetIntParameter / GetFloatParameter, which the patch
    # series already hooks, so covering them is an artifact refresh and v2 absorbs
    # it unchanged. Whether each may be EMITTED is a separate question from whether
    # it can be: see WITHHELD.
    "MAX_VARYING_COMPONENTS":       (0x8B4B, "int"),
    "MAX_VERTEX_OUTPUT_COMPONENTS": (0x9122, "int"),
    "MAX_FRAGMENT_UNIFORM_BLOCKS":  (0x8A2D, "int"),
    "MAX_PROGRAM_TEXEL_OFFSET":     (0x8905, "int"),
    "MIN_PROGRAM_TEXEL_OFFSET":     (0x8904, "int"),
    "UNIFORM_BUFFER_OFFSET_ALIGNMENT": (0x8A34, "int"),
    "FRAGMENT_INTERPOLATION_OFFSET_BITS_OES": (0x8E5D, "int"),
    "MAX_FRAGMENT_INTERPOLATION_OFFSET_OES":  (0x8E5C, "float"),
    "MIN_FRAGMENT_INTERPOLATION_OFFSET_OES":  (0x8E5B, "float"),
}

# Enforceable limits. Mapped above, measured as differing, and DELIBERATELY NOT
# EMITTED.
#
# Blink validates draw calls against the limits it cached from the REAL driver
# at context creation, while OverrideGlInt rewrites only the JS-facing
# getParameter. Emit MAX_TEXTURE_SIZE and a page gets a context that advertises
# 16384 and then refuses a 16384x1 texImage2D with INVALID_VALUE. Measured
# 2026-09-08 on all four arms, with MAX_RENDERBUFFER_SIZE (renderbufferStorage)
# and MAX_SAMPLES (renderbufferStorageMultisample) doing exactly the same:
# fork/gl-persona-capability-coverage.md section 6. Both honest arms agree with
# themselves; only the spoofed one disagrees with itself.
#
# That is fork/readback-perturbation.md's argument again. A known-wrong value
# needs a GPU database to catch; an impossible one needs two lines of JavaScript
# and no reference machine. Withholding trades four honest SwiftShader limits
# under a RENOIR string -- the database-only kind -- for removing three
# self-contradictions. The strictly weaker tell wins.
#
# UNCONDITIONAL, not "when over SwiftShader". Where the real limit differs from
# the claim the contradiction appears whichever direction it differs in, and
# where it matches -- RENOIR on RENOIR, where the persona is a measured no-op --
# emitting buys nothing. So there is no backend to detect here and no second
# artifact to build.
#
# MAX_VIEWPORT_DIMS is here for coherence rather than for a measured refusal:
# viewport() clamps instead of erroring, but leaving it at 16384 beside an
# honest 8192 MAX_TEXTURE_SIZE and MAX_RENDERBUFFER_SIZE would be a new
# mismatch inside one family.
#
# THE CRITERION is "does anything other than getParameter enforce this value" --
# not "is it named like a limit", and after the recapture it is close to the same
# thing: eight of the eleven mapped divergences turned out to be enforced.
#
# What survives is the ADVISORY class -- values nothing checks:
#   SUBPIXEL_BITS                            a precision report; nothing to exceed
#   MAX_TEXTURE_LOD_BIAS                     clamped
#   ALIASED_LINE_WIDTH_RANGE                 clamped: lineWidth(4) against a real
#   ALIASED_POINT_SIZE_RANGE                 [1,1] silently draws 1px
#   FRAGMENT_INTERPOLATION_OFFSET_BITS_OES   a precision report, like SUBPIXEL_BITS
#   MAX_FRAGMENT_INTERPOLATION_OFFSET_OES    interpolateAtOffset offsets are runtime
#   MIN_FRAGMENT_INTERPOLATION_OFFSET_OES    values; out of range is UNDEFINED, not
#                                            an error
#
# The clamped four are a DECLARED RESIDUAL, not a claim of purity: catching them
# needs a pixel measurement rather than getError, which is weaker but not nothing.
# The three OES rows are classed by SPEC READING rather than by measurement -- the
# behavioural probe covered the six that error, and "undefined results" has no
# getError to check. Labelled so, because six assumptions of exactly this kind were
# wrong on 2026-09-08. See fork/gl-persona-capability-coverage.md.
#
# Kept in ENUMS so the ABI record stays complete and reversing this is a one-line
# change; the subset check below makes a typo here a load-time failure rather than a
# silently-emitted limit. Raised rather than asserted, because `python -O` strips
# asserts and would take the guard with them.
WITHHELD = {
    "MAX_RENDERBUFFER_SIZE",
    "MAX_SAMPLES",
    "MAX_TEXTURE_SIZE",
    "MAX_VIEWPORT_DIMS",
    # ADDED after review pointed out the rule above was not being applied to its own
    # artifact. Both of these are enforced at SHADER LINK time from the real driver's
    # cached limits, which makes them the same class as MAX_TEXTURE_SIZE and refutable
    # without a reference machine:
    #
    #   MAX_VERTEX_UNIFORM_BLOCKS  claimed 16, real 14 -- a vertex shader declaring 15
    #                              uniform blocks is inside the advertised limit and the
    #                              driver refuses to link it.
    #   MAX_VARYING_VECTORS        claimed 30, real 31 -- inverted, and just as loud: a
    #                              31-varying program links while the context advertises
    #                              30 as the maximum.
    #
    # The second one is why this set cannot be "only limits we inflate": the comment
    # below already says the contradiction appears whichever direction the value
    # differs in, and MAX_VARYING_VECTORS is the case that proves it. Both were filed in
    # fork/gl-persona-capability-coverage.md as "query-only" cross-checks against honest
    # siblings, which understated them -- a link failure is behaviour, not a query.
    "MAX_VARYING_VECTORS",
    "MAX_VERTEX_UNIFORM_BLOCKS",
    # ---- and the six the 2026-09-08 recapture added, all MEASURED enforced ----
    # The recapture was meant to close coverage by emitting these nine and their
    # honest siblings, on the theory that a spoofed limit beside a spoofed sibling is
    # coherent. It is not: the sibling fixes the QUERY PAIR and the BEHAVIOUR still
    # refutes it. Measured on mybox with a throwaway artifact spoofing all of
    # them over SwiftShader, against the honest arm as control -- 6 of 6 refuted,
    # using nothing but the context under test:
    #
    #   MAX_FRAGMENT_UNIFORM_BLOCKS      claim 16 / real 14 -- a 15-block fragment
    #                                    shader FAILS AT LINK
    #   MAX_PROGRAM_TEXEL_OFFSET         claim 31 / real 7  -- textureOffset(+20)
    #                                    FAILS AT COMPILE, the translator checks it
    #   MIN_PROGRAM_TEXEL_OFFSET         claim -32 / real -8 -- same, at -20
    #   UNIFORM_BUFFER_OFFSET_ALIGNMENT  claim 4 / real 256 -- bindBufferRange at
    #                                    offset 4 returns INVALID_VALUE
    #   MAX_VARYING_COMPONENTS           claim 120 / real 124 -- INVERTED: a
    #                                    124-component program links even though the
    #                                    claim forbids it
    #   MAX_VERTEX_OUTPUT_COMPONENTS     claim 124 / real 128 -- same shape
    #
    # The honest arm agreed with itself on every one of those. So the general rule is
    # not "some limits are enforced": a getParameter hook cannot spoof a LIMIT at
    # all, because a limit is by definition something the implementation enforces
    # elsewhere. What this mechanism can do is (a) values nothing enforces and (b)
    # HIDE extensions -- which works precisely because ExtensionSupportedAndAllowed
    # changes behaviour too, not just the answer.
    "MAX_FRAGMENT_UNIFORM_BLOCKS",
    "MAX_PROGRAM_TEXEL_OFFSET",
    "MAX_VARYING_COMPONENTS",
    "MAX_VERTEX_OUTPUT_COMPONENTS",
    "MIN_PROGRAM_TEXEL_OFFSET",
    "UNIFORM_BUFFER_OFFSET_ALIGNMENT",
}
if not WITHHELD <= set(ENUMS):
    raise AssertionError(
        "WITHHELD names parameters the generator has no enum for, so they would be "
        f"emitted as UNMAPPED instead of withheld: {sorted(WITHHELD - set(ENUMS))}"
    )


def canonical(body):
    """The bytes the digest is taken over: compact JSON, keys sorted, no digest.

    Pinned here because a SECOND implementation has to agree with it byte for
    byte -- xrio re-derives the digest before every render
    (``xrio.browser.gl_table.canonical_digest``). Both sides carry the same
    known-answer vector in their tests so a drift in either is a test failure
    rather than a render that refuses for no visible reason:

        {"schema": "xrio-gl-table/v2", "name": "t"}
        -> sha256:8a703b7c72bbf5be9b98f0b25c1f9c1f5d8d520f9c5e03e83d46908b2bda05de

    in ``tools/gen_gl_persona_test.py`` here and ``tests/unit/test_gl_table.py``
    there. It moved with the v1 -> v2 bump because the schema is part of the
    body being hashed, and for a while only xrio carried it -- this module
    ended with a bare ``main()``, so importing it to reach ``digest()`` ran the
    argument parser and exited.

    Deliberately not verified by the browser. Re-canonicalising parsed JSON in
    C++ means matching Python's float repr from base::Value doubles, which is a
    source of FALSE refusals; the fork's safety comes from failing closed on
    structure, and the digest's job is traceability in the envelope.
    """
    return json.dumps({k: v for k, v in body.items() if k != "digest"},
                      sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


def digest(body):
    return "sha256:" + hashlib.sha256(canonical(body)).hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("over", type=pathlib.Path, help="capture we produce (SwiftShader)")
    ap.add_argument("claim", type=pathlib.Path, help="capture we claim (the real GPU)")
    # v2. NOT derivable from either capture: a GL capture reports what the
    # driver says, and neither the chassis nor the CPU that GPU shipped beside
    # is in it. They are a judgement about the device id, so they are typed in
    # by whoever reads the PCI ID list, and the artifact records the reading.
    ap.add_argument("--form-factor", choices=("laptop", "desktop"),
                    required=True,
                    help="chassis the claimed GPU shipped in. A laptop persona "
                         "reporting upstream's batteryless desktop tuple is a "
                         "contradiction one layer down.")
    ap.add_argument("--max-threads", type=int, required=True,
                    help="most threads a CPU paired with this GPU ever had. "
                         "Caps the machine-class draw, so a row above it can "
                         "never be drawn under this persona.")
    ap.add_argument("--chrome-version", default=None,
                    help="Chrome the pair was captured on; defaults to CHROMIUM_VERSION")
    ap.add_argument("--hide-only", action="store_true",
                    help="refuse to write anything but a TRUTHFUL SwiftShader "
                         "artifact: same vendor, same renderer, no numeric "
                         "override, nothing in not_added. The only artifact "
                         "kind the supported policy allows over SwiftShader. "
                         "There is deliberately no flag for the hide list -- "
                         "it stays computed as source minus claim, because a "
                         "hand-authored one is a claim nothing measured.")
    ap.add_argument("--out", type=pathlib.Path, default=None,
                    help="directory for the artifact; defaults to the claim's own directory")
    args = ap.parse_args()

    src = json.loads(args.over.read_text())    # what we produce
    tgt = json.loads(args.claim.read_text())   # what we claim
    ps, pt = src["params"], tgt["params"]

    version = args.chrome_version or dict(line.split("=", 1) for line in (ROOT / "VERSIONS").read_text().split())["CHROMIUM_VERSION"]
    if not version:
        sys.exit("no Chrome version: CHROMIUM_VERSION is empty and --chrome-version unset")

    ints, floats, farrays, iarrays, unmapped, withheld = [], [], [], [], [], []
    for name, value in sorted(pt.items()):
        if ps.get(name) == value:
            continue
        if name in WITHHELD:
            withheld.append(name)
            continue
        if name not in ENUMS:
            unmapped.append(name)
            continue
        enum, kind = ENUMS[name]
        if kind == "int":
            ints.append((enum, int(value)))
        elif kind == "float":
            floats.append((enum, float(value)))
        elif kind == "floatarray":
            farrays.append((enum, [float(v) for v in value]))
        elif kind == "intarray":
            iarrays.append((enum, [int(v) for v in value]))

    hide = sorted(set(src["extensions"]) - set(tgt["extensions"]))
    absent = sorted(set(tgt["extensions"]) - set(src["extensions"]))

    # getShaderPrecisionFormat guard. NOT emitted into the table: there is no
    # hook for it, because the two backends measured identical. Compare here so
    # that stays true -- a divergence is a strings-say-AMD/precision-says-
    # SwiftShader tell, and unlike params it would ship silently.
    prec_src, prec_tgt = src.get("precision"), tgt.get("precision")
    prec_missing = [p.name for p, block in ((args.over, prec_src), (args.claim, prec_tgt))
                    if block is None]
    prec_diff = []
    if prec_src is not None and prec_tgt is not None:
        for key in sorted(set(prec_src) | set(prec_tgt)):
            if prec_src.get(key) != prec_tgt.get(key):
                prec_diff.append((key, prec_src.get(key), prec_tgt.get(key)))

    # Refuse BEFORE writing. The .inc this replaced was written on failure
    # because compiling it still took a human; an artifact is shippable the
    # moment it exists, so a write here would make the guard advisory.
    if prec_diff:
        print("\n".join([
            "=" * 72,
            "REFUSING TO WRITE: getShaderPrecisionFormat DIFFERS between backends.",
            "It has no hook and no table today, on the measured assumption that ANGLE",
            "reports it identically on both backends. That assumption just broke:",
            "",
            *[f"    {k}: over={s} claim={t}" for k, s, t in prec_diff],
            "",
            "The claimed renderer string would sit over honest precision ranges -- the",
            "strings-say-AMD/capabilities-say-SwiftShader tell the GL table exists to",
            "prevent. Add a getShaderPrecisionFormat hook + table before shipping this",
            "persona (a Chromium change, i.e. a recompile). NOTHING was written.",
            "=" * 72,
        ]), file=sys.stderr)
        sys.exit(1)

    if args.max_threads < 1:
        print("--max-threads must be at least 1", file=sys.stderr)
        sys.exit(1)

    if args.hide_only:
        # EVERY rule, then one refusal. Reporting the first broken rule would
        # make fixing a capture a game of whack-a-mole against a generator that
        # only ever names one problem at a time.
        reasons = []
        if not names_swiftshader(src["renderer"]):
            reasons.append(
                f"the SOURCE capture's renderer is {src['renderer']!r}, which "
                "does not identify itself as SwiftShader. --hide-only writes "
                "an artifact that claims to be the backend it runs over; over "
                "anything else it would be claiming a rasterizer this build "
                "does not ship.")
        if src["vendor"] != tgt["vendor"]:
            reasons.append(
                f"vendor differs: source {src['vendor']!r}, claim "
                f"{tgt['vendor']!r}. A hide-only artifact says nothing the "
                "backend does not already say.")
        if src["renderer"] != tgt["renderer"]:
            reasons.append(
                f"renderer differs: source {src['renderer']!r}, claim "
                f"{tgt['renderer']!r}. Same rule as the vendor, and this is "
                "the string every page reads.")
        differing = sorted(n for n in set(ps) | set(pt) if ps.get(n) != pt.get(n))
        if differing:
            reasons.append(
                "these getParameter values differ between the captures, so "
                "the artifact would not be hide-only: " + ", ".join(differing)
                + ". WITHHELD and UNMAPPED do not rescue this -- a value the "
                "artifact leaves alone is still a value the claim got wrong, "
                "and the claim is supposed to BE the source.")
        if absent:
            reasons.append(
                "not_added would be non-empty: " + ", ".join(absent)
                + ". The claim has extensions the source does not, which means "
                "it is not this machine minus a hide list.")
        if prec_missing:
            reasons.append(
                "no 'precision' block in " + ", ".join(prec_missing)
                + ", so getShaderPrecisionFormat equality could not be "
                "ESTABLISHED. Elsewhere that is a warning; here the equality "
                "is one of the claims being made, and an unverified claim is "
                "not a weaker claim, it is an unsupported one. Re-capture.")
        if not hide:
            reasons.append(
                "the hide list is empty, so this artifact would change "
                "nothing at all. It would still be recorded as an applied "
                "persona and qualify as honest_software_hide_only -- a "
                "verdict that differs from honest_software only by naming a "
                "file that did nothing. Remove the extensions you mean to "
                "hide from the CLAIM capture.")
        if reasons:
            print("\n".join([
                "=" * 72,
                "REFUSING TO WRITE: --hide-only was asked for and this pair is "
                "not hide-only.",
                "A hide-only artifact is the ONLY kind the supported policy "
                "allows over SwiftShader.",
                "It must claim exactly what the",
                "backend already reports and remove extensions, nothing else:",
                "",
                *[f"  * {reason}" for reason in reasons],
                "",
                "NOTHING was written. Drop --hide-only to generate an ordinary "
                "hardware persona,",
                "which is refused over SwiftShader and qualified only on "
                "hardware that matches it.",
                "=" * 72,
            ]), file=sys.stderr)
            sys.exit(1)

    name = args.claim.stem
    body = {
        "schema": SCHEMA,
        "name": name,
        # Provenance, for a reader of the file rather than for the loader.
        "claim": args.claim.name,
        "over": args.over.name,
        "chrome_version": version,
        "vendor": tgt["vendor"],
        "renderer": tgt["renderer"],
        "form_factor": args.form_factor,
        "max_threads": args.max_threads,
        "ints": [[e, v] for e, v in ints],
        "floats": [[e, v] for e, v in floats],
        "float_arrays": [[e, v] for e, v in farrays],
        "int_arrays": [[e, v] for e, v in iarrays],
        "hidden_extensions": hide,
        # Recorded and IGNORED by the loader: the known residual, kept where a
        # reader will find it rather than a list to start honouring. Announcing
        # an extension whose getExtension() returns nothing is a worse tell than
        # a list three entries short.
        "not_added": absent,
    }
    body["digest"] = digest(body)

    kind = artifact_kind(body)
    if args.hide_only and kind != HIDE_ONLY:
        # The rules above are stated in terms of the CAPTURES; this asks the
        # classifier every consumer actually uses about the FILE. They should
        # never disagree, and if they ever do it is this generator that is
        # wrong -- so it refuses rather than shipping an artifact the probe and
        # xrio would both go on to reject.
        print(f"REFUSING TO WRITE: the artifact this pair produces classifies "
              f"as {kind!r}, not {HIDE_ONLY!r}, even though every --hide-only "
              "rule passed. gen_gl_persona.py and gl_backend_probe.py's "
              "artifact_kind() disagree; fix the generator.", file=sys.stderr)
        sys.exit(1)

    out_dir = args.out or args.claim.parent
    out = out_dir / (name + SUFFIX)
    out.write_text(json.dumps(body, indent=2, sort_keys=True, ensure_ascii=False) + "\n")

    print(f"{out}: {len(ints)} int, {len(floats)} float, {len(farrays)} float[], "
          f"{len(iarrays)} int[], {len(hide)} hidden, {len(absent)} not-added"
          + (f", {len(withheld)} withheld" if withheld else "")
          + (f", {len(unmapped)} UNMAPPED" if unmapped else ""))
    print(f"  chrome {version}  {body['digest']}")
    print(f"  kind: {kind}"
          + ("" if kind == HIDE_ONLY else
             "  -- REFUSED over SwiftShader; only qualifies on hardware whose "
             "renderer matches this artifact exactly"))
    if withheld:
        # Printed on every run, not only when it changes: an operator reading
        # this output has to see that the artifact is short on purpose, or the
        # next person to diff it against a capture will "fix" it.
        print("  WITHHELD (differ, mapped, and left honest because Blink enforces "
              "the driver's own limit): " + ", ".join(sorted(withheld)))
    if unmapped:
        print("  UNMAPPED (differ but no enum in the generator): "
              + ", ".join(unmapped), file=sys.stderr)
    if prec_missing:
        print("WARNING: no 'precision' block in " + ", ".join(prec_missing)
              + " -- cannot verify getShaderPrecisionFormat; re-capture to cover it.",
              file=sys.stderr)
    else:
        print(f"  getShaderPrecisionFormat: {len(prec_tgt)} entries, delta empty -- "
              "coherent, no hook needed (as documented).")


if __name__ == "__main__":
    main()
