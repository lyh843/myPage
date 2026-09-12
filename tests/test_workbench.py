#!/usr/bin/env python3
"""Isolated HTTP, recurrence, recovery and research security regression checks."""

import http.cookiejar
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import urllib.request
from datetime import timedelta
from unittest.mock import patch

from test_integration import request_json, expect_status

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    with tempfile.TemporaryDirectory(prefix="workbench-test-") as directory:
        os.environ.update(DATA_DIR=directory, APP_SECRET="test-secret-32-characters-for-llm-and-auth",
                          ADMIN_PASSWORD="test-password", PUBLIC_READ="false", COOKIE_SECURE="false")
        import server
        import research
        import schedule

        server.init_database()
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.DashboardHandler)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        base = f"http://127.0.0.1:{httpd.server_port}"
        visitor = urllib.request.build_opener()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        try:
            initial = request_json(visitor, base + "/api/bootstrap")
            assert initial["settings"] == {} and initial["tasks"] == []
            assert "llm_settings" not in initial and "research_items" not in initial
            for path in ("/api/research/refresh", "/api/research/inspect", "/api/llm-settings", "/api/reminders/state", "/api/history/1/undo"):
                expect_status(visitor, base + path, 401, method="POST", payload={})
            csrf = request_json(opener, base + "/api/login", method="POST",
                                payload={"password": "test-password"})["csrf_token"]

            def call(path, data=None, method="POST"):
                return request_json(opener, base + path, method=method, payload=data, csrf=csrf)

            def bootstrap():
                return call("/api/bootstrap", method="GET")

            def undo(result):
                return call(f"/api/history/{result.get('_history_id') or result['history_id']}/undo", {})

            captured = call("/api/inbox", {"title": "Prepare the next experiment"})
            task = call("/api/tasks", {"title": captured["title"], "_inbox_id": captured["id"],
                                      "_inbox_version": captured["updated_at"]})
            assert not bootstrap()["inbox"]
            undo(task)
            assert bootstrap()["inbox"][0]["id"] == captured["id"]
            task = call("/api/tasks", {"title": "Report", "due_date": "2026-09-18",
                                      "_inbox_id": captured["id"], "_inbox_version": captured["updated_at"]})
            block = call("/api/calendar-events", {"title": "Read", "task_id": task["id"],
                "start_at": "2026-09-15T09:00", "end_at": "2026-09-15T10:00"})
            block2 = call("/api/calendar-events", {"title": "Write", "task_id": task["id"],
                "start_at": "2026-09-16T09:00", "end_at": "2026-09-16T11:00"})

            def events(start="2026-09-12T00:00", end="2026-09-26T00:00"):
                from urllib.parse import urlencode
                return call("/api/calendar?" + urlencode(dict(start=start, end=end)), method="GET")

            markers = [item for item in events() if item["event"].get("_source") == "deadline" and item["event"]["id"] == task["id"]]
            assert len(markers) == 1 and markers[0]["event"]["start_at"] == "2026-09-18T23:59"
            assert sum(item["event"].get("task_id") == task["id"] for item in events()) == 2
            deleted = call(f"/api/tasks/{task['id']}", {"_version": task["updated_at"]}, "DELETE")
            assert not any(item.get("task_id") == task["id"] for item in bootstrap()["calendar_events"])
            undo(deleted)
            assert sum(item.get("task_id") == task["id"] for item in bootstrap()["calendar_events"]) == 2

            repeating = call("/api/calendar-events", {"title": "Weekly meeting", "repeat_rule": "weekly",
                "repeat_weekdays": "0,2", "repeat_interval": 1, "repeat_until": "2026-10-01",
                "start_at": "2026-09-14T14:00", "end_at": "2026-09-14T15:00"})
            specific = call(f"/api/calendar-events/{repeating['id']}/occurrence", {
                "_version": repeating["updated_at"], "occurrence": "2026-09-16T14:00", "scope": "one",
                "event": {**repeating, "title": "Moved meeting", "start_at": "2026-09-17T16:00", "end_at": "2026-09-17T17:00"},
            })
            items = [item for item in events() if item["event"]["id"] == repeating["id"] and item["event"].get("_source") != "deadline"]
            assert len(items) == 4
            assert any(item["event"]["start_at"] == "2026-09-17T16:00" for item in items)
            assert not any(item["event"]["start_at"] == "2026-09-16T14:00" for item in items)
            moved_into_window = events("2026-09-17T00:00", "2026-09-18T00:00")
            assert any(item["event"]["title"] == "Moved meeting" for item in moved_into_window)
            undo(specific)
            split = call(f"/api/calendar-events/{repeating['id']}/occurrence", {
                "occurrence": "2026-09-21T14:00", "scope": "following",
                "event": {**repeating, "title": "New series", "start_at": "2026-09-21T14:00", "end_at": "2026-09-21T16:00"},
            })
            assert sum(item["event"]["title"] == "New series" for item in events()) == 2
            undo(split)
            skip = call(f"/api/calendar-events/{repeating['id']}/occurrence", {
                "occurrence": "2026-09-16T14:00", "scope": "one", "delete": True,
            })
            assert sum(item["event"]["title"] == "Weekly meeting" for item in events()) == 3
            undo(skip)
            expect_status(opener, base + f"/api/calendar-events/{repeating['id']}/occurrence", 409,
                method="POST", payload={"occurrence": "2026-09-15T14:00", "scope": "one", "delete": True}, csrf=csrf)

            repeated_task = call("/api/tasks", {"title": "Weekly task", "due_date": "2026-09-14",
                                              "repeat_rule": "weekly"})
            edited = call(f"/api/tasks/{repeated_task['id']}", {
                **repeated_task, "title": "Only this time", "_scope": "one", "_version": repeated_task["updated_at"],
            }, "PUT")
            completed = call(f"/api/tasks/{repeated_task['id']}", {
                **edited, "status": "done", "_version": edited["updated_at"],
            }, "PUT")
            next_tasks = [item for item in bootstrap()["tasks"] if item["series_id"] == repeated_task["id"]]
            assert len(next_tasks) == 1 and next_tasks[0]["title"] == "Weekly task"
            assert next_tasks[0]["due_date"] == "2026-09-21"
            undo(completed)
            assert not any(item["series_id"] == repeated_task["id"] for item in bootstrap()["tasks"])
            skipped = call(f"/api/tasks/{repeated_task['id']}", {
                **edited, "status": "done", "_skip": True, "_version": edited["updated_at"],
            }, "PUT")
            assert skipped["skipped"] == 1
            undo(skipped)
            completed_again = call(f"/api/tasks/{repeated_task['id']}", {
                **edited, "status": "done", "_version": edited["updated_at"],
            }, "PUT")
            reopened = call(f"/api/tasks/{repeated_task['id']}", {
                **completed_again, "status": "todo", "_version": completed_again["updated_at"],
            }, "PUT")
            call(f"/api/tasks/{repeated_task['id']}", {
                **reopened, "status": "done", "_version": reopened["updated_at"],
            }, "PUT")
            assert sum(item["series_id"] == repeated_task["id"] for item in bootstrap()["tasks"]) == 1

            changed = call(f"/api/tasks/{task['id']}", {**task, "title": "Changed", "_version": task["updated_at"]}, "PUT")
            expect_status(opener, base + f"/api/tasks/{task['id']}", 409, method="PUT",
                          payload={**task, "title": "Stale edit", "_version": task["updated_at"]}, csrf=csrf)
            changed2 = call(f"/api/tasks/{task['id']}", {**changed, "title": "Changed again", "_version": changed["updated_at"]}, "PUT")
            expect_status(opener, base + f"/api/history/{changed['_history_id']}/undo", 409, method="POST", payload={}, csrf=csrf)
            undo(changed2)
            undo(changed)

            now = server.local_now().replace(second=0, microsecond=0)
            upcoming = call("/api/calendar-events", {"title": "Soon",
                "start_at": (now + timedelta(minutes=5)).isoformat(timespec="minutes"),
                "end_at": (now + timedelta(minutes=35)).isoformat(timespec="minutes"), "reminder_minutes": 15})
            reminder = next(item for item in bootstrap()["reminders"] if item["event"]["title"] == "Soon")
            call("/api/reminders/state", {"key": reminder["reminder_key"], "snooze": True})
            assert not any(item["event"]["title"] == "Soon" for item in bootstrap()["reminders"])
            with server.db_connect() as db:
                later = schedule.reminders(db, now + timedelta(minutes=11))
            assert any(item["event"]["title"] == "Soon" for item in later)
            call("/api/reminders/state", {"key": reminder["reminder_key"]})
            assert not any(item["event"]["title"] == "Soon" for item in bootstrap()["reminders"])

            def dns(address):
                return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))]

            for address in ("127.0.0.1", "10.1.2.3", "169.254.169.254", "0.0.0.0", "224.0.0.1", "::1", "fc00::1"):
                with patch("research.socket.getaddrinfo", return_value=dns(address)):
                    try:
                        research.public_url("https://example.org")
                        raise AssertionError("private address allowed: " + address)
                    except ValueError:
                        pass
            for url in ("file:///etc/passwd", "https://user:pass@example.org", "http://example.org:8888", "javascript:alert(1)"):
                try:
                    research.public_url(url)
                    raise AssertionError("unsafe URL allowed")
                except ValueError:
                    pass
            from unittest.mock import Mock
            redirected = Mock(status=302, headers={"Location": "http://127.0.0.1/private"})
            pool = Mock()
            pool.urlopen.return_value = redirected
            real_dns = socket.getaddrinfo
            with patch("research.socket.getaddrinfo", side_effect=lambda host, *args, **kwargs: dns("127.0.0.1" if host == "127.0.0.1" else "93.184.216.34")), patch("research.urllib3.HTTPSConnectionPool", return_value=pool) as constructor:
                try:
                    research.fetch_public("https://example.org/article")
                    raise AssertionError("redirect to loopback was allowed")
                except ValueError:
                    pass
                assert constructor.call_args.args[0] == "93.184.216.34"
                assert constructor.call_args.kwargs["assert_hostname"] == "example.org"
                assert constructor.call_args.kwargs["server_hostname"] == "example.org"
                assert pool.urlopen.call_count == 1
                assert pool.urlopen.call_args.kwargs["redirect"] is False
                try:
                    research.fetch_public("https://example.org/v1", body=b"{}", headers={"Authorization": "Bearer secret"})
                    raise AssertionError("API redirect was followed")
                except ValueError:
                    pass
            real_dns = socket.getaddrinfo
            with patch("research.socket.getaddrinfo", side_effect=lambda host, *args, **kwargs: real_dns(host, *args, **kwargs) if host == "127.0.0.1" else dns("93.184.216.34")):
                result = call("/api/llm-settings", {"llm_endpoint": "https://example.org/v1",
                    "llm_model": "test-model", "llm_enabled": True, "api_key": "test-api-key-do-not-expose", "llm_daily_limit": 1})
                assert result["llm_key_configured"] and "llm_key" not in result

            day = research.date.today().isoformat()
            fixture = {"paper": {"id": "2609.01234", "title": "Fixture: calibrated reasoning",
                        "summary": "A controlled fixture abstract about measuring reasoning uncertainty and comparing calibrated predictions. No real results are claimed.",
                        "authors": [{"name": "Test author"}], "upvotes": 42}}
            with patch("research.fetch_public", return_value=(json.dumps([fixture]).encode(), "application/json", "")):
                research.refresh_feed(server.db_connect, force=True)
            papers = bootstrap()["research_items"]
            assert len(papers) == 1 and papers[0]["votes"] == 42 and papers[0]["source_date"] == day
            paper = papers[0]
            call(f"/api/research-items/{paper['id']}", {"favorite": True}, "PUT")
            assert bootstrap()["research_items"][0]["favorite"] == 1
            with patch("research.fetch_public") as fetch:
                expect_status(opener, base + f"/api/research/{paper['id']}/summarize", 400,
                              method="POST", payload={}, csrf=csrf)
                fetch.assert_not_called()
                fetch.return_value = (json.dumps({"choices": [{"message": {"content": "Fixture summary <script>alert(1)</script>"}}]}).encode(), "application/json", "")
                summary = call(f"/api/research/{paper['id']}/summarize", {"consent": True})
                assert summary["summary_model"] == "test-model"
                sent = json.loads(fetch.call_args.kwargs["body"])
                assert "test-api-key-do-not-expose" not in json.dumps(sent)
                assert "Changed" not in json.dumps(sent)
                assert fetch.call_args.kwargs["headers"]["Authorization"] == "Bearer test-api-key-do-not-expose"
                expect_status(opener, base + f"/api/research/{paper['id']}/summarize", 400,
                              method="POST", payload={"consent": True}, csrf=csrf)
                assert fetch.call_count == 1
            exported = call("/api/export", method="GET")
            assert "test-api-key-do-not-expose" not in json.dumps(exported)
            assert "llm_settings" not in exported
            assert exported["research_items"][0]["summary"]
            with server.db_connect() as db:
                encrypted = db.execute("SELECT value FROM settings WHERE key='llm_key'").fetchone()[0]
                assert "test-api-key-do-not-expose" not in encrypted
                assert research.settings(db, private=True)["llm_key"] == "test-api-key-do-not-expose"
            html = b"<html><head><title>Fixture article</title></head><body><article><h1>Fixture article</h1><p>" + fixture["paper"]["summary"].encode() * 10 + b"</p></article></body></html>"
            with patch("research.fetch_public", return_value=(html, "text/html", "https://example.org/article")):
                link = call("/api/research/inspect", {"url": "https://example.org/article"})
                assert link["title"] == "Fixture article" and link["content_scope"] == "网页正文"
            with patch("research.fetch_public", return_value=(b"%PDF", "application/pdf", "https://example.org/test.pdf")):
                expect_status(opener, base + "/api/research/inspect", 400, method="POST",
                              payload={"url": "https://example.org/test.pdf"}, csrf=csrf)
            print("PASS: inbox conversion, linked work blocks, deadlines, recurrence exceptions, scoped task edits, undo conflicts, snooze, private auth, SSRF, encrypted keys, paper dedup, summaries, quota and exports")
        finally:
            httpd.shutdown()
            httpd.server_close()
            worker.join(timeout=5)


if __name__ == "__main__":
    main()
