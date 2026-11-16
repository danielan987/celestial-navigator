import gzip
import hashlib
import json
from pathlib import Path
import struct
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from http.server import ThreadingHTTPServer
import urllib.request
import urllib.error

import numpy as np

from assets import Assets, HEADER
from storage import Downloads

class AssetTests(unittest.TestCase):
    def test_lossless_binary_values_and_validity_mask(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Assets(directory)
            original = [1.2345678901234567, -0., None, np.nan, -42, 1e-100]
            asset = store.array(original, 3, 2)
            path = store.path(asset['url'].rsplit('/', 1)[1])
            payload = path.read_bytes()
            self.assertEqual(HEADER.unpack(payload[:32]), (b'CNAR', 1, 3, 2, 8, 1, 6, 0))
            values = np.frombuffer(payload, dtype='<f8', count=6, offset=32)
            mask = np.unpackbits(np.frombuffer(payload[-1:], dtype=np.uint8), bitorder='little')[:6]
            np.testing.assert_equal(mask, [1, 1, 0, 0, 1, 1])
            np.testing.assert_equal(values[[0, 1, 4, 5]], np.asarray(original, dtype=float)[[0, 1, 4, 5]])
            self.assertTrue(np.signbit(values[1]))
            self.assertEqual(gzip.decompress(path.with_name(path.name+'.gz').read_bytes()), payload)
            self.assertEqual(store.array(original, 3, 2)['url'], asset['url'])
            with self.assertRaises(ValueError):
                store.array([1], 3, 2)

    def test_metadata_references_arrays_instead_of_embedding_pixels(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Assets(directory)
            url = store.manifest(dict(width=2, height=1, maps=[dict(id='pah', values=[1., None])], medianValues=[2., 3.], galex=None))
            metadata = json.loads(store.path(url.rsplit('/', 1)[1]).read_text())
            self.assertNotIn('values', metadata['maps'][0])
            self.assertIn('array', metadata['maps'][0])
            self.assertNotIn('medianValues', metadata)

class DownloadTests(unittest.TestCase):
    def test_independent_downloads_overlap_but_duplicates_share_one_fetch(self):
        active = 0; maximum = 0; calls = {}; lock = threading.Lock()
        class Response:
            headers = {'ETag': 'test-version'}
            def raise_for_status(self): pass
            def __enter__(self):
                nonlocal active, maximum
                with lock:
                    active += 1; maximum = max(maximum, active)
                return self
            def __exit__(self, *args):
                nonlocal active
                with lock: active -= 1
            def iter_content(self, size):
                time.sleep(.03)
                yield b'original-fits-bytes'
        def fetch(url, **kwargs):
            with lock: calls[url] = calls.get(url, 0) + 1
            return Response()
        with tempfile.TemporaryDirectory() as directory, patch('storage.requests.get', side_effect=fetch):
            downloads = Downloads(directory, limit=2)
            with ThreadPoolExecutor(max_workers=6) as pool:
                paths = list(pool.map(lambda name: downloads.fetch('https://archive/'+name, name), ['a', 'a', 'b', 'c', 'd', 'b']))
            self.assertEqual(maximum, 2)
            self.assertEqual(set(calls.values()), {1})
            self.assertEqual(paths[0].read_bytes(), b'original-fits-bytes')
            manifest = json.loads(paths[0].with_name(paths[0].name+'.source.json').read_text())
            self.assertEqual(manifest['sha256'], hashlib.sha256(b'original-fits-bytes').hexdigest())
            self.assertEqual(manifest['etag'], 'test-version')

class AlignedCacheTests(unittest.TestCase):
    def test_redshift_changes_reuse_prepared_cube_without_resampling(self):
        import server
        from metrics import CURRENT, Measurements
        with tempfile.TemporaryDirectory() as directory:
            target = server.TARGETS['m101']
            identity = hashlib.sha256(json.dumps([server.CUBES, target['ra'], target['dec'], 64, .1, 'mask-v1']).encode()).hexdigest()
            cube = np.arange(12., dtype=float).reshape(3, 2, 2)
            np.savez_compressed(Path(directory) / f'aligned-{identity}.npz', cube=cube)
            meter = Measurements(); token = CURRENT.set(meter)
            try:
                with patch.object(server, 'CACHE', Path(directory)), patch.object(server, 'ALIGNED_MEMORY', {}), patch.object(server, 'sample_tile') as sample:
                    # Use a real OrderedDict for the bounded in-memory tier.
                    from collections import OrderedDict
                    server.ALIGNED_MEMORY = OrderedDict()
                    a = server.aligned_cube(target, np.arange(3), 0, None, lambda _: self.fail('unexpected reprojection'))
                    b = server.aligned_cube(target, np.arange(3), .01, None, lambda _: self.fail('unexpected reprojection'))
                    self.assertIs(a, b)
                    self.assertFalse(a.flags.writeable)
                    np.testing.assert_array_equal(a, cube)
                    sample.assert_not_called()
                    self.assertEqual(meter.snapshot()['aligned_cache_hits'], 1)
                    self.assertEqual(meter.snapshot()['aligned_memory_hits'], 1)
            finally:
                CURRENT.reset(token)

class HttpTests(unittest.TestCase):
    def test_immutable_gzip_assets_etag_and_tiny_status(self):
        import server
        with tempfile.TemporaryDirectory() as directory:
            store = Assets(directory)
            asset = store.array(np.arange(4096), 64, 64)
            key = f'v6-{server.SETTINGS_ID}-m101-0.00000-30.0'
            state = dict(status='ready', stage='complete', resultUrl='/science/assets/metadata.json')
            with patch.object(server, 'ASSETS', store), patch.dict(server.JOBS, {key: state}):
                http = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
                thread = threading.Thread(target=http.serve_forever, daemon=True); thread.start()
                base = f'http://127.0.0.1:{http.server_port}'
                try:
                    with urllib.request.urlopen(base+'/science/extract?target=m101') as response:
                        status = response.read()
                        self.assertLess(len(status), 1024)
                        self.assertNotIn(b'values', status)
                        self.assertEqual(response.headers['Cache-Control'], 'no-store')
                    request = urllib.request.Request(base+asset['url'], headers={'Accept-Encoding': 'gzip'})
                    with urllib.request.urlopen(request) as response:
                        payload = response.read(); etag = response.headers['ETag']
                        self.assertEqual(response.headers['Content-Encoding'], 'gzip')
                        self.assertIn('immutable', response.headers['Cache-Control'])
                        self.assertLess(len(payload), asset['bytes'])
                        self.assertEqual(gzip.decompress(payload)[:4], b'CNAR')
                    conditional = urllib.request.Request(base+asset['url'], headers={'Accept-Encoding': 'gzip', 'If-None-Match': etag})
                    with self.assertRaises(urllib.error.HTTPError) as caught:
                        urllib.request.urlopen(conditional)
                    self.assertEqual(caught.exception.code, 304)
                    caught.exception.close()
                finally:
                    http.shutdown(); http.server_close(); thread.join()

if __name__ == '__main__':
    unittest.main()
