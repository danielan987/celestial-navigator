"""Local progressive FITS processing with tiny status and immutable binary assets."""
import gzip
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import threading
from concurrent.futures import ThreadPoolExecutor
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

from astropy.io import fits
from astropy.table import Table
from astropy.wcs import WCS
from astropy_healpix import HEALPix
import numpy as np
import requests

from analysis import FEATURES, feature_map
from assets import Assets
from metrics import CURRENT, Measurements, count
from storage import Downloads, KeyLocks
from subsets import sample_tile, required_channels, cache_array, open_cube

REPO = Path(__file__).resolve().parents[1]
CACHE = Path(os.environ.get('SCIENCE_CACHE', REPO.parent / 'work' / 'science-cache'))
CACHE.mkdir(parents=True, exist_ok=True)
TARGETS = {t['id']: t for t in json.loads((REPO / 'src/api/mock/targets.json').read_text())}
HIPS = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube'
CUBES = 'https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/hips5_cube/hips_20261026'
SETTINGS = dict(source=CUBES, features=FEATURES, pixels=64, fieldDeg=.1,
                projection='TAN', interpolation='nearest', mask='mask-v1', floatPrecision=64)
SETTINGS_ID = hashlib.sha256(json.dumps(SETTINGS, sort_keys=True).encode()).hexdigest()[:16]
HP = HEALPix(nside=32, order='nested', frame='icrs')
JOBS = {}
LOCK = threading.Lock()
POOL = ThreadPoolExecutor(max_workers=2)
PREPARED_LOCKS = KeyLocks()
DOWNLOADS = Downloads(CACHE, limit=3)
ASSETS = Assets(CACHE / 'assets')
ALIGNED_MEMORY = OrderedDict()
MEMORY_LOCK = threading.Lock()

def remember_cube(identity, cube):
    cube.flags.writeable = False
    with MEMORY_LOCK:
        ALIGNED_MEMORY[identity] = cube
        ALIGNED_MEMORY.move_to_end(identity)
        while len(ALIGNED_MEMORY) > 3:
            ALIGNED_MEMORY.popitem(last=False)
    return cube



def grid(target, size=64, fov=.1):
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ['RA---TAN', 'DEC--TAN']
    wcs.wcs.crval = [target['ra'], target['dec']]
    wcs.wcs.crpix = [(size + 1) / 2] * 2
    wcs.wcs.cdelt = [-fov / size, fov / size]
    yy, xx = np.indices((size, size))
    return wcs, wcs.pixel_to_world(xx, yy)


def values(array):
    # Preserve full float64 precision and NaNs; the binary validity mask represents gaps.
    return np.flipud(array).reshape(-1)


def atomic_json(path, data):
    temporary = path.with_name(path.name + f'.{threading.get_ident()}.part')
    temporary.write_text(json.dumps(data, allow_nan=False, separators=(',', ':')))
    temporary.replace(path)


def publish(key, result, status, meter, stage):
    url = ASSETS.manifest(result)
    snapshot = dict(status=status, stage=stage, resultUrl=url, metrics=meter.snapshot())
    if status == 'ready':
        atomic_json(CACHE / f'{key}.job.json', snapshot)
    with LOCK:
        JOBS[key] = snapshot


