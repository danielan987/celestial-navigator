"""Immutable JSON metadata and lossless little-endian float64/mask assets."""
import gzip
import hashlib
import json
from pathlib import Path
import struct
import threading

import numpy as np

HEADER = struct.Struct('<4s7I')

def encode_array(values, width, height):
    arr = np.asarray(values, dtype='<f8').reshape(-1)
    if len(arr) != width * height:
        raise ValueError('Array dimensions do not match metadata.')
    valid = np.isfinite(arr)
    mask = np.packbits(valid, bitorder='little').tobytes()
    header = HEADER.pack(b'CNAR', 1, width, height, 8, len(mask), len(arr), 0)
    return header + np.where(valid, arr, 0).astype('<f8').tobytes() + mask


class Assets:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def write(self, content, extension):
        digest = hashlib.sha256(content).hexdigest()
        name = digest + extension
        path = self.root / name
        if not path.exists():
            temporary = path.with_name(name + f'.{threading.get_ident()}.part')
            temporary.write_bytes(content); temporary.replace(path)
        compressed = path.with_name(name + '.gz')
        if not compressed.exists():
            temporary = compressed.with_name(compressed.name + f'.{threading.get_ident()}.part')
            temporary.write_bytes(gzip.compress(content, compresslevel=6, mtime=0))
            temporary.replace(compressed)
        return f'/science/assets/{name}'

    def array(self, values, width, height):
        payload = encode_array(values, width, height)
        return dict(url=self.write(payload, '.bin'), width=width, height=height,
                    dtype='float64-le', validity='bitset-lsb', bytes=len(payload))

    def manifest(self, result):
        width, height = result['width'], result['height']
        metadata = {k: v for k, v in result.items() if k not in ('maps', 'medianValues', 'galex')}
        metadata['medianArray'] = self.array(result['medianValues'], width, height) if result.get('medianValues') is not None else None
        metadata['maps'] = [{**{k: v for k, v in item.items() if k != 'values'},
                             'array': self.array(item['values'], width, height)} for item in result['maps']]
        metadata['galex'] = ({**{k: v for k, v in result['galex'].items() if k != 'values'},
                               'array': self.array(result['galex']['values'], width, height)} if result.get('galex') else None)
        payload = json.dumps(metadata, allow_nan=False, separators=(',', ':')).encode()
        return self.write(payload, '.json')

    def path(self, name):
        if len(name) not in (68, 69) or name.split('.')[0].strip('0123456789abcdef') or not name.endswith(('.bin', '.json')):
            raise ValueError('Invalid asset name.')
        path = self.root / name
        if not path.exists():
            raise FileNotFoundError(name)
        return path
