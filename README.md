# Research Desk

部署在服务器上的日程与科研阅读工作台。每个账户拥有独立的数据与设置，可主动共享项目及推进项；同一账户在不同设备上同步。本地文件、研究日志及 Zotero 数据交换留给其他工具或后续独立的本地工作台。

## 快速开始

推荐使用 Docker Compose：

```bash
cp .env.example .env
# 编辑 .env，设置强 ADMIN_PASSWORD 和至少 32 字符的随机 APP_SECRET
docker compose up -d --build
```

通过 HTTPS 反向代理访问后，使用用户名 `admin` 和配置的初始密码登录。在“设置 → 账户管理”创建成员，在项目详情的“共享与成员”中授予项目权限。仅在本机 HTTP 调试时，将 `.env` 中的 `COOKIE_SECURE` 改为 `false`，然后访问 `http://127.0.0.1:8765`。

已有部署升级前应备份整个数据目录或 Docker 数据卷。启动后原有数据归属 `admin`，旧会话失效；账号创建后，修改环境变量 `ADMIN_PASSWORD` 不会重置已有密码。

## 已实现

- 今日与明日安排：切换两天的安排，查看待办、截止点与逾期事项。
- 快速收集：一句话保存到收集箱，随后编辑、删除或转为项目／推进项／日程；转换与撤销是原子操作。
- 站内提醒：顶部未处理计数、页面内提示、已知晓和稍后 10 分钟。日程可设置提前量；显示最近七天的已开始日程及尚未处理的任务截止提醒。
- 网址导航：恢复旧站 98 个入口，按 10 个分类检索并支持在线维护。
- 项目推进：项目维护期望结果、状态、优先级、截止日期、阻塞和自定义变量；项目下的推进项沿用任务的截止、重复、完成与日历排程能力。
- 收集箱转项目：一条收集内容可以直接建立项目，或加入已有项目成为推进项；转换与撤销是原子操作。
- 日历：月、周、日、议程列表，分类筛选，隐藏已完成任务，框选创建、拖拽改期、拉伸时长、复制和重叠并排布局。保存与拖拽时检查当前时间段的冲突，允许确认后继续。
- 重复：按天／周／月／年和间隔、每周多天、截止日期；日程支持仅本次、本次及以后、整个系列和单次取消。重复任务完成／跳过后生成下一项，可仅修改本次并保留后续模板。
- 撤销与恢复：页面提示提供撤销，设置页提供最近 300 项操作和回收站，保留期限 30 天。后续修改或关联发生冲突时拒绝覆盖，历史跨设备保存。
- 论文发现：后台约每六小时聚合一次 Hugging Face 近七天每日收录，去重并按当前社区赞数排序，可手动刷新、筛选和收藏。
- 按需摘要：选择论文或读取公开网页，确认向配置的 LLM 服务发送所选内容后生成中文概述；结果保存在服务器，不自动批量消耗 API 额度。
- 全局搜索：使用 `Ctrl/Cmd + K` 搜索页面、项目、推进项、导航网站和日程。
- 多人账户：用户名与密码登录，由管理员创建账户、停用账户和重置密码，暂不开放注册。密码使用 scrypt 哈希；会话使用 HttpOnly Cookie，有效期 14 天，取消记住则使用浏览器会话 Cookie。退出会撤销当前会话，修改或重置密码、停用账户会撤销该账户所有会话。
- 项目共享：项目所有者按用户名授予查看或编辑权限，可随时移除成员。查看成员可以阅读项目详情与推进项；编辑成员可以修改项目、创建／修改／删除推进项。项目删除及成员管理保留给所有者。
- 设置与导出：个人资料、API 地址／模型／Key、每日请求上限、自动收集开关和 JSON 导出。
- 响应式界面：桌面、平板和手机使用对应的导航与信息布局。

后端使用 Python、SQLite、dateutil、trafilatura、cryptography 和 urllib3。日历交互使用本地固定版本 FullCalendar，许可证保存在 `static/vendor/`。账户、会话和项目授权保存在 `data/accounts.db`；初始管理员的数据沿用 `data/workspace.db`，其他账户的数据位于 `data/users/<用户ID>/workspace.db`。

## 多人使用与升级

1. 首次启动创建用户名为 `admin` 的管理员，初始密码来自 `ADMIN_PASSWORD`。升级已有部署时，原工作台数据、API 设置和操作历史自动归属此账户，原单用户 Cookie 失效，需要重新登录。
2. 登录后在“设置 → 账户管理”创建成员账户。用户名为 3–40 位字母、数字、下划线或短横线，统一转为小写；新账户及修改后的密码需为 10–256 个字符。新账户获得独立的导航目录和空工作台，不复制原管理员的任务或个人资料。
3. 在自己的项目详情中点击“共享与成员”，填写已启用账户的用户名，选择“查看”或“编辑”。收到的项目显示在成员的项目列表中，并标注所有者与权限。共享权限由后端检查，移除成员后下一次请求即无法访问。
4. 个人资料、导航、日历与日程、提醒处理状态、收集箱、论文收藏／摘要、LLM Key 与每日额度保持独立。共享项目的截止日期可在项目列表查看；为共享推进项安排日历时创建自己的日程副本，不关联所有者的私人日历。
5. 共享成员的修改记录保存在项目所有者的操作历史中；成员无法读取或撤销所有者的历史。成员删除推进项时，所有者关联的私人日程会保留并解除任务关联。共享项目不能直接从个人收集箱原子转换，需先创建共享推进项再处理收集内容。删除项目后，所有者恢复项目会同时恢复原成员的访问；要永久取消共享，应先移除成员。

