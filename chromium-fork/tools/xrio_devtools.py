#!/usr/bin/env python3
"""One authority for the DEVTOOLS DEBUGGING TRANSPORT, shared by every probe.

THIS IS DEPLOYMENT HARDENING, NOT A BROWSER FINGERPRINT CLAIM. Nothing here
changes a page-visible value. It changes who on the host can reach the
debugging socket and the profile behind it, and whether anything is left
listening afterwards.

WHY THIS EXISTS -- one defect, eleven copies.

    def free_port():
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

was copy-pasted verbatim into audio_probe.py, battery_probe.py, capture_gl.py,
config_probe.py, font_probe.py, geometry_probe.py, gl_backend_probe.py,
invariant_probe.py, media_device_probe.py, memory_probe.py and
verify_probe.py. tools/xrio_launch.py's docstring already records what three
copies of BASE_FLAGS cost; eleven copies of the transport cost the same thing,
and it is why section 5 of fork/known-limitations-implementation-checklist.md
had nowhere to put a single assertion that holds for every caller.

THREE DEFECTS THE COPIES SHARED.

1. BIND-THEN-CLOSE IS A RACE. `bind(0)`, read the number, `close()`, then hand
   the number to a browser that binds it again some milliseconds later. In
   between, the kernel is free to give that port to anything else -- including
   the next arm of the same probe, since five arms run in sequence out of the
   same ephemeral range. The loser gets "Address already in use" from a
   browser whose stderr is DEVNULL, i.e. a launch that dies with no reason.
   This module does not keep that path: NO call site needs the number before
   launch, they all only need it to talk CDP afterwards. So the browser picks
   with `--remote-debugging-port=0` and writes the result to
   `DevToolsActivePort` in its profile -- the pattern
   tools/speech_behavior_probe.js:125,146 already uses, and the only one where
   the number in hand is the number actually bound.

2. THE BIND ADDRESS WAS NEVER READ. Every copy assumed loopback because
   Chromium defaults there. `--remote-debugging-address=0.0.0.0` in an `extra`
   list, or a build that changed the default, would have published the
   debugging socket to the network and no probe would have said a word.
   `observe_bind()` reads the ACTUAL listening address out of the kernel and
   `classify_bind()` refuses a wildcard or a routable one.

3. THE PROFILE PATH WAS PREDICTABLE. audio_probe.py, geometry_probe.py,
   memory_probe.py, invariant_probe.py and verify_probe.py used FIXED paths --
   `/tmp/xrio-audio/{name}`, `/tmp/verify/{name}` -- rmtree'd and re-mkdir'd on
   every start, in the one directory every local user can write. That is a
   pre-creation squat on the profile and the port file, and `mkdir(parents=
   True)` takes the umask, so the directory was 0755 whenever the umask was
   022. `profile_dir()` mkdtemps instead and VERIFIES the mode afterwards
   rather than trusting the umask. (gl_backend_probe.py:460 already moved to
   mkdtemp for the concurrency half of this; the permission half was still
   open.)

tools/webgl_readback_probe.py:489 is the strongest existing statement in the
tree about this surface -- it deliberately runs with NO debugging port,
because "that would be a listening socket on the host to answer a question the
existing connection answers for free". That is the right answer wherever it is
available. This module exists for the callers where it is not.

WHAT THIS MODULE REFUSES vs WHAT IT ONLY RECORDS. A refusal here fires in every
probe, so it is reserved for facts that are unambiguous and cheap: a wildcard
or routable bind address (observed or asked for), a profile directory that is
not owner-only. Everything else -- an unobservable bind address on a host with
neither /proc nor lsof, an orphan left after teardown -- is RECORDED in
`evidence()` and left to tools/devtools_boundary_probe.py to judge. A gate that
reds eleven working probes on a laptop is a gate somebody deletes.

USAGE, and the whole migration is this:

    with xrio_devtools.launch(CHROME, BASE_FLAGS + extra, tag="audio") as dt:
        return xrio_cdp.evaluate(dt.port, url, JS)

Exit of the block terminates the browser, checks for an orphaned listener and
orphaned processes, and removes the profile -- on success, on exception, on
timeout, on a client crash and on a browser that died on its own.
"""
from __future__ import annotations

import ipaddress
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PORT_FILE = "DevToolsActivePort"

