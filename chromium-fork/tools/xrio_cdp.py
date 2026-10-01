"""A CDP client with no dependencies, for probing a build on a bare box.

verify_probe.py needs `requests` and `websockets`, which means a venv on every
machine a probe has to run on -- and a probe that cannot run is a probe that
does not run. The protocol needs are small enough to not be worth that: one
HTTP GET, one websocket upgrade, and text frames in both directions.

Only what CDP actually uses is here. No permessage-deflate (Chrome does not
offer it on the debugging socket), no binary frames, no client fragmentation.
Server fragmentation and pings ARE handled, because Chrome sends both.
"""
import base64
import collections
import json
import os
import socket
import struct
import time
import urllib.request
from urllib.parse import urlparse


class WebSocket:
    def __init__(self, url, timeout=30.0):
        parts = urlparse(url)
        port = parts.port or 80
        self._sock = socket.create_connection((parts.hostname, port), timeout=timeout)
        self._sock.settimeout(timeout)
        self._buf = b""
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        key = base64.b64encode(os.urandom(16)).decode()
        self._sock.sendall(
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {parts.hostname}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n".encode()
        )
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise ConnectionError("upgrade closed before the response headers")
            head += chunk
        status, _, rest = head.partition(b"\r\n")
        if b"101" not in status:
            raise ConnectionError(f"upgrade refused: {status!r}")
        # Anything after the header block is already frame data.
        self._buf = rest.partition(b"\r\n\r\n")[2]

    def _read(self, count):
        while len(self._buf) < count:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise ConnectionError("socket closed mid-frame")
            self._buf += chunk
        out, self._buf = self._buf[:count], self._buf[count:]
        return out

    def _write_frame(self, opcode, payload):
        # Client frames MUST be masked (RFC 6455 5.1); Chrome closes if they are not.
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 1 << 16:
            header.append(0x80 | 126)
            header += struct.pack("!H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack("!Q", length)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
        self._sock.sendall(bytes(header) + masked)

    def send(self, text):
        self._write_frame(0x1, text.encode())

    def recv(self):
        """The next complete text message, transparently answering pings."""
        parts = []
        while True:
            b0, b1 = self._read(2)
            fin, opcode = b0 & 0x80, b0 & 0x0F
            length = b1 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read(8))[0]
            mask = self._read(4) if b1 & 0x80 else None
            payload = self._read(length) if length else b""
            if mask:
                payload = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
            if opcode == 0x8:
                raise ConnectionError("peer closed the websocket")
            if opcode == 0x9:
                self._write_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            parts.append(payload)
            if fin:
                return b"".join(parts).decode()

    def close(self):
        try:
            self._write_frame(0x8, b"")
        except OSError:
            pass
        self._sock.close()


class Cdp:
    """One websocket, ids allocated here, events dropped unless waited for."""

    def __init__(self, ws_url):
        self._ws = WebSocket(ws_url, timeout=60.0)
        self._id = 0
        # EVENTS ARE KEPT NOW, not dropped. They were discarded on the floor of
        # the loop below, so a caller that needed one -- the BFCache refusal
        # arrives ONLY as Page.backForwardCacheNotUsed, never as a reply -- had
        # no way to see it. Bounded, because an unbounded list on a long run is
        # a memory leak in a diagnostic: the newest are the ones anybody reads.
        self.events = collections.deque(maxlen=2000)

    def send(self, method, params=None, session=None):
        self._id += 1
        msg = {"id": self._id, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        self._ws.send(json.dumps(msg))
        while True:
            reply = json.loads(self._ws.recv())
            if "method" in reply and "id" not in reply:
                self.events.append(reply)
                continue
            if reply.get("id") == self._id:
                if "error" in reply:
                    raise RuntimeError(f"{method}: {reply['error']}")
                return reply.get("result", {})

    def drain(self, seconds=1.0):
        """Read whatever the browser has already sent, then stop.

        EVENTS ONLY ARRIVED AS A SIDE EFFECT OF SENDING before this: the loop
        in send() is the only thing that reads the socket, so an event produced
        while no request was in flight sat unread in the kernel buffer. A
        caller that navigates, sleeps, and then looks at `events` therefore saw
        nothing -- which is exactly the shape of Page.backForwardCacheNotUsed,
        fired during the navigation and read afterwards.
        """
        deadline = time.monotonic() + seconds
        previous = self._ws._sock.gettimeout()
        try:
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    return
                self._ws._sock.settimeout(left)
                try:
                    message = json.loads(self._ws.recv())
                except (socket.timeout, TimeoutError, OSError):
                    return
                if "method" in message and "id" not in message:
                    self.events.append(message)
        finally:
            try:
                self._ws._sock.settimeout(previous)
            except OSError:
                pass

    def close(self):
        self._ws.close()


def wait_for_endpoint(port, attempts=120, delay=0.25):
    """Chrome writes /json/version only once the debugging socket is listening."""
    last = None
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/json/version", timeout=1
            ) as response:
                return json.load(response)["webSocketDebuggerUrl"]
        except Exception as exc:  # connection refused until it is up
            last = exc
            time.sleep(delay)
    raise RuntimeError(f"chrome never opened its debugging port: {last!r}")


def evaluate(port, url, expression, settle=2.0):
    """Navigate a fresh target to `url`, then evaluate and return by value."""
    client = Cdp(wait_for_endpoint(port))
    try:
        target = client.send("Target.createTarget", {"url": "about:blank"})["targetId"]
        session = client.send(
            "Target.attachToTarget", {"targetId": target, "flatten": True}
        )["sessionId"]
        client.send("Page.enable", {}, session)
        client.send("Page.navigate", {"url": url}, session)
        time.sleep(settle)
        result = client.send(
            "Runtime.evaluate",
            {"expression": expression, "awaitPromise": True, "returnByValue": True},
            session,
        )
        inner = result.get("result", {})
        if "value" not in inner:
            raise RuntimeError(f"evaluate returned no value: {json.dumps(result)[:600]}")
        return inner["value"]
    finally:
        client.close()
