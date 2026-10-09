#!/usr/bin/env python3
"""One authority for launch MODE and display GEOMETRY, shared by every probe.

WHY THIS EXISTS -- two defects, one cause.

1. `BASE_FLAGS` was copy-pasted verbatim into verify_probe.py, config_probe.py
   and geometry_probe.py. Three copies means a fix lands in one and not the
   others, which is how the second defect survived in all three.

2. All three passed `--window-size=1600,900` with no `--screen-info`. In
   headless mode Chromium then defaults the screen to 800x600
   (chrome/browser/headless/headless_mode_init.cc:100-104), so the browser
   reported a 1600x900 window inside an 800x600 screen. No real display
   produces a window larger than its screen. Every headless probe run to date
   carried that, and no assertion could see it because no arm differed.

THE TWO MODES ARE NOT EQUALLY EXPRESSIVE, which is why SCREEN is restricted.
`--screen-info` can express DPR, rotation, work-area insets and internal-display
state; plain `xvfb-run --server-args` expresses only dimensions, depth and DPI.
Worse, the units differ: --screen-info dimensions are PHYSICAL pixels and
devicePixelRatio divides them into the CSS dimensions a page reads --
`{1600x1200 devicePixelRatio=2}` yields `width:800 height:600 devicePixelRatio:2`
(components/headless/screen_info/README.md) -- whereas an Xvfb `-screen` size is
what the page reads directly at DPR 1.

So SCREEN stays inside the intersection the two encodings reproduce IDENTICALLY:

    devicePixelRatio 1      physical pixels and DIPs coincide
    rotation 0
    isInternal 0            external display
    work-area insets 0      matches Xvfb, which has no panel -- personas/README.md
                            records availHeight == height for exactly this reason

A HiDPI, rotated or panel-inset persona needs XRandR and window-manager
configuration on the HEADED side before it can be compared at all. Do not widen
SCREEN before that exists: a tuple the headed arm cannot reproduce turns the
parity gate into a comparison of two different displays.

The values themselves are the ones already on record for the reference host --
personas/mybox-surfaces.json reads screen 1920x1080 / colorDepth 24 with a
1600x900 outer window, and Makefile:132 runs Xvfb at `1920x1080x24 -dpi 96`.
"""
from __future__ import annotations
import os
import shutil
import subprocess
import sys

# Physical pixels. At devicePixelRatio 1 these are also the CSS pixels a page
# reads, which is the whole point of pinning DPR to 1 (see the module docstring).
SCREEN_WIDTH = 1920
SCREEN_HEIGHT = 1080
SCREEN_COLOR_DEPTH = 24
SCREEN_DPI = 96

# Outer window bounds. Must fit inside the screen in BOTH modes; see defect 2.
WINDOW_WIDTH = 1600
WINDOW_HEIGHT = 900
WINDOW_X = 0
WINDOW_Y = 0


def screen_info() -> str:
    """The `--screen-info` value. Headless only -- ozone/X11 never reads it.

    Every field is written explicitly, including the ones whose default already
    matches. Two reasons: `isInternal`'s documented default disagrees with its
    code default (components/headless/screen_info/README.md says true,
    headless_screen_info.h:19-25 says false), and a malformed or surprising
    tuple is a CHECK crash in ozone rather than a warning
    (ui/ozone/platform/headless/headless_screen.cc:89), so there is no value in
    leaving any of it implicit.
    """
    return ("{0,0 %dx%d colorDepth=%d devicePixelRatio=1 isInternal=0 rotation=0 "
            "workAreaLeft=0 workAreaRight=0 workAreaTop=0 workAreaBottom=0}"
            % (SCREEN_WIDTH, SCREEN_HEIGHT, SCREEN_COLOR_DEPTH))


def xvfb_server_args() -> str:
    """The same geometry, in the encoding Xvfb takes. For the headed arm."""
    return (f"-screen 0 {SCREEN_WIDTH}x{SCREEN_HEIGHT}x{SCREEN_COLOR_DEPTH} "
            f"-dpi {SCREEN_DPI} -noreset")


