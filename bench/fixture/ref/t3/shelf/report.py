"""Plain-text reports."""

def _fmt_row(title, who, year):
    return "%s | %s | %s" % (title.strip().ljust(30)[:30], who.strip().ljust(20)[:20], str(year).rjust(4))

def book_line(b):
    return _fmt_row(b["title"], b["author"], b["year"])

def loan_line(l):
    return _fmt_row(l["title"], l["borrower"], l["due_year"])

def render(rows, kind):
    fn = book_line if kind == "book" else loan_line
    return "\n".join(fn(r) for r in rows)
