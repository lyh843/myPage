#!/usr/bin/env python3
"""End-to-end regression test for retained dashboard APIs and legacy data."""

from __future__ import annotations

import http.cookiejar
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PASSWORD = "integration-password"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def prepare_legacy_tasks_schema(data_dir: str) -> None:
    """Exercise the in-place migration used by existing installations."""
    with sqlite3.connect(Path(data_dir) / "workspace.db") as db:
        db.execute(
            """CREATE TABLE tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                course TEXT NOT NULL DEFAULT '',
                due_date TEXT NOT NULL DEFAULT '',
                priority TEXT NOT NULL DEFAULT 'medium',
                status TEXT NOT NULL DEFAULT 'todo',
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"""
        )


def main() -> None:
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    cookie_jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))

    with tempfile.TemporaryDirectory(prefix="research-desk-test-") as data_dir:
        prepare_legacy_tasks_schema(data_dir)
        env = {
            **os.environ,
            "HOST": "127.0.0.1",
            "PORT": str(port),
            "DATA_DIR": data_dir,
            "ADMIN_PASSWORD": PASSWORD,
            "APP_SECRET": "integration-secret-that-is-long-and-stable",
            "PUBLIC_READ": "true",
            "COOKIE_SECURE": "false",
        }
        process = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py")],
            cwd=ROOT,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            wait_until_ready(base)
            visitor = request_json(opener, f"{base}/api/bootstrap")
            assert visitor["authenticated"] is False and visitor["public_read"] is False
            assert visitor["settings"] == {} and visitor["tasks"] == []
            request_json(opener, f"{base}/api/login", method="POST", payload={"password": PASSWORD})
            bootstrap = request_json(opener, f"{base}/api/bootstrap")
            assert bootstrap["authenticated"] is True
            assert len(bootstrap["directory_links"]) == 98
            assert bootstrap["stats"]["directory_links"] == 98
            assert bootstrap["directory_categories"] == list(
                dict.fromkeys(item["category"] for item in bootstrap["directory_links"])
            )
            assert len(bootstrap["tasks"]) == 4
            assert all("start_at" in item and "end_at" in item for item in bootstrap["tasks"])
            assert bootstrap["calendar_events"] == []
            assert not {"links", "papers", "focus_sessions"} & bootstrap.keys()
            assert not {"focus_minutes", "focus_target", "reading_papers"} & bootstrap["stats"].keys()
            assert "focus_target" not in bootstrap["settings"]
            with sqlite3.connect(Path(data_dir) / "workspace.db") as db:
                tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
                assert not {"links", "papers", "focus_sessions"} & tables
                for table in ("links", "papers", "focus_sessions"):
                    db.execute(f"CREATE TABLE {table} (id INTEGER PRIMARY KEY, title TEXT)")
                    db.execute(f"INSERT INTO {table} VALUES (1, 'Legacy data')")
                db.execute("INSERT INTO settings VALUES ('focus_target', 'legacy-invalid-value')")
            cookie_jar.clear()

            expect_status(
                opener,
                f"{base}/api/tasks",
                401,
                method="POST",
                payload={"title": "Unauthorized"},
            )
            expect_status(
                opener,
                f"{base}/api/directory-categories",
                401,
                method="POST",
                payload={"name": "Unauthorized"},
            )
            expect_status(
                opener,
                f"{base}/api/login",
                401,
                method="POST",
                payload={"password": "wrong"},
            )
            login = request_json(
                opener,
                f"{base}/api/login",
                method="POST",
                payload={"password": PASSWORD},
            )
            csrf = login["csrf_token"]
            for endpoint in ("links", "papers", "focus-sessions"):
                for method in ("GET", "POST", "PUT", "DELETE"):
                    suffix = "/1" if method in {"PUT", "DELETE"} else ""
                    expect_status(
                        opener,
                        f"{base}/api/{endpoint}{suffix}",
                        404,
                        method=method,
                        payload={},
                        csrf=csrf,
                    )
            expect_status(
                opener,
                f"{base}/api/directory-categories",
                403,
                method="POST",
                payload={"name": "Missing CSRF"},
            )
            for name in ("", "   ", "x" * 31, "全部", 123, []):
                expect_status(
                    opener,
                    f"{base}/api/directory-categories",
                    400,
                    method="POST",
                    payload={"name": name},
                    csrf=csrf,
                )
            category = request_json(
                opener,
                f"{base}/api/directory-categories",
                method="POST",
                payload={"name": "  Integration category  "},
                csrf=csrf,
            )
            assert category == {"name": "Integration category"}
            categories = request_json(opener, f"{base}/api/bootstrap")["directory_categories"]
            assert categories == [*bootstrap["directory_categories"], category["name"]]
            for name in (category["name"], "  Integration category  ", bootstrap["directory_categories"][0]):
                expect_status(
                    opener,
                    f"{base}/api/directory-categories",
                    409,
                    method="POST",
                    payload={"name": name},
                    csrf=csrf,
                )
            with sqlite3.connect(Path(data_dir) / "workspace.db") as db:
                assert db.execute(
                    "SELECT name FROM directory_categories WHERE name = ?", (category["name"],)
                ).fetchone() == (category["name"],)
            expect_status(
                opener,
                f"{base}/api/tasks",
                403,
                method="POST",
                payload={"title": "Missing CSRF"},
            )

            directory_link = request_json(
                opener,
                f"{base}/api/directory-links",
                method="POST",
                payload={
                    "title": "Directory Test",
                    "url": "https://example.com/directory",
                    "category": category["name"],
                    "note": "Created by integration test",
                    "icon": "wrench",
                    "color": "green",
                },
                csrf=csrf,
            )
            assert directory_link["category"] == category["name"]
            directory_link["title"] = "Updated Directory Test"
            directory_link["category"] = "API category"
            updated_directory_link = request_json(
                opener,
                f"{base}/api/directory-links/{directory_link['id']}",
                method="PUT",
                payload=directory_link,
                csrf=csrf,
            )
            assert updated_directory_link["title"] == "Updated Directory Test"
            assert updated_directory_link["category"] == "API category"
            assert "API category" in request_json(opener, f"{base}/api/bootstrap")["directory_categories"]

            task = request_json(
                opener,
                f"{base}/api/tasks",
                method="POST",
                payload={
                    "title": "Integration task",
                    "course": "测试",
                    "due_date": "2026-08-28",
                    "start_at": "2026-08-28T09:00",
                    "end_at": "2026-08-28T10:30",
                    "priority": "high",
                    "status": "todo",
                    "notes": "Exercise CRUD",
                },
                csrf=csrf,
            )
            assert task["start_at"] == "2026-08-28T09:00"
            assert task["end_at"] == "2026-08-28T10:30"
            task["status"] = "doing"
            updated_task = request_json(
                opener,
                f"{base}/api/tasks/{task['id']}",
                method="PUT",
                payload=task,
                csrf=csrf,
            )
            assert updated_task["status"] == "doing"
            assert updated_task["end_at"] == "2026-08-28T10:30"

            end_only_task = request_json(
                opener,
                f"{base}/api/tasks",
                method="POST",
                payload={
                    "title": "End-only task",
                    "end_at": "2026-08-29T18:00",
                    "priority": "medium",
                    "status": "todo",
                },
                csrf=csrf,
            )
            assert end_only_task["start_at"] == ""
            assert end_only_task["end_at"] == "2026-08-29T18:00"
            expect_status(
                opener,
                f"{base}/api/tasks",
                400,
                method="POST",
                payload={"title": "Start without end", "start_at": "2026-08-30T09:00"},
                csrf=csrf,
            )
            expect_status(
                opener,
                f"{base}/api/tasks",
                400,
                method="POST",
                payload={
                    "title": "Invalid task interval",
                    "start_at": "2026-08-30T10:00",
                    "end_at": "2026-08-30T09:00",
                },
                csrf=csrf,
            )

            calendar_event = request_json(
                opener,
                f"{base}/api/calendar-events",
                method="POST",
                payload={
                    "title": "Integration calendar event",
                    "start_at": "2026-08-28T09:30",
                    "end_at": "2026-08-28T10:45",
                    "all_day": False,
                    "timezone": "Asia/Shanghai",
                    "location": "Lab 201",
                    "description": "Review experiment results",
                    "calendar_name": "科研",
                    "color": "green",
                    "repeat_rule": "weekly",
                    "repeat_until": "2026-10-01",
                },
                csrf=csrf,
            )
            assert calendar_event["repeat_rule"] == "weekly"
            calendar_event["location"] = "Lab 202"
            updated_calendar_event = request_json(
                opener,
                f"{base}/api/calendar-events/{calendar_event['id']}",
                method="PUT",
                payload=calendar_event,
                csrf=csrf,
            )
            assert updated_calendar_event["location"] == "Lab 202"

            settings = request_json(
                opener,
                f"{base}/api/settings",
                method="POST",
                payload={**bootstrap["settings"], "display_name": "Schedule test", "focus_target": 25},
                csrf=csrf,
            )
            assert settings["display_name"] == "Schedule test"
            assert "focus_target" not in settings

            exported = request_json(opener, f"{base}/api/export")
            assert not {"links", "papers", "focus_sessions"} & exported.keys()
            assert not {"focus_minutes", "focus_target", "reading_papers"} & exported["stats"].keys()
            assert "focus_target" not in exported["settings"]
            assert any(item["id"] == task["id"] for item in exported["tasks"])
            assert any(item["id"] == calendar_event["id"] for item in exported["calendar_events"])
            assert category["name"] in exported["directory_categories"]

            request_json(
                opener,
                f"{base}/api/directory-links/{directory_link['id']}",
                method="DELETE",
                csrf=csrf,
            )
            request_json(
                opener,
                f"{base}/api/calendar-events/{calendar_event['id']}",
                method="DELETE",
                csrf=csrf,
            )
            final = request_json(opener, f"{base}/api/bootstrap")
            assert final["authenticated"] is True
            assert len(final["directory_links"]) == 98
            assert category["name"] in final["directory_categories"]
            assert "API category" in final["directory_categories"]

            with opener.open(f"{base}/") as response:
                html = response.read().decode()
                assert "Research Desk" in html
                assert 'id="overview-calendar-list"' in html
                assert 'id="due-today-count"' in html
                assert 'id="overdue-count"' in html
                for retired in ("links", "papers", "focus"):
                    assert f'data-view="{retired}"' not in html
                    assert f'data-route="{retired}"' not in html
                assert "Content-Security-Policy" in response.headers
                assert "style-src-attr 'unsafe-inline'" in response.headers["Content-Security-Policy"]

            process.terminate()
            process.wait(timeout=5)
            env["PUBLIC_READ"] = "false"
            process = subprocess.Popen(
                [sys.executable, str(ROOT / "server.py")],
                cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            )
            wait_until_ready(base)
            restarted = request_json(opener, f"{base}/api/bootstrap")
            assert restarted["tasks"] == final["tasks"]
            assert restarted["directory_links"] == final["directory_links"]
            visitor = request_json(urllib.request.build_opener(), f"{base}/api/bootstrap")
            assert visitor["public_read"] is False
            assert visitor["authenticated"] is False
            for key in ("tasks", "calendar_events", "directory_links", "directory_categories"):
                assert visitor[key] == []
            assert "focus_target" not in restarted["settings"]
            assert not {"links", "papers", "focus_sessions"} & restarted.keys()
            with sqlite3.connect(Path(data_dir) / "workspace.db") as db:
                for table in ("links", "papers", "focus_sessions"):
                    assert db.execute(f"SELECT title FROM {table}").fetchall() == [("Legacy data",)]
                assert db.execute("SELECT value FROM settings WHERE key = 'focus_target'").fetchone() == ("legacy-invalid-value",)

            print("PASS: auth, CSRF, CRUD, directory categories, task scheduling, calendar, export, retired APIs and legacy data preservation")
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def wait_until_ready(base: str) -> None:
    deadline = time.time() + 8
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{base}/api/bootstrap", timeout=0.5):
                return
        except (urllib.error.URLError, ConnectionError):
            time.sleep(0.1)
    raise RuntimeError("Server did not become ready")


def request_json(
    opener: urllib.request.OpenerDirector,
    url: str,
    *,
    method: str = "GET",
    payload: dict | None = None,
    csrf: str = "",
) -> dict:
    body = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"} if payload is not None else {}
    if csrf:
        headers["X-CSRF-Token"] = csrf
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    with opener.open(request, timeout=2) as response:
        return json.loads(response.read())


def expect_status(
    opener: urllib.request.OpenerDirector,
    url: str,
    status: int,
    *,
    method: str,
    payload: dict,
    csrf: str = "",
) -> None:
    try:
        request_json(opener, url, method=method, payload=payload, csrf=csrf)
    except urllib.error.HTTPError as error:
        assert error.code == status, f"expected {status}, received {error.code}"
    else:
        raise AssertionError(f"expected HTTP {status}")


if __name__ == "__main__":
    main()