def check_headed_display() -> str:
    """Refuse a headed launch whose display does not match SCREEN.

    A headed arm on a differently-sized display is not a control for the
    headless arm -- it is a second variable. `xdpyinfo` answers this in one
    call; when it is absent the mismatch cannot be ruled out, so say so rather
    than implying the geometry was verified.
    """
    display = os.environ.get("DISPLAY")
    if not display:
        sys.exit("--headed needs a DISPLAY; run under `xvfb-run -a` with\n"
                 f'  --server-args="{xvfb_server_args()}"\n'
                 "or point at a live server of that geometry")
    if not shutil.which("xdpyinfo"):
        print(f"WARNING: xdpyinfo not installed, so {display}'s geometry is "
              f"UNVERIFIED against the declared "
              f"{SCREEN_WIDTH}x{SCREEN_HEIGHT}x{SCREEN_COLOR_DEPTH}", flush=True)
        return display
    out = subprocess.run(["xdpyinfo", "-display", display],
                         capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"xdpyinfo cannot read {display}: {out.stderr.strip()[:200]}")
    dims = [ln.split()[1] for ln in out.stdout.splitlines()
            if ln.strip().startswith("dimensions:")]
    want = f"{SCREEN_WIDTH}x{SCREEN_HEIGHT}"
    if not dims:
        sys.exit(f"xdpyinfo reported no dimensions for {display}")
    if dims[0] != want:
        sys.exit(f"{display} is {dims[0]}, not the declared {want}.\n"
                 "  A headed arm on a different display is not a control for "
                 "the headless arm.\n"
                 f'  Relaunch with --server-args="{xvfb_server_args()}"')
    return display


def mode_flags(headless: bool) -> list[str]:
    """Mode plus geometry: the pair that must never be set independently.

    Headless carries the tuple on the command line. Headed gets it from the X
    server, which is why the headed branch verifies rather than declares.
    """
    if headless:
        return [
            "--headless=new",
            f"--screen-info={screen_info()}",
            f"--window-size={WINDOW_WIDTH},{WINDOW_HEIGHT}",
            f"--window-position={WINDOW_X},{WINDOW_Y}",
        ]
    check_headed_display()
    return [
        f"--window-size={WINDOW_WIDTH},{WINDOW_HEIGHT}",
        f"--window-position={WINDOW_X},{WINDOW_Y}",
    ]


# Blink's paint-holding feature, and the one behaviour `--headless` changes that
# needs no patch at all.
#
# content/public/common/content_switch_dependent_feature_overrides.cc:102
# disables blink::features::kPaintHolding whenever --headless is present -- the
# ONLY --headless entry in that file -- while the feature is
# FEATURE_ENABLED_BY_DEFAULT (third_party/blink/common/features.cc:2000). So
# headless silently gets different first-commit and paint-timing behaviour from
# headed.
#
# An explicit --enable-features wins over that. Upstream says so in a comment at
# components/variations/service/variations_field_trial_creator.cc:295-304 --
# command-line features are registered BEFORE the switch-dependent overrides
# "because the explicit cmdline --disable-features and --enable-features should
# take precedence" -- and FeatureList::RegisterOverride ends in try_emplace, so
# only the first registration for a name takes effect
# (base/feature_list.cc:1260-1264). The browser's resolved state then reaches
# children ahead of their own switch-dependent pass
# (content/child/field_trial.cc:38-50).
#
# The name string is "PaintHolding" with no k: the two-argument BASE_FEATURE
# derives it from the variable by dropping the first character
# (base/feature_internal.h:22-31, `storage[i] = feature[i + 1]`).
#
# It is passed in BOTH modes on purpose. Headed it is a no-op, since the feature
# is already on -- so it is not an asymmetry between arms, and it means the
# probes measure the configuration that will actually ship rather than one
# paint-holding behaviour in the gate and another in production.
PAINT_HOLDING = "PaintHolding"

# THE SOFTWARE GL BACKEND, on its own because two callers need exactly this
# pair and nothing else in COMMON_FLAGS. SwiftShader is not incidental and must
# not be "improved" to hardware: on the hardware backend the reference host's
# real AMD iGPU already reports the values the persona table claims, so every
# persona arm would pass whether the persona applied or not.
#
# The second caller is walk_assignment.py, which cannot take COMMON_FLAGS
# wholesale -- its launch flags are the parity contract and adding
# --no-first-run et al to them would change what every number on record was
# measured under. Named here so the two encodings of "software GL" cannot
# drift apart, the same reason screen_info() and xvfb_args() live in this file.
GL_FLAGS = ["--use-gl=angle", "--use-angle=swiftshader"]

# Everything except mode and geometry.
COMMON_FLAGS = [
    *GL_FLAGS,
    "--no-first-run", "--no-default-browser-check",
    "--disable-component-update", "--disable-background-networking",
    "--lang=en-US",
    f"--enable-features={PAINT_HOLDING}",
]


