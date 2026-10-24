import unittest
from shelf.paging import paginate, page_count
class T(unittest.TestCase):
    def test_first(self): self.assertEqual(paginate(list(range(10)),1,3),[0,1,2])
    def test_last(self): self.assertEqual(paginate(list(range(10)),4,3),[9])
    def test_oob(self): self.assertEqual(paginate(list(range(10)),5,3),[])
    def test_zero(self): self.assertEqual(paginate(list(range(10)),0,3),[])
    def test_count(self): self.assertEqual(page_count(10,3),4); self.assertEqual(page_count(9,3),3); self.assertEqual(page_count(0,3),0)
