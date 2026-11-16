import tempfile
import json
from pathlib import Path
import unittest

from astropy.io import fits
from astropy.wcs import WCS
import numpy as np

from analysis import FEATURES, feature_map
from subsets import required_channels, sample_tile, section_samples


class SubsetTests(unittest.TestCase):
    def test_required_channels_cover_features_and_continuum(self):
        waves = np.arange(.75, 5.01, .01)
        selected = required_channels(waves, FEATURES, .01)
        for feature in FEATURES:
            _, index, continuum = feature_map(np.ones((len(waves), 1, 1)), waves, feature, .01)
            self.assertTrue(set([index, *continuum]).issubset(selected))
        self.assertNotIn(50, selected)
        self.assertNotIn(51, selected)
        self.assertLess(len(selected), len(waves))

    def test_section_reads_keep_flags_and_hits_without_loading_full_arrays(self):
        class Hdu:
            def __init__(self, array):
                self.section = array
            @property
            def data(self):
                raise AssertionError('Full-array reads are forbidden')
        image = np.arange(3 * 4 * 5, dtype=float).reshape(3, 4, 5)
        hits = np.ones_like(image, dtype=int)
        flags = np.zeros_like(image, dtype=int)
        flags[0, 1, 2] = 1 << 21  # SOURCE is retained
        flags[2, 3, 4] = 1 << 10  # HOT is masked
        hits[0, 3, 4] = 0
        sampled = section_samples({key: Hdu(arr) for key, arr in [('IMAGE', image), ('NHITS', hits), ('FLAGS', flags)]}, [0, 2], np.array([2, 4]), np.array([1, 3]))
        self.assertEqual(sampled[0, 0], image[0, 1, 2])
        self.assertEqual(sampled[1, 0], image[2, 1, 2])
        self.assertTrue(np.isnan(sampled[0, 1]))
        self.assertTrue(np.isnan(sampled[1, 1]))

    def test_cached_subset_matches_direct_native_pixels(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wcs = WCS(naxis=3)
            wcs.wcs.ctype = ['RA---TAN', 'DEC--TAN', 'WAVE']
            wcs.wcs.crval = [10, 20, 1e-6]
            wcs.wcs.crpix = [4, 4, 1]
            wcs.wcs.cdelt = [-.01, .01, 1e-7]
            header = wcs.to_header(); header['BUNIT'] = 'MJy/sr'
            image = np.arange(3*8*8, dtype=np.float32).reshape(3, 8, 8)
            path = root / 'cube.fits'
            flags = np.zeros_like(image, dtype=np.int32); flags[2, 5, 4] = 1 << 10
            variance = np.ones_like(image) * .125
            fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(image, header=header, name='IMAGE'), fits.ImageHDU(np.ones_like(image, dtype=np.int32), name='NHITS'), fits.ImageHDU(flags, name='FLAGS'), fits.ImageHDU(variance, name='VARIANCE')]).writeto(path)
            sky = wcs.celestial.pixel_to_world(np.array([[2, 4]]), np.array([[3, 5]]))
            for _ in range(2):
                mask, sampled = sample_tile(str(path), sky, np.ones((1, 2), bool), [0, 2], root/'cache', path)
                np.testing.assert_array_equal(mask, [[True, True]])
                expected = image[[0, 2]][:, [3, 5], [2, 4]].astype(float); expected[1, 1] = np.nan
                np.testing.assert_array_equal(sampled, expected)
            with np.load(next((root/'cache/raw').glob('*.npz')), allow_pickle=False) as raw:
                np.testing.assert_array_equal(raw['IMAGE'], image[[0, 2]][:, [3, 5], [2, 4]])
                self.assertEqual(raw['FLAGS'][1, 1], 1 << 10)
                self.assertEqual(raw['VARIANCE'][1, 1], .125)
            metadata = json.loads(next((root/'cache').glob('*.json')).read_text())
            self.assertIn('originalHeader', metadata)
            self.assertIn('VARIANCE', metadata['extensionHeaders'])

if __name__ == '__main__':
    unittest.main()
