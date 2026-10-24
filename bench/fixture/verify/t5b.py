import unittest
from shelf.config import load_config
class T(unittest.TestCase):
    def test_env(self): self.assertEqual(load_config(env="prod")["env"],"prod")
    def test_env_default(self): self.assertEqual(load_config()["env"],"dev")
