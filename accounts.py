"""Account registry, revocable sessions and explicit project membership."""

import hashlib
import hmac
import re
import secrets
import sqlite3
import time
from contextlib import closing


def connect(root):
    db = sqlite3.connect(root / "accounts.db", timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    return db


def username(value):
    value = str(value or "").strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{2,39}", value):
        raise ValueError("用户名需为 3–40 位字母、数字、下划线或短横线")
    return value


def password_hash(value, validate=True):
    if not isinstance(value, str) or (validate and len(value) < 10) or len(value) > 256:
        raise ValueError("密码需为 10–256 个字符")
    salt = secrets.token_hex(16)
    digest = hashlib.scrypt(value.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return f"scrypt${salt}${digest}"


def verify(value, encoded):
    if not isinstance(value, str) or len(value) > 256:
        return False
    try:
        algorithm, salt, expected = encoded.split("$")
        if algorithm != "scrypt":
            return False
        actual = hashlib.scrypt(value.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def initialize(root, admin_password):
    with closing(connect(root)) as db, db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                is_admin INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
                expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS project_members (
                owner_id INTEGER NOT NULL REFERENCES users(id), project_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL REFERENCES users(id), permission TEXT NOT NULL
                    CHECK(permission IN ('view','edit')),
                PRIMARY KEY(owner_id, project_id, user_id)
            );
        """)
        if not db.execute("SELECT 1 FROM users LIMIT 1").fetchone():
            db.execute("INSERT INTO users(username,password_hash,is_admin,created_at) VALUES('admin',?,1,?)",
                       (password_hash(admin_password, validate=False), int(time.time())))


def public_user(row):
    return {key: row[key] for key in ("id", "username", "is_admin", "enabled")}


def find_user(root, name):
    with closing(connect(root)) as db:
        return db.execute("SELECT * FROM users WHERE username=?", (name,)).fetchone()


def session_user(root, payload):
    with closing(connect(root)) as db:
        return db.execute("""SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id
            WHERE s.id=? AND s.user_id=? AND s.expires_at>=? AND u.enabled=1""",
            (payload.get("sid", ""), payload.get("uid", 0), int(time.time()))).fetchone()


def new_session(root, user_id, expires):
    sid = secrets.token_urlsafe(32)
    with closing(connect(root)) as db, db:
        db.execute("DELETE FROM sessions WHERE expires_at<?", (int(time.time()),))
        db.execute("INSERT INTO sessions VALUES(?,?,?)", (sid, user_id, expires))
    return sid


def revoke(root, sid):
    with closing(connect(root)) as db, db:
        db.execute("DELETE FROM sessions WHERE id=?", (sid,))


def list_users(root):
    with closing(connect(root)) as db:
        return [public_user(row) for row in db.execute("SELECT * FROM users ORDER BY id")]


def create_user(root, data):
    name = username(data.get("username"))
    hashed = password_hash(data.get("password"))
    with closing(connect(root)) as db, db:
        row = db.execute("INSERT INTO users(username,password_hash,created_at) VALUES(?,?,?) RETURNING *",
                         (name, hashed, int(time.time()))).fetchone()
    return public_user(row)


def update_user(root, user_id, data):
    with closing(connect(root)) as db, db:
        row = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        if not row:
            raise ValueError("账户不存在")
        if "enabled" in data:
            if not isinstance(data["enabled"], bool):
                raise ValueError("账户状态无效")
            if row["is_admin"] and not data["enabled"]:
                raise ValueError("不能停用初始管理员")
            db.execute("UPDATE users SET enabled=? WHERE id=?", (int(data["enabled"]), user_id))
        if "password" in data:
            db.execute("UPDATE users SET password_hash=? WHERE id=?", (password_hash(data["password"]), user_id))
        db.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
        return public_user(db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone())


def membership(root, owner_id, project_id, user_id):
    with closing(connect(root)) as db:
        row = db.execute("""SELECT m.permission FROM project_members m JOIN users u ON u.id=m.owner_id
            WHERE m.owner_id=? AND m.project_id=? AND m.user_id=? AND u.enabled=1""",
            (owner_id, project_id, user_id)).fetchone()
        return row["permission"] if row else None


def shared_projects(root, user_id):
    with closing(connect(root)) as db:
        return [dict(row) for row in db.execute("""SELECT m.*, u.username AS owner_name
            FROM project_members m JOIN users u ON u.id=m.owner_id
            WHERE m.user_id=? AND u.enabled=1 ORDER BY m.owner_id,m.project_id""", (user_id,))]


def members(root, owner_id, project_id):
    with closing(connect(root)) as db:
        return [dict(row) for row in db.execute("""SELECT u.id,u.username,u.enabled,m.permission
            FROM project_members m JOIN users u ON u.id=m.user_id
            WHERE m.owner_id=? AND m.project_id=? ORDER BY u.username""", (owner_id, project_id))]


def set_member(root, owner_id, project_id, data):
    name = username(data.get("username"))
    permission = data.get("permission")
    if permission not in {"view", "edit", "remove"}:
        raise ValueError("请选择查看、编辑或移除成员")
    with closing(connect(root)) as db, db:
        user = db.execute("SELECT * FROM users WHERE username=?", (name,)).fetchone()
        if not user or (not user["enabled"] and permission != "remove") or user["id"] == owner_id:
            raise ValueError("请选择已启用的其他账户")
        if permission == "remove":
            db.execute("DELETE FROM project_members WHERE owner_id=? AND project_id=? AND user_id=?",
                       (owner_id, project_id, user["id"]))
        else:
            db.execute("""INSERT INTO project_members VALUES(?,?,?,?)
                ON CONFLICT(owner_id,project_id,user_id) DO UPDATE SET permission=excluded.permission""",
                (owner_id, project_id, user["id"], permission))
