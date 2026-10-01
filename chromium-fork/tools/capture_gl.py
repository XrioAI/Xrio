#!/usr/bin/env python3
"""Capture a GL persona source JSON (like personas/mybox-*.json).

gl_profile.py was scratchpad-only (imported xrio.build_ledger). This
replicates its capture over CDP with the fork binary directly - no xrio
install needed. Run twice on SAME Chrome build, only the GL backend differs:

  # 1) SwiftShader (what VPS produces)
  python3 tools/capture_gl.py --swiftshader --out personas/mybox-swiftshader.json

  # 2) Hardware (what you want to claim - needs a real GPU + Vulkan ICD on
  #    THIS box, and --headed: headless measurably changes the WebGL readback
  #    on the hardware backend, see tools/invariant_probe.py's "check C")
  python3 tools/capture_gl.py --headed --out personas/mybox-nvidia-3090.json

Then:
  python3 tools/gen_gl_persona.py personas/mybox-swiftshader.json personas/mybox-nvidia-3090.json
  # -> personas/mybox-nvidia-3090.xrio-gl.json
  tools/package.sh   # copies to <chrome>/personas/

Both captures must be on Chrome CHROMIUM_VERSION (the tree's pin) or
gen_gl_persona.py / verify_probe.py will refuse the artifact.

WHAT A CAPTURE HOLDS, in two parts, and the split is load-bearing. `params`,
`extensions`, `precision`, `renderer` and `vendor` are the CANDIDATE half: they
are what gen_gl_persona.py diffs, so a key added to the `P` map becomes a
spoofing candidate by default. Everything after the `VALIDATION-ONLY SURFACES`
comment in the JS below is the other half -- `context_attributes`,
`compressed_texture_formats`, `internalformat_samples`, `wide_params` and the
whole `webgl1` sub-object. The generator never reads those, by construction, so
they can record how far a claim and a backend diverge without ever becoming a
claim themselves. fork/IMPLEMENTATION_CHECKLIST.md section 2 asks for exactly
that ordering: capture for validation first, do not automatically override.

Read fork/gl-persona-capability-coverage.md section 8b before treating any of
those rows as work. Widening the EMIT path was tried on 2026-09-08 and
withdrawn on measurement: six of six spoofed limits were refuted from inside the
context under test, because a limit is enforced where a getParameter hook is
not -- the linker, the shader translator, the allocator.

CAPTURES TAKEN BEFORE 2026-09-09 DO NOT CARRY THE VALIDATION HALF, and nothing
refuses them for it: the generator does not read those keys, so an old pair
still produces a byte-identical artifact. A re-capture is how the rows appear,
and it is worth taking on the next pin bump rather than on its own.
"""
import argparse, functools, http.server, json, os, shutil, socketserver
import subprocess, sys, tempfile, threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xrio_cdp  # noqa: E402
import xrio_devtools  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CHROME = os.environ.get("XRIO_CHROME", str(ROOT / "chrome"))

# What "hardware" means here: Vulkan ANGLE, because that's the backend that
# produced the AMD RENOIR target persona (personas/README.md: "Vulkan 1.3.0
# (...)"). Not `--use-angle=default` - default is whatever ANGLE picks for
# the box, which is not guaranteed to be the backend the target was captured
# on, and capturing on the wrong backend silently breaks the "only the GL
# backend differs" premise the delta's trustworthiness depends on.
GL_BACKENDS = ("vulkan", "gl")