# ponytail: loopback TCP only. `--remote-debugging-pipe` is the strictly better
# transport -- an inherited fd, no listening socket at all, nothing for another
# user or another host to connect to -- and `classify_bind` already names it so
# the evidence vocabulary does not have to change later. It is blocked on
# tools/xrio_cdp.py speaking a pipe instead of HTTP+ws, which is not this
# section's job.
KIND_LOOPBACK = "loopback-tcp"
KIND_PIPE = "inherited-pipe"


# --------------------------------------------------------------- pure deciders
# Everything in this block is a pure function of facts. That is deliberate:
# these decisions have to be exercised on a Mac, and the facts they decide on
# come from a Linux release host running a Linux binary. See
# tools/devtools_boundary_probe.py --self-check, which drives every one of them.

def classify_bind(address: str) -> tuple[str, str | None]:
    """(kind, refusal-reason) for an OBSERVED listening address.

    Refuses a wildcard outright rather than treating it as "loopback plus
    extra": `0.0.0.0` means the debugging socket answers on every interface the
    host has, which is the exact posture section 5 exists to forbid. An
    address that is neither wildcard nor loopback is refused too -- a bind to
    the host's LAN address is a network service whether or not a firewall
    happens to be in front of it today.
    """
    if address in ("pipe", KIND_PIPE):
        return KIND_PIPE, None
    if address in ("", "*", "0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0"):
        return KIND_LOOPBACK, (
            f"the debugging socket is bound to the wildcard address "
            f"{address or '(empty)'!r} -- it answers on every interface this "
            "host has, which is a network service and not a private transport")
    try:
        parsed = ipaddress.ip_address(address.strip("[]"))
    except ValueError:
        return KIND_LOOPBACK, (
            f"cannot parse {address!r} as an address, so the transport's "
            "reachability is unknown -- refusing rather than assuming loopback")
    # `::ffff:127.0.0.1` is loopback and Python's is_loopback says otherwise,
    # because it only compares the v6 form. Unmap first; a dual-stack listener
    # on 127.0.0.1 shows up in this form in /proc/net/tcp6.
    mapped = getattr(parsed, "ipv4_mapped", None)
    if mapped is not None:
        parsed = mapped
    if parsed.is_unspecified:
        return KIND_LOOPBACK, (
            f"{address} is the unspecified address -- the socket answers on "
            "every interface")
    if not parsed.is_loopback:
        return KIND_LOOPBACK, (
            f"{address} is not a loopback address, so the debugging socket is "
            "reachable from off-host -- bind 127.0.0.1 or use "
            "--remote-debugging-pipe")
    return KIND_LOOPBACK, None


def owner_only(st_mode: int, st_uid: int, my_uid: int, *,
               want_dir: bool, role: str = "path") -> str | None:
    """Refusal reason for a path that is not owner-only. Pure, takes stat facts.

    Both halves matter and only one of them is about permission bits: a
    directory that is 0700 but owned by SOMEBODY ELSE is not a private profile
    either, it is a profile we are borrowing.
    """
    if st_uid != my_uid:
        return (f"the {role} is owned by uid {st_uid}, not by this process's "
                f"uid {my_uid}")
    if want_dir and not stat.S_ISDIR(st_mode):
        return f"the {role} is not a directory"
    leaked = stat.S_IMODE(st_mode) & 0o077
    if leaked:
        return (f"the {role} is mode {stat.S_IMODE(st_mode):04o}; "
                f"group/other bits {leaked:03o} are set, so another local user "
                "can reach it")
    return None


# Anything that reconnects without re-deriving it is a credential for this
# purpose. `webSocketDebuggerUrl` carries a target id and is enough on its own
# to drive the browser, so it must never reach retained evidence -- section 5
# asks for the transport KIND and the ADDRESS, and those are not secrets.
_CREDENTIAL_PATTERNS = (
    re.compile(r"\bws{1,2}s?://", re.I),
    re.compile(r"webSocketDebuggerUrl", re.I),
    re.compile(r"/devtools/(?:page|browser)/", re.I),
    re.compile(r"\bdevtoolsFrontendUrl\b", re.I),
)