def assert_no_feature_conflict(extra: list[str]) -> None:
    """Refuse a launch whose extra switches would defeat --enable-features.

    Two distinct hazards, and both fail SILENTLY, which is why this refuses
    rather than warning.

    `--disable-features=PaintHolding` WINS. base/feature_list.cc:485-489
    processes disabled features first "so that disabled ones take precedence
    over enabled ones (since RegisterOverride() uses emplace())". So the
    enable above becomes a no-op and nothing says so.

    A second `--enable-features=...` CLOBBERS ours. base::CommandLine keeps
    switches in a map, so the later value replaces the earlier one rather than
    merging -- paint holding then quietly reverts to the headless default.
    Merge into one value at the call site instead.
    """
    for flag in extra:
        if flag.startswith("--disable-features="):
            named = flag.split("=", 1)[1].split(",")
            if PAINT_HOLDING in (n.strip() for n in named):
                sys.exit(
                    f"refusing to launch: {flag} disables {PAINT_HOLDING}, and "
                    "a disable BEATS an enable (base/feature_list.cc:485-489), "
                    "so headless would silently keep upstream's paint-holding "
                    "override. Drop it, or say why in writing first.")
        if flag.startswith("--enable-features="):
            sys.exit(
                f"refusing to launch: {flag} would REPLACE this probe's own "
                f"--enable-features={PAINT_HOLDING} rather than merge with it "
                "(base::CommandLine stores switches in a map). Pass one merged "
                f"--enable-features value that includes {PAINT_HOLDING}.")


# The same set with the GL pair removed, for the one probe whose own axis IS
# the backend (invariant_probe.py varies --use-angle between runs and must not
# be handed a fixed one).
COMMON_LESS_GL = [f for f in COMMON_FLAGS
                  if not f.startswith(("--use-gl", "--use-angle"))]


def base_flags(headless: bool = True) -> list[str]:
    return COMMON_FLAGS + mode_flags(headless)


def describe(headless: bool) -> str:
    """One line naming the mode, for a probe's header.

    invariant_probe.py already prints this and it is the reason a headless
    hardware run stopped being read as a backend verdict (fork/TODO_LIST.md
    section 8.17). Every probe should say which mode produced its numbers.
    """
    if headless:
        return (f"headless  screen {SCREEN_WIDTH}x{SCREEN_HEIGHT}"
                f"x{SCREEN_COLOR_DEPTH} dpr 1  window "
                f"{WINDOW_WIDTH}x{WINDOW_HEIGHT}")
    return (f"headed (DISPLAY={os.environ.get('DISPLAY')})  screen "
            f"{SCREEN_WIDTH}x{SCREEN_HEIGHT}x{SCREEN_COLOR_DEPTH}  window "
            f"{WINDOW_WIDTH}x{WINDOW_HEIGHT}")


def pop_mode_flag(argv: list[str], default_headless: bool = True) -> bool:
    """Consume `--headed` / `--headless` from a plain argv. Returns `headless`.

    For the probes that read sys.argv positionally instead of using argparse.
    Removes the flag in place so the caller's positional indices are unchanged.

    `default_headless` exists so adding a mode axis cannot silently flip an
    existing caller's behaviour: the CDP probes have always run headless, the
    double-agent walker has always run headed, and each keeps what it had until
    told otherwise.

    LAST FLAG IN ARGV WINS, which is the only resolution that matches how a
    shell user thinks. The first version of this looped over the two spellings
    and let loop order decide, so `--headless --headed` resolved to HEADLESS --
    the opposite of what was typed, with nothing said about it.
    """
    headless = default_headless
    kept = []
    for arg in argv:
        if arg == "--headed":
            headless = False
        elif arg == "--headless" or arg == "--headless=new":
            headless = True
        elif arg.startswith("--headless="):
            # Not silently ignored, which is what the old matcher did: it
            # compared against the bare spellings only, so `--headless=old`
            # survived into the caller's positionals and became the PERSONA
            # NAME in verify_probe.py -- failing later with an artifact error
            # that says nothing about the mode.
            sys.exit(f"{arg}: the mode is selectable, its value is not. These "
                     "probes always launch --headless=new; pass --headless or "
                     "--headed.")
        else:
            kept.append(arg)
    argv[:] = kept
    return headless


if __name__ == "__main__":
    # So a launcher in any language can ask for the canonical strings.
    what = sys.argv[1] if len(sys.argv) > 1 else "help"
    if what == "screen-info":
        print(screen_info())
    elif what == "xvfb-args":
        print(xvfb_server_args())
    elif what == "headless-flags":
        print(" ".join(base_flags(True)))
    elif what == "headed-flags":
        print(" ".join(COMMON_FLAGS + [
            f"--window-size={WINDOW_WIDTH},{WINDOW_HEIGHT}",
            f"--window-position={WINDOW_X},{WINDOW_Y}"]))
    else:
        sys.exit("usage: xrio_launch.py "
                 "screen-info|xvfb-args|headless-flags|headed-flags")