def aligned_cube(target, waves, z, sky, on_chemistry):
    identity = hashlib.sha256(json.dumps([CUBES, target['ra'], target['dec'], 64, .1, 'mask-v1']).encode()).hexdigest()
    path = CACHE / f'aligned-{identity}.npz'
    with PREPARED_LOCKS.for_key(path):
        with MEMORY_LOCK:
            if identity in ALIGNED_MEMORY:
                cube = ALIGNED_MEMORY[identity]
                ALIGNED_MEMORY.move_to_end(identity)
                count('aligned_memory_hits')
                return cube
        if path.exists():
            count('aligned_cache_hits')
            with np.load(path, allow_pickle=False) as saved:
                return remember_cube(identity, saved['cube'])
        cube = np.full((len(waves), *sky.shape), np.nan)
        pixels = HP.skycoord_to_healpix(sky)
        needed = required_channels(waves, FEATURES, z)
        tile_urls = {int(tile): f'{CUBES}/Norder5/Dir{int(tile)//10000*10000}/Npix{tile}_cube.fits' for tile in np.unique(pixels)}
        def read(channels):
            for tile, url in tile_urls.items():
                inside, samples = sample_tile(url, sky, pixels == tile, channels,
                    CACHE / 'subsets', CACHE / f'Npix{tile}_cube.fits')
                for i, channel in enumerate(channels):
                    cube[channel, inside] = samples[i]
        read(needed)
        on_chemistry(cube)
        read(sorted(set(range(len(waves))) - set(needed) - {50, 51}))
        provenance = json.dumps(dict(source=list(tile_urls.values()), wavelengths=waves.tolist(),
            mask=SETTINGS['mask'], interpolation=SETTINGS['interpolation'], ra=target['ra'], dec=target['dec'],
            fieldDeg=.1, pixels=64, variance='not provided in HiPS cube; no uncertainty inferred'))
        cache_array(path, cube=cube, provenance=np.array(provenance))
        return remember_cube(identity, cube)


def galex_field(target, sky):
    identity = hashlib.sha256(json.dumps([target['ra'], target['dec'], 64, .1, 'galex-fuv-bilinear-v1']).encode()).hexdigest()
    cached = CACHE / f'galex-aligned-{identity}.npz'
    metadata = cached.with_suffix('.json')
    with PREPARED_LOCKS.for_key(cached):
        if cached.exists() and metadata.exists():
            count('galex_cache_hits')
            with np.load(cached, allow_pickle=False) as saved:
                return {**json.loads(metadata.read_text()), 'values': values(saved['image'])}
        # Migrate a proven existing aligned field without another upstream download.
        for version in ('v5', 'v4', 'v3'):
            previous = CACHE / f'{version}-{target["id"]}-0.00000-30.0.json'
            if not previous.exists():
                continue
            old = json.loads(previous.read_text())
            if old.get('ra') == target['ra'] and old.get('dec') == target['dec'] and old.get('fieldSizeDeg') == .1 and old.get('galex'):
                old = old['galex']
                image = np.flipud(np.asarray(old['values'], dtype=float).reshape(sky.shape))
                info = {k: old[k] for k in ('source', 'unit')}
                cache_array(cached, image=image); atomic_json(metadata, info)
                count('galex_cache_hits')
                return {**info, 'values': values(image)}
        response = requests.get('https://irsa.ipac.caltech.edu/SIA', params={
            'POS': f"CIRCLE {target['ra']} {target['dec']} 0.000278", 'COLLECTION': 'spitzer_lvl', 'MAXREC': 100}, timeout=(20, 60))
        response.raise_for_status(); count('download_bytes', len(response.content))
        table = Table.read(io.BytesIO(response.content), format='votable', use_names_over_ids=True)
        matches = [row for row in table if str(row['instrument_name']) == 'GALEX'
            and str(row['energy_bandpassname']) == 'FUV' and str(row['dataproduct_subtype']) == 'science']
        if matches:
            url = str(matches[0]['access_url'])
            if urlparse(url).scheme != 'https' or urlparse(url).hostname != 'irsa.ipac.caltech.edu':
                raise ValueError('Unexpected GALEX archive host')
            legacy = CACHE / f'galex-{target["id"]}.fits'
            opened = open_cube(legacy if legacy.exists() else url)
        else:
            query = urlencode(dict(hips='CDS/P/GALEXGR6/AIS/FUV', width=64, height=64,
                fov=.1, projection='TAN', coordsys='icrs', ra=target['ra'], dec=target['dec'], format='fits'))
            url = f'https://alasky.cds.unistra.fr/hips-image-services/hips2fits?{query}'
            response = requests.get(url, timeout=(20, 60)); response.raise_for_status()
            count('download_bytes', len(response.content))
            opened = fits.open(io.BytesIO(response.content))
        from scipy.ndimage import map_coordinates
        with opened as hdul:
            header = hdul[0].header
            gx, gy = WCS(header).celestial.world_to_pixel(sky)
            finite = np.isfinite(gx) & np.isfinite(gy)
            if not finite.any():
                raise ValueError('No GALEX FUV coverage in this field')
            ny, nx = hdul[0].shape
            x0, x1 = max(0, int(np.floor(gx[finite].min()))-1), min(nx, int(np.ceil(gx[finite].max()))+2)
            y0, y1 = max(0, int(np.floor(gy[finite].min()))-1), min(ny, int(np.ceil(gy[finite].max()))+2)
            if x1 <= x0 or y1 <= y0:
                raise ValueError('No GALEX FUV coverage in this field')
            raw = hdul[0].section[y0:y1, x0:x1]
            image = map_coordinates(raw.astype(float), [gy-y0, gx-x0], order=1, mode='constant', cval=np.nan)
            if not np.isfinite(image).any():
                raise ValueError('No GALEX FUV coverage in this field')
            cache_array(CACHE / f'galex-raw-subset-{identity}.npz', image=raw,
                x0=np.array(x0), y0=np.array(y0), header=np.array(header.tostring()), source=np.array(url))
            info = dict(source=url, unit=header.get('BUNIT') or 'native survey intensity')
        cache_array(cached, image=image); atomic_json(metadata, info)
        return {**info, 'values': values(image)}


