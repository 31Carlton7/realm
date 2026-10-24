"""Pagination helpers."""

def paginate(items, page, per_page):
    """Return the items on 1-indexed `page`. Empty list if out of range."""
    start = page * per_page
    end = start + per_page
    return items[start:end]

def page_count(total, per_page):
    return total // per_page
