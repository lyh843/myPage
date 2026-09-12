# Research Desk

部署在服务器上的私人日程与科研阅读工作台。不同设备共享日程、任务、收集箱、论文收藏与摘要。本地文件、研究日志、项目管理及 Zotero 数据交换留给其他工具或后续独立的本地工作台。

## 已实现

- 今日与明日安排：切换两天的安排，查看待办、截止点与逾期事项。
- 快速收集：一句话保存到收集箱，随后编辑、删除或转为任务／日程；转换与撤销是原子操作。
- 站内提醒：顶部未处理计数、页面内提示、已知晓和稍后 10 分钟。日程可设置提前量；显示最近七天的已开始日程及尚未处理的任务截止提醒。
- 网址导航：恢复旧站 98 个入口，按 10 个分类检索并支持在线维护。
- 任务与排程分开：截止日期／时间是截止点；通过关联日程，为一个任务安排多个工作时间块。
- 日历：月、周、日、议程列表，分类筛选，隐藏已完成任务，框选创建、拖拽改期、拉伸时长、复制和重叠并排布局。保存与拖拽时检查当前时间段的冲突，允许确认后继续。
- 重复：按天／周／月／年和间隔、每周多天、截止日期；日程支持仅本次、本次及以后、整个系列和单次取消。重复任务完成／跳过后生成下一项，可仅修改本次并保留后续模板。
- 撤销与恢复：页面提示提供撤销，设置页提供最近 300 项操作和回收站，保留期限 30 天。后续修改或关联发生冲突时拒绝覆盖，历史跨设备保存。
- 论文发现：后台约每六小时聚合一次 Hugging Face 近七天每日收录，去重并按当前社区赞数排序，可手动刷新、筛选和收藏。
- 按需摘要：选择论文或读取公开网页，确认向配置的 LLM 服务发送所选内容后生成中文概述；结果保存在服务器，不自动批量消耗 API 额度。
- 全局搜索：使用 `Ctrl/Cmd + K` 搜索页面、导航网站、任务和日程。
- 私人登录：默认首次访问需要密码，登录即可编辑；可使用 HttpOnly Cookie 记住浏览器 14 天，取消勾选则使用浏览器会话 Cookie。
- 设置与导出：个人资料、API 地址／模型／Key、每日请求上限、自动收集开关和 JSON 导出。
- 响应式界面：桌面、平板和手机使用对应的导航与信息布局。

后端使用 Python、SQLite、dateutil、trafilatura、cryptography 和 urllib3。日历交互使用本地固定版本 FullCalendar，许可证保存在 `static/vendor/`。持久化数据默认位于 `data/workspace.db`。

## 功能边界

- 站内提醒不使用系统通知、邮件或 Web Push；关闭网页后不会提醒。页面可见且没有编辑弹窗时约每 30 秒同步，返回页面也会刷新；编辑时保留草稿，过期版本保存返回冲突。
- 不实现教学周、学期、外部日历双向同步或跨时区转换。日程沿用本地墙钟时间，站内到期判断沿用北京时间。
- 月末或闰日重复遵循 dateutil / RFC 的有效日期规则，例如每月 31 日跳过没有 31 日的月份，不自动改为月末。
- “热门”仅表示 Hugging Face AI/ML 社区热度，不是全学科榜单，也不保证论文发表于最近七天。界面同时给出收录区间、检查时间及失败日期；失败保留旧缓存，不填充虚构论文。
- 自动论文概述基于来源提供的摘要；arXiv PDF 链接会转换为摘要页。普通链接只提取公开 HTML／纯文本，不读取登录页、内网、动态渲染内容或普通 PDF；截取到 40,000 字符时标明范围，不声称已读全文。
- API 使用兼容 Chat Completions 的协议，基础地址通常以 `/v1` 结尾，也可填写完整 `/chat/completions` 地址；需要支持 `messages`、`max_completion_tokens` 和 `choices[].message.content`。服务失败时保留原有摘要。
- 旧快捷入口、论文管理和专注模块仍然移除；新论文发现使用独立的 `research_items` 表。旧库历史表不销毁、不读取、不导出。升级前保留 SQLite 备份。
- 旧任务的明确起止时间会迁移为关联日程；仅结束时间且没有截止日期的旧任务会迁移为精确截止点，不再虚构前一小时的工作安排。

## 本地运行

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
ADMIN_PASSWORD='your-password' \
APP_SECRET='replace-with-a-long-random-string' \
.venv/bin/python server.py
```

打开 <http://127.0.0.1:8765>。若未配置环境变量，开发环境的临时密码是 `change-me`；这个默认值不能用于公网部署。

运行端到端回归测试（测试数据只写入临时目录）：

```bash
RESEARCH_AUTO_FETCH=false .venv/bin/python tests/test_integration.py
.venv/bin/python tests/test_workbench.py
```

前端逻辑回归使用 Node.js，无需安装 npm 依赖：

```bash
node tests/test_directory_ui.js
node tests/test_schedule_ui.js
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

服务器版统一为私密访问，未登录不会返回资料、日程、任务、论文及设置。旧部署的 `PUBLIC_READ` 配置不再生效，保留旧 `.env` 也不会重新开放业务读取。

完整数据库备份可在停止服务后复制 `data/workspace.db`，运行中使用 SQLite backup API。JSON 导出包含收藏、摘要、日程例外及提醒处理状态，但不包含 API 设置、Key 或会话凭证；目前没有整库 JSON 导入。单条误操作使用操作历史恢复，不能用它替代数据库备份。

API Key 使用 Fernet 加密，密钥由部署环境中的固定 `APP_SECRET` 派生，不存在浏览器存储、正常响应、日志或 JSON 导出中。保存 Key 要求 `APP_SECRET` 至少 32 字符；它应是高熵随机值，单独保管。更换它会使登录失效，也需要重新录入 API Key。

链接读取校验每一跳 DNS，拒绝本机、私网、保留地址与非标准端口，并固定连接目标 IP、验证原始域名 TLS。API 请求禁止重定向，不把 Key 转发到其他站点。每天请求数有上限，失败请求同样计数；这不是供应商费用硬上限，仍应在供应商侧设置预算。

## 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | `change-me` | 登录密码，上线必须修改 |
| `APP_SECRET` | 启动时随机生成 | 会话签名和 API Key 加密根密钥，上线必须固定 |
| `COOKIE_SECURE` | `false` | 是否只通过 HTTPS 发送登录 Cookie |
| `HOST` | `127.0.0.1` | 服务监听地址 |
| `PORT` | `8765` | 服务端口 |
| `DATA_DIR` | `./data` | SQLite 数据目录 |
| `RESEARCH_AUTO_FETCH` | `true` | 是否启动自动论文收集线程，测试时关闭；手动刷新仍可使用 |

## 项目结构

```text
.
├── server.py          # HTTP 服务、鉴权、校验与 SQLite API
├── schedule.py        # 重复实例、提醒、迁移和可撤销变更
├── research.py        # 论文源、公开网页读取、加密设置与摘要
├── requirements.txt
├── static/
│   ├── index.html     # 工作台语义结构
│   ├── styles.css     # 响应式视觉系统
│   ├── app.js         # 日程、任务、网址导航与搜索交互
│   ├── workbench.js   # 交互日历、收集、提醒、论文和设置
│   └── vendor/        # 固定版本 FullCalendar 与许可证
├── Dockerfile
├── compose.yaml
└── .env.example
```