def run(target_id, z, radius, key):
    meter = Measurements(); token = CURRENT.set(meter)
    try:
        target = TARGETS[target_id]
        wcs, sky = grid(target)
        properties = DOWNLOADS.fetch(f'{HIPS}/properties', 'properties.txt', release=CUBES)
        props = dict(line.split('=', 1) for line in properties.read_text().splitlines() if '=' in line and not line.startswith('#'))
        props = {k.strip(): v.strip() for k, v in props.items()}
        waves = np.array(props['data_cube_crval3_arr'].split(), float)
        tiles = np.unique(HP.skycoord_to_healpix(sky))
        result = dict(targetId=target_id, width=64, height=64, fieldSizeDeg=.1,
            ra=target['ra'], dec=target['dec'], redshift=z, apertureArcsec=radius,
            annulusArcsec=[radius*2, radius*3], wavelengths=waves.tolist(), maps=[], medianValues=None,
            sources=[f'{CUBES}/Norder5/Dir{int(tile)//10000*10000}/Npix{tile}_cube.fits' for tile in tiles],
            galex=None, galexPending=True, galexError=None,
            provenance=dict(settings=SETTINGS, settingsId=SETTINGS_ID, wcs=wcs.to_header().tostring(),
                            uncertainty='not available in HiPS cube; no significance inferred'))
        def chemistry(cube):
            result['maps'] = []
            for feature in FEATURES:
                image, index, continuum = feature_map(cube, waves, feature, z)
                result['maps'].append({**feature, 'observed': float(waves[index]), 'channel': index,
                    'continuum': waves[continuum].tolist(), 'values': values(image),
                    'unit': 'MJy/sr excess' if feature['kind'] == 'emission' else 'apparent optical depth'})
            meter.mark('chemistry_ready_ms')
            publish(key, result, 'loading', meter, 'chemistry')
        cube = aligned_cube(target, waves, z, sky, chemistry)
        if not result['maps']:
            chemistry(cube)
        result['medianValues'] = values(np.nanmedian(cube, axis=0))
        meter.mark('median_ready_ms'); publish(key, result, 'loading', meter, 'median')
        try:
            result['galex'] = galex_field(target, sky)
        except Exception as exc:
            result['galexError'] = str(exc)
        result['galexPending'] = False
        meter.mark('total_ms'); publish(key, result, 'ready', meter, 'complete')
    except Exception as exc:
        logging.exception('Processing failed')
        with LOCK:
            previous = JOBS.get(key, {})
            JOBS[key] = {**previous, 'status': 'error', 'error': str(exc), 'metrics': meter.snapshot()}
    finally:
        CURRENT.reset(token)