管理员权限用于管理账户，不会自动开放其他账户的工作台。当前没有账户删除、项目转移、共享日历、公开注册、邮件找回或多人即时通知。创建账号后，`ADMIN_PASSWORD` 不会覆盖数据库中的密码；后续通过设置页修改或重置。

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

需要 Python 3.13 或更新版本；前端回归测试另需 Node.js。应用前端不需要 npm 安装或构建。

Linux / macOS：

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
ADMIN_PASSWORD='your-password' \
APP_SECRET='replace-with-a-long-random-string' \
.venv/bin/python server.py
```

打开 <http://127.0.0.1:8765>。若未配置环境变量，开发环境的临时密码是 `change-me`；这个默认值不能用于公网部署。

Windows PowerShell：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
$env:ADMIN_PASSWORD = 'replace-with-a-strong-password'
$env:APP_SECRET = 'replace-with-at-least-32-random-characters'
$env:COOKIE_SECURE = 'false'
.\.venv\Scripts\python.exe server.py
```

直接运行 `server.py` 时不会自动读取 `.env`，需通过终端或服务管理器注入环境变量。`.env` 用于 Docker Compose 的变量替换。`APP_SECRET` 示例只是占位符，实际部署应生成高熵随机值，例如运行 `python -c "import secrets; print(secrets.token_hex(32))"`。

运行端到端回归测试（测试数据只写入临时目录）：

```bash
RESEARCH_AUTO_FETCH=false .venv/bin/python tests/test_integration.py
.venv/bin/python tests/test_workbench.py
.venv/bin/python tests/test_accounts.py
```

前端逻辑回归使用 Node.js，无需安装 npm 依赖：

```bash
node tests/test_directory_ui.js
node tests/test_schedule_ui.js
node tests/test_accounts_ui.js
```

Windows 下将 Python 测试命令的 `.venv/bin/python` 替换为 `.\.venv\Scripts\python.exe`。测试会启动本机临时 HTTP 服务、创建并清理临时数据库，不修改实际工作台；科研请求使用模拟数据。多人回归覆盖旧库归属、账户管理、独立数据与 API Key、共享查看／编辑／撤销授权、跨项目越权、会话撤销及后台刷新隔离。

## Docker 部署

```bash
cp .env.example .env
# 编辑 .env，设置 ADMIN_PASSWORD 和 APP_SECRET
docker compose up -d --build
```

容器只监听宿主机的 `127.0.0.1:8765`，数据保存在 Docker 的 `research-data` 命名卷中。建议使用 Caddy 或 Nginx 提供 HTTPS。HTTPS 开启后保留 `COOKIE_SECURE=true`；仅在本地 HTTP 调试时设置为 `false`。

后续更新使用 `docker compose up -d --build`，查看服务状态与日志使用 `docker compose ps` 和 `docker compose logs --tail=100`。`docker compose down` 会保留命名卷；不要使用 `docker compose down -v`，该命令会删除工作台数据卷。

当前 Compose 文件从 `.env` 注入 `ADMIN_PASSWORD`、`APP_SECRET`、`COOKIE_SECURE`；容器的监听地址、端口和数据目录由 Dockerfile 设置。若需调整其他配置项，请在 `compose.yaml` 的 `environment` 中显式添加。

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

完整备份应在停止服务后复制整个 `data/` 目录，包含账户数据库、原管理员工作台和所有用户工作台；运行中需对各数据库使用 SQLite backup API。升级前先备份旧数据目录。JSON 导出包含当前账户可见的项目（包括共享项目）、收藏、摘要、私有日程例外及提醒处理状态，但不包含账户数据库、API 设置、Key 或会话凭证；目前没有整库 JSON 导入。单条误操作使用操作历史恢复，不能用它替代数据库备份。

Docker 部署应先执行 `docker compose stop`，备份 `research-data` 命名卷中的完整内容，完成后执行 `docker compose start`。恢复时同样先停服务，还原整个目录或卷并保持文件权限，使用原有 `APP_SECRET` 后再启动。工作台、账户、授权和 API Key 加密数据必须作为一套备份恢复。

API Key 使用 Fernet 加密，密钥由部署环境中的固定 `APP_SECRET` 派生，不存在浏览器存储、正常响应、日志或 JSON 导出中。保存 Key 要求 `APP_SECRET` 至少 32 字符；它应是高熵随机值，单独保管。更换它会使登录失效，也需要重新录入 API Key。

链接读取校验每一跳 DNS，拒绝本机、私网、保留地址与非标准端口，并固定连接目标 IP、验证原始域名 TLS。API 请求禁止重定向，不把 Key 转发到其他站点。每天请求数有上限，失败请求同样计数；这不是供应商费用硬上限，仍应在供应商侧设置预算。

## 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | `change-me` | 首次创建 `admin` 的初始密码，上线必须修改；已有账户的密码以数据库为准 |
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
├── accounts.py        # 账户、密码哈希、可撤销会话与共享授权
├── schedule.py        # 重复实例、提醒、迁移和可撤销变更
├── research.py        # 论文源、公开网页读取、加密设置与摘要
├── requirements.txt
├── static/
│   ├── index.html     # 工作台语义结构
│   ├── styles.css     # 响应式视觉系统
│   ├── app.js         # 项目推进、日程、网址导航与搜索交互
│   ├── workbench.js   # 交互日历、收集、提醒、论文和设置
│   ├── accounts.js    # 账户管理、修改密码与共享成员
│   └── vendor/        # 固定版本 FullCalendar 与许可证
├── Dockerfile
├── compose.yaml
└── .env.example
```

`.gitignore` 排除真实环境配置、数据库及 SQLite 日志、虚拟环境、本地规划／预览、备份和编辑器文件；`.env.example` 保留在仓库中。自定义 `DATA_DIR` 时也应确保实际数据目录不进入版本控制。
