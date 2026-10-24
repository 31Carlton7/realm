"""Plain-text reports. Contains duplicated formatting logic."""

def book_line(b):
    title = b["title"].strip()
    author = b["author"].strip()
    year = str(b["year"]).rjust(4)
    return "%s | %s | %s" % (title.ljust(30)[:30], author.ljust(20)[:20], year)

def loan_line(l):
    title = l["title"].strip()
    author = l["borrower"].strip()
    year = str(l["due_year"]).rjust(4)
    return "%s | %s | %s" % (title.ljust(30)[:30], author.ljust(20)[:20], year)

def render(rows, kind):
    fn = book_line if kind == "book" else loan_line
    return "\n".join(fn(r) for r in rows)
