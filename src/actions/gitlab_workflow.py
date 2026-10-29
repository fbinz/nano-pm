"""Pure workflow interpretation. Unknown timestamps stay unknown."""

from itertools import groupby


def interpret(labels, closed, mapping):
    if closed or set(labels).intersection(mapping["done"]):
        return "done"
    for state in ("in-progress", "not-started"):
        if set(labels).intersection(mapping[state]):
            return state
    return mapping["fallback"]


def reduce_history(labels, source_state, events, mapping, closed_at=None):
    events = sorted(events, key=lambda event: (event["at"], event["kind"], event["id"]))
    # Work backwards from the current snapshot to establish the pre-history
    # baseline. Labels with no recorded transition must not acquire a timestamp.
    baseline = set(labels)
    closed = source_state == "closed"
    for event in reversed(events):
        data = event["data"]
        if event["kind"] == "label" and data.get("label"):
            if data["action"] == "add":
                baseline.discard(data["label"])
            else:
                baseline.add(data["label"])
        elif event["kind"] == "state":
            closed = data["state"] != "closed"

    if source_state == "closed" and closed_at and not any(
        event["kind"] == "state" and event["data"]["state"] == "closed" for event in events
    ):
        events.append({"at": closed_at, "kind": "state", "id": 0, "data": {"state": "closed"}})
        events.sort(key=lambda event: (event["at"], event["kind"], event["id"]))
        closed = False

    state = interpret(baseline, closed, mapping)
    intervals = []
    active = {"start": None, "end": None} if state == "in-progress" else None
    for at, group in groupby(events, key=lambda event: event["at"]):
        for event in group:
            data = event["data"]
            if event["kind"] == "label" and data.get("label"):
                if data["action"] == "add":
                    baseline.add(data["label"])
                else:
                    baseline.discard(data["label"])
            elif event["kind"] == "state":
                closed = data["state"] == "closed"
        next_state = interpret(baseline, closed, mapping)
        if next_state != state:
            if state == "in-progress" and active:
                active["end"] = at
                intervals.append(active)
                active = None
            elif next_state == "done":
                intervals.append({"start": None, "end": at})
            if next_state == "in-progress":
                active = {"start": at, "end": None}
            state = next_state
    if active and active["start"]:
        intervals.append(active)
    return interpret(labels, source_state == "closed", mapping), intervals
