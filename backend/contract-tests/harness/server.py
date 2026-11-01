"""Lifecycle of the server under test: start with a given environment, wait until ready, kill."""

from __future__ import annotations

import queue
import re
import subprocess
import threading
import time
from pathlib import Path

from .client import http_request


class ServerStartError(RuntimeError):
    def __init__(self, message: str, port_in_use: bool = False):
        super().__init__(message)
        # The server could not bind its port (taken by another process): worth a retry elsewhere.
        self.port_in_use = port_in_use


# How the Rust server and the Go/Fiber server report a port that is already taken.
_PORT_IN_USE = re.compile(r"address already in use|Failed to bind|os error (98|48|10048)", re.IGNORECASE)


class ServerProcess:
    def __init__(self, binary: str, env: dict[str, str], workdir: Path, log_path: Path, port: int):
        self.binary = binary
        self.env = env
        self.workdir = workdir
        self.log_path = log_path
        self.port = port
        self.proc: subprocess.Popen | None = None
        self._log = None

    def start(self) -> None:
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self._log = open(self.log_path, "wb")
        try:
            self.proc = subprocess.Popen(
                [self.binary],
                cwd=str(self.workdir),  # empty directory: the Go server would otherwise load ./.env
                env=self.env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
            )
        except OSError as exc:
            self._log.close()
            raise ServerStartError(f"cannot start {self.binary}: {exc}") from exc
        # The server logs every request synchronously; a slow log file (e.g. scanned by an antivirus
        # on every write) would add latency to responses. Drain the pipe into memory and write the
        # file from a separate thread so the server never waits for the disk.
        self._queue: queue.Queue[bytes | None] = queue.Queue()
        self._reader = threading.Thread(target=self._read_output, name="server-log-reader", daemon=True)
        self._writer = threading.Thread(target=self._write_output, name="server-log-writer", daemon=True)
        self._reader.start()
        self._writer.start()

    def _read_output(self) -> None:
        assert self.proc and self.proc.stdout
        stream = self.proc.stdout
        try:
            for chunk in iter(lambda: stream.read1(65536), b""):
                self._queue.put(chunk)
        except (OSError, ValueError):
            pass
        finally:
            self._queue.put(None)

    def _write_output(self) -> None:
        log = self._log
        while True:
            chunk = self._queue.get()
            if chunk is None:
                break
            if log:
                log.write(chunk)
        if log:
            log.flush()

    def wait_ready(self, timeout: float = 90.0) -> float:
        """Poll `GET /` until it answers 200; returns the startup time in seconds."""
        started = time.time()
        deadline = started + timeout
        while time.time() < deadline:
            if self.proc and self.proc.poll() is not None:
                code = self.proc.returncode
                tail = self.log_tail()
                raise ServerStartError(
                    f"server exited with code {code} during startup (log: {self.log_path})"
                    + "".join(f"\n      | {line}" for line in tail),
                    port_in_use=any(_PORT_IN_USE.search(line) for line in tail),
                )
            try:
                res = http_request("127.0.0.1", self.port, "GET", "/", timeout=2.0)
                if res.status == 200:
                    return time.time() - started
            except OSError:
                pass
            time.sleep(0.05)
        raise ServerStartError(f"server not ready after {timeout:.0f}s (log: {self.log_path})")

    def log_tail(self, lines: int = 8) -> list[str]:
        """The last lines the (exited) server wrote, once its output has been flushed to the log."""
        self._reader.join(5)
        self._writer.join(5)
        try:
            text = self.log_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return []
        return [line for line in text.splitlines() if line.strip()][-lines:]

    def stop(self) -> None:
        if self.proc:
            if self.proc.poll() is None:
                self.proc.kill()
            try:
                self.proc.wait(15)
            except subprocess.TimeoutExpired:
                pass
            self._reader.join(10)
            self._writer.join(10)
            if self.proc.stdout:
                self.proc.stdout.close()
            self.proc = None
        if self._log:
            self._log.close()
            self._log = None
