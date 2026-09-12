"""Persistent schedule occurrences, inbox and reversible workspace changes."""

import json
from datetime import datetime, timedelta, timezone

from dateutil.rrule import DAILY, MONTHLY, WEEKLY, YEARLY, rrule


TABLES = {"tasks", "calendar_events", "inbox", "research_items"}
FREQUENCIES = {"daily": DAILY, "weekly": WEEKLY, "monthly": MONTHLY, "yearly": YEARLY}


class Conflict(ValueError):
    pass


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def init_schema(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS inbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS event_exceptions (
            event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
            occurrence TEXT NOT NULL, replacement TEXT,
            PRIMARY KEY (event_id, occurrence)
        );
        CREATE TABLE IF NOT EXISTS reminder_states (
            key TEXT PRIMARY KEY, dismissed INTEGER NOT NULL DEFAULT 0,
            snoozed_until TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS change_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL,
            changes TEXT NOT NULL, created_at TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0
        );
    """)
    additions = {
        "tasks": {
            "deadline_at": "TEXT NOT NULL DEFAULT ''",
            "repeat_rule": "TEXT NOT NULL DEFAULT 'none'",
            "repeat_interval": "INTEGER NOT NULL DEFAULT 1",
            "repeat_weekdays": "TEXT NOT NULL DEFAULT ''",
            "repeat_until": "TEXT NOT NULL DEFAULT ''",
            "series_id": "INTEGER NOT NULL DEFAULT 0",
            "skipped": "INTEGER NOT NULL DEFAULT 0",
            "repeat_template": "TEXT NOT NULL DEFAULT ''",
            "successor_id": "INTEGER",
        },
        "calendar_events": {
            "repeat_interval": "INTEGER NOT NULL DEFAULT 1",
            "repeat_weekdays": "TEXT NOT NULL DEFAULT ''",
            "task_id": "INTEGER REFERENCES tasks(id)",
            "reminder_minutes": "INTEGER NOT NULL DEFAULT 15",
        },
    }
    for table, fields in additions.items():
        existing = {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}
        for name, definition in fields.items():
            if name not in existing:
                db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
    if not db.execute("SELECT 1 FROM settings WHERE key='schedule_v2'").fetchone():
        for task in db.execute("SELECT * FROM tasks WHERE end_at != ''").fetchall():
            if task["start_at"]:
                db.execute("""
                    INSERT INTO calendar_events
                    (title, start_at, end_at, task_id, calendar_name, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (task["title"], task["start_at"], task["end_at"], task["id"],
                      task["course"] or "任务", task["created_at"], task["updated_at"]))
            elif not task["due_date"]:
                db.execute("UPDATE tasks SET deadline_at=? WHERE id=?", (task["end_at"], task["id"]))
        db.execute("INSERT INTO settings VALUES ('schedule_v2','1')")


def integer(value, minimum, maximum, label):
    try:
        result = int(value)
    except (ValueError, TypeError, OverflowError):
        raise ValueError(f"{label}无效") from None
    if str(value).strip() != str(result) or not minimum <= result <= maximum:
        raise ValueError(f"{label}应在 {minimum} 到 {maximum} 之间")
    return result


def repeat_fields(data, base=""):
    rule = str(data.get("repeat_rule", "none"))
    if rule not in {"none", *FREQUENCIES}:
        raise ValueError("重复规则无效")
    interval = integer(data.get("repeat_interval", 1), 1, 365, "重复间隔")
    weekdays = str(data.get("repeat_weekdays", ""))
    if weekdays and (rule != "weekly" or any(day not in list("0123456") for day in weekdays.split(","))):
        raise ValueError("重复星期无效")
    weekdays = ",".join(sorted(set(weekdays.split(",")))) if weekdays else ""
    until = str(data.get("repeat_until") or "")
    if until:
        try:
            parsed = datetime.strptime(until, "%Y-%m-%d")
        except ValueError:
            raise ValueError("重复截止日期无效") from None
        if base and parsed.date() < datetime.fromisoformat(base).date():
            raise ValueError("重复截止不能早于首次日期")
    return dict(repeat_rule=rule, repeat_interval=interval, repeat_weekdays=weekdays, repeat_until=until)


def recurrence(record, base):
    options = dict(dtstart=base, interval=record.get("repeat_interval", 1))
    if record.get("repeat_until"):
        options["until"] = datetime.fromisoformat(record["repeat_until"] + "T23:59:59")
    if record.get("repeat_weekdays") and record["repeat_rule"] == "weekly":
        options["byweekday"] = [int(value) for value in record["repeat_weekdays"].split(",")]
    return rrule(FREQUENCIES[record["repeat_rule"]], **options)


def snapshot(db, table, record_id):
    if table not in TABLES | {"directory_links"}:
        raise ValueError("未知记录")
    row = db.execute(f"SELECT * FROM {table} WHERE id=?", (record_id,)).fetchone()
    if not row:
        return None
    value = dict(row)
    if table == "calendar_events":
        value["_exceptions"] = [dict(item) for item in db.execute(
            "SELECT * FROM event_exceptions WHERE event_id=? ORDER BY occurrence", (record_id,))]
    return value


def record_change(db, label, changes):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    db.execute("DELETE FROM change_history WHERE created_at < ?", (cutoff,))
    cursor = db.execute(
        "INSERT INTO change_history(label, changes, created_at) VALUES (?, ?, ?)",
        (label, json.dumps(changes, ensure_ascii=False), stamp()),
    )
    return cursor.lastrowid


def change(db, table, before, record_id):
    return {"table": table, "id": record_id, "before": before, "after": snapshot(db, table, record_id)}


def check_version(before, data):
    if before is None:
        raise ValueError("记录不存在")
    version = data.get("_version")
    if version and version != before["updated_at"]:
        raise Conflict("此记录已在其他设备修改，请刷新后重试")


def history_items(db):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    return [dict(row) for row in db.execute("""
        SELECT id, label, created_at, undone,
        EXISTS(SELECT 1 FROM json_each(changes) WHERE json_extract(value,'$.after') IS NULL) AS deleted
        FROM change_history WHERE created_at >= ? ORDER BY id DESC LIMIT 300
    """, (cutoff,))]


def undo(db, history_id):
    row = db.execute("SELECT * FROM change_history WHERE id=?", (history_id,)).fetchone()
    if not row or row["undone"] or datetime.fromisoformat(row["created_at"]) < datetime.now(timezone.utc) - timedelta(days=30):
        raise Conflict("这项操作已恢复或超过保留期限")
    changes = json.loads(row["changes"])
    for item in changes:
        if snapshot(db, item["table"], item["id"]) != item["after"]:
            raise Conflict("相关记录后来又有改动，不能覆盖这些改动")
    # Restore parents before children; deletes run in reverse dependency order.
    for item in changes:
        if item["before"] is None:
            continue
        table = item["table"]
        value = dict(item["before"])
        exceptions = value.pop("_exceptions", [])
        keys = list(value)
        updates = ", ".join(f"{key}=excluded.{key}" for key in keys if key != "id")
        db.execute(f"""INSERT INTO {table}({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})
                    ON CONFLICT(id) DO UPDATE SET {updates}""", list(value.values()))
        if table == "calendar_events":
            db.execute("DELETE FROM event_exceptions WHERE event_id=?", (item["id"],))
            db.executemany("INSERT INTO event_exceptions VALUES (?, ?, ?)",
                           [(e["event_id"], e["occurrence"], e["replacement"]) for e in exceptions])
    for item in reversed(changes):
        if item["before"] is None:
            db.execute(f"DELETE FROM {item['table']} WHERE id=?", (item["id"],))
    db.execute("UPDATE change_history SET undone=1 WHERE id=?", (history_id,))


def expand_events(db, start, end, include_old_deadlines=False):
    if end <= start or end - start > timedelta(days=370):
        raise ValueError("查询范围应在 1 到 370 天之间")
    results = []
    exceptions = {(row["event_id"], row["occurrence"]): row["replacement"]
                  for row in db.execute("SELECT * FROM event_exceptions")}
    tasks = {row["id"]: dict(row) for row in db.execute("SELECT * FROM tasks")}
    for row in db.execute("SELECT * FROM calendar_events"):
        event = dict(row)
        base = datetime.fromisoformat(event["start_at"])
        duration = datetime.fromisoformat(event["end_at"]) - base
        starts = [base] if event["repeat_rule"] == "none" else recurrence(event, base).between(
            start - duration, end, inc=True)
        candidates = {value.isoformat(timespec="minutes"): value for value in starts}
        # An exception can be moved into this window from a different original date.
        for (event_id, occurrence), replacement in exceptions.items():
            if event_id == event["id"] and replacement:
                candidates[occurrence] = datetime.fromisoformat(occurrence)
        for key, value in candidates.items():
            current = dict(event)
            if (event["id"], key) in exceptions:
                replacement = exceptions[event["id"], key]
                if replacement is None:
                    continue
                current.update(json.loads(replacement))
                begins = datetime.fromisoformat(current["start_at"])
                finishes = datetime.fromisoformat(current["end_at"])
            else:
                begins, finishes = value, value + duration
            if begins >= end or finishes <= start:
                continue
            current["start_at"] = begins.isoformat(timespec="minutes")
            current["end_at"] = finishes.isoformat(timespec="minutes")
            task = tasks.get(current.get("task_id"))
            current["task_done"] = bool(task and task["status"] == "done")
            results.append({"key": f"event:{event['id']}:{key}", "occurrence": key, "event": current})
            if len(results) > 10000:
                raise ValueError("日程数量过多，请缩小查询范围")
    # Deadlines are markers, not invented one-hour work blocks.
    for task in tasks.values():
        due = task["deadline_at"] or (task["due_date"] + "T23:59" if task["due_date"] else "")
        if not due:
            continue
        value = datetime.fromisoformat(due)
        if start <= value < end or (include_old_deadlines and value < start and task["status"] != "done"):
            results.append({"key": f"deadline:{task['id']}:{due}", "occurrence": due, "event": {
                "id": task["id"], "title": task["title"], "start_at": due,
                "end_at": (value + timedelta(minutes=1)).isoformat(timespec="minutes"),
                "all_day": not bool(task["deadline_at"]), "color": "red", "calendar_name": "截止事项",
                "_source": "deadline", "task_done": task["status"] == "done",
                "repeat_rule": "none", "reminder_minutes": 0, "location": task["course"],
            }})
    return sorted(results, key=lambda item: (item["event"]["start_at"], item["key"]))


def reminders(db, now):
    states = {row["key"]: dict(row) for row in db.execute("SELECT * FROM reminder_states")}
    items = []
    for occurrence in expand_events(db, now - timedelta(days=7), now + timedelta(days=2), include_old_deadlines=True):
        event = occurrence["event"]
        begins = datetime.fromisoformat(event["start_at"])
        minutes = event.get("reminder_minutes", 15)
        if event["task_done"] or minutes < 0 or begins - timedelta(minutes=minutes) > now:
            continue
        # The revision makes a rescheduled occurrence eligible for a fresh reminder.
        key = occurrence["key"] + ":" + event["start_at"]
        saved = states.get(key, {})
        if saved.get("dismissed") or saved.get("snoozed_until", "") > now.isoformat(timespec="minutes"):
            continue
        items.append({**occurrence, "reminder_key": key, "overdue": begins < now})
    return items[-100:]


def complete_repeating_task(db, before, values):
    if before["status"] == "done" or values["status"] != "done" or before.get("successor_id"):
        return []
    template = values.get("repeat_template", before.get("repeat_template", ""))
    values = {**values, **json.loads(template or "{}")}
    if values["repeat_rule"] == "none":
        return []
    base_text = values["deadline_at"] or (values["due_date"] + "T23:59" if values["due_date"] else "")
    if not base_text:
        raise ValueError("重复任务需要截止日期")
    base = datetime.fromisoformat(base_text)
    next_date = recurrence(values, base).after(base)
    if not next_date:
        return []
    next_values = {key: value for key, value in values.items() if key not in {"updated_at", "skipped"}}
    next_values.update(status="todo", series_id=before["series_id"] or before["id"],
                       start_at="", end_at="", repeat_template="", created_at=stamp(), updated_at=stamp())
    if values["deadline_at"]:
        next_values["deadline_at"] = next_date.isoformat(timespec="minutes")
    if values["due_date"]:
        next_values["due_date"] = next_date.date().isoformat()
    cursor = db.execute(f"INSERT INTO tasks({','.join(next_values)}) VALUES ({','.join('?' for _ in next_values)})",
                        list(next_values.values()))
    db.execute("UPDATE tasks SET successor_id=? WHERE id=?", (cursor.lastrowid, before["id"]))
    return [change(db, "tasks", None, cursor.lastrowid)]


def edit_occurrence(db, event_id, data, validate):
    before = snapshot(db, "calendar_events", event_id)
    check_version(before, data)
    key = str(data.get("occurrence", ""))
    try:
        selected = datetime.strptime(key, "%Y-%m-%dT%H:%M")
    except ValueError:
        raise ValueError("日程实例时间无效") from None
    base = datetime.fromisoformat(before["start_at"])
    valid = selected == base if before["repeat_rule"] == "none" else bool(recurrence(before, base).between(
        selected, selected, inc=True))
    if not valid:
        raise Conflict("该重复实例不存在")
    scope = data.get("scope", "one")
    deleting = data.get("delete") is True
    if scope not in {"one", "following", "all"}:
        raise ValueError("修改范围无效")
    changes = []
    if before["repeat_rule"] == "none":
        scope = "all"
    if scope == "one":
        replacement = None if deleting else validate("calendar_events", data["event"])
        if replacement and replacement["task_id"] and not db.execute(
                "SELECT 1 FROM tasks WHERE id=?", (replacement["task_id"],)).fetchone():
            raise ValueError("关联任务不存在")
        db.execute("""INSERT INTO event_exceptions VALUES(?, ?, ?)
            ON CONFLICT(event_id, occurrence) DO UPDATE SET replacement=excluded.replacement""",
                   (event_id, key, json.dumps(replacement, ensure_ascii=False) if replacement else None))
        db.execute("UPDATE calendar_events SET updated_at=? WHERE id=?", (stamp(), event_id))
    elif scope == "following" and selected > base:
        db.execute("UPDATE calendar_events SET repeat_until=?, updated_at=? WHERE id=?",
                   ((selected - timedelta(days=1)).date().isoformat(), stamp(), event_id))
        db.execute("DELETE FROM event_exceptions WHERE event_id=? AND occurrence>=?", (event_id, key))
        if not deleting:
            values = validate("calendar_events", data["event"])
            values.update(created_at=stamp(), updated_at=stamp())
            cursor = db.execute(
                f"INSERT INTO calendar_events({','.join(values)}) VALUES ({','.join('?' for _ in values)})",
                list(values.values()))
            changes.append(change(db, "calendar_events", None, cursor.lastrowid))
    elif deleting:
        db.execute("DELETE FROM calendar_events WHERE id=?", (event_id,))
    else:
        values = validate("calendar_events", data["event"])
        # Shift the series base by the selected occurrence's time delta.
        duration = datetime.fromisoformat(values["end_at"]) - datetime.fromisoformat(values["start_at"])
        delta = datetime.fromisoformat(values["start_at"]) - selected
        values["start_at"] = (base + delta).isoformat(timespec="minutes")
        values["end_at"] = (base + delta + duration).isoformat(timespec="minutes")
        values = validate("calendar_events", values)
        values["updated_at"] = stamp()
        db.execute(f"UPDATE calendar_events SET {','.join(key+'=?' for key in values)} WHERE id=?",
                   [*values.values(), event_id])
        db.execute("DELETE FROM event_exceptions WHERE event_id=?", (event_id,))
    changes.insert(0, change(db, "calendar_events", before, event_id))
    return record_change(db, "删除日程" if deleting else "修改日程", changes)
