"""HTTP checks for account migration, private workspaces and shared project authorization."""

import http.cookiejar
import json
import os
import sqlite3
import sys
import tempfile
import threading
from pathlib import Path
from unittest.mock import patch
import urllib.request
from contextlib import closing

from test_integration import request_json, expect_status

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    with tempfile.TemporaryDirectory(prefix="accounts-test-") as directory:
        os.environ.update(DATA_DIR=directory, ADMIN_PASSWORD="admin-password", COOKIE_SECURE="false",
                          APP_SECRET="accounts-tests-fixed-secret-with-32-characters", RESEARCH_AUTO_FETCH="false")
        # A legacy workspace must keep its data and be inherited only by admin.
        with closing(sqlite3.connect(Path(directory) / "workspace.db")) as db, db:
            db.execute("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
            db.execute("INSERT INTO settings VALUES('display_name','Legacy owner')")
        import server
        import accounts
        import research
        server.init_database()
        server.DashboardHandler.log_message = lambda *args: None
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.DashboardHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{httpd.server_port}"

        def client():
            jar = http.cookiejar.CookieJar()
            return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)), jar

        def login(opener, username, password, remember=True):
            return request_json(opener, base + "/api/login", method="POST", payload={
                "username": username, "password": password, "remember": remember})["csrf_token"]

        def call(opener, csrf, path, data=None, method="POST"):
            return request_json(opener, base + path, method=method, payload=data, csrf=csrf)

        def boot(opener):
            return request_json(opener, base + "/api/bootstrap")

        admin, admin_jar = client()
        alice, alice_jar = client()
        bob, bob_jar = client()
        try:
            assert boot(admin)["authenticated"] is False
            ac = login(admin, "admin", "admin-password")
            assert boot(admin)["settings"]["display_name"] == "Legacy owner"
            a = call(admin, ac, "/api/accounts", {"username": "alice", "password": "alice-password"})
            b = call(admin, ac, "/api/accounts", {"username": "bob", "password": "bob-password"})
            expect_status(admin, base + "/api/accounts", 409, method="POST",
                          payload={"username": "ALICE", "password": "another-password"}, csrf=ac)
            expect_status(admin, base + "/api/accounts", 400, method="POST",
                          payload={"username": "eve", "password": "short"}, csrf=ac)
            expect_status(admin, base + "/api/accounts/1", 400, method="POST",
                          payload={"enabled": False}, csrf=ac)
            alc = login(alice, "alice", "alice-password", remember=False)
            bc = login(bob, "bob", "bob-password")
            assert next(iter(alice_jar)).discard is True
            assert next(iter(admin_jar)).discard is False
            assert boot(alice)["tasks"] == [] and boot(alice)["settings"]["display_name"] == "我的工作台"
            expect_status(alice, base + "/api/accounts", 403, method="GET", payload=None)
            expect_status(alice, base + "/api/accounts", 403, method="POST",
                          payload={"username": "eve", "password": "eve-password"}, csrf=alc)
            expect_status(alice, base + "/api/accounts/1", 403, method="POST",
                          payload={"password": "new-admin-password"}, csrf=alc)
            private = call(admin, ac, "/api/projects", {"title": "Admin private", "variables": {"secret": "private"}})
            shared = call(admin, ac, "/api/projects", {"title": "Collaborative", "variables": {"goal": "shared"}})
            own = call(alice, alc, "/api/projects", {"title": "Alice private"})
            assert own["id"] == private["id"]  # IDs can overlap safely between private workspaces.
            call(alice, alc, f"/api/projects/{own['id']}", {**own, "title": "Alice still private"}, "PUT")
            assert boot(admin)["projects"][0]["title"] == "Admin private"
            call(alice, alc, f"/api/projects/{own['id']}/members", {"username": "bob", "permission": "edit"})
            bob_project = boot(bob)["projects"][0]
            assert bob_project["id"] == f"shared:{a['id']}:{own['id']}"
            alice_shared_path = f"/api/shared/{a['id']}/{own['id']}"
            bob_task = call(bob, bc, alice_shared_path + "/tasks", {"title": "Bob collaboration", "project_id": own["id"]})
            assert boot(alice)["tasks"][0]["title"] == "Bob collaboration"
            call(alice, alc, f"/api/projects/{own['id']}/members", {"username": "bob", "permission": "remove"})
            call(alice, alc, f"/api/tasks/{bob_task['id']}", {}, "DELETE")
            task = call(admin, ac, "/api/tasks", {"title": "Shared task", "project_id": shared["id"], "due_date": "2026-12-20", "repeat_rule": "daily"})
            hidden = call(admin, ac, "/api/tasks", {"title": "Hidden task", "project_id": private["id"]})
            event = call(admin, ac, "/api/calendar-events", {"title": "Private time block", "task_id": task["id"], "start_at": "2026-12-20T09:00", "end_at": "2026-12-20T10:00"})
            call(admin, ac, "/api/inbox", {"title": "Private inbox"})
            call(admin, ac, "/api/llm-settings", {"api_key": "private-api-key", "llm_model": "private-model", "llm_daily_limit": 2})
            assert len(boot(alice)["projects"]) == 1
            call(admin, ac, f"/api/projects/{shared['id']}/members", {"username": "alice", "permission": "view"})
            ab = boot(alice)
            assert {p["title"] for p in ab["projects"]} == {"Alice still private", "Collaborative"}
            assert {t["title"] for t in ab["tasks"]} == {"Shared task"}
            assert ab["inbox"] == [] and ab["calendar_events"] == []
            assert not ab["llm_settings"]["llm_key_configured"] and ab["llm_settings"]["llm_model"] == ""
            assert all("Private" not in item["label"] for item in ab["history"])
            shared_path = f"/api/shared/1/{shared['id']}"
            expect_status(alice, base + shared_path + f"/tasks/{task['id']}", 403, method="PUT",
                          payload={**task, "status": "doing"}, csrf=alc)
            assert boot(bob)["projects"] == []
            expect_status(bob, base + shared_path + "/tasks", 403, method="POST", payload={"title": "Forbidden"}, csrf=bc)
            call(admin, ac, f"/api/projects/{shared['id']}/members", {"username": "alice", "permission": "edit"})
            # Sharing a project never grants access to other projects, histories or membership management.
            expect_status(alice, base + f"/api/shared/1/{private['id']}/tasks/{hidden['id']}", 403,
                          method="PUT", payload={**hidden, "title": "Stolen"}, csrf=alc)
            expect_status(alice, base + shared_path + f"/tasks/{hidden['id']}", 404,
                          method="PUT", payload={**hidden}, csrf=alc)
            expect_status(alice, base + shared_path + "/members", 404, method="POST", payload={}, csrf=alc)
            expect_status(alice, base + shared_path + f"/projects/{shared['id']}", 403,
                          method="DELETE", payload={}, csrf=alc)
            expect_status(alice, base + shared_path + f"/tasks/{task['id']}", 403, method="PUT",
                          payload={**task, "project_id": private["id"]}, csrf=alc)
            expect_status(alice, base + shared_path + "/tasks", 400, method="POST",
                          payload={"title": "Bad inbox conversion", "_inbox_id": 1}, csrf=alc)
            expect_status(alice, base + shared_path + "/tasks", 403, method="POST", payload={"title": "No CSRF"})
            changed = call(alice, alc, shared_path + f"/tasks/{task['id']}", {**task, "status": "done"}, "PUT")
            assert "_history_id" not in changed and "start_at" not in changed
            assert len([t for t in boot(admin)["tasks"] if t["project_id"] == shared["id"]]) == 2
            call(alice, alc, shared_path + f"/tasks/{task['id']}", {}, "DELETE")
            owner_boot = boot(admin)
            assert owner_boot["calendar_events"][0]["id"] == event["id"]
            assert owner_boot["calendar_events"][0]["task_id"] is None
            deleted = next(item for item in owner_boot["history"] if item["label"] == "删除：Shared task")
            call(admin, ac, f"/api/history/{deleted['id']}/undo", {})
            assert boot(admin)["calendar_events"][0]["task_id"] == task["id"]
            call(alice, alc, shared_path + f"/projects/{shared['id']}", {**shared, "title": "Together"}, "PUT")
            made = call(alice, alc, shared_path + "/tasks", {"title": "Member task", "project_id": shared["id"]})
            call(alice, alc, shared_path + f"/tasks/{made['id']}", {}, "DELETE")
            exported = call(alice, alc, "/api/export", method="GET")
            assert "Admin private" not in json.dumps(exported) and "private-api-key" not in json.dumps(exported)
            assert exported["calendar_events"] == []
            call(admin, ac, f"/api/projects/{shared['id']}/members", {"username": "alice", "permission": "remove"})
            assert all(not p["shared"] for p in boot(alice)["projects"])
            expect_status(alice, base + shared_path + "/tasks", 403, method="POST", payload={"title": "Removed"}, csrf=alc)
            call(admin, ac, f"/api/accounts/{a['id']}", {"enabled": False})
            assert boot(alice)["authenticated"] is False
            expect_status(alice, base + "/api/login", 401, method="POST", payload={"username": "alice", "password": "alice-password"})
            call(admin, ac, f"/api/accounts/{a['id']}", {"enabled": True, "password": "alice-reset-password"})
            alc = login(alice, "alice", "alice-reset-password")
            assert boot(alice)["projects"][0]["id"] == own["id"]
            copy, copy_jar = client()
            for cookie in alice_jar: copy_jar.set_cookie(cookie)
            call(alice, alc, "/api/logout", {})
            assert boot(copy)["authenticated"] is False
            alc = login(alice, "alice", "alice-reset-password")
            call(alice, alc, "/api/password", {"current_password": "alice-reset-password", "password": "alice-final-password"})
            assert boot(alice)["authenticated"] is False
            expect_status(alice, base + "/api/login", 401, method="POST", payload={"username": "alice", "password": "alice-reset-password"})
            login(alice, "alice", "alice-final-password")
            old = server.encode_token({"exp": 9999999999, "csrf": "legacy"})
            assert accounts.session_user(server.DATA_DIR, server.decode_token(old)) is None
            # Restart initialization must not overwrite changed database passwords.
            server.init_database()
            assert accounts.verify("alice-final-password", accounts.find_user(server.DATA_DIR, "alice")["password_hash"])
            assert accounts.find_user(server.DATA_DIR, "alice")["password_hash"] != "alice-final-password"
            assert research.workspace_lock(lambda: server.connect_workspace(a["id"]), "summary") is not research.workspace_lock(lambda: server.connect_workspace(1), "summary")
            refreshed = threading.Event()
            paths = []
            def refresh(connect, force=False):
                with connect() as db:
                    paths.append(db.execute("PRAGMA database_list").fetchone()[2])
                refreshed.set()
            with patch("research.refresh_feed", side_effect=refresh):
                call(bob, bc, "/api/research/refresh", {})
                assert refreshed.wait(2)
            assert Path(paths[0]) == server.workspace_path(b["id"])
            print("PASS: legacy admin migration, managed accounts, private data and keys, sharing view/edit/removal, cross-project denial, repeats, export, disable/reset, logout revocation and old-token rejection")
        finally:
            httpd.shutdown(); httpd.server_close(); thread.join(timeout=5)


if __name__ == "__main__":
    main()
