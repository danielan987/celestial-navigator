import unittest
import numpy as np
from analysis import FEATURES, feature_map, spectrum

class AnalysisTests(unittest.TestCase):
    def setUp(self):
        self.waves = np.arange(.75, 5.01, .01)
        self.cube = np.ones((len(self.waves), 3, 3)) * 10

    def test_pah_excess_over_linear_continuum(self):
        self.cube = np.broadcast_to((2 * self.waves + 5)[:, None, None], self.cube.shape).copy()
        idx = np.argmin(abs(self.waves - 3.3))
        self.cube[idx] += 4
        image, selected, _ = feature_map(self.cube, self.waves, FEATURES[0])
        np.testing.assert_allclose(image, 4)
        self.assertEqual(idx, selected)

    def test_ice_optical_depth_and_nonpositive_mask(self):
        feature = FEATURES[2]
        idx = np.argmin(abs(self.waves - feature['wave']))
        self.cube[idx] *= np.exp(-.6)
        self.cube[idx, 0, 0] = 0
        image, _, _ = feature_map(self.cube, self.waves, feature)
        self.assertTrue(np.isnan(image[0, 0]))
        np.testing.assert_allclose(image[1:], .6)

    def test_missing_continuum_does_not_become_detection(self):
        self.cube[np.argmin(abs(self.waves - 3.2))] = np.nan
        image, _, _ = feature_map(self.cube, self.waves, FEATURES[0])
        self.assertTrue(np.isnan(image).all())

    def test_redshift_moves_channel(self):
        _, idx, _ = feature_map(self.cube, self.waves, FEATURES[0], .01)
        self.assertAlmostEqual(self.waves[idx], 3.333, places=2)

    def test_background_subtraction_units_and_missing_coverage(self):
        aperture = np.zeros((3, 3), bool); aperture[1, 1] = True
        annulus = ~aperture
        cube = np.ones((2, 3, 3)) * 10; cube[0, 1, 1] = 12; cube[1, 1, 1] = np.nan
        self.assertEqual(spectrum(cube, aperture, annulus, np.ones((3, 3)) * 1e-9), [2.0, None])

if __name__ == '__main__':
    unittest.main()
