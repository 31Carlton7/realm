"""Statistics helpers (no tests yet)."""

def mean(xs):
    if not xs:
        raise ValueError("empty")
    return sum(xs) / len(xs)

def median(xs):
    if not xs:
        raise ValueError("empty")
    s = sorted(xs)
    n = len(s)
    mid = n // 2
    if n % 2:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2

def clamp(x, lo, hi):
    if lo > hi:
        raise ValueError("lo>hi")
    return max(lo, min(x, hi))