JS = r"""
(async () => {
  const sha32 = async (bytes) => {
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,32);
  };
  const out = {};
  // SECURE ORIGIN OR NOTHING. crypto.subtle is only exposed in a secure context, and the
  // readback hashes below need it. On about:blank isSecureContext is FALSE, so sha32 threw,
  // this whole async function rejected, evaluate() returned {}, and `renderer` fell back to
  // its "" default -- which the SwiftShader guard then reported as "SwiftShader did not
  // load". Two hours of chasing a GL problem that did not exist. Fail loudly instead.
  out.secure = window.isSecureContext;
  if (!(window.crypto && crypto.subtle)) {
    return {error: 'crypto.subtle unavailable (isSecureContext=' + window.isSecureContext +
                   ') -- the readback hashes need a secure origin. Serve the page from ' +
                   'http://127.0.0.1:<port>/ (which IS trustworthy), not about:blank.'};
  }
  // ---- WebGL ----
  const c = document.createElement('canvas'); c.width=160; c.height=120;
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  if (!gl) return {error: 'no webgl'};
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  // Enabled BEFORE the parameter sweep, because three of the pnames below are only
  // readable while their extension is enabled -- Blink gates them on
  // ExtensionEnabled and getParameter throws INVALID_ENUM otherwise. Enabling an
  // extension does not change getSupportedExtensions(), so the list captured further
  // down is unaffected. An extension the backend does not have simply stays null and
  // its pnames come back as ERR:, which is the honest record of "not readable here".
  gl.getExtension('OES_shader_multisample_interpolation');
  gl.getExtension('WEBGL_blend_func_extended');
  out.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
  out.vendor   = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : '';
  // params - cover every key gen_gl_persona.py knows + the rest for provenance
  const P = {
    ALIASED_LINE_WIDTH_RANGE: 0x846E, ALIASED_POINT_SIZE_RANGE: 0x846D,
    ALPHA_BITS: 0x0D55, BLUE_BITS: 0x0D54, DEPTH_BITS: 0x0D56, GREEN_BITS: 0x0D53,
    MAX_3D_TEXTURE_SIZE: 0x8073, MAX_ARRAY_TEXTURE_LAYERS: 0x88FF,
    MAX_COLOR_ATTACHMENTS: 0x8CDF, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B80,
    MAX_CUBE_MAP_TEXTURE_SIZE: 0x851C, MAX_DRAW_BUFFERS: 0x8824,
    MAX_ELEMENTS_INDICES: 0x80E9, MAX_ELEMENTS_VERTICES: 0x80E8,
    MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD, MAX_RENDERBUFFER_SIZE: 0x84E8,
    MAX_SAMPLES: 0x8D57, MAX_TEXTURE_IMAGE_UNITS: 0x8872,
    MAX_TEXTURE_LOD_BIAS: 0x84FD, MAX_TEXTURE_SIZE: 0x0D33,
    MAX_VARYING_VECTORS: 0x8DFC, MAX_VERTEX_ATTRIBS: 0x8869,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8B4C, MAX_VERTEX_UNIFORM_BLOCKS: 0x8A2B,
    MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB, MAX_VIEWPORT_DIMS: 0x0D3A,
    RED_BITS: 0x0D52, RENDERER: 0x1F01, SHADING_LANGUAGE_VERSION: 0x8B8C,
    STENCIL_BITS: 0x0D57, SUBPIXEL_BITS: 0x0D50, VENDOR: 0x1F00, VERSION: 0x1F02,
    // ---- ADDED 2026-09-08 ----------------------------------------------------
    // Twelve parameters that DIFFER between the two backends and that this list
    // never asked for, so gen_gl_persona.py never saw a delta to emit and reported
    // "0 UNMAPPED" while missing all of them. Measured by an enum-walk probe that
    // read every integer constant on WebGL2RenderingContext rather than a named
    // list -- 36 of 158 readable parameters differ, and the artifact was closing 10.
    // fork/gl-persona-capability-coverage.md has the full table.
    //
    // UNMAPPED can only warn about a parameter the capture already collects, which
    // is why no guard caught this: there was nothing there to catch. The lesson is
    // about the capture list, not the guard.
    //
    // The first six are core WebGL2 and always readable. The next three need
    // OES_shader_multisample_interpolation, enabled above. The last three have no
    // hook in the fork at all -- two want GetInt64Parameter and one
    // GetUnsignedIntParameter -- and are collected anyway so the generator reports
    // them as UNMAPPED, which is the visible form of a known hole.
    MAX_VARYING_COMPONENTS: 0x8B4B,
    MAX_VERTEX_OUTPUT_COMPONENTS: 0x9122,
    MAX_FRAGMENT_UNIFORM_BLOCKS: 0x8A2D,
    MAX_PROGRAM_TEXEL_OFFSET: 0x8905,
    MIN_PROGRAM_TEXEL_OFFSET: 0x8904,
    UNIFORM_BUFFER_OFFSET_ALIGNMENT: 0x8A34,
    FRAGMENT_INTERPOLATION_OFFSET_BITS_OES: 0x8E5D,
    MAX_FRAGMENT_INTERPOLATION_OFFSET_OES: 0x8E5C,
    MIN_FRAGMENT_INTERPOLATION_OFFSET_OES: 0x8E5B,
    MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS: 0x8A31,
    MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS: 0x8A33,
    MAX_DUAL_SOURCE_DRAW_BUFFERS_WEBGL: 0x88FC,
  };
  out.params = {};
  for (const [k, e] of Object.entries(P)) {
    try {
      let v = gl.getParameter(e);
      // typed arrays -> plain arrays for JSON
      if (v && typeof v.length === 'number' && typeof v !== 'string' && !(v instanceof WebGLBuffer))
        v = [...v];
      out.params[k] = v;
    } catch(err) { out.params[k] = `ERR:${err.message}`; }
  }
  // extensions sorted for byte-stable diff
  out.extensions = (gl.getSupportedExtensions() || []).slice().sort();

  // ---- VALIDATION-ONLY SURFACES, and they are deliberately NOT in `P` -----
  // Everything above this line is a candidate the artifact can carry: `P`'s
  // keys are what gen_gl_persona.py diffs into `ints`/`floats`/`float_arrays`/
  // `int_arrays`, and a key added there becomes a spoofing candidate by
  // default. The keys below cannot: gen_gl_persona.py reads `params`,
  // `extensions`, `precision`, `renderer` and `vendor`, and nothing else. So
  // this block is exactly what fork/IMPLEMENTATION_CHECKLIST.md section 2 asks
  // for -- "capture these for validation first; do not automatically override
  // them" -- and the structural separation is the reason it stays that way
  // when somebody widens `P` later.
  //
  // The audit that produced this list is fork/gl-persona-capability-coverage.md
  // and its section 8b matters before reading any of it as a to-do: widening
  // the EMIT path was tried, measured and WITHDRAWN. Six of six spoofed limits
  // were refuted from inside the context under test, because a limit is
  // enforced somewhere a getParameter hook is not -- the linker, the shader
  // translator, the allocator. These rows are here to tell a HUMAN how far the
  // claim and the backend diverge, not to be emitted.

  // getContextAttributes(): what the context was actually created with. Not a
  // pname, so no hook reaches it, and it is the cheapest cross-check on the
  // {ALPHA,DEPTH,STENCIL}_BITS rows above -- a claimed depth buffer and
  // `depth: false` is a contradiction inside one object.
  try {
    const a = gl.getContextAttributes();
    out.context_attributes = a ? JSON.parse(JSON.stringify(a)) : null;
  } catch(err) { out.context_attributes = `ERR:${err.message}`; }

  // COMPRESSED_TEXTURE_FORMATS: driver-dependent, and the one row the
  // extension HIDE mechanism moves for free. Hiding the ASTC/ETC trio took
  // SwiftShader from 55 formats to RENOIR's 16 with no numeric claim at all
  // (coverage doc section 7), which is why it is worth recording per capture
  // rather than inferring from the extension list.
  try {
    const f = gl.getParameter(0x86A3);
    out.compressed_texture_formats = f ? [...f].sort((x, y) => x - y) : null;
  } catch(err) { out.compressed_texture_formats = `ERR:${err.message}`; }

  // getInternalformatParameter(RENDERBUFFER, fmt, SAMPLES): the largest single
  // coverage hole in the audit -- 16 of 16 formats differed between backends
  // and NOTHING in the artifact schema can carry them. It is also the only way
  // a spoofed MAX_SAMPLES could ever be made coherent, since max(SAMPLES) and
  // MAX_SAMPLES are two answers to one question. WebGL2 only; on a WebGL1
  // context the call does not exist and the key records that.
  out.internalformat_samples = {};
  if (gl.getInternalformatParameter) {
    // Every colour/depth/stencil format WebGL2 requires to be renderbuffer-
    // renderable, in spec order. Fixed and named rather than enumerated,
    // because two captures are only comparable over the same list.
    const FMT = {
      R8: 0x8229, R8UI: 0x8232, R8I: 0x8231, R16UI: 0x8234, R16I: 0x8233,
      R32UI: 0x8236, R32I: 0x8235, RG8: 0x822B, RG8UI: 0x8238, RG8I: 0x8237,
      RG16UI: 0x823A, RG16I: 0x8239, RG32UI: 0x823C, RG32I: 0x823B,
      RGB8: 0x8051, RGB565: 0x8D62, RGBA8: 0x8058, SRGB8_ALPHA8: 0x8C43,
      RGB5_A1: 0x8057, RGBA4: 0x8056, RGB10_A2: 0x8059, RGBA8UI: 0x8D7C,
      RGBA8I: 0x8D8E, RGB10_A2UI: 0x906F, RGBA16UI: 0x8D76, RGBA16I: 0x8D88,
      RGBA32UI: 0x8D70, RGBA32I: 0x8D82,
      DEPTH_COMPONENT16: 0x81A5, DEPTH_COMPONENT24: 0x81A6,
      DEPTH_COMPONENT32F: 0x8CAC, DEPTH24_STENCIL8: 0x88F0,
      DEPTH32F_STENCIL8: 0x8CAD, STENCIL_INDEX8: 0x8D48,
    };
    for (const [name, fmt] of Object.entries(FMT)) {
      try {
        const v = gl.getInternalformatParameter(0x8D41 /* RENDERBUFFER */,
                                                fmt, 0x80A9 /* SAMPLES */);
        out.internalformat_samples[name] = v ? [...v] : null;
      } catch(err) { out.internalformat_samples[name] = `ERR:${err.message}`; }
    }
  } else {
    out.internalformat_samples = 'ABSENT:webgl1';
  }

  // The 64-bit and unsigned helpers Blink routes some pnames through, read
  // here so a capture records what they SAY even though no hook can change
  // them. MAX_COMBINED_*_UNIFORM_COMPONENTS go through GetInt64Parameter and
  // MAX_DUAL_SOURCE_DRAW_BUFFERS_WEBGL through GetUnsignedIntParameter; none of
  // the three is in `P` for that reason, and the coverage doc records them as
  // permanently unmapped rather than as an omission to fix. A JS number holds
  // both exactly at these magnitudes, so no precision is lost on the way out.
  out.wide_params = {};
  for (const [k, e] of Object.entries({
    MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS: 0x8A31,
    MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS: 0x8A33,
    MAX_DUAL_SOURCE_DRAW_BUFFERS_WEBGL: 0x88FC,
  })) {
    try {
      const v = gl.getParameter(e);
      out.wide_params[k] = (v && typeof v.length === 'number') ? [...v] : v;
    } catch(err) { out.wide_params[k] = `ERR:${err.message}`; }
  }

  // ---- WebGL1, on its own context -----------------------------------------
  // Its own context because a WebGL2 context answering WebGL1 pnames is not
  // the same measurement: the two go through different Blink classes
  // (webgl_rendering_context_base.cc is patched, webgl2_rendering_context_base
  // .cc is not), so a divergence between them is exactly the kind of thing
  // only a capture can find. The same `P` sweep, so the two are comparable
  // key by key -- a WebGL2-only pname simply records ERR: here, which is the
  // honest answer for "not readable on this context".
  try {
    const c1 = document.createElement('canvas'); c1.width=160; c1.height=120;
    const gl1 = c1.getContext('webgl');
    if (!gl1) {
      out.webgl1 = 'ABSENT';
    } else {
      const dbg1 = gl1.getExtension('WEBGL_debug_renderer_info');
      out.webgl1 = {
        renderer: dbg1 ? gl1.getParameter(dbg1.UNMASKED_RENDERER_WEBGL) : '',
        vendor: dbg1 ? gl1.getParameter(dbg1.UNMASKED_VENDOR_WEBGL) : '',
        version: gl1.getParameter(0x1F02),
        extensions: (gl1.getSupportedExtensions() || []).slice().sort(),
        params: {},
      };
      try {
        const a1 = gl1.getContextAttributes();
        out.webgl1.context_attributes = a1 ? JSON.parse(JSON.stringify(a1)) : null;
      } catch(err) { out.webgl1.context_attributes = `ERR:${err.message}`; }
      for (const [k, e] of Object.entries(P)) {
        try {
          let v = gl1.getParameter(e);
          if (v && typeof v.length === 'number' && typeof v !== 'string' &&
              !(v instanceof WebGLBuffer))
            v = [...v];
          out.webgl1.params[k] = v;
        } catch(err) { out.webgl1.params[k] = `ERR:${err.message}`; }
      }
    }
  } catch(err) { out.webgl1 = `ERR:${err.message}`; }
  // precision - the guard gen_gl_persona.py checks (ANGLE reports identical on both backends).
  // All 6 WebGL precision types, not just the 4 a shader is likeliest to touch:
  // the guard's whole job is to catch a divergence before it ships silently.
  out.precision = {};
  const PRECISION_TYPES = {
    HIGH_FLOAT: 'FLOAT', MEDIUM_FLOAT: 'FLOAT', LOW_FLOAT: 'FLOAT',
    HIGH_INT: 'INT', MEDIUM_INT: 'INT', LOW_INT: 'INT',
  };
  for (const sh of ['VERTEX_SHADER','FRAGMENT_SHADER']) {
    const shader = sh==='VERTEX_SHADER' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER;
    for (const tp of Object.keys(PRECISION_TYPES)) {
      const f = gl.getShaderPrecisionFormat(shader, gl[tp]);
      out.precision[`${sh}.${tp}`] = [f.rangeMin, f.rangeMax, f.precision];
    }
  }
  // readback hashes - not consumed by gen_gl_persona, but provenance + verify
  const c2 = document.createElement('canvas'); c2.width=240; c2.height=60;
  const g = c2.getContext('2d');
  g.fillStyle='#f60'; g.fillRect(0,0,240,60);
  g.fillStyle='#069'; g.font='18px Arial'; g.fillText('xrio 0123 ☃',4,40);
  g.strokeStyle='rgba(0,255,0,0.7)'; g.beginPath(); g.arc(120,30,22,0,7); g.stroke();
  const d2 = g.getImageData(0,0,240,60).data;
  out.readback = {};
  out.readback.canvas2d_sha256 = await sha32(d2);
  out.readback.measureText = [g.measureText('The quick brown fox 0123456789').width, 13, 4];
  gl.clearColor(0.2,0.6,0.9,1); gl.clear(gl.COLOR_BUFFER_BIT);
  const px = new Uint8Array(160*120*4);
  gl.readPixels(0,0,160,120, gl.RGBA, gl.UNSIGNED_BYTE, px);
  out.readback.webgl_pixels_sha256 = await sha32(px);
  let nz=0; for (let i=0;i<px.length;i++) if(px[i]!==0) nz++;
  out.readback.webgl_nonzero = nz;
  return out;
})()
"""

