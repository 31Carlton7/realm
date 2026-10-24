"""Pagination helpers."""

def paginate(items, page, per_page):
    """Return the items on 1-indexed `page`. Empty list if out of range."""
    if page < 1:
        return []
    start = (page - 1) * per_page
    end = start + per_page
    return items[start:end]

def page_count(total, per_page):
    return -(-total // per_page)
