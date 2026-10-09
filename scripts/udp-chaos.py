#!/usr/bin/env python3
"""Local UDP network-condition proxy; one proxy listen port per Unity client.

Example: python3 udp-chaos.py --listen 127.0.0.1:7781 --target 127.0.0.1:7777 \
    --delay-ms 75 --jitter-ms 20 --loss .03 --seed 41

Delay and random loss apply independently in each direction. 75ms gives ~150ms
added RTT. The first client address is pinned for the process lifetime; another
client/source port cannot steal its replies. Send SIGUSR1 immediately before
deliberately reconnecting with a new source port to clear the pinned binding. This is a test tool, not a
public relay. JSON counters are printed on startup, periodically and on exit.
"""
import argparse
import asyncio
import json
import random
import signal
import socket
import time


def endpoint(value):
    try:
        host, port = value.rsplit(":", 1)
        port = int(port)
        if not host or not 0 < port < 65536:
            raise ValueError()
        return host, port
    except ValueError as exc:
        raise argparse.ArgumentTypeError("expected IPv4-host:port, port 1..65535") from exc


class ChaosProxy(asyncio.DatagramProtocol):
    def __init__(self, target, delay_ms, jitter_ms, loss, seed):
        self.target = target
        self.delay = delay_ms / 1000
        self.jitter = jitter_ms / 1000
        self.loss = loss
        self.random = random.Random(seed)
        self.seed = seed
        self.transport = None
        self.client = None
        self.started = time.monotonic()
        self.pending = set()
        self.stats = {key: 0 for key in (
            "c2s_received", "s2c_received", "c2s_forwarded", "s2c_forwarded",
            "c2s_dropped", "s2c_dropped", "rejected_peers", "rejected_oversize",
            "queue_overflow", "transport_errors", "binding_resets")}

    def connection_made(self, transport):
        self.transport = transport
        self.report("started")

    def datagram_received(self, data, address):
        if len(data) > 4096:
            self.stats["rejected_oversize"] += 1
            return
        if address == self.target:
            if self.client is None:
                return
            direction, destination = "s2c", self.client
        else:
            if self.client is None:
                self.client = address
            if address != self.client:
                self.stats["rejected_peers"] += 1
                return
            direction, destination = "c2s", self.target
        self.stats[direction + "_received"] += 1
        if self.random.random() < self.loss:
            self.stats[direction + "_dropped"] += 1
            return
        if len(self.pending) >= 4096:
            self.stats["queue_overflow"] += 1
            self.stats[direction + "_dropped"] += 1
            return
        delay = max(0.0, self.delay + self.random.uniform(-self.jitter, self.jitter))
        handle = None

        def deliver():
            self.pending.discard(handle)
            if self.transport and not self.transport.is_closing():
                self.transport.sendto(data, destination)
                self.stats[direction + "_forwarded"] += 1

        handle = asyncio.get_running_loop().call_later(delay, deliver)
        self.pending.add(handle)

    def error_received(self, _error):
        self.stats["transport_errors"] += 1

    def report(self, event):
        print(json.dumps({"event": event, "elapsed_seconds": round(time.monotonic() - self.started, 3),
                          "listen": self.transport.get_extra_info("sockname") if self.transport else None,
                          "target": self.target, "client": self.client, "seed": self.seed,
                          "one_way_delay_ms": self.delay * 1000, "jitter_ms": self.jitter * 1000,
                          "configured_loss": self.loss, "pending": len(self.pending), **self.stats}), flush=True)

    def reset_binding(self):
        for handle in self.pending:
            handle.cancel()
        self.pending.clear()
        self.client = None
        self.stats["binding_resets"] += 1
        self.report("binding_reset")

    def close(self):
        for handle in self.pending:
            handle.cancel()
        self.pending.clear()
        self.report("stopped")
        if self.transport:
            self.transport.close()


async def run(args):
    loop = asyncio.get_running_loop()
    resolved = await loop.getaddrinfo(*args.target, family=socket.AF_INET, type=socket.SOCK_DGRAM)
    target = resolved[0][4]
    stop = asyncio.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signum, stop.set)
    _, proxy = await loop.create_datagram_endpoint(
        lambda: ChaosProxy(target, args.delay_ms, args.jitter_ms, args.loss, args.seed),
        local_addr=args.listen, family=socket.AF_INET)
    loop.add_signal_handler(signal.SIGUSR1, proxy.reset_binding)
    duration_handle = loop.call_later(args.duration, stop.set) if args.duration > 0 else None
    try:
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=args.report_seconds)
            except asyncio.TimeoutError:
                proxy.report("metrics")
    finally:
        if duration_handle:
            duration_handle.cancel()
        proxy.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--listen", type=endpoint, required=True)
    parser.add_argument("--target", type=endpoint, required=True)
    parser.add_argument("--delay-ms", type=float, default=75)
    parser.add_argument("--jitter-ms", type=float, default=20)
    parser.add_argument("--loss", type=float, default=.03)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--report-seconds", type=float, default=5)
    parser.add_argument("--duration", type=float, default=0, help="Stop after N seconds; zero runs until SIGINT/SIGTERM")
    args = parser.parse_args()
    import math
    if (not all(math.isfinite(v) for v in (args.delay_ms, args.jitter_ms, args.loss, args.report_seconds, args.duration))
            or not 0 <= args.delay_ms <= 10000 or not 0 <= args.jitter_ms <= 10000
            or not 0 <= args.loss <= 1 or args.report_seconds <= 0 or args.duration < 0):
        parser.error("invalid delay/jitter/loss/report/duration values")
    if args.listen == args.target:
        parser.error("listen and target must differ")
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
