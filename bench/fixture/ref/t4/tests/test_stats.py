import unittest
from shelf.stats import mean, median, clamp

class StatsTests(unittest.TestCase):
    def test_mean(self): self.assertEqual(mean([1, 2, 3]), 2)
    def test_mean_empty(self):
        with self.assertRaises(ValueError): mean([])
    def test_median_odd(self): self.assertEqual(median([3, 1, 2]), 2)
    def test_median_even(self): self.assertEqual(median([4, 1, 3, 2]), 2.5)
    def test_median_empty(self):
        with self.assertRaises(ValueError): median([])
    def test_clamp_below(self): self.assertEqual(clamp(-5, 0, 10), 0)
    def test_clamp_inside(self): self.assertEqual(clamp(5, 0, 10), 5)
    def test_clamp_above(self): self.assertEqual(clamp(50, 0, 10), 10)
    def test_clamp_bad(self):
        with self.assertRaises(ValueError): clamp(1, 5, 1)
