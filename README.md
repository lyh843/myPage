# Research Desk

面向 AI 方向本科生的个人学习与科研工作台。它将原本写死在静态页面里的快捷入口改为服务器数据，并把任务、论文阅读和专注记录放在同一套界面中。

## 已实现

- 快捷入口：在线新增、编辑、删除、分类和搜索。
- 网址导航：恢复旧站 98 个入口，按 10 个分类检索并支持在线维护。
- 任务推进：按待处理、推进中、已完成组织，支持优先级与截止日期。
- 日历日程：提供月、周、日视图，支持全天日程、地点、颜色和重复规则。
- 论文队列：记录作者、来源、标签、阅读状态和笔记。
- 专注计时：保留 25 / 5 / 50 分钟模式，也可自由设置 1–240 分钟，完成后计入本周目标。
- 全局搜索：使用 `Ctrl/Cmd + K` 搜索页面、入口、任务和论文。
- 单用户编辑鉴权：访客可浏览，只有登录后可以写入数据。
- 数据导出：编辑模式下可下载完整 JSON 备份。
- 响应式界面：桌面、平板和手机使用对应的导航与信息布局。

后端仅使用 Python 标准库和 SQLite，不需要安装 pip 包。所有持久化数据默认位于 `data/workspace.db`。

## 本地运行

```bash
ADMIN_PASSWORD='your-password' \
APP_SECRET='replace-with-a-long-random-string' \
python3 server.py
```

打开 <http://127.0.0.1:8765>。若未配置环境变量，开发环境的临时密码是 `change-me`；这个默认值不能用于公网部署。

运行端到端回归测试（测试数据只写入临时目录）：

```bash
python3 tests/test_integration.py
```

## Docker 部署

```bash
cp .env.example .env
# 编辑 .env，设置 ADMIN_PASSWORD 和 APP_SECRET
docker compose up -d --build
```

容器只监听宿主机的 `127.0.0.1:8765`，数据保存在 Docker 的 `research-data` 命名卷中。建议使用 Caddy 或 Nginx 提供 HTTPS。HTTPS 开启后保留 `COOKIE_SECURE=true`；仅在本地 HTTP 调试时设置为 `false`。

Nginx 反向代理的最小配置：

```nginx
server {
    listen 443 ssl http2;
    server_name desk.example.com;

    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 隐私与备份

`PUBLIC_READ=true` 表示任何访客可以浏览数据，但写操作仍需要密码。若任务和论文笔记不适合公开，将其设为 `false`，未登录时界面不会返回工作台数据。

本地运行时可以直接备份 `data/workspace.db`。Docker 部署时推荐在编辑模式点击顶部下载按钮导出 JSON；`research-data` 命名卷会在容器重建和升级后继续保留。

## 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | `change-me` | 编辑模式密码，上线必须修改 |
| `APP_SECRET` | 启动时随机生成 | 会话签名密钥，上线必须固定 |
| `PUBLIC_READ` | `true` | 是否允许未登录访客读取数据 |
| `COOKIE_SECURE` | `false` | 是否只通过 HTTPS 发送登录 Cookie |
| `HOST` | `127.0.0.1` | 服务监听地址 |
| `PORT` | `8765` | 服务端口 |
| `DATA_DIR` | `./data` | SQLite 数据目录 |

## 项目结构

```text
.
├── server.py          # HTTP 服务、鉴权、校验与 SQLite API
├── static/
│   ├── index.html     # 工作台语义结构
│   ├── styles.css     # 响应式视觉系统
│   └── app.js         # CRUD、搜索与专注计时交互
├── Dockerfile
├── compose.yaml
└── .env.example
```
