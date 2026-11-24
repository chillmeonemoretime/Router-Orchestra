#!/usr/bin/env python3
"""Router Orchestra — Listen to your Internet.

Reads WAN hardware counters (`ethtool -S <iface>`) from an OpenWrt router over
one persistent SSH connection, turns them into Mbps / PPS and streams them to
a browser via Server-Sent Events, where they are turned into music.

Nothing is installed or changed on the router; hardware NAT stays enabled.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import random
import re
import select
import shlex
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import asdict, dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

STATIC_DIR = Path(__file__).resolve().parent / "static"
COUNTERS = ("rx_bytes", "tx_bytes", "rx_packets", "tx_packets")
INTERFACE_RE = re.compile(r"^[A-Za-z0-9_.:@-]{1,32}$")
HISTORY_SECONDS = 60

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
}


# --------------------------------------------------------------------------
# Metrics
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Sample:
    """One reading of the cumulative WAN counters at router-monotonic time t."""

    t: float
    rx_bytes: int
    tx_bytes: int
    rx_packets: int
    tx_packets: int


@dataclass(frozen=True)
class Rates:
    down_mbps: float
    up_mbps: float
    rx_pps: float
    tx_pps: float
    dt: float


def parse_sample(line: str) -> Sample | None:
    """Parse a remote line: `RO <uptime> <rx_bytes> <tx_bytes> <rx_pkts> <tx_pkts>`."""
    parts = line.split()
    if len(parts) != 6 or parts[0] != "RO":
        return None
    try:
        t = float(parts[1])
        counters = [int(p) for p in parts[2:]]
    except ValueError:
        return None
    if t < 0 or any(c < 0 for c in counters):
        return None
    return Sample(t, *counters)


class RateCalculator:
    """Turns consecutive counter samples into rates.

    The first sample after construction or `reset()` only initialises state.
    A counter going backwards, the clock not advancing, or a gap longer than
    `max_gap` seconds re-initialises instead of producing a bogus rate.
    """

    def __init__(self, max_gap: float = 10.0):
        self.max_gap = max_gap
        self._prev: Sample | None = None

    def reset(self) -> None:
        self._prev = None

    def update(self, sample: Sample) -> Rates | None:
        prev, self._prev = self._prev, sample
        if prev is None:
            return None
        dt = sample.t - prev.t
        if dt <= 0 or dt > self.max_gap:
            return None
        deltas = [getattr(sample, k) - getattr(prev, k) for k in COUNTERS]
        if any(d < 0 for d in deltas):
            return None
        rx_b, tx_b, rx_p, tx_p = deltas
        return Rates(
            down_mbps=rx_b * 8 / dt / 1_000_000,
            up_mbps=tx_b * 8 / dt / 1_000_000,
            rx_pps=rx_p / dt,
            tx_pps=tx_p / dt,
            dt=dt,
        )


# --------------------------------------------------------------------------
# Event hub (SSE fan-out)
# --------------------------------------------------------------------------

class Hub:
    """Keeps the latest status plus recent metrics and fans events out to clients."""

    def __init__(self, info: dict, history_len: int):
        self._lock = threading.Lock()
        self._clients: set[queue.Queue] = set()
        self._history: deque = deque(maxlen=history_len)
        self._status = {"state": "starting", "message": "Starting…", **info}
        self._info = info

    def subscribe(self) -> tuple[queue.Queue, dict, list]:
        q: queue.Queue = queue.Queue(maxsize=256)
        with self._lock:
            self._clients.add(q)
            return q, dict(self._status), list(self._history)

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            self._clients.discard(q)

    def status(self, state: str, message: str) -> None:
        with self._lock:
            self._status = {"state": state, "message": message, **self._info}
            self._broadcast("status", self._status)

    def metrics(self, rates: Rates) -> None:
        payload = {
            "ts": time.time(),
            "down": round(rates.down_mbps, 4),
            "up": round(rates.up_mbps, 4),
            "rx_pps": round(rates.rx_pps, 1),
            "tx_pps": round(rates.tx_pps, 1),
        }
        with self._lock:
            self._history.append(payload)
            self._broadcast("metrics", payload)

    def _broadcast(self, event: str, data: dict) -> None:
        for q in self._clients:
            try:
                q.put_nowait((event, data))
            except queue.Full:
                pass  # slow client: drop rather than block the collector


# --------------------------------------------------------------------------
# Collectors
# --------------------------------------------------------------------------

def remote_script(interface: str, interval: float) -> str:
    """Shell loop run on the router: one `RO ...` line per sample.

    `|| exit 1` makes the loop die once the SSH channel is gone (awk gets
    SIGPIPE), so no orphaned loop is left behind on the router.
    """
    awk = (
        '{k=$1; sub(/:$/, "", k); if (!(k in v)) v[k]=$2} '
        'END {print "RO", t, v["rx_bytes"], v["tx_bytes"], v["rx_packets"], v["tx_packets"]}'
    )
    return (
        "while :; do "
        "read up _ < /proc/uptime; "
        f'ethtool -S {shlex.quote(interface)} | awk -v t="$up" {shlex.quote(awk)} || exit 1; '
        f"sleep {interval:g}; "
        "done"
    )


class SSHCollector:
    MIN_BACKOFF = 2.0
    MAX_BACKOFF = 30.0

    def __init__(self, hub: Hub, host: str, user: str | None, interface: str, interval: float):
        self.hub = hub
        self.host = host
        self.user = user
        self.interface = interface
        self.interval = interval
        self.stale_after = max(10.0, interval * 5)

    @property
    def target(self) -> str:
        return f"{self.user}@{self.host}" if self.user else self.host

    def command(self) -> list[str]:
        cmd = [
            "ssh",
            "-o", "BatchMode=yes",  # key / agent auth only, never prompt for a password
            "-o", "ConnectTimeout=10",
            "-o", "ServerAliveInterval=5",
            "-o", "ServerAliveCountMax=2",
        ]
        if self.user:
            cmd += ["-l", self.user]
        cmd += [self.host, remote_script(self.interface, self.interval)]
        return cmd

    def run(self, stop: threading.Event) -> None:
        backoff = self.MIN_BACKOFF
        while not stop.is_set():
            self.hub.status("connecting", f"Connecting to {self.target}…")
            got_data, error = self._session(stop)
            if stop.is_set():
                break
            if got_data:
                backoff = self.MIN_BACKOFF
            self.hub.status("disconnected", f"{error} — retrying in {backoff:g}s")
            stop.wait(backoff)
            backoff = min(backoff * 2, self.MAX_BACKOFF)

    def _session(self, stop: threading.Event) -> tuple[bool, str]:
        try:
            proc = subprocess.Popen(
                self.command(),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except OSError as e:
            return False, f"Cannot run ssh: {e}"

        stderr_tail: deque[str] = deque(maxlen=3)

        def drain_stderr() -> None:
            for raw in proc.stderr:
                line = raw.decode(errors="replace").strip()
                if line:
                    stderr_tail.append(line)

        drainer = threading.Thread(target=drain_stderr, daemon=True)
        drainer.start()

        # Every session starts from scratch so a reconnect never yields a
        # giant delta from counters accumulated while we were away.
        calc = RateCalculator(max_gap=max(10.0, self.interval * 10))
        fd = proc.stdout.fileno()
        buf = b""
        got_data = False
        bad_lines = 0
        last_valid = time.monotonic()
        error = None
        try:
            while not stop.is_set():
                ready, _, _ = select.select([fd], [], [], 0.5)
                if not ready:
                    if time.monotonic() - last_valid > self.stale_after:
                        error = f"No data from router for {self.stale_after:g}s"
                        if bad_lines:
                            error = f"ethtool -S {self.interface} did not report rx/tx counters"
                        break
                    continue
                chunk = os.read(fd, 4096)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    raw, buf = buf.split(b"\n", 1)
                    sample = parse_sample(raw.decode(errors="replace"))
                    if sample is None:
                        bad_lines += 1
                        continue
                    last_valid = time.monotonic()
                    if not got_data:
                        got_data = True
                        self.hub.status(
                            "connected", f"Connected to {self.target} · {self.interface}"
                        )
                    rates = calc.update(sample)
                    if rates is not None:
                        self.hub.metrics(rates)
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()

        drainer.join(timeout=1)
        if error is None:
            error = stderr_tail[-1] if stderr_tail else "SSH connection closed"
        return got_data, error


class DemoCollector:
    """Simulated WAN traffic cycling through recognisable scenes."""

    SCENES = (
        ("Idle", 20),
        ("Web browsing", 30),
        ("Video streaming", 30),
        ("Large download", 20),
        ("Upload", 20),
        ("Speed test", 25),
    )

    def __init__(self, hub: Hub, interval: float, seed: int | None = None):
        self.hub = hub
        self.interval = interval
        self.rng = random.Random(seed)

    def traffic(self, scene: str, elapsed: float) -> tuple[float, float]:
        """(download Mbps, upload Mbps) for a scene `elapsed` seconds in."""
        r = self.rng
        background = (r.uniform(0.01, 0.06), r.uniform(0.01, 0.04))
        if scene == "Idle":
            return background
        if scene == "Web browsing":
            if r.random() < 0.3:
                return r.uniform(4, 40), r.uniform(0.3, 2)
            return r.uniform(0.1, 0.8), r.uniform(0.05, 0.3)
        if scene == "Video streaming":
            if elapsed % 4 < 1.6:  # chunked segment fetches
                return r.uniform(18, 30), r.uniform(0.4, 0.8)
            return r.uniform(0.1, 0.4), r.uniform(0.05, 0.15)
        if scene == "Large download":
            ramp = min(1.0, elapsed / 3)
            return ramp * r.uniform(240, 320), ramp * r.uniform(4, 7)
        if scene == "Upload":
            ramp = min(1.0, elapsed / 3)
            return ramp * r.uniform(1.5, 3), ramp * r.uniform(30, 45)
        if scene == "Speed test":
            if elapsed < 10:
                return r.uniform(380, 480), r.uniform(6, 10)
            if elapsed < 20:
                return r.uniform(2, 5), r.uniform(45, 60)
            return background
        return background

    def run(self, stop: threading.Event) -> None:
        calc = RateCalculator()
        rx_b = tx_b = rx_p = tx_p = 0
        start = last = time.monotonic()
        cycle = sum(d for _, d in self.SCENES)
        current = None
        while True:
            now = time.monotonic()
            pos = (now - start) % cycle
            for scene, duration in self.SCENES:
                if pos < duration:
                    break
                pos -= duration
            if scene != current:
                current = scene
                self.hub.status("demo", f"Demo mode · {scene}")

            dt = now - last
            last = now
            down, up = self.traffic(scene, pos)
            down_bps, up_bps = down * 1e6 / 8, up * 1e6 / 8
            # Data packets ~1400 B, plus TCP ACKs (~66 B) for the other direction.
            rx_data, tx_data = down_bps / 1400, up_bps / 1400
            rx_acks, tx_acks = tx_data * 0.5, rx_data * 0.5
            rx_b += int((down_bps + rx_acks * 66) * dt)
            tx_b += int((up_bps + tx_acks * 66) * dt)
            rx_p += int((rx_data + rx_acks + self.rng.uniform(5, 25)) * dt)
            tx_p += int((tx_data + tx_acks + self.rng.uniform(5, 20)) * dt)

            rates = calc.update(Sample(now, rx_b, tx_b, rx_p, tx_p))
            if rates is not None:
                self.hub.metrics(rates)
            if stop.wait(self.interval):
                break


# --------------------------------------------------------------------------
# HTTP server
# --------------------------------------------------------------------------

def make_handler(hub: Hub, stop: threading.Event):
    class Handler(BaseHTTPRequestHandler):
        server_version = "RouterOrchestra/0.1"

        def do_GET(self) -> None:
            path = self.path.split("?", 1)[0]
            if path == "/events":
                self._events()
            else:
                self._static("index.html" if path == "/" else path.lstrip("/"))

        def _static(self, name: str) -> None:
            file = (STATIC_DIR / name).resolve()
            if STATIC_DIR not in file.parents or not file.is_file():
                self.send_error(404)
                return
            body = file.read_bytes()
            self.send_response(200)
            self.send_header(
                "Content-Type", CONTENT_TYPES.get(file.suffix, "application/octet-stream")
            )
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)

        def _send_event(self, event: str, data) -> None:
            self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
            self.wfile.flush()

        def _events(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            q, status, history = hub.subscribe()
            try:
                self.wfile.write(b"retry: 3000\n\n")
                self._send_event("status", status)
                self._send_event("history", history)
                while not stop.is_set():
                    try:
                        event, data = q.get(timeout=15)
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        continue
                    self._send_event(event, data)
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                hub.unsubscribe(q)

        def log_message(self, format: str, *args) -> None:
            pass  # keep the terminal quiet; status is shown in the UI

    return Handler


class Server(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="orchestra.py",
        description="Router Orchestra — Listen to your Internet.",
    )
    p.add_argument("--host", help="router address or ~/.ssh/config alias")
    p.add_argument("--user", default="root", help="SSH user (default: root)")
    p.add_argument("--interface", default="wan", help="WAN interface (default: wan)")
    p.add_argument("--interval", type=float, default=1.0, help="sample interval in seconds (default: 1)")
    p.add_argument("--port", type=int, default=8765, help="HTTP port (default: 8765)")
    p.add_argument("--bind", default="127.0.0.1", help="HTTP bind address (default: 127.0.0.1)")
    p.add_argument("--demo", action="store_true", help="simulated traffic, no router needed")
    args = p.parse_args(argv)

    if not args.demo and not args.host:
        p.error("--host is required (or use --demo)")
    if not INTERFACE_RE.match(args.interface):
        p.error(f"invalid interface name: {args.interface!r}")
    if not 0.2 <= args.interval <= 10:
        p.error("--interval must be between 0.2 and 10 seconds")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    stop = threading.Event()
    history_len = max(2, int(HISTORY_SECONDS / args.interval) + 1)

    if args.demo:
        info = {"mode": "demo", "interval": args.interval, "target": "simulated"}
    else:
        target = f"{args.user}@{args.host}" if args.user else args.host
        info = {"mode": "router", "interval": args.interval, "target": f"{target} · {args.interface}"}
    hub = Hub(info, history_len)
    if args.demo:
        collector = DemoCollector(hub, args.interval)
    else:
        collector = SSHCollector(hub, args.host, args.user, args.interface, args.interval)

    try:
        server = Server((args.bind, args.port), make_handler(hub, stop))
    except OSError as e:
        print(f"Cannot listen on {args.bind}:{args.port}: {e}", file=sys.stderr)
        print("Try another port, e.g. --port 8766", file=sys.stderr)
        return 1

    worker = threading.Thread(target=collector.run, args=(stop,), daemon=True)
    worker.start()

    host = "127.0.0.1" if args.bind in ("0.0.0.0", "") else args.bind
    print("Router Orchestra — Listen to your Internet.")
    print(f"  source: {info['target']} ({info['mode']})")
    print(f"  open:   http://{host}:{args.port}")
    print("  Ctrl-C to quit")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print()
    finally:
        stop.set()
        server.server_close()
        worker.join(timeout=3)
    return 0


if __name__ == "__main__":
    sys.exit(main())