def credential_free(record) -> str | None:
    """Refusal reason if a record carries a reusable connection URL.

    Walks the whole structure rather than checking known keys: the leak that
    matters is the one added later by someone dumping a CDP reply into the
    evidence, and that will not be under a key this file knows about.
    """
    def walk(node, where):
        if isinstance(node, dict):
            for key, value in node.items():
                for pattern in _CREDENTIAL_PATTERNS:
                    if pattern.search(str(key)):
                        return (f"{where}{key}: the key itself names a "
                                "reusable connection URL")
                found = walk(value, f"{where}{key}.")
                if found:
                    return found
            return None
        if isinstance(node, (list, tuple)):
            for index, value in enumerate(node):
                found = walk(value, f"{where}{index}.")
                if found:
                    return found
            return None
        text = str(node)
        for pattern in _CREDENTIAL_PATTERNS:
            if pattern.search(text):
                return (f"{where.rstrip('.') or 'record'} carries "
                        f"{text[:80]!r}, a reusable connection URL -- record "
                        "the transport kind and bind address instead")
        return None

    return walk(record, "")


# ------------------------------------------------------------ observed facts

def _decode_proc_addr(hex_addr: str) -> str:
    """One /proc/net/tcp local_address field as a printable address.

    The field is little-endian per 32-bit WORD, not per address, which is why
    the v6 form is chunked in eights before the bytes are reversed. Getting
    this wrong reads ::1 as a routable address and refuses every launch.
    """
    raw = b""
    for offset in range(0, len(hex_addr), 8):
        raw += bytes.fromhex(hex_addr[offset:offset + 8])[::-1]
    family = socket.AF_INET if len(raw) == 4 else socket.AF_INET6
    return socket.inet_ntop(family, raw)


def _bind_from_proc(port: int) -> str | None:
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            lines = Path(table).read_text(errors="replace").splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            if len(fields) < 4 or fields[3] != "0A":  # 0A == TCP_LISTEN
                continue
            local, _, local_port = fields[1].rpartition(":")
            if int(local_port, 16) != port:
                continue
            return _decode_proc_addr(local)
    return None


