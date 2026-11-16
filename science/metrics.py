"""Per-job measurements shared safely with bounded I/O worker threads."""
from contextvars import ContextVar
import threading
import time

CURRENT = ContextVar('science_metrics', default=None)

class Measurements:
    def __init__(self):
        self.started = time.perf_counter()
        self.lock = threading.Lock()
        self.data = {}

    def add(self, name, value=1):
        with self.lock:
            self.data[name] = self.data.get(name, 0) + value

    def mark(self, name):
        with self.lock:
            self.data[name] = round((time.perf_counter() - self.started) * 1000, 2)

    def snapshot(self):
        with self.lock:
            return dict(self.data)


def count(name, amount=1):
    meter = CURRENT.get()
    if meter:
        meter.add(name, amount)
