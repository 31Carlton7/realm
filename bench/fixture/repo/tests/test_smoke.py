import unittest
from shelf.config import load_config
from shelf.report import render

class Smoke(unittest.TestCase):
    def test_config_default(self):
        self.assertEqual(load_config()["retries"], 3)
    def test_render_book(self):
        out = render([{"title": "Dune", "author": "Herbert", "year": 1965}], "book")
        self.assertTrue(out.startswith("Dune"))
        self.assertTrue(out.endswith("1965"))
    def test_render_loan(self):
        out = render([{"title": "Dune", "borrower": "Ann", "due_year": 2026}], "loan")
        self.assertIn("Ann", out)
