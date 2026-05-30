"""Lexicographic fractional-index ranks for ordering items on a board.

A rank is a string over the base-36 alphabet `0-9a-z`, compared with plain
lexicographic (`<`) ordering. The key property: between any two distinct ranks
you can always construct a third that sorts strictly between them, so inserting
a card touches exactly one row — no renumbering of neighbours.

`rank_between(lower, upper)` returns a rank `r` with `lower < r < upper`, where
an empty string on either side means "unbounded": `lower=""` is "before all",
`upper=""` is "after all". `rank_between("", "")` is the seed rank for an empty
column.

The only cost is key growth when you repeatedly insert into the same narrow
gap; the key gains a character each time. That never matters at human-dragged
board scale, but if it ever did, a column can be rebalanced by reassigning
evenly-spread ranks in display order.
"""

BASE = "0123456789abcdefghijklmnopqrstuvwxyz"


def rank_between(lower: str, upper: str) -> str:
    """Return a rank strictly between `lower` and `upper`.

    `lower`/`upper` are existing ranks, or `""` for an open boundary
    (`lower=""` → before everything, `upper=""` → after everything).
    Caller must ensure `lower < upper` when both are non-empty.
    """
    if upper:
        # Carry the shared prefix and recurse on the first differing suffix —
        # this is what lets two close keys (e.g. "ab"/"ac") subdivide. An
        # exhausted `lower` counts as a virtual "0" digit here, since a prefix
        # sorts before any extension of it.
        n = 0
        while n < len(upper) and (lower[n] if n < len(lower) else "0") == upper[n]:
            n += 1
        if n > 0:
            return upper[:n] + rank_between(lower[n:], upper[n:])

    lo_digit = BASE.index(lower[0]) if lower else 0
    hi_digit = BASE.index(upper[0]) if upper else len(BASE)

    if hi_digit - lo_digit > 1:
        # Room for a digit strictly between the two — the common, O(1) case.
        return BASE[(lo_digit + hi_digit) // 2]
    # Digits are adjacent, so there's no single digit between them: descend a
    # level. If `upper` has room below its leading digit, recurse into it;
    # otherwise keep `lower`'s leading digit and split the gap above its
    # remainder. Neither branch ever emits a trailing "0".
    if upper and len(upper) > 1:
        return upper[:1]
    return BASE[lo_digit] + rank_between(lower[1:] if lower else "", "")
