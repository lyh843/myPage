#!/usr/bin/env python3
"""Single-user, server-hosted schedule and research dashboard."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import research
import schedule


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data")).resolve()
DB_PATH = DATA_DIR / "workspace.db"
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8765"))
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "change-me")
APP_SECRET = os.environ.get("APP_SECRET") or secrets.token_hex(32)
SESSION_TTL = 60 * 60 * 24 * 14
MAX_BODY_SIZE = 512 * 1024

DB_LOCK = threading.RLock()
LOGIN_ATTEMPTS: dict[str, list[float]] = {}

TASK_STATUSES = {"todo", "doing", "done"}


def utc_now() -> str:
    return schedule.stamp()


def local_now() -> datetime:
    return datetime.now(timezone(timedelta(hours=8))).replace(tzinfo=None)


def db_connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    return connection


def init_database() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with DB_LOCK, db_connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS directory_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                url TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT '其他',
                note TEXT NOT NULL DEFAULT '',
                icon TEXT NOT NULL DEFAULT 'link',
                color TEXT NOT NULL DEFAULT 'blue',
                position INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS directory_categories (
                name TEXT PRIMARY KEY
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                course TEXT NOT NULL DEFAULT '',
                due_date TEXT NOT NULL DEFAULT '',
                start_at TEXT NOT NULL DEFAULT '',
                end_at TEXT NOT NULL DEFAULT '',
                priority TEXT NOT NULL DEFAULT 'medium',
                status TEXT NOT NULL DEFAULT 'todo',
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS calendar_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                start_at TEXT NOT NULL,
                end_at TEXT NOT NULL,
                all_day INTEGER NOT NULL DEFAULT 0,
                timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
                location TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                calendar_name TEXT NOT NULL DEFAULT '个人日历',
                color TEXT NOT NULL DEFAULT 'blue',
                repeat_rule TEXT NOT NULL DEFAULT 'none',
                repeat_until TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )

        task_columns = {
            row["name"] for row in db.execute("PRAGMA table_info(tasks)").fetchall()
        }
        if "start_at" not in task_columns:
            db.execute("ALTER TABLE tasks ADD COLUMN start_at TEXT NOT NULL DEFAULT ''")
        if "end_at" not in task_columns:
            db.execute("ALTER TABLE tasks ADD COLUMN end_at TEXT NOT NULL DEFAULT ''")

        existing = db.execute("SELECT COUNT(*) FROM settings").fetchone()[0]
        if existing == 0:
            seed_database(db)
        directory_seeded = db.execute(
            "SELECT value FROM settings WHERE key = 'directory_seed_version'"
        ).fetchone()
        if directory_seeded is None:
            directory_count = db.execute("SELECT COUNT(*) FROM directory_links").fetchone()[0]
            if directory_count == 0:
                seed_directory_links(db)
            db.execute(
                "INSERT INTO settings (key, value) VALUES ('directory_seed_version', 'legacy-v1')"
            )
        db.execute(
            """INSERT OR IGNORE INTO directory_categories (name)
            SELECT category FROM directory_links WHERE category != '' ORDER BY position, id"""
        )
        schedule.init_schema(db)
        research.init_schema(db)


def seed_database(db: sqlite3.Connection) -> None:
    now = utc_now()
    settings = {
        "display_name": "LYH",
        "role": "个人日程",
        "bio": "日常待办与日程安排。",
        "github": "https://github.com/lyh843",
    }
    db.executemany(
        "INSERT INTO settings (key, value) VALUES (?, ?)", settings.items()
    )

    today = date.today()
    tasks = [
        ("整理本周组会实验结果", "科研", str(today + timedelta(days=1)), "high", "doing", "补齐消融实验表格"),
        ("复习 Transformer 注意力机制", "深度学习", str(today + timedelta(days=3)), "medium", "todo", "从公式推导到 PyTorch 实现"),
        ("配置论文复现环境", "科研", str(today + timedelta(days=5)), "low", "todo", "记录 CUDA 与依赖版本"),
        ("完成概率论习题", "课程", str(today - timedelta(days=1)), "medium", "done", "第 4 章"),
    ]
    db.executemany(
        """INSERT INTO tasks
        (title, course, due_date, priority, status, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        [(*item, now, now) for item in tasks],
    )


