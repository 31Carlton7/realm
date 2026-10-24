import unittest
from shelf.slug import slugify
class T(unittest.TestCase):
    def test_basic(self): self.assertEqual(slugify("Hello World"),"hello-world")
    def test_punct(self): self.assertEqual(slugify("  Dune: Messiah!! "),"dune-messiah")
    def test_multi(self): self.assertEqual(slugify("a  --  b"),"a-b")
    def test_empty(self): self.assertEqual(slugify("???"),"")
    def test_maxlen(self): self.assertEqual(slugify("abcdef ghij",max_len=8),"abcdef-g")
    def test_maxlen_trailing(self): self.assertEqual(slugify("abcdef ghij",max_len=7),"abcdef")
