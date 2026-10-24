import unittest, inspect
from shelf import report
class T(unittest.TestCase):
    def test_same_output(self):
        b=report.book_line({"title":"Dune","author":"Herbert","year":1965})
        l=report.loan_line({"title":"Dune","borrower":"Herbert","due_year":1965})
        self.assertEqual(b,l)
        self.assertEqual(b,"Dune".ljust(30)+" | "+"Herbert".ljust(20)+" | 1965")
    def test_long_truncate(self):
        r=report.render([{"title":"x"*50,"author":"y"*40,"year":7}],"book")
        self.assertEqual(r,"x"*30+" | "+"y"*20+" | "+"   7")
    def test_dedup(self):
        src=inspect.getsource(report)
        self.assertLessEqual(src.count(".ljust(30)"),1, "duplicated formatting remains")
