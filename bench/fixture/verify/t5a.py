import unittest
from shelf.config import load_config
class T(unittest.TestCase):
    def test_retries_default(self): self.assertEqual(load_config()["retries"],5)