class Handler(BaseHTTPRequestHandler):
    def send_asset(self, name):
        path = ASSETS.path(name)
        compressed = 'gzip' in self.headers.get('Accept-Encoding', '')
        etag = '"' + name + ('-gzip' if compressed else '') + '"'
        if self.headers.get('If-None-Match') == etag:
            self.send_response(304)
            self.send_header('ETag', etag); self.send_header('Cache-Control', 'public, max-age=31536000, immutable')
            self.send_header('Vary', 'Accept-Encoding'); self.end_headers(); return
        payload = path.with_name(path.name + '.gz').read_bytes() if compressed else path.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json' if name.endswith('.json') else 'application/octet-stream')
        self.send_header('Content-Length', str(len(payload))); self.send_header('ETag', etag)
        self.send_header('Cache-Control', 'public, max-age=31536000, immutable')
        self.send_header('Vary', 'Accept-Encoding')
        if compressed:
            self.send_header('Content-Encoding', 'gzip')
        self.end_headers(); self.wfile.write(payload)

    def do_GET(self):
        request = urlparse(self.path)
        try:
            if request.path.startswith('/science/assets/'):
                self.send_asset(request.path.removeprefix('/science/assets/')); return
            if request.path != '/science/extract':
                self.send_error(404); return
            params = parse_qs(request.query)
            target = params.get('target', [''])[0]
            if 'ra' in params and 'dec' in params:
                # Added for Celestial Navigator's uncharted spots: any position, by ra/dec in
                # degrees, named like the on-demand backend's spots (spot_<ra>_<dec>, 0.0001°).
                ra, dec = float(params['ra'][0]), float(params['dec'][0])
                if not (np.isfinite(ra) and np.isfinite(dec) and 0 <= ra < 360 and -90 <= dec <= 90):
                    raise ValueError('ra must be 0–360 and dec −90–90 degrees')
                ra, dec = round(ra, 4) % 360, round(dec, 4) + 0.0
                target = f'spot_{ra:.4f}_{dec:.4f}'
                with LOCK:
                    TARGETS.setdefault(target, dict(id=target, name=target, ra=ra, dec=dec))
            if target not in TARGETS:
                raise ValueError('Choose a catalogued target')
            z = round(float(params.get('z', ['0'])[0]), 5)
            radius = round(float(params.get('radius', ['30'])[0]), 1)
            if not np.isfinite(z) or not 0 <= z <= .02 or not np.isfinite(radius) or not 15 <= radius <= 50:
                raise ValueError('Redshift must be 0–0.02; aperture radius 15–50 arcsec')
            key = f'v6-{SETTINGS_ID}-{target}-{z:.5f}-{radius:.1f}'
            with LOCK:
                pointer = CACHE / f'{key}.job.json'
                if key not in JOBS and pointer.exists():
                    JOBS[key] = {**json.loads(pointer.read_text()), 'cacheHit': True}
                if key not in JOBS or (JOBS[key]['status'] == 'error' and params.get('retry') == ['1']):
                    JOBS[key] = dict(status='loading', stage='queued')
                    POOL.submit(run, target, z, radius, key)
                payload = json.dumps(JOBS[key], allow_nan=False, separators=(',', ':')).encode()
            self.send_response(200)
        except FileNotFoundError:
            self.send_error(404); return
        except (ValueError, KeyError) as exc:
            payload = json.dumps(dict(status='error', error=str(exc))).encode(); self.send_response(400)
        self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(payload)

    def log_message(self, format, *args):
        if args and str(args[1]) not in ('200', '304'):
            super().log_message(format, *args)


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    ThreadingHTTPServer(('127.0.0.1', 8001), Handler).serve_forever()
