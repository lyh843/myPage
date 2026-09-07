#!/usr/bin/env python3
"""End-to-end smoke test for the zero-dependency dashboard server."""

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
            bootstrap = request_json(opener, f"{base}/api/bootstrap")
            assert bootstrap["authenticated"] is False
            assert len(bootstrap["links"]) == 6
            assert len(bootstrap["directory_links"]) == 98
            assert bootstrap["stats"]["directory_links"] == 98
            assert bootstrap["directory_categories"] == list(
                dict.fromkeys(item["category"] for item in bootstrap["directory_links"])
            )
            assert len(bootstrap["tasks"]) == 4
            assert all("start_at" in item and "end_at" in item for item in bootstrap["tasks"])
            assert len(bootstrap["papers"]) == 3
            assert bootstrap["calendar_events"] == []

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

            link = request_json(
                opener,
                f"{base}/api/links",
                method="POST",
                payload={
                    "title": "Test Resource",
                    "url": "https://example.com/resource",
                    "category": "测试",
                    "note": "Created by integration test",
                    "icon": "link",
                    "color": "blue",
                },
                csrf=csrf,
            )
            assert link["id"] > 0
            link["title"] = "Updated Resource"
            updated_link = request_json(
                opener,
                f"{base}/api/links/{link['id']}",
                method="PUT",
                payload=link,
                csrf=csrf,
            )
            assert updated_link["title"] == "Updated Resource"

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

            paper = request_json(
                opener,
                f"{base}/api/papers",
                method="POST",
                payload={
                    "title": "Integration Paper",
                    "authors": "Test et al.",
                    "venue": "CI",
                    "year": 2026,
                    "url": "https://example.com/paper",
                    "status": "reading",
                    "tags": ["Test", "API"],
                    "notes": "Smoke test",
                },
                csrf=csrf,
            )
            assert paper["tags"] == ["Test", "API"]

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

            focus = request_json(
                opener,
                f"{base}/api/focus-sessions",
                method="POST",
                payload={"duration": 25, "label": "Integration"},
                csrf=csrf,
            )
            assert focus["duration"] == 25

            exported = request_json(opener, f"{base}/api/export")
            assert exported["stats"]["focus_minutes"] == 25
            assert any(item["id"] == paper["id"] for item in exported["papers"])
            assert any(item["id"] == calendar_event["id"] for item in exported["calendar_events"])
            assert category["name"] in exported["directory_categories"]

            request_json(
                opener,
                f"{base}/api/links/{link['id']}",
                method="DELETE",
                csrf=csrf,
            )
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
            assert not any(item["id"] == link["id"] for item in final["links"])
            assert len(final["directory_links"]) == 98
            assert category["name"] in final["directory_categories"]
            assert "API category" in final["directory_categories"]

            with opener.open(f"{base}/") as response:
                html = response.read().decode()
                assert "Research Desk" in html
                assert 'id="overview-calendar-list"' in html
                assert "Content-Security-Policy" in response.headers
                assert "style-src-attr 'unsafe-inline'" in response.headers["Content-Security-Policy"]

            print("PASS: static files, auth, CSRF, CRUD, directory categories, task scheduling, calendar, focus tracking and export")
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
