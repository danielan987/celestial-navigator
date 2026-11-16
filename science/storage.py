"""Atomic raw-file downloads: deduplicated per path, independently concurrent."""
import hashlib
import json
from pathlib import Path
import threading
import time

import requests
from metrics import count

class KeyLocks:
    def __init__(self):
        self.guard = threading.Lock()
        self.locks = {}

    def for_key(self, key):
        with self.guard:
            return self.locks.setdefault(str(key), threading.Lock())

class Downloads:
    def __init__(self, root, limit=3):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.slots = threading.BoundedSemaphore(limit)
        self.locks = KeyLocks()

    def cache_path(self, url, name, release=None):
        identity = hashlib.sha256(json.dumps([url, release], separators=(',', ':')).encode()).hexdigest()
        folder = self.root / 'raw-downloads'
        folder.mkdir(exist_ok=True)
        return folder / f'{identity}-{Path(name).name}'

    def fetch(self, url, name, release=None):
        path = self.cache_path(url, name, release)
        with self.locks.for_key(path):
            if path.exists():
                count('raw_cache_hits')
                return path
            with self.slots:
                temporary = path.with_name(path.name + '.part')
                digest = hashlib.sha256()
                size = 0
                try:
                    with requests.get(url, stream=True, timeout=(20, 180)) as response:
                        response.raise_for_status()
                        with temporary.open('wb') as output:
                            for block in response.iter_content(1024 * 1024):
                                output.write(block); digest.update(block); size += len(block)
                        provenance = dict(source=url, release=release, bytes=size, sha256=digest.hexdigest(),
                                          etag=response.headers.get('ETag'),
                                          lastModified=response.headers.get('Last-Modified'),
                                          fetchedAt=time.time())
                    temporary.replace(path)
                    manifest = path.with_name(path.name + '.source.json')
                    pending = manifest.with_name(manifest.name + '.part')
                    pending.write_text(json.dumps(provenance)); pending.replace(manifest)
                    count('download_bytes', size)
                    return path
                finally:
                    temporary.unlink(missing_ok=True)