def seed_directory_links(db: sqlite3.Connection) -> None:
    """Restore the deduplicated link collection from the previous static site."""
    groups = [
        ("个人入口", "user-round", "dark", [
            ("AnyRouter", "https://anyrouter.top/register?aff=x5ZK"),
            ("我的 GitHub", "https://github.com/lyh843"),
            ("我的博客", "http://4.189.252.43"),
            ("旧版 todo_list", "https://lyh843.github.io/todo"),
            ("旧版南大相关网站", "https://lyh843.github.io/nju"),
            ("旧版所有课程", "https://lyh843.github.io/preClass"),
            ("旧版所有工具", "https://lyh843.github.io/tools"),
        ]),
        ("南大常用", "landmark", "red", [
            ("南京大学官网", "https://www.nju.edu.cn/"),
            ("办事服务大厅", "https://ehall.nju.edu.cn/"),
            ("南京大学 Wi-Fi", "https://p.nju.edu.cn/"),
            ("南京大学邮箱", "https://mail.nju.edu.cn/"),
            ("教务系统", "http://elite.nju.edu.cn/jiaowu/login.do"),
            ("南大云盘 Box", "https://box.nju.edu.cn/"),
            ("本科生院教学信息网", "https://jw.nju.edu.cn/"),
            ("南大五育", "https://ndwy.nju.edu.cn/dztml/"),
            ("南大第二课堂", "https://youth.nju.edu.cn/tw/"),
            ("南大图书馆", "https://lib.nju.edu.cn/"),
            ("南大测速", "https://test.nju.edu.cn/"),
            ("信息化建设管理服务中心", "https://itsc.nju.edu.cn/main.htm"),
            ("南大 Table", "https://table.nju.edu.cn/"),
            ("查排名网站 1", "http://elite.nju.edu.cn/exchangesystem"),
            ("查排名网站 2", "http://elite.nju.edu.cn/exchangesystem/index/create?pid=380"),
        ]),
        ("南大服务", "building-2", "red", [
            ("中国大学 MOOC", "https://www.icourse163.org/"),
            ("南大 SPOC", "https://study.nju.edu.cn/"),
            ("南大 DeepSeek", "https://chat.nju.edu.cn/"),
            ("南大 LaTeX", "https://tex.nju.edu.cn/zh/login/"),
            ("智慧团建", "https://zhtj.youth.cn/zhtj/"),
            ("南大共青团", "https://tuanwei.nju.edu.cn/"),
            ("国际化工作处", "https://stuex.nju.edu.cn/"),
            ("体育部", "https://tyb.nju.edu.cn/"),
            ("财务处", "https://ndcwc.nju.edu.cn/main.psp"),
            ("南大校医院", "https://hospital.nju.edu.cn/"),
            ("南大选课", "https://xk.nju.edu.cn/"),
            ("南大英语", "https://eol.nju.edu.cn/"),
        ]),
        ("当前课程", "notebook-tabs", "blue", [
            ("机器学习导论", "http://10.58.102.15:3001/"),
            ("数据库概论", "http://ws2.nju.edu.cn/kgwiki/doku.php?id=courses:db2"),
            ("数据库 CSLab", "https://cslab-cms.nju.edu.cn/classrooms/iazf4uhj/announcement"),
            ("数理逻辑", "https://daiwz.net/teaching/"),
            ("操作系统课堂派", "https://www.ketangpai.cn/#/main/classDetail?courseid=MDAwMDAwMDAwMLOcuZaGqbuxhaVyoQ&courserole=0&submodulename=0"),
            ("计算方法", "https://nju-3dv.github.io/cm2026/"),
            ("Lab RoadMap", "https://github.com/LAMDASZ-ML/Lab-RoadMap"),
            ("Happy LLM", "https://datawhalechina.github.io/happy-llm/#/"),
            ("Hello Agents", "https://datawhalechina.github.io/hello-agents/#/"),
        ]),
        ("课程基础", "school", "blue", [
            ("高级程序设计", "https://cslab-cms.nju.edu.cn/"),
            ("高级程序设计 OJ", "https://oj.cpl.icu/"),
            ("南大 C 语言飞书", "https://njusecourse.feishu.cn/wiki/A1HzwviAgiFnQwkfRUWcVjqunLf"),
            ("程序设计", "https://yangyibiao.github.io/cpl"),
            ("数字系统设计基础", "http://zhuhao.cc/course"),
        ]),
        ("课程核心", "binary", "blue", [
            ("概率论与数理统计", "https://lukexuke.github.io/course/probability/Probability%20and%20Statistics%20(Fall%202025).html"),
            ("人工智能导论", "https://www.lamda.nju.edu.cn/guolz/introAi/fall2025/index.html"),
            ("最优化方法导论", "https://optimization-2025.github.io/"),
            ("数据结构", "https://iseoj.nju.edu.cn/is"),
            ("程序设计实训 OJ", "http://njuszoj.openjudge.cn"),
            ("智软数据结构 OJ", "https://iseoj.nju.edu.cn/"),
            ("SICP", "https://sicp.pascal-lab.net/2025/"),
        ]),
        ("AI 对话", "messages-square", "yellow", [
            ("DeepSeek", "https://chat.deepseek.com/"),
            ("GitHub", "https://github.com/"),
            ("ChatGPT", "https://chatgpt.com/"),
            ("Gemini", "https://gemini.google.com/app"),
            ("豆包", "https://www.doubao.com/"),
            ("Sakura Cat", "https://sakura-cat1.com/dashboard"),
        ]),
        ("AI 科研", "microscope", "green", [
            ("Google Scholar", "https://scholar.google.com/"),
            ("arXiv", "https://arxiv.org/"),
            ("Semantic Scholar", "https://www.semanticscholar.org/"),
            ("OpenReview", "https://openreview.net/"),
            ("Hugging Face", "https://huggingface.co/"),
            ("Hugging Face Papers", "https://huggingface.co/papers"),
            ("JMLR", "https://jmlr.org/"),
            ("TMLR", "https://www.jmlr.org/tmlr/"),
            ("CVF Open Access", "https://openaccess.thecvf.com/"),
            ("ACL Anthology", "https://aclanthology.org/"),
            ("NeurIPS", "https://neurips.cc/"),
            ("ICML", "https://icml.cc/"),
            ("ICLR", "https://iclr.cc/"),
            ("DBLP", "https://dblp.org/"),
        ]),
        ("常用网站", "globe-2", "dark", [
            ("智科全家桶", "https://njuis-students.github.io/"),
            ("哔哩哔哩", "https://www.bilibili.com/"),
            ("网易云音乐", "https://music.163.com/"),
            ("百度", "https://www.baidu.com/"),
            ("Bing", "https://www.bing.com/"),
            ("学习通网页版", "https://passport2.chaoxing.com/login?fid=&newversion=true&refer=https%3A%2F%2Fi.chaoxing.com"),
            ("PaperPass", "https://www.paperpass.com/"),
            ("LeetCode", "https://leetcode.cn/"),
            ("有道词典", "https://www.youdao.com/"),
            ("C 语言手册", "https://ref.cpl.icu/"),
        ]),
        ("开发工具", "wrench", "green", [
            ("Stack Overflow", "https://stackoverflow.com/"),
            ("函数可视化", "https://graphtoy.com/"),
            ("数据结构可视化", "https://visualgo.net/zh"),
            ("泡泡狗", "https://0223.ppg02-mqelltoq.top/"),
            ("DeepSeek API 平台", "https://platform.deepseek.com/usage"),
            ("阿里云 API 平台", "https://bailian.console.aliyun.com/cn-beijing/?tab=model#/api-key"),
            ("稀土掘金", "https://juejin.cn/"),
            ("Consensus", "https://consensus.app/"),
            ("中国知网", "https://www.cnki.net/"),
            ("IEEE Xplore", "https://ieeexplore.ieee.org/Xplore/home.jsp"),
            ("C++ 在线编译", "http://cpp.sh/"),
            ("LMArena", "https://lmarena.ai/"),
            ("NVIDIA Build", "https://build.nvidia.com/"),
        ]),
    ]
    now = utc_now()
    rows = []
    position = 1
    for category, icon, color, items in groups:
        for title, url in items:
            rows.append((title, url, category, "", icon, color, position, now, now))
            position += 1
    db.executemany(
        """INSERT INTO directory_links
        (title, url, category, note, icon, color, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        rows,
    )


def encode_token(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, separators=(",", ":")).encode()
    body = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
    signature = hmac.new(APP_SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{signature}"


def decode_token(token: str) -> dict[str, Any] | None:
    try:
        body, supplied_signature = token.split(".", 1)
        expected = hmac.new(APP_SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(supplied_signature, expected):
            return None
        padding = "=" * (-len(body) % 4)
        payload = json.loads(base64.urlsafe_b64decode(body + padding))
        if int(payload.get("exp", 0)) < int(time.time()):
            return None
        return payload
    except (ValueError, TypeError, json.JSONDecodeError):
        return None


def clean_text(value: Any, field: str, max_length: int, required: bool = False) -> str:
    text = str(value or "").strip()
    if required and not text:
        raise ValueError(f"{field}不能为空")
    if len(text) > max_length:
        raise ValueError(f"{field}不能超过 {max_length} 个字符")
    return text


def clean_url(value: Any, field: str = "链接", required: bool = False) -> str:
    url = clean_text(value, field, 1200, required)
    if not url:
        return ""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{field}必须是有效的 http(s) 地址")
    return url


def clean_local_datetime(value: Any, field: str) -> tuple[str, datetime | None]:
    text = clean_text(value, field, 16)
    if not text:
        return "", None
    try:
        parsed = datetime.strptime(text, "%Y-%m-%dT%H:%M")
    except ValueError as error:
        raise ValueError(f"{field}格式无效") from error
    return text, parsed


def validate_payload(table: str, data: dict[str, Any]) -> dict[str, Any]:
    if table == "inbox":
        return {"title": clean_text(data.get("title"), "收集内容", 1000, True)}
    if table == "research_items":
        return {"favorite": int(bool(data.get("favorite")))}
    if table == "directory_links":
        color = clean_text(data.get("color", "blue"), "颜色", 20)
        if color not in {"blue", "red", "yellow", "green", "dark"}:
            color = "blue"
        return {
            "title": clean_text(data.get("title"), "名称", 80, True),
            "url": clean_url(data.get("url"), required=True),
            "category": clean_text(data.get("category", "工具"), "分类", 30) or "工具",
            "note": clean_text(data.get("note"), "备注", 160),
            "icon": clean_text(data.get("icon", "link"), "图标", 40) or "link",
            "color": color,
        }
    if table == "tasks":
        status = clean_text(data.get("status", "todo"), "状态", 20)
        priority = clean_text(data.get("priority", "medium"), "优先级", 20)
        due_date = clean_text(data.get("due_date"), "截止日期", 10)
        start_at, start_time = clean_local_datetime(data.get("start_at"), "起始时间")
        end_at, end_time = clean_local_datetime(data.get("end_at"), "终止时间")
        if status not in TASK_STATUSES:
            raise ValueError("任务状态无效")
        if priority not in {"low", "medium", "high"}:
            raise ValueError("任务优先级无效")
        if due_date:
            try:
                datetime.strptime(due_date, "%Y-%m-%d")
            except ValueError:
                raise ValueError("截止日期格式无效") from None
        deadline_at, _ = clean_local_datetime(data.get("deadline_at"), "截止时间")
        if not deadline_at and end_at and not start_at and not due_date:
            deadline_at = end_at
        repeat = schedule.repeat_fields(data, deadline_at or due_date)
        if repeat["repeat_rule"] != "none" and not (deadline_at or due_date):
            raise ValueError("重复任务需要截止日期或时间")
        if start_time and not end_time:
            raise ValueError("设置起始时间后还需要设置终止时间")
        if start_time and end_time and end_time <= start_time:
            raise ValueError("终止时间必须晚于起始时间")
        return {
            "title": clean_text(data.get("title"), "任务名称", 160, True),
            "course": clean_text(data.get("course"), "领域", 50),
            "due_date": due_date,
            "start_at": start_at,
            "end_at": end_at,
            "priority": priority,
            "status": status,
            "notes": clean_text(data.get("notes"), "备注", 1200),
            "deadline_at": deadline_at,
            **repeat,
        }
    if table == "calendar_events":
        start_at = clean_text(data.get("start_at"), "开始时间", 16, True)
        end_at = clean_text(data.get("end_at"), "结束时间", 16, True)
        try:
            start_time = datetime.strptime(start_at, "%Y-%m-%dT%H:%M")
            end_time = datetime.strptime(end_at, "%Y-%m-%dT%H:%M")
        except ValueError as error:
            raise ValueError("日程时间格式无效") from error
        if end_time <= start_time:
            raise ValueError("结束时间必须晚于开始时间")

        repeat_rule = clean_text(data.get("repeat_rule", "none"), "重复规则", 20) or "none"
        if repeat_rule not in {"none", "daily", "weekly", "monthly", "yearly"}:
            raise ValueError("重复规则无效")
        repeat_until = clean_text(data.get("repeat_until"), "重复截止日期", 10)
        if repeat_until:
            try:
                until_date = datetime.strptime(repeat_until, "%Y-%m-%d").date()
            except ValueError as error:
                raise ValueError("重复截止日期格式无效") from error
            if until_date < start_time.date():
                raise ValueError("重复截止日期不能早于开始日期")

        color = clean_text(data.get("color", "blue"), "颜色", 20) or "blue"
        if color not in {"blue", "red", "yellow", "green", "dark"}:
            color = "blue"
        all_day = data.get("all_day", False)
        if isinstance(all_day, str):
            all_day = all_day.lower() in {"1", "true", "yes", "on"}
        return {
            "title": clean_text(data.get("title"), "日程标题", 160, True),
            "start_at": start_at,
            "end_at": end_at,
            "all_day": int(bool(all_day)),
            "timezone": clean_text(data.get("timezone", "Asia/Shanghai"), "时区", 80) or "Asia/Shanghai",
            "location": clean_text(data.get("location"), "地点", 200),
            "description": clean_text(data.get("description"), "说明", 2000),
            "calendar_name": clean_text(data.get("calendar_name", "个人日历"), "所属日历", 40) or "个人日历",
            "color": color,
            "repeat_rule": repeat_rule,
            "repeat_until": repeat_until,
            **schedule.repeat_fields(data, start_at),
            "task_id": schedule.integer(data["task_id"], 1, 2147483647, "关联任务") if data.get("task_id") else None,
            "reminder_minutes": schedule.integer(data.get("reminder_minutes", 15), -1, 1440, "提醒提前分钟数"),
        }
    raise ValueError("未知的数据类型")


def get_bootstrap_data(authenticated: bool) -> dict[str, Any]:
    with DB_LOCK, db_connect() as db:
        settings = {
            row["key"]: row["value"]
            for row in db.execute(
                "SELECT key, value FROM settings WHERE key IN ('display_name', 'role', 'bio', 'github')"
            )
        }
        can_read = authenticated
        if not can_read:
            settings = {}
        if can_read:
            directory_links = [dict(row) for row in db.execute("SELECT * FROM directory_links ORDER BY position, id")]
            directory_categories = [
                row["name"] for row in db.execute("SELECT name FROM directory_categories ORDER BY rowid")
            ]
            tasks = [dict(row) for row in db.execute("SELECT * FROM tasks ORDER BY status, due_date, id")]
            calendar_events = [
                dict(row)
                for row in db.execute("SELECT * FROM calendar_events ORDER BY start_at, id")
            ]
        else:
            directory_links, tasks, calendar_events = [], [], []
            directory_categories = []
        extra = {}
        if authenticated:
            now = local_now()
            extra = {
                "inbox": [dict(row) for row in db.execute("SELECT * FROM inbox ORDER BY id DESC")],
                "occurrences": schedule.expand_events(db, now - timedelta(days=7), now + timedelta(days=90)),
                "reminders": schedule.reminders(db, now),
                "history": schedule.history_items(db),
                "research_items": research.list_items(db),
                "llm_settings": research.settings(db),
                "feed_refreshing": research.REFRESH_LOCK.locked(),
            }

    stats = {
        "open_tasks": sum(task["status"] != "done" for task in tasks),
        "directory_links": len(directory_links),
    }
    return {
        "authenticated": authenticated,
        "public_read": False,
        "settings": settings,
        "directory_links": directory_links,
        "directory_categories": directory_categories,
        "tasks": tasks,
        "calendar_events": calendar_events,
        "stats": stats,
        **extra,
    }


class DashboardHandler(SimpleHTTPRequestHandler):
    server_version = "ResearchDesk/1.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stdout.write(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}\n")

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' https://unpkg.com; "
            "style-src 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; "
            "img-src 'self' data: https://github.com https://avatars.githubusercontent.com; "
            "connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        )
        super().end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/bootstrap":
            authenticated, csrf = self.auth_context()
            payload = get_bootstrap_data(authenticated)
            payload["csrf_token"] = csrf if authenticated else ""
            self.send_json(payload)
            return
        if path == "/api/calendar":
            authenticated, _ = self.auth_context()
            if not authenticated:
                self.send_error_json(HTTPStatus.UNAUTHORIZED, "请先登录")
                return
            try:
                params = parse_qs(urlparse(self.path).query)
                start = datetime.strptime(params.get("start", [""])[0], "%Y-%m-%dT%H:%M")
                end = datetime.strptime(params.get("end", [""])[0], "%Y-%m-%dT%H:%M")
                with DB_LOCK, db_connect() as db:
                    self.send_json(schedule.expand_events(db, start, end))
            except ValueError as error:
                self.send_error_json(HTTPStatus.BAD_REQUEST, str(error))
            return
        if path == "/api/export":
            authenticated, _ = self.auth_context()
            if not authenticated:
                self.send_error_json(HTTPStatus.UNAUTHORIZED, "请先登录")
                return
            data = get_bootstrap_data(True)
            data.pop("authenticated", None)
            data.pop("public_read", None)
            for key in ("llm_settings", "feed_refreshing", "occurrences", "reminders", "history"):
                data.pop(key, None)
            with DB_LOCK, db_connect() as db:
                data["research_items"] = [dict(row) for row in db.execute("SELECT * FROM research_items")]
                data["event_exceptions"] = [dict(row) for row in db.execute("SELECT * FROM event_exceptions")]
                data["reminder_states"] = [dict(row) for row in db.execute("SELECT * FROM reminder_states")]
            data["exported_at"] = utc_now()
            body = json.dumps(data, ensure_ascii=False, indent=2).encode()
            filename = f"research-desk-{date.today().isoformat()}.json"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path.startswith("/api/"):
            self.send_error_json(HTTPStatus.NOT_FOUND, "接口不存在")
            return
        if path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            data = self.read_json()
        except ValueError as error:
            self.send_error_json(HTTPStatus.BAD_REQUEST, str(error))
            return

        if path == "/api/login":
            self.handle_login(data)
            return

        authenticated, csrf = self.auth_context()
        if not self.require_write_auth(authenticated, csrf):
            return

        if path == "/api/logout":
            self.send_json(
                {"ok": True},
                cookie="research_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
            )
            return
        if self.feature_action(path, data):
            return

        match = re.fullmatch(r"/api/(directory-links|tasks|calendar-events|inbox)", path)
        if match:
            self.create_record(match.group(1).replace("-", "_"), data)
            return

        if path == "/api/directory-categories":
            self.create_directory_category(data)
            return

        if path == "/api/settings":
            self.update_settings(data)
            return

        self.send_error_json(HTTPStatus.NOT_FOUND, "接口不存在")

    def do_PUT(self) -> None:
        path = urlparse(self.path).path
        try:
            data = self.read_json()
        except ValueError as error:
            self.send_error_json(HTTPStatus.BAD_REQUEST, str(error))
            return
        authenticated, csrf = self.auth_context()
        if not self.require_write_auth(authenticated, csrf):
            return
        match = re.fullmatch(r"/api/(directory-links|tasks|calendar-events|inbox|research-items)/(\d+)", path)
        if not match:
            self.send_error_json(HTTPStatus.NOT_FOUND, "接口不存在")
            return
        self.update_record(match.group(1).replace("-", "_"), int(match.group(2)), data)

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        authenticated, csrf = self.auth_context()
        if not self.require_write_auth(authenticated, csrf):
            return
        match = re.fullmatch(r"/api/(directory-links|tasks|calendar-events|inbox|research-items)/(\d+)", path)
        if not match:
            self.send_error_json(HTTPStatus.NOT_FOUND, "接口不存在")
            return
        table, record_id = match.group(1).replace("-", "_"), int(match.group(2))
        try:
            data = self.read_json()
            with DB_LOCK, db_connect() as db:
                before = schedule.snapshot(db, table, record_id)
                if before is None:
                    self.send_error_json(HTTPStatus.NOT_FOUND, "记录不存在")
                    return
                schedule.check_version(before, data)
                changes = []
                if table == "tasks":
                    for event in db.execute("SELECT id FROM calendar_events WHERE task_id=?", (record_id,)).fetchall():
                        old = schedule.snapshot(db, "calendar_events", event["id"])
                        db.execute("DELETE FROM calendar_events WHERE id=?", (event["id"],))
                        changes.append(schedule.change(db, "calendar_events", old, event["id"]))
                db.execute(f"DELETE FROM {table} WHERE id=?", (record_id,))
                changes.insert(0, schedule.change(db, table, before, record_id))
                history_id = schedule.record_change(db, "删除：" + before.get("title", ""), changes)
            self.send_json({"ok": True, "history_id": history_id})
        except (ValueError, sqlite3.IntegrityError) as error:
            self.feature_error(error)

    def feature_error(self, error) -> None:
        status = HTTPStatus.CONFLICT if isinstance(error, (schedule.Conflict, sqlite3.IntegrityError)) else HTTPStatus.BAD_REQUEST
        message = "记录存在关联或已经改变，请刷新后重试" if isinstance(error, sqlite3.IntegrityError) else str(error)
        self.send_error_json(status, message)

    def feature_action(self, path, data) -> bool:
        undo = re.fullmatch(r"/api/history/(\d+)/undo", path)
        occurrence = re.fullmatch(r"/api/calendar-events/(\d+)/occurrence", path)
        summarize = re.fullmatch(r"/api/research/(\d+)/summarize", path)
        if path not in {"/api/reminders/state", "/api/llm-settings", "/api/research/refresh",
                        "/api/research/inspect"} and not (undo or occurrence or summarize):
            return False
        try:
            if path == "/api/research/refresh":
                threading.Thread(target=research.refresh_feed, args=(db_connect, True), daemon=True).start()
                self.send_json({"ok": True, "refreshing": True}, HTTPStatus.ACCEPTED)
                return True
            if path == "/api/research/inspect":
                item = research.extract_link(clean_text(data.get("url"), "链接", 2000, True))
                with DB_LOCK, db_connect() as db:
                    result = research.save_link(db, item)
                result.pop("content", None)
                self.send_json(result)
                return True
            if summarize:
                self.send_json(research.summarize(db_connect, int(summarize.group(1)), data.get("consent")))
                return True
            with DB_LOCK, db_connect() as db:
                result = {"ok": True}
                if undo:
                    schedule.undo(db, int(undo.group(1)))
                elif occurrence:
                    if not isinstance(data.get("event", {}), dict):
                        raise ValueError("日程格式无效")
                    result["history_id"] = schedule.edit_occurrence(
                        db, int(occurrence.group(1)), data, validate_payload)
                elif path == "/api/reminders/state":
                    key = clean_text(data.get("key"), "提醒标识", 250, True)
                    snoozed = (local_now() + timedelta(minutes=10)).isoformat(timespec="minutes") if data.get("snooze") else ""
                    db.execute("""INSERT INTO reminder_states VALUES (?, ?, ?)
                        ON CONFLICT(key) DO UPDATE SET dismissed=excluded.dismissed,snoozed_until=excluded.snoozed_until""",
                               (key, int(not bool(data.get("snooze"))), snoozed))
                elif path == "/api/llm-settings":
                    result = research.save_settings(db, data)
            self.send_json(result)
        except (ValueError, TypeError, sqlite3.IntegrityError) as error:
            self.feature_error(error)
        return True

    def handle_login(self, data: dict[str, Any]) -> None:
        client = self.client_address[0]
        now = time.time()
        attempts = [stamp for stamp in LOGIN_ATTEMPTS.get(client, []) if now - stamp < 300]
        LOGIN_ATTEMPTS[client] = attempts
        if len(attempts) >= 8:
            self.send_error_json(HTTPStatus.TOO_MANY_REQUESTS, "尝试次数过多，请 5 分钟后再试")
            return
        supplied = str(data.get("password", ""))
        if not hmac.compare_digest(supplied, ADMIN_PASSWORD):
            attempts.append(now)
            self.send_error_json(HTTPStatus.UNAUTHORIZED, "密码不正确")
            return
        LOGIN_ATTEMPTS.pop(client, None)
        csrf = secrets.token_urlsafe(24)
        token = encode_token({"exp": int(now) + SESSION_TTL, "csrf": csrf})
        cookie = f"research_session={token}; Path=/; HttpOnly; SameSite=Strict"
        if data.get("remember", True):
            cookie += f"; Max-Age={SESSION_TTL}"
        if os.environ.get("COOKIE_SECURE", "false").lower() in {"1", "true", "yes", "on"}:
            cookie += "; Secure"
        self.send_json({"ok": True, "csrf_token": csrf}, cookie=cookie)

    def auth_context(self) -> tuple[bool, str]:
        try:
            cookie = SimpleCookie(self.headers.get("Cookie", ""))
        except Exception:
            return False, ""
        morsel = cookie.get("research_session")
        if not morsel:
            return False, ""
        payload = decode_token(morsel.value)
        if not payload:
            return False, ""
        return True, str(payload.get("csrf", ""))

    def require_write_auth(self, authenticated: bool, csrf: str) -> bool:
        if not authenticated:
            self.send_error_json(HTTPStatus.UNAUTHORIZED, "请先登录后再编辑")
            return False
        if not csrf or not hmac.compare_digest(self.headers.get("X-CSRF-Token", ""), csrf):
            self.send_error_json(HTTPStatus.FORBIDDEN, "页面凭证已失效，请刷新后重试")
            return False
        return True

    def create_record(self, table: str, data: dict[str, Any]) -> None:
        try:
            values = validate_payload(table, data)
        except (ValueError, TypeError) as error:
            self.send_error_json(HTTPStatus.BAD_REQUEST, str(error))
            return
        now = utc_now()
        columns = list(values) + ["created_at", "updated_at"]
        params = list(values.values()) + [now, now]
        placeholders = ", ".join("?" for _ in columns)
        try:
            with DB_LOCK, db_connect() as db:
                inbox = schedule.snapshot(db, "inbox", data["_inbox_id"]) if data.get("_inbox_id") else None
                if data.get("_inbox_id"):
                    schedule.check_version(inbox, {"_version": data.get("_inbox_version")})
                cursor = db.execute(
                    f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({placeholders})", params)
                record_id = cursor.lastrowid
                row = db.execute(f"SELECT * FROM {table} WHERE id = ?", (record_id,)).fetchone()
                if table == "directory_links":
                    db.execute("INSERT OR IGNORE INTO directory_categories (name) VALUES (?)", (values["category"],))
                changes = [schedule.change(db, table, None, record_id)]
                if inbox:
                    db.execute("DELETE FROM inbox WHERE id=?", (inbox["id"],))
                    changes.append(schedule.change(db, "inbox", inbox, inbox["id"]))
                history_id = schedule.record_change(db, "添加：" + values.get("title", ""), changes)
            self.send_json({**dict(row), "_history_id": history_id}, status=HTTPStatus.CREATED)
        except (ValueError, sqlite3.IntegrityError) as error:
            self.feature_error(error)

    def update_record(self, table: str, record_id: int, data: dict[str, Any]) -> None:
        try:
            values = validate_payload(table, data)
        except (ValueError, TypeError) as error:
            self.send_error_json(HTTPStatus.BAD_REQUEST, str(error))
            return
        values["updated_at"] = utc_now()
        try:
            with DB_LOCK, db_connect() as db:
                before = schedule.snapshot(db, table, record_id)
                if before is None:
                    self.send_error_json(HTTPStatus.NOT_FOUND, "记录不存在")
                    return
                schedule.check_version(before, data)
                if table == "tasks" and before["repeat_rule"] != "none" and before["status"] != "done":
                    if data.get("_scope") == "one":
                        template = {key: before[key] for key in values if key != "updated_at"}
                        values["repeat_template"] = before["repeat_template"] or json.dumps(template, ensure_ascii=False)
                    elif "_scope" in data:
                        values["repeat_template"] = ""
                    else:
                        values["repeat_template"] = before["repeat_template"]
                if table == "tasks" and data.get("_skip") and values["repeat_rule"] != "none":
                    values["skipped"] = 1
                assignments = ", ".join(f"{key} = ?" for key in values)
                db.execute(f"UPDATE {table} SET {assignments} WHERE id=?", [*values.values(), record_id])
                changes = []
                if table == "tasks":
                    changes.extend(schedule.complete_repeating_task(db, before, values))
                changes.insert(0, schedule.change(db, table, before, record_id))
                row = db.execute(f"SELECT * FROM {table} WHERE id=?", (record_id,)).fetchone()
                if table == "directory_links":
                    db.execute("INSERT OR IGNORE INTO directory_categories (name) VALUES (?)", (values["category"],))
                history_id = schedule.record_change(db, "修改：" + before.get("title", ""), changes)
            self.send_json({**dict(row), "_history_id": history_id})
        except (ValueError, sqlite3.IntegrityError) as error:
            self.feature_error(error)

    def create_directory_category(self, data: dict[str, Any]) -> None:
        try:
            if not isinstance(data.get("name"), str):
                raise ValueError("分类名称必须是文本")
            name = clean_text(data["name"], "分类名称", 30, True)
            if name == "全部":
                raise ValueError("“全部”用于显示所有站点，请使用其他分类名称")
        except ValueError as error:
            self.send_error_json(HTTPStatus.BAD_REQUEST, str(error))
            return
        with DB_LOCK, db_connect() as db:
            cursor = db.execute("INSERT OR IGNORE INTO directory_categories (name) VALUES (?)", (name,))
            if cursor.rowcount == 0:
                self.send_error_json(HTTPStatus.CONFLICT, "该分类已存在")
                return
        self.send_json({"name": name}, status=HTTPStatus.CREATED)

    def update_settings(self, data: dict[str, Any]) -> None:
        try:
            values = {
                "display_name": clean_text(data.get("display_name"), "称呼", 40, True),
                "role": clean_text(data.get("role"), "身份", 80),
                "bio": clean_text(data.get("bio"), "简介", 180),
                "github": clean_url(data.get("github"), "GitHub 地址"),
            }
        except (ValueError, TypeError) as error:
            self.send_error_json(HTTPStatus.BAD_REQUEST, str(error))
            return
        with DB_LOCK, db_connect() as db:
            db.executemany(
                """INSERT INTO settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
                values.items(),
            )
        self.send_json(values)

    def read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("请求长度无效") from error
        if length <= 0:
            return {}
        if length > MAX_BODY_SIZE:
            raise ValueError("请求内容过大")
        try:
            value = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ValueError("请求内容不是有效的 JSON") from error
        if not isinstance(value, dict):
            raise ValueError("请求内容格式无效")
        return value

    def send_json(
        self,
        data: Any,
        status: HTTPStatus = HTTPStatus.OK,
        cookie: str | None = None,
    ) -> None:
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status: HTTPStatus, message: str) -> None:
        self.send_json({"error": message}, status=status)


def main() -> None:
    init_database()
    if ADMIN_PASSWORD == "change-me":
        print("WARNING: using development password 'change-me'. Set ADMIN_PASSWORD before deployment.")
    if "APP_SECRET" not in os.environ:
        print("NOTICE: APP_SECRET is temporary; sessions will reset after a restart.")
    server = ThreadingHTTPServer((HOST, PORT), DashboardHandler)
    stop = threading.Event()
    if os.environ.get("RESEARCH_AUTO_FETCH", "true").lower() == "true":
        threading.Thread(target=research.feed_worker, args=(db_connect, stop), daemon=True).start()
    print(f"Research Desk running at http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
    finally:
        stop.set()
        server.server_close()


if __name__ == "__main__":
    main()