def serve(root):
    """Serve `root` on 127.0.0.1, which is a potentially-trustworthy origin.

    Same construct as tools/battery_probe.py -- the capture has to run in a secure context
    (see the JS above), and about:blank is not one. 127.0.0.1 is trustworthy without a
    certificate, so this needs no TLS and no /etc/hosts entry.
    """
    class Silent(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Silent, directory=str(root))

    class Quiet(socketserver.TCPServer):
        allow_reuse_address = True

        def handle_error(self, *args):
            pass

    server = Quiet(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]

def main():
    ap=argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, type=Path, help="output JSON (personas/<name>.json)")
    ap.add_argument("--swiftshader", action="store_true", help="force SwiftShader (otherwise hardware ANGLE)")
    ap.add_argument("--gl-backend", choices=GL_BACKENDS, default="vulkan",
                    help="ANGLE backend for the non-SwiftShader capture (default: vulkan, "
                         "matching how the target persona was captured)")
    ap.add_argument("--headed", action="store_true",
                    help="launch on $DISPLAY instead of --headless=new; required for a "
                         "trustworthy hardware capture")
    ap.add_argument("--chrome", default=CHROME, help="fork binary")
    args=ap.parse_args()
    chrome=Path(args.chrome)
    if not chrome.is_file(): sys.exit(f"not a file: {chrome}")

    if args.headed and not os.environ.get("DISPLAY"):
        sys.exit("--headed needs a DISPLAY; run under xvfb-run")
    if not args.swiftshader and not args.headed:
        print("WARNING: capturing the hardware backend headless. Headless measurably "
              "changes the WebGL readback on the hardware arm - pass --headed under xvfb-run for a capture that matches a real "
              "render.", file=sys.stderr)

    pin = ROOT / "VERSIONS"
    pinned = dict(line.split("=", 1) for line in pin.read_text().split()).get("CHROMIUM_VERSION", "") if pin.exists() else ""
    if pinned:
        built = subprocess.run([str(chrome), "--version"], capture_output=True, text=True,
                               check=True).stdout.split()[-1]
        if built != pinned:
            print(f"WARNING: {chrome} is {built}, tree is pinned to {pinned}; "
                  "gen_gl_persona.py stamps the pin, not this binary, unless you pass "
                  "--chrome-version to it.", file=sys.stderr)

    backend = "swiftshader" if args.swiftshader else args.gl_backend
    base=["--no-first-run","--no-default-browser-check",
          "--disable-component-update","--disable-background-networking","--lang=en-US",
          "--window-size=1600,900", "--use-gl=angle", f"--use-angle={backend}"]
    if not args.headed:
        base.insert(0, "--headless=new")

    # The page is served rather than inlined because the capture needs a SECURE ORIGIN for
    # crypto.subtle; see the JS. Nothing about the document matters, only its origin.
    docroot=Path(tempfile.mkdtemp(prefix="xrio-cap-doc-"))
    (docroot/"index.html").write_text("<!doctype html><title>xrio capture</title>\n")
    server, http_port = serve(docroot)
    page_url = f"http://127.0.0.1:{http_port}/index.html"
    # The debugging port and the user-data-dir come from tools/xrio_devtools.py:
    # this file held one of eleven copies of free_port(). Deployment hardening
    # only -- the GL flags and what this capture measures are unchanged.
    try:
        with xrio_devtools.launch(chrome, base, tag="capture-gl") as dt:
            data=xrio_cdp.evaluate(dt.port, page_url, JS, settle=2.0)
    finally:
        server.shutdown()
        shutil.rmtree(docroot, ignore_errors=True)

    if "error" in data:
        sys.exit(f"capture failed: {data['error']}")

    # AN EMPTY RESULT IS NOT A GL PROBLEM, and it was being reported as one. When the JS
    # rejected, every key was absent, `renderer` took its "" default, and the SwiftShader guard
    # below blamed the backend for a failure that happened before WebGL was ever queried. These
    # two checks make that misattribution impossible.
    if not data:
        sys.exit(f"capture failed: evaluating on {page_url} returned no result at all -- the JS "
                 "rejected, or the evaluation timed out. NOT a backend problem: check the page "
                 "and the CDP transport before touching GL flags.")
    if not data.get("secure"):
        sys.exit(f"capture failed: {page_url} was not a secure context, so the readback hashes "
                 "cannot be computed. 127.0.0.1 is trustworthy by definition, so something "
                 "rewrote the origin.")

    renderer = data.get("renderer", "")
    is_swiftshader = "SwiftShader" in renderer
    if args.swiftshader and not is_swiftshader:
        sys.exit(f"--swiftshader requested but renderer is {renderer!r} - SwiftShader "
                 "did not load; refusing to write a mislabeled capture")
    if not args.swiftshader and is_swiftshader:
        sys.exit(f"hardware backend requested (--use-angle={backend}) but renderer fell "
                 f"back to SwiftShader ({renderer!r}) - no GPU/ICD for that backend on "
                 "this box; refusing to write a mislabeled capture")

    args.out.write_text(json.dumps(data, indent=1, sort_keys=True)+"\n")
    print(f"wrote {args.out}  renderer={renderer[:70]}  vendor={data.get('vendor')}  ext={len(data.get('extensions',[]))}")

if __name__=="__main__": main()
