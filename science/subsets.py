"""Range-read small, sky-aligned subsets without downloading complete FITS cubes."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, nullcontext
from contextvars import copy_context
import base64
import io
import ssl
import certifi
import hashlib
import json
import logging
from pathlib import Path
import threading
import time

import astropy.units as u
from astropy.io import fits
from astropy.wcs import WCS
import numpy as np
from metrics import count

BAD_BITS = (0, 1, 2, 6, 7, 9, 10, 11, 14, 15, 17, 19, 20, 22, 23, 24, 25, 26, 27, 28)
BAD_MASK = sum(1 << bit for bit in BAD_BITS)


def required_channels(waves, features, redshift):
    channels = set()
    for feature in features:
        channels.add(int(np.argmin(abs(waves - feature['wave'] * (1 + redshift)))))
        for side in ('left', 'right'):
            lo, hi = np.array(feature[side]) * (1 + redshift)
            channels.update(np.where((waves >= lo) & (waves <= hi))[0].tolist())
    return sorted(channels - {50, 51})


TRANSFER_BYTES = 0
METRIC_LOCK = threading.Lock()
REMOTE_SLOTS = threading.BoundedSemaphore(4)
TLS = ssl.create_default_context(cafile=certifi.where())


@contextmanager
def open_cube(source):
    global TRANSFER_BYTES
    remote = not isinstance(source, Path) and str(source).startswith('https://')
    kwargs = dict(use_fsspec=True, fsspec_kwargs={
        'block_size': 65536, 'cache_type': 'blockcache', 'ssl': TLS,
        'cache_options': {'maxblocks': 32}}, memmap=False) if remote else dict(memmap=True)
    with (REMOTE_SLOTS if remote else nullcontext()), fits.open(source, **kwargs) as hdul:
        try:
            yield hdul
        finally:
            if remote:
                cache = getattr(hdul._file._file, 'cache', None)
                count = getattr(cache, 'total_requested_bytes', 0)
                with METRIC_LOCK:
                    TRANSFER_BYTES += count
                from metrics import count as record_count
                record_count('range_bytes', count)


def section_records(hdul, channels, x, y):
    """Retain unmodified native IMAGE, NHITS, FLAGS and optional VARIANCE samples."""
    y0, y1 = int(y.min()), int(y.max()) + 1
    names = ['IMAGE', 'NHITS', 'FLAGS'] + (['VARIANCE'] if 'VARIANCE' in hdul else [])
    records = {name: [] for name in names}
    for channel in channels:
        for name in names:
            strip = hdul[name].section[channel, y0:y1, :]
            records[name].append(strip[y-y0, x])
    return {name: np.stack(rows) for name, rows in records.items()}


def masked_samples(records):
    samples = records['IMAGE'].astype(float)
    samples[(records['NHITS'] <= 0) | ((records['FLAGS'] & BAD_MASK) != 0)] = np.nan
    return samples


def section_samples(hdul, channels, x, y):
    return masked_samples(section_records(hdul, channels, x, y))


def cache_array(path, **arrays):
    temporary = path.with_name(path.name + f'.{threading.get_ident()}.part')
    try:
        with temporary.open('wb') as out:
            np.savez_compressed(out, **arrays)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def sample_tile(url, sky, tile_mask, channels, cache_dir, local_file=None):
    """Return [channels, covered output pixels], using existing full files if present."""
    cache_dir = Path(cache_dir); cache_dir.mkdir(parents=True, exist_ok=True)
    identity = hashlib.sha256(url.encode()).hexdigest()
    metadata = cache_dir / f'{identity}.json'
    source = local_file if local_file is not None and Path(local_file).exists() else url
    meta = json.loads(metadata.read_text()) if metadata.exists() else {}
    if meta.get('metadataVersion') == 2:
        spatial = WCS(fits.Header.fromstring(meta['header'], sep='\n'))
    else:
        with open_cube(source) as hdul:
            spatial = WCS(hdul['IMAGE'].header, fobj=hdul).celestial
            tables = {}
            for name in ('WCS-WAVE', 'SPECTRAL_CHANNELS'):
                if name in hdul:
                    stream = io.BytesIO()
                    fits.HDUList([fits.PrimaryHDU(), hdul[name].copy()]).writeto(stream)
                    tables[name] = base64.b64encode(stream.getvalue()).decode()
            meta = dict(metadataVersion=2, source=url, header=spatial.to_header().tostring(sep='\n'),
                        originalHeader=hdul['IMAGE'].header.tostring(sep='\n'),
                        extensionHeaders={name: hdul[name].header.tostring(sep='\n') for name in ('NHITS', 'FLAGS', 'VARIANCE') if name in hdul},
                        spectralTablesFitsBase64=tables,
                        uncertainty='VARIANCE retained when supplied; absent otherwise',
                        shape=list(hdul['IMAGE'].shape), unit=hdul['IMAGE'].header['BUNIT'])
        temp = metadata.with_name(metadata.name + f'.{threading.get_ident()}.part')
        temp.write_text(json.dumps(meta)); temp.replace(metadata)
    x, y = spatial.world_to_pixel(sky)
    finite = np.isfinite(x) & np.isfinite(y)
    x = np.rint(np.where(finite, x, -1)).astype(int)
    y = np.rint(np.where(finite, y, -1)).astype(int)
    shape = meta['shape']
    if channels and max(channels) >= shape[0]:
        raise ValueError('Requested channel is outside the FITS cube.')
    inside = tile_mask & finite & (x >= 0) & (x < shape[2]) & (y >= 0) & (y < shape[1])
    if not inside.any() or not channels:
        return inside, np.empty((len(channels), 0))
    xx, yy = x[inside], y[inside]
    # Identity includes native sample coordinates and channels, independent of query order.
    digest = hashlib.sha256(identity.encode() + xx.tobytes() + yy.tobytes() + np.array(channels, dtype=np.int32).tobytes() + b'mask-v2-raw').hexdigest()
    cached = cache_dir / f'{digest}.npz'
    if cached.exists():
        count('subset_cache_hits')
        with np.load(cached, allow_pickle=False) as saved:
            return inside, saved['samples']
    started = time.monotonic()
    chunks = [part.tolist() for part in np.array_split(channels, min(4, len(channels))) if len(part)]
    def read(chunk):
        with open_cube(source) as hdul:
            return section_records(hdul, chunk, xx, yy)
    with ThreadPoolExecutor(max_workers=4) as pool:
        tasks = [pool.submit(copy_context().run, read, chunk) for chunk in chunks]
        records = [task.result() for task in tasks]
    raw = {name: np.concatenate([record[name] for record in records], axis=0) for name in records[0]}
    raw_dir = cache_dir / 'raw'; raw_dir.mkdir(exist_ok=True)
    cache_array(raw_dir / f'{digest}.npz', **raw, x=xx, y=yy, channels=np.array(channels),
                metadata=np.array(str(metadata.name)), source=np.array(url))
    samples = masked_samples(raw)
    samples *= (1 * u.Unit(meta['unit'])).to_value(u.MJy / u.sr)
    cache_array(cached, samples=samples)
    logging.info('Subset: %d channels × %d sky samples in %.2fs (%s)', len(channels), len(xx), time.monotonic()-started, 'local' if source != url else 'HTTP ranges')
    return inside, samples
