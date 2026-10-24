import re

def slugify(text, max_len=None):
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    if max_len is not None:
        s = s[:max_len].rstrip("-")
    return s
