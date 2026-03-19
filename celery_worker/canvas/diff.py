"""Diff engine: compare fresh iCal parse results against current DB state."""


def compute_diff(current: dict, fresh: list[dict]) -> dict:
    """Compare fresh parsed events against DB state, keyed by canvas_uid.

    Args:
        current: Dict keyed by canvas_uid -> {"due_date": ..., ...} from DB.
        fresh: List of parsed event dicts from parse_vevents().
    Returns:
        {"added": [event_dict, ...], "changed": [event_dict, ...], "removed": [canvas_uid, ...]}

    Note: Only due_date changes count as "changed" per project decision.
          Title-only changes are intentionally ignored.
    """
    fresh_by_uid = {e["canvas_uid"]: e for e in fresh}

    added = [e for uid, e in fresh_by_uid.items() if uid not in current]
    changed = [
        e for uid, e in fresh_by_uid.items()
        if uid in current and e["due_date"] != current[uid]["due_date"]
    ]
    removed_uids = [uid for uid in current if uid not in fresh_by_uid]

    return {"added": added, "changed": changed, "removed": removed_uids}