def _bind_from_lsof(port: int) -> str | None:
    if not shutil.which("lsof"):
        return None
    out = subprocess.run(
        ["lsof", "-nP", "-a", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fn"],
        capture_output=True, text=True)
    for line in out.stdout.splitlines():
        if not line.startswith("n"):
            continue
        # `n127.0.0.1:52341`, `n*:52341`, `n[::1]:52341`
        name = line[1:]
        address, _, _ = name.rpartition(":")
        return address or "*"
    return None


def observe_bind(port: int) -> tuple[str | None, str]:
    """(address, source) for the real listener on `port`, read from the kernel.

    NOT derived from the flag. A flag says what was asked for; this says what
    answered. Where neither source is readable the address is None and the
    source says so -- "this Mac has no /proc" is not a fact about the release
    (tools/release_gate.py's sandbox_report() sets that precedent), so it is
    reported unverified rather than assumed good.
    """
    address = _bind_from_proc(port)
    if address is not None:
        return address, "/proc/net/tcp"
    address = _bind_from_lsof(port)
    if address is not None:
        return address, "lsof"
    return None, "unverified: no readable /proc/net/tcp and no lsof"


def listener_answers(port: int, timeout: float = 0.35) -> bool:
    """Whether anything accepts a loopback connection on `port` right now."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def _processes_holding(marker: str) -> tuple[list[str], str]:
    """(pids, source) for processes whose argv still names `marker`.

    `marker` is the profile path, which mkdtemp made unique, so a match is a
    process from THIS launch and not a neighbour's. pgrep exists on both
    platforms; where it does not, say so instead of reporting zero.
    """
    if not shutil.which("pgrep"):
        return [], "not-covered: no pgrep on this host"
    out = subprocess.run(["pgrep", "-f", marker], capture_output=True,
                         text=True)
    return [p for p in out.stdout.split() if p.strip()], "pgrep -f"


# ----------------------------------------------------------------- the layout

def profile_dir(tag: str) -> Path:
    """A PER-RENDER profile directory, owner-only, mode verified after creation.

    The port file lands inside it (Chromium writes DevToolsActivePort at the
    root of --user-data-dir), so one 0700 directory covers the profile and the
    port file together and there is one path to clean up.

    mkdtemp is already 0700 on every platform this runs on. It is checked
    anyway, because the point of this function is that the mode is a FACT about
    the run and not an assumption about the platform -- and because the call
    sites this replaces used `mkdir(parents=True)`, which takes the umask and
    produced 0755 under the common umask of 022.
    """
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", str(tag))[:40] or "render"
    path = Path(tempfile.mkdtemp(prefix=f"xrio-dt-{safe}-"))
    info = path.stat()
    reason = owner_only(info.st_mode, info.st_uid, os.getuid(),
                        want_dir=True, role="profile directory")
    if reason:
        shutil.rmtree(path, ignore_errors=True)
        sys.exit(f"refusing to launch: {reason} ({path})")
    return path


def _assert_flags(flags) -> str | None:
    """Refuse a caller's transport flags before a browser starts.

    Static, so it fires on every platform including the ones where the bound
    address cannot be observed at all. This is the layer that catches an
    `extra` list carrying --remote-debugging-address=0.0.0.0, which is how the
    wildcard would actually arrive.
    """
    for flag in flags:
        if flag.startswith("--remote-debugging-address="):
            address = flag.split("=", 1)[1]
            _, reason = classify_bind(address)
            if reason:
                return f"{flag}: {reason}"
        if flag.startswith("--remote-debugging-port="):
            return (f"{flag}: this module owns the debugging port. It launches "
                    "with --remote-debugging-port=0 and reads the number the "
                    "browser actually bound out of DevToolsActivePort; a "
                    "pre-picked number is the bind-then-close race this module "
                    "exists to remove (see the docstring).")
        if flag == "--remote-debugging-pipe":
            return (f"{flag}: not supported yet -- tools/xrio_cdp.py speaks "
                    "HTTP+ws over TCP. Remove it, or teach xrio_cdp a pipe "
                    "transport first.")
    return None


class Devtools:
    """A live browser and its debugging transport. Usable as a context manager.

    Started by `launch()`, so there is no half-constructed state: if the object
    exists the browser is up, the port is the one it bound, and the bind
    address has been checked as far as this host allows.
    """

    def __init__(self, proc, profile, *, owns_profile, stderr_path,
                 flags, tag, argv=()):
        self.proc = proc
        self.profile = profile
        self.tag = tag
        self.flags = list(flags)
        # The argv AS SPAWNED, for the probes that record what they launched.
        # Not in evidence(): the flags are public but the record's job is the
        # transport, and a growing evidence blob is how a credential gets in.
        self.argv = list(argv)
        self.stderr_path = stderr_path
        self._owns_profile = owns_profile
        self.port = None
        self.kind = KIND_LOOPBACK
        self.bind_address = None
        self.address_source = "unobserved"
        self.port_file_mode = None
        self.outcome = "running"
        self.orphans = []
        self.orphan_source = "unrun"
        self._closed = False

    # -- startup ----------------------------------------------------------
    def _read_port(self, timeout):
        """The port the browser actually bound, from its own port file.

        Chromium writes DevToolsActivePort only once the socket is listening,
        which is what makes this both the allocation and the readiness signal.
        A browser that died instead says so here rather than in a CDP timeout
        sixty seconds later -- which is what every copied call site did, since
        stderr was DEVNULL and wait_for_endpoint() only knew the port never
        opened.
        """
        path = self.profile / PORT_FILE
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if path.is_file():
                head = path.read_text(errors="replace").splitlines()
                if head and head[0].strip().isdigit():
                    return int(head[0].strip()), path
            if self.proc.poll() is not None:
                raise RuntimeError(
                    f"the browser exited {self.proc.returncode} before it "
                    f"wrote {PORT_FILE}{self._stderr_tail()}")
            time.sleep(0.05)
        raise RuntimeError(
            f"no {PORT_FILE} in {self.profile} after {timeout:.0f}s"
            f"{self._stderr_tail()}")

    def _stderr_tail(self):
        if not self.stderr_path or not self.stderr_path.is_file():
            return ""
        tail = self.stderr_path.read_text(errors="replace").strip()[-400:]
        return f" -- stderr: {tail}" if tail else ""

    def _start(self, timeout):
        self.port, port_path = self._read_port(timeout)
        # The port file inside a 0700 directory is already unreachable by other
        # users, but Chromium creates it with the process umask (0644 under the
        # common 022) and section 5 asks about the FILE as well as the
        # directory. One chmod makes the file's own mode match the claim, so
        # the assertion does not depend on the parent alone.
        try:
            os.chmod(port_path, 0o600)
        except OSError:
            pass
        try:
            self.port_file_mode = stat.S_IMODE(port_path.stat().st_mode)
        except OSError:
            self.port_file_mode = None
        self.bind_address, self.address_source = observe_bind(self.port)
        if self.bind_address is not None:
            self.kind, reason = classify_bind(self.bind_address)
            if reason:
                self.close("refused")
                sys.exit(f"refusing this launch: {reason} "
                         f"(observed via {self.address_source} on port "
                         f"{self.port})")
        return self

    # -- teardown ---------------------------------------------------------
    def close(self, outcome="success"):
        """Terminate, then check what is left. Idempotent.

        The same path runs for all five outcomes section 5 names -- success,
        failure, timeout, client crash, browser crash -- because a teardown
        that only runs on the happy path is exactly the one that leaves the
        listener up.
        """
        if self._closed:
            return self.evidence()
        self._closed = True
        self.outcome = outcome
        if self.proc.poll() is not None and outcome == "success":
            # The browser died on its own and the caller still finished. Worth
            # naming: the CDP work ran against a browser that was already gone.
            self.outcome = f"browser-exited-{self.proc.returncode}"
        marker = str(self.profile)
        self.proc.terminate()
        try:
            self.proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        self.orphans, self.orphan_source = self._scan_orphans(marker)
        if self._owns_profile:
            shutil.rmtree(self.profile, ignore_errors=True)
        return self.evidence()

    def _scan_orphans(self, marker):
        """What is still alive after the browser was told to go.

        Checked twice with a second in between, and only the second reading is
        reported: a SIGKILLed browser's renderers take a moment to notice, and
        a probe that cried orphan on every kill would be ignored inside a week.
        """
        found, source = self._orphans_now(marker)
        if not found:
            return found, source
        time.sleep(1.0)
        return self._orphans_now(marker)

    def _orphans_now(self, marker):
        found = []
        if self.proc.poll() is None:
            found.append(f"the browser (pid {self.proc.pid}) survived "
                         "SIGTERM and SIGKILL")
        if self.port and listener_answers(self.port):
            found.append(f"something still accepts connections on "
                         f"127.0.0.1:{self.port} after teardown")
        pids, source = _processes_holding(marker)
        if pids:
            found.append(f"pid(s) {','.join(pids)} still name {marker} in "
                         "their argv")
        return found, source

    def __enter__(self):
        return self

    def __exit__(self, kind, value, traceback):
        if kind is None:
            self.close("success")
        elif kind is TimeoutError or isinstance(value, subprocess.TimeoutExpired):
            self.close("timeout")
        elif kind is KeyboardInterrupt:
            self.close("interrupted")
        else:
            self.close(f"error:{kind.__name__}")
        return False

    # -- evidence ---------------------------------------------------------
    def evidence(self):
        """The transport record for release evidence. NO credentials, ever.

        Section 5 asks for the transport kind and the bind address and
        explicitly not for credentials or a reusable connection URL. So the
        websocket URL, the browser target id and the CDP session id are not
        here and there is no key for them -- and `credential_free()` is run on
        the way out, so a later addition that smuggles one in fails loudly
        instead of shipping.
        """
        record = {
            "kind": self.kind,
            "bind_address": self.bind_address,
            "port": self.port,
            "port_source": PORT_FILE,
            "address_source": self.address_source,
            "profile": str(self.profile),
            "profile_mode": self._mode_of(self.profile),
            "port_file_mode": self.port_file_mode,
            "stderr_sink": (str(self.stderr_path) if self.stderr_path
                            else "DEVNULL"),
            "stderr_mode": self._mode_of(self.stderr_path),
            "outcome": self.outcome,
            "orphans": list(self.orphans),
            "orphan_source": self.orphan_source,
            "tag": self.tag,
        }
        leak = credential_free(record)
        if leak:  # pragma: no cover -- the guard against a future edit
            raise AssertionError(f"transport evidence leaks a credential: {leak}")
        return record

    @staticmethod
    def _mode_of(path):
        if not path:
            return None
        try:
            return stat.S_IMODE(Path(path).stat().st_mode)
        except OSError:
            return None


def launch(binary, flags=(), *, tag="render", profile=None, env=None,
           capture_stderr=False, timeout=30.0):
    """Start a browser with a private debugging transport. Returns it live.

    `flags` is whatever the caller already passes -- xrio_launch.base_flags()
    and the probe's own axis. This adds exactly two: the user-data-dir (unless
    the caller's flags already carry one, which the xrio ledger path in
    font_probe.py does) and --remote-debugging-port=0.

    `capture_stderr` puts the browser's stderr in a 0600 file inside the
    profile instead of DEVNULL. Every call site today uses DEVNULL, which is
    unreadable by definition; the option exists so
    tools/devtools_boundary_probe.py has a real stderr sink whose mode it can
    assert, because "another local user cannot read the browser's stderr" is
    one of section 5's bullets and DEVNULL answers it only by accident.
    """
    flags = list(flags)
    refusal = _assert_flags(flags)
    if refusal:
        sys.exit(f"refusing to launch: {refusal}")

    owns_profile = profile is None
    existing = [f for f in flags if f.startswith("--user-data-dir=")]
    if existing:
        # The caller built its own; verify it here rather than adding a second
        # one, because a second --user-data-dir would silently win or lose
        # depending on order and the port file would be in the other directory.
        profile = Path(existing[-1].split("=", 1)[1])
        owns_profile = False
    if profile is None:
        profile = profile_dir(tag)
    profile = Path(profile)
    if not existing:
        flags = [f"--user-data-dir={profile}", *flags]

    if not profile.exists():
        # Chromium would create it with the umask. Create it here instead, so
        # the mode is 0700 by construction and the check below is a check and
        # not a coin flip on the caller's umask.
        profile.mkdir(parents=True, mode=0o700)
    info = profile.stat()
    reason = owner_only(info.st_mode, info.st_uid, os.getuid(),
                        want_dir=True, role="profile directory")
    if reason:
        sys.exit(f"refusing to launch: {reason} ({profile})")

    stderr_path = None
    if capture_stderr:
        stderr_path = profile / "browser-stderr.log"
        handle = os.open(str(stderr_path),
                         os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        sink = os.fdopen(handle, "wb")
    else:
        sink = subprocess.DEVNULL

    # A STALE PORT FILE IS INDISTINGUISHABLE FROM A FRESH ONE, so remove it
    # before the browser starts. _read_port() polls every 50 ms and returns the
    # first DevToolsActivePort it sees; a profile that arrived with one already
    # in it therefore hands back a number from a previous run on the first
    # iteration, before this browser has bound anything. Any real Chrome
    # profile ever driven over CDP contains one, and launch() explicitly
    # supports a caller-supplied profile: font_probe.py's xrio ledger path,
    # and mode_corpus.py, which copytree()s an operator-supplied
    # --profile-snapshot. The failure is a CDP client connecting to nothing --
    # or worse, to an unrelated listener that has since taken the number.
    stale = profile / PORT_FILE
    try:
        stale.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:
        sys.exit(f"refusing to launch: {stale} could not be removed ({exc}). "
                 "A port file left from another run would be read as this "
                 "browser's own.")

    argv = [str(binary), "--remote-debugging-port=0", *flags]
    proc = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=sink,
                            env=env)
    if capture_stderr:
        sink.close()
    session = Devtools(proc, profile, owns_profile=owns_profile,
                       stderr_path=stderr_path, flags=flags, tag=tag,
                       argv=argv)
    try:
        return session._start(timeout)
    except BaseException:
        session.close("launch-failed")
        raise


if __name__ == "__main__":
    # No browser here. The facts this module decides on come from a Linux
    # release host; the DECISIONS are exercised by
    # tools/devtools_boundary_probe.py --self-check, which is the runnable
    # check for this file too.
    what = sys.argv[1] if len(sys.argv) > 1 else "help"
    if what == "profile-dir":
        print(profile_dir(sys.argv[2] if len(sys.argv) > 2 else "manual"))
    elif what == "bind":
        address, source = observe_bind(int(sys.argv[2]))
        print(f"{address}  via {source}")
    else:
        sys.exit("usage: xrio_devtools.py profile-dir [TAG] | bind PORT")
