"use strict";

const state = {
  authenticated: false,
  csrfToken: "",
  settings: {},
  links: [],
  directoryLinks: [],
  tasks: [],
  papers: [],
  calendarEvents: [],
  stats: {},
  linkFilter: "全部",
  directoryFilter: "全部",
  taskFilter: "all",
  paperFilter: "all",
  editor: { kind: "", id: null },
  commandItems: [],
  commandIndex: 0,
  calendar: { view: localStorage.getItem("research-calendar-view") || "week", cursor: new Date(), scrollKey: "" },
  timer: { total: 25 * 60, remaining: 25 * 60, running: false, interval: null, isBreak: false },
};

const labels = {
  taskStatus: { todo: "待处理", doing: "推进中", done: "已完成" },
  paperStatus: { queue: "待读", reading: "精读中", done: "已完成" },
  priority: { low: "低", medium: "中", high: "高" },
};

const iconNames = new Set([
  "link", "graduation-cap", "file-text", "code-2", "boxes", "github", "sigma",
  "book-open", "brain-circuit", "database", "terminal", "globe-2", "notebook-pen",
  "chart-no-axes-combined", "bot", "folder-code", "external-link",
  "user-round", "landmark", "building-2", "notebook-tabs", "school", "binary",
  "messages-square", "microscope", "wrench", "compass",
]);

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeIcon(value) {
  return iconNames.has(value) ? value : "link";
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { "aria-hidden": "true" } });
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  if (method !== "GET" && state.csrfToken) headers["X-CSRF-Token"] = state.csrfToken;
  setConnectionState("saving");
  try {
    const response = await fetch(path, { ...options, method, headers });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : null;
    if (!response.ok) {
      if (response.status === 401 && path !== "/api/login") showLogin();
      throw new Error(payload?.error || `请求失败 (${response.status})`);
    }
    setConnectionState("online");
    return payload;
  } catch (error) {
    setConnectionState("error");
    throw error;
  }
}

function setConnectionState(status) {
  const element = $("#save-state");
  element.classList.toggle("is-error", status === "error");
  element.lastChild.textContent = status === "saving" ? "正在同步…" : status === "error" ? "连接异常" : "服务器已连接";
}

async function loadData({ quiet = false } = {}) {
  try {
    const data = await api("/api/bootstrap");
    state.authenticated = data.authenticated;
    state.csrfToken = data.csrf_token;
    state.settings = data.settings || {};
    state.links = data.links || [];
    state.directoryLinks = data.directory_links || [];
    state.tasks = data.tasks || [];
    state.papers = data.papers || [];
    state.calendarEvents = data.calendar_events || [];
    state.stats = data.stats || {};
    renderAll();
    if (!data.public_read && !data.authenticated) showLogin();
  } catch (error) {
    if (!quiet) toast(error.message, true);
  }
}

function renderAll() {
  document.body.classList.toggle("is-authenticated", state.authenticated);
  const loginButton = $("#login-button");
  loginButton.classList.toggle("is-authenticated", state.authenticated);
  loginButton.innerHTML = state.authenticated
    ? '<i data-lucide="shield-check"></i><span>编辑模式</span>'
    : '<i data-lucide="lock-keyhole"></i><span>进入编辑</span>';

  const settings = state.settings;
  $("#display-name").textContent = settings.display_name || "LYH";
  $("#sidebar-name").textContent = settings.display_name || "LYH";
  $("#sidebar-role").textContent = settings.role || "AI learner";
  $("#profile-link").href = settings.github || "https://github.com/lyh843";
  $("#profile-link img").src = githubAvatar(settings.github);

  $("#open-task-count").textContent = state.stats.open_tasks ?? 0;
  $("#reading-count").textContent = state.stats.reading_papers ?? 0;
  $("#weekly-focus").textContent = state.stats.focus_minutes ?? 0;
  $("#weekly-target").textContent = state.stats.focus_target ?? 600;
  $("#focus-page-minutes").textContent = state.stats.focus_minutes ?? 0;
  $("#task-nav-count").textContent = state.stats.open_tasks ?? 0;
  $("#directory-nav-count").textContent = state.stats.directory_links ?? state.directoryLinks.length;
  $("#directory-count").textContent = state.directoryLinks.length;
  const focusPercent = Math.min(100, ((state.stats.focus_minutes || 0) / (state.stats.focus_target || 600)) * 100);
  $("#pulse-fill").style.width = `${focusPercent}%`;
  $("#focus-page-fill").style.width = `${focusPercent}%`;

  renderOverview();
  renderLinks();
  renderDirectory();
  renderTasks();
  renderPapers();
  renderCalendar();
  refreshIcons();
}

function githubAvatar(url) {
  const match = String(url || "").match(/github\.com\/([^/?#]+)/i);
  return match ? `https://github.com/${encodeURIComponent(match[1])}.png?size=96` : "https://github.com/lyh843.png?size=96";
}

function renderOverview() {
  const activeTasks = state.tasks
    .filter((task) => task.status !== "done")
    .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || compareDates(a.due_date, b.due_date));
  const priority = activeTasks[0];
  $("#today-priority").textContent = priority ? labels.priority[priority.priority] : "—";
  $("#today-priority-label").textContent = priority ? truncate(priority.title, 13) : "尚未安排";

  $("#overview-tasks").innerHTML = activeTasks.length
    ? activeTasks.slice(0, 4).map((task) => `
      <article class="priority-item">
        <span class="priority-dot ${escapeHtml(task.priority)}" aria-hidden="true"></span>
        <div class="priority-copy"><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.course || "未分类")} · ${formatDue(task.due_date)}</span></div>
        <button class="status-button auth-gated" type="button" data-advance-task="${task.id}"><i data-lucide="arrow-right"></i>${labels.taskStatus[task.status]}</button>
      </article>`).join("")
    : emptyState("circle-check-big", "当前没有待办", "可以安排下一项学习任务");

  const reading = state.papers.filter((paper) => paper.status !== "done");
  $("#overview-papers").innerHTML = reading.length
    ? reading.slice(0, 3).map((paper) => `
      <article class="reading-item">
        <div><strong>${escapeHtml(paper.title)}</strong><p>${escapeHtml(paper.authors || "作者待补充")} · ${escapeHtml(paper.venue || "来源待补充")}${paper.year ? ` ${paper.year}` : ""}</p></div>
        <span class="paper-status ${paper.status}">${labels.paperStatus[paper.status]}</span>
      </article>`).join("")
    : emptyState("book-check", "阅读队列已清空", "收录下一篇值得精读的论文");

  renderOverviewCalendar();

  $("#overview-links").innerHTML = state.links.length
    ? state.links.slice(0, 6).map((link) => `
      <a class="quick-link" data-color="${escapeHtml(link.color)}" href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">
        <i data-lucide="${safeIcon(link.icon)}"></i>
        <div><strong>${escapeHtml(link.title)}</strong><span>${escapeHtml(link.category)}</span></div>
      </a>`).join("")
    : emptyState("panels-top-left", "还没有快捷入口", "登录后添加常用工具");
}

function renderOverviewCalendar() {
  const now = new Date();
  const rangeStart = startOfCalendarDay(now);
  const upcoming = calendarOccurrences(rangeStart, addCalendarDays(now, 90))
    .filter((item) => item.end > now)
    .slice(0, 4);
  const container = $("#overview-calendar-list");
  if (!upcoming.length) {
    container.innerHTML = `<div class="overview-calendar-empty"><i data-lucide="calendar-plus"></i><span><strong>近期没有日程</strong><small>添加日程后会在这里提醒你</small></span><button class="text-button auth-gated" type="button" data-action="add" data-kind="calendarEvents">新建日程 <i data-lucide="plus"></i></button></div>`;
    return;
  }
  container.innerHTML = upcoming.map((item) => {
    const ongoing = item.start <= now && item.end > now;
    const dateLabel = overviewCalendarDateLabel(item.start, now);
    const timeLabel = item.event.all_day ? "全天" : `${padNumber(item.start.getHours())}:${padNumber(item.start.getMinutes())}`;
    return `<button class="overview-calendar-item ${ongoing ? "is-ongoing" : ""}" type="button" data-calendar-open-day="${localDateKey(item.start)}" data-color="${escapeHtml(item.event.color)}">
      <span class="overview-calendar-date"><small>${escapeHtml(dateLabel.label)}</small><strong>${padNumber(item.start.getDate())}</strong><em>${escapeHtml(dateLabel.month)}</em></span>
      <span class="overview-calendar-copy"><small>${ongoing ? "进行中" : timeLabel}${item.event.repeat_rule !== "none" ? " · 重复" : ""}</small><strong>${escapeHtml(item.event.title)}</strong><em>${escapeHtml(item.event.location || item.event.calendar_name || "个人日历")}</em></span>
      <i data-lucide="chevron-right"></i>
    </button>`;
  }).join("");
}

function overviewCalendarDateLabel(value, today) {
  if (sameCalendarDay(value, today)) return { label: "今天", month: `${value.getMonth() + 1} 月` };
  if (sameCalendarDay(value, addCalendarDays(today, 1))) return { label: "明天", month: `${value.getMonth() + 1} 月` };
  return { label: `周${calendarWeekdays[(value.getDay() + 6) % 7]}`, month: `${value.getMonth() + 1} 月` };
}

function renderLinks() {
  const categories = ["全部", ...new Set(state.links.map((link) => link.category).filter(Boolean))];
  if (!categories.includes(state.linkFilter)) state.linkFilter = "全部";
  $("#link-filters").innerHTML = categories.map((category) => `
    <button class="${state.linkFilter === category ? "is-active" : ""}" type="button" data-link-filter="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join("");
  const query = $("#link-search").value.trim().toLowerCase();
  const links = state.links.filter((link) => {
    const inCategory = state.linkFilter === "全部" || link.category === state.linkFilter;
    const inSearch = !query || [link.title, link.category, link.note].join(" ").toLowerCase().includes(query);
    return inCategory && inSearch;
  });
  $("#links-grid").innerHTML = links.length
    ? links.map((link) => `
      <article class="link-card" data-color="${escapeHtml(link.color)}">
        <div class="link-card-head">
          <span class="link-icon"><i data-lucide="${safeIcon(link.icon)}"></i></span>
          <button class="icon-button card-menu auth-only" type="button" data-edit="links" data-id="${link.id}" data-tooltip="编辑" aria-label="编辑 ${escapeHtml(link.title)}"><i data-lucide="pencil"></i></button>
        </div>
        <div class="link-copy"><strong>${escapeHtml(link.title)}</strong><p>${escapeHtml(link.note || domainOf(link.url))}</p></div>
        <div class="link-card-foot"><span class="tag">${escapeHtml(link.category)}</span><a class="open-link" href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">打开 <i data-lucide="arrow-up-right"></i></a></div>
      </article>`).join("")
    : emptyState("search-x", "没有匹配的入口", "换一个关键词或分类试试");
  refreshIcons();
}

function renderDirectory() {
  const categories = [...new Set(state.directoryLinks.map((link) => link.category).filter(Boolean))];
  if (state.directoryFilter !== "全部" && !categories.includes(state.directoryFilter)) state.directoryFilter = "全部";
  const counts = Object.fromEntries(categories.map((category) => [category, state.directoryLinks.filter((link) => link.category === category).length]));
  $("#directory-filters").innerHTML = ["全部", ...categories].map((category) => `
    <button class="${state.directoryFilter === category ? "is-active" : ""}" type="button" data-directory-filter="${escapeHtml(category)}"><strong>${escapeHtml(category)}</strong><span>${category === "全部" ? state.directoryLinks.length : counts[category]}</span></button>`).join("");

  const query = $("#directory-search").value.trim().toLowerCase();
  const matching = state.directoryLinks.filter((link) => {
    const inCategory = state.directoryFilter === "全部" || link.category === state.directoryFilter;
    const inSearch = !query || [link.title, link.category, link.note, domainOf(link.url)].join(" ").toLowerCase().includes(query);
    return inCategory && inSearch;
  });
  const visibleCategories = categories.filter((category) => matching.some((link) => link.category === category));
  $("#directory-result-note").textContent = query || state.directoryFilter !== "全部" ? `找到 ${matching.length} 个站点` : "显示全部站点";
  $("#directory-groups").innerHTML = visibleCategories.length ? visibleCategories.map((category) => {
    const links = matching.filter((link) => link.category === category);
    return `<section class="directory-group" id="directory-${slugify(category)}">
      <header class="directory-group-head"><h2>${escapeHtml(category)} <span>${String(links.length).padStart(2, "0")}</span></h2><span>${escapeHtml(categoryLabel(category))}</span></header>
      <div class="directory-site-grid">${links.map((link) => `
        <article class="directory-site" data-color="${escapeHtml(link.color)}">
          <a class="directory-site-link" href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">
            <span class="directory-site-icon"><i data-lucide="${safeIcon(link.icon)}"></i></span>
            <span class="directory-site-copy"><strong>${escapeHtml(link.title)}</strong><small>${escapeHtml(domainOf(link.url))}</small></span>
            <i data-lucide="arrow-up-right"></i>
          </a>
          <button class="directory-edit auth-only" type="button" data-edit="directoryLinks" data-id="${link.id}" aria-label="编辑 ${escapeHtml(link.title)}"><i data-lucide="pencil"></i></button>
        </article>`).join("")}</div>
    </section>`;
  }).join("") : emptyState("search-x", "没有匹配的站点", "换一个关键词或分类试试");
  refreshIcons();
}

function categoryLabel(category) {
  return {
    "个人入口": "PROFILE & LEGACY", "南大常用": "NJU ESSENTIALS", "南大服务": "NJU SERVICES",
    "当前课程": "CURRENT COURSES", "课程基础": "FOUNDATIONS", "课程核心": "CORE COURSES",
    "AI 对话": "AI ASSISTANTS", "AI 科研": "AI RESEARCH", "常用网站": "DAILY WEB", "开发工具": "DEV TOOLKIT",
  }[category] || "LINK COLLECTION";
}

function slugify(value) {
  let hash = 0;
  for (const char of String(value)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

function renderTasks() {
  const statuses = [
    { key: "todo", title: "待处理" },
    { key: "doing", title: "推进中" },
    { key: "done", title: "已完成" },
  ];
  const now = new Date();
  const tasks = state.tasks.filter((task) => {
    if (state.taskFilter === "high") return task.priority === "high" && task.status !== "done";
    if (state.taskFilter === "due") {
      const due = parseDate(task.due_date);
      return task.status !== "done" && due && due.getTime() - now.getTime() < 4 * 86400000;
    }
    return true;
  });
  $("#task-board").innerHTML = statuses.map((column) => {
    const columnTasks = tasks.filter((task) => task.status === column.key);
    return `<section class="kanban-column" aria-labelledby="column-${column.key}">
      <header class="kanban-head"><div><h2 id="column-${column.key}">${column.title}</h2><span>${columnTasks.length}</span></div><button class="auth-only" type="button" data-action="add-task-status" data-status="${column.key}" aria-label="在${column.title}中新增任务"><i data-lucide="plus"></i></button></header>
      <div class="task-list">${columnTasks.length ? columnTasks.map(taskCard).join("") : emptyState("inbox", "这里暂时为空", column.key === "done" ? "完成的任务会出现在这里" : "新增任务来开始推进")}</div>
    </section>`;
  }).join("");
  refreshIcons();
}

function taskCard(task) {
  const dueClass = isOverdue(task) ? "overdue" : "";
  const nextLabel = task.status === "todo" ? "开始" : task.status === "doing" ? "完成" : "已完成";
  return `<article class="task-card">
    <div class="task-card-top"><span class="priority-mark ${escapeHtml(task.priority)}" title="${labels.priority[task.priority]}优先级"></span><button class="task-edit auth-only" type="button" data-edit="tasks" data-id="${task.id}" aria-label="编辑任务"><i data-lucide="more-horizontal"></i></button></div>
    <h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(task.notes || task.course || "暂无备注")}</p>
    <div class="task-card-meta"><span class="due ${dueClass}"><i data-lucide="calendar-days"></i>${formatDue(task.due_date)}</span><button class="advance-button auth-gated" type="button" data-advance-task="${task.id}" ${task.status === "done" ? "disabled" : ""}>${nextLabel}<i data-lucide="chevron-right"></i></button></div>
  </article>`;
}

function renderPapers() {
  const query = $("#paper-search").value.trim().toLowerCase();
  const papers = state.papers.filter((paper) => {
    const inStatus = state.paperFilter === "all" || paper.status === state.paperFilter;
    const inSearch = !query || [paper.title, paper.authors, paper.venue, ...(paper.tags || [])].join(" ").toLowerCase().includes(query);
    return inStatus && inSearch;
  });
  const tableBody = $("#paper-table-body");
  tableBody.innerHTML = papers.length ? papers.map((paper) => `
    <tr>
      <td class="paper-title-cell">${paper.url ? `<a href="${escapeHtml(paper.url)}" target="_blank" rel="noreferrer">${escapeHtml(paper.title)}</a>` : `<strong>${escapeHtml(paper.title)}</strong>`}<span>${escapeHtml(paper.authors || "作者待补充")}</span></td>
      <td class="venue-cell"><strong>${escapeHtml(paper.venue || "—")}</strong><span>${paper.year || "年份待补充"}</span></td>
      <td><div class="tag-list">${(paper.tags || []).slice(0, 3).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("") || '<span class="tag">未分类</span>'}</div></td>
      <td><span class="paper-status ${paper.status}">${labels.paperStatus[paper.status]}</span></td>
      <td><div class="paper-row-actions"><button class="auth-only" type="button" data-edit="papers" data-id="${paper.id}" aria-label="编辑论文"><i data-lucide="pencil"></i></button>${paper.url ? `<a class="icon-button" href="${escapeHtml(paper.url)}" target="_blank" rel="noreferrer" aria-label="打开论文"><i data-lucide="arrow-up-right"></i></a>` : ""}</div></td>
    </tr>`).join("") : `<tr><td colspan="5">${emptyState("search-x", "没有匹配的论文", "调整关键词或阅读状态")}</td></tr>`;

  $("#mobile-paper-list").innerHTML = papers.length ? papers.map((paper) => `
    <article class="mobile-paper">
      <div class="mobile-paper-head"><h3>${escapeHtml(paper.title)}</h3><button class="task-edit auth-only" type="button" data-edit="papers" data-id="${paper.id}" aria-label="编辑论文"><i data-lucide="pencil"></i></button></div>
      <p>${escapeHtml(paper.authors || "作者待补充")} · ${escapeHtml(paper.venue || "来源待补充")} ${paper.year || ""}</p>
      <div class="mobile-paper-foot"><div class="tag-list">${(paper.tags || []).slice(0, 2).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div><span class="paper-status ${paper.status}">${labels.paperStatus[paper.status]}</span></div>
    </article>`).join("") : emptyState("search-x", "没有匹配的论文", "调整关键词或阅读状态");
  refreshIcons();
}

const calendarWeekdays = ["一", "二", "三", "四", "五", "六", "日"];

function padNumber(value) { return String(value).padStart(2, "0"); }
function localDateKey(value) { return `${value.getFullYear()}-${padNumber(value.getMonth() + 1)}-${padNumber(value.getDate())}`; }
function localDateTimeValue(value) { return `${localDateKey(value)}T${padNumber(value.getHours())}:${padNumber(value.getMinutes())}`; }
function parseLocalDateTime(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}
function startOfCalendarDay(value) { const result = new Date(value); result.setHours(0, 0, 0, 0); return result; }
function addCalendarDays(value, amount) { const result = new Date(value); result.setDate(result.getDate() + amount); return result; }
function startOfCalendarWeek(value) {
  const result = startOfCalendarDay(value);
  result.setDate(result.getDate() - ((result.getDay() + 6) % 7));
  return result;
}
function sameCalendarDay(a, b) { return localDateKey(a) === localDateKey(b); }
function daysInCalendarMonth(year, month) { return new Date(year, month + 1, 0).getDate(); }

function defaultCalendarStart() {
  const value = new Date();
  value.setSeconds(0, 0);
  value.setMinutes(Math.ceil(value.getMinutes() / 30) * 30);
  if (value.getTime() < Date.now()) value.setMinutes(value.getMinutes() + 30);
  return value;
}

function eventEditorParts(value) {
  const parsed = parseLocalDateTime(value) || defaultCalendarStart();
  return { date: localDateKey(parsed), time: `${padNumber(parsed.getHours())}:${padNumber(parsed.getMinutes())}` };
}

function endpointForKind(kind) {
  return { directoryLinks: "directory-links", calendarEvents: "calendar-events" }[kind] || kind;
}

function syncEventAllDayFields() {
  const checkbox = $('#editor-fields input[name="all_day"]');
  if (!checkbox) return;
  $$(".event-time-field", $("#editor-fields")).forEach((field) => {
    field.hidden = checkbox.checked;
    const input = $("input", field);
    if (input) input.required = !checkbox.checked;
  });
  $("#editor-fields .event-date-grid")?.classList.toggle("is-all-day", checkbox.checked);
}

function calendarVisibleRange() {
  const cursor = startOfCalendarDay(state.calendar.cursor);
  if (state.calendar.view === "day") return { start: cursor, end: addCalendarDays(cursor, 1), days: [cursor] };
  if (state.calendar.view === "week") {
    const start = startOfCalendarWeek(cursor);
    return { start, end: addCalendarDays(start, 7), days: Array.from({ length: 7 }, (_, index) => addCalendarDays(start, index)) };
  }
  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = startOfCalendarWeek(monthStart);
  return { start, end: addCalendarDays(start, 42), days: Array.from({ length: 42 }, (_, index) => addCalendarDays(start, index)) };
}

function recurrenceStart(base, rule, index) {
  if (index === 0 || rule === "none") return new Date(base);
  const result = new Date(base);
  if (rule === "daily") result.setDate(result.getDate() + index);
  if (rule === "weekly") result.setDate(result.getDate() + index * 7);
  if (rule === "monthly") {
    const day = base.getDate();
    result.setDate(1);
    result.setMonth(base.getMonth() + index);
    result.setDate(Math.min(day, daysInCalendarMonth(result.getFullYear(), result.getMonth())));
  }
  if (rule === "yearly") {
    const month = base.getMonth();
    const day = base.getDate();
    result.setDate(1);
    result.setFullYear(base.getFullYear() + index);
    result.setMonth(month);
    result.setDate(Math.min(day, daysInCalendarMonth(result.getFullYear(), month)));
  }
  return result;
}

function recurrenceIndexNear(base, rule, target) {
  if (target <= base || rule === "none") return 0;
  const dayDistance = Math.floor((target - base) / 86400000);
  if (rule === "daily") return Math.max(0, dayDistance - 2);
  if (rule === "weekly") return Math.max(0, Math.floor(dayDistance / 7) - 2);
  if (rule === "monthly") return Math.max(0, (target.getFullYear() - base.getFullYear()) * 12 + target.getMonth() - base.getMonth() - 2);
  if (rule === "yearly") return Math.max(0, target.getFullYear() - base.getFullYear() - 2);
  return 0;
}

function calendarOccurrences(rangeStart, rangeEnd) {
  const occurrences = [];
  state.calendarEvents.forEach((event) => {
    const baseStart = parseLocalDateTime(event.start_at);
    const baseEnd = parseLocalDateTime(event.end_at);
    if (!baseStart || !baseEnd || baseEnd <= baseStart) return;
    const duration = baseEnd.getTime() - baseStart.getTime();
    const rule = event.repeat_rule || "none";
    const until = event.repeat_until ? new Date(`${event.repeat_until}T23:59:59`) : null;
    const firstIndex = recurrenceIndexNear(baseStart, rule, new Date(rangeStart.getTime() - duration));
    for (let index = firstIndex; index < firstIndex + 5000; index += 1) {
      const start = recurrenceStart(baseStart, rule, index);
      if (until && start > until) break;
      if (start >= rangeEnd) break;
      const end = new Date(start.getTime() + duration);
      if (end > rangeStart && start < rangeEnd) occurrences.push({ event, start, end, key: `${event.id}-${start.getTime()}` });
      if (rule === "none") break;
    }
  });
  return occurrences.sort((a, b) => a.start - b.start || a.end - b.end);
}

function calendarRangeTitle(range) {
  const cursor = state.calendar.cursor;
  if (state.calendar.view === "month") return `${cursor.getFullYear()} 年 ${cursor.getMonth() + 1} 月`;
  if (state.calendar.view === "day") return `${cursor.getFullYear()} 年 ${cursor.getMonth() + 1} 月 ${cursor.getDate()} 日`;
  const last = addCalendarDays(range.end, -1);
  if (range.start.getFullYear() !== last.getFullYear()) return `${range.start.getFullYear()} 年 ${range.start.getMonth() + 1} 月 - ${last.getFullYear()} 年 ${last.getMonth() + 1} 月`;
  if (range.start.getMonth() !== last.getMonth()) return `${range.start.getFullYear()} 年 ${range.start.getMonth() + 1} 月 - ${last.getMonth() + 1} 月`;
  return `${range.start.getFullYear()} 年 ${range.start.getMonth() + 1} 月`;
}

function renderCalendar() {
  if (!$("#calendar-canvas")) return;
  if (!["month", "week", "day"].includes(state.calendar.view)) state.calendar.view = "week";
  const range = calendarVisibleRange();
  $("#calendar-range-title").textContent = calendarRangeTitle(range);
  $$('[data-calendar-view]', $("#calendar-view-switch")).forEach((button) => button.classList.toggle("is-active", button.dataset.calendarView === state.calendar.view));
  renderMiniCalendar(range);
  renderCalendarUpcoming();
  if (state.calendar.view === "month") renderMonthCalendar(range);
  else renderTimeCalendar(range);
  refreshIcons();
}

function renderMiniCalendar(range) {
  const cursor = state.calendar.cursor;
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const gridStart = startOfCalendarWeek(first);
  $("#mini-calendar-title").textContent = `${cursor.getFullYear()} 年 ${cursor.getMonth() + 1} 月`;
  const days = Array.from({ length: 42 }, (_, index) => addCalendarDays(gridStart, index));
  $("#mini-calendar").innerHTML = `
    <div class="mini-weekdays">${calendarWeekdays.map((day) => `<span>${day}</span>`).join("")}</div>
    <div class="mini-days">${days.map((day) => {
      const outside = day.getMonth() !== cursor.getMonth();
      const selected = day >= range.start && day < range.end;
      return `<button class="${outside ? "is-outside" : ""} ${selected ? "is-selected" : ""} ${sameCalendarDay(day, new Date()) ? "is-today" : ""}" type="button" data-calendar-date="${localDateKey(day)}" aria-label="${day.getMonth() + 1}月${day.getDate()}日">${day.getDate()}</button>`;
    }).join("")}</div>`;
}

function renderCalendarUpcoming() {
  const now = new Date();
  const upcoming = calendarOccurrences(now, addCalendarDays(now, 90)).filter((item) => item.end > now).slice(0, 6);
  $("#calendar-upcoming").innerHTML = upcoming.length ? upcoming.map((item) => `
    <button class="upcoming-event" type="button" data-edit="calendarEvents" data-id="${item.event.id}" data-color="${escapeHtml(item.event.color)}">
      <span class="upcoming-date"><strong>${padNumber(item.start.getDate())}</strong><small>${item.start.getMonth() + 1} 月</small></span>
      <span><strong>${escapeHtml(item.event.title)}</strong><small>${item.event.all_day ? "全天" : `${padNumber(item.start.getHours())}:${padNumber(item.start.getMinutes())}`} ${item.event.location ? `· ${escapeHtml(item.event.location)}` : ""}</small></span>
    </button>`).join("") : `<div class="calendar-empty"><i data-lucide="calendar-check-2"></i><span>近期没有日程</span></div>`;
}

function renderMonthCalendar(range) {
  const occurrences = calendarOccurrences(range.start, range.end);
  $("#calendar-canvas").innerHTML = `
    <div class="calendar-month-view">
      <div class="month-weekdays">${calendarWeekdays.map((day, index) => `<span class="${index > 4 ? "is-weekend" : ""}">周${day}</span>`).join("")}</div>
      <div class="month-grid">${range.days.map((day) => {
        const dayStart = startOfCalendarDay(day);
        const dayEnd = addCalendarDays(dayStart, 1);
        const dayEvents = occurrences.filter((item) => item.end > dayStart && item.start < dayEnd);
        const outside = day.getMonth() !== state.calendar.cursor.getMonth();
        return `<div class="month-cell ${outside ? "is-outside" : ""} ${sameCalendarDay(day, new Date()) ? "is-today" : ""}" data-calendar-create="${localDateKey(day)}T09:00">
          <button class="month-date" type="button" data-calendar-open-day="${localDateKey(day)}">${day.getDate()}</button>
          <div class="month-events">${dayEvents.slice(0, 3).map((item) => monthEventChip(item, day)).join("")}${dayEvents.length > 3 ? `<button class="month-more" type="button" data-calendar-open-day="${localDateKey(day)}">还有 ${dayEvents.length - 3} 项</button>` : ""}</div>
        </div>`;
      }).join("")}</div>
    </div>`;
}

function monthEventChip(occurrence, day) {
  const startsToday = sameCalendarDay(occurrence.start, day);
  const time = occurrence.event.all_day ? "" : startsToday ? `${padNumber(occurrence.start.getHours())}:${padNumber(occurrence.start.getMinutes())}` : "←";
  return `<button class="month-event" type="button" data-edit="calendarEvents" data-id="${occurrence.event.id}" data-color="${escapeHtml(occurrence.event.color)}" title="${escapeHtml(occurrence.event.title)}"><span>${time}</span><strong>${escapeHtml(occurrence.event.title)}</strong>${occurrence.event.repeat_rule !== "none" ? '<i data-lucide="repeat-2"></i>' : ""}</button>`;
}

function renderTimeCalendar(range) {
  const occurrences = calendarOccurrences(range.start, range.end);
  const days = range.days;
  const allDay = occurrences.filter((item) => item.event.all_day);
  const timed = occurrences.filter((item) => !item.event.all_day);
  const dayHeaders = days.map((day) => `<button class="calendar-day-head ${sameCalendarDay(day, new Date()) ? "is-today" : ""}" type="button" data-calendar-open-day="${localDateKey(day)}"><span>周${calendarWeekdays[(day.getDay() + 6) % 7]}</span><strong>${day.getDate()}</strong></button>`).join("");
  const allDayColumns = days.map((day) => {
    const start = startOfCalendarDay(day);
    const end = addCalendarDays(start, 1);
    return `<div class="all-day-column">${allDay.filter((item) => item.end > start && item.start < end).map((item) => `<button type="button" data-edit="calendarEvents" data-id="${item.event.id}" data-color="${escapeHtml(item.event.color)}"><strong>${escapeHtml(item.event.title)}</strong>${item.event.repeat_rule !== "none" ? '<i data-lucide="repeat-2"></i>' : ""}</button>`).join("")}</div>`;
  }).join("");
  const timeLabels = Array.from({ length: 24 }, (_, hour) => `<span>${padNumber(hour)}:00</span>`).join("");
  const columns = days.map((day) => renderTimeDayColumn(day, timed)).join("");
  $("#calendar-canvas").innerHTML = `
    <div class="calendar-time-view is-${state.calendar.view}" style="--calendar-days:${days.length}">
      <div class="calendar-time-head"><span class="timezone-label">GMT+8</span>${dayHeaders}</div>
      <div class="calendar-all-day"><span>全天</span>${allDayColumns}</div>
      <div class="calendar-time-scroll">
        <div class="calendar-time-grid"><div class="time-labels">${timeLabels}</div>${columns}</div>
      </div>
    </div>`;

  const scrollKey = `${state.calendar.view}-${localDateKey(range.start)}`;
  if (state.calendar.scrollKey !== scrollKey) {
    state.calendar.scrollKey = scrollKey;
    requestAnimationFrame(() => {
      const scroller = $(".calendar-time-scroll", $("#calendar-canvas"));
      if (scroller) scroller.scrollTop = Math.max(0, new Date().getHours() * 60 - 120);
    });
  }
}

function renderTimeDayColumn(day, occurrences) {
  const dayStart = startOfCalendarDay(day);
  const dayEnd = addCalendarDays(dayStart, 1);
  const events = occurrences.filter((item) => item.end > dayStart && item.start < dayEnd);
  const slots = Array.from({ length: 24 }, (_, hour) => `<button class="calendar-hour-slot" type="button" data-calendar-create="${localDateKey(day)}T${padNumber(hour)}:00" aria-label="${day.getMonth() + 1}月${day.getDate()}日 ${hour}点新建日程"></button>`).join("");
  const eventButtons = events.map((item) => {
    const clippedStart = item.start < dayStart ? dayStart : item.start;
    const clippedEnd = item.end > dayEnd ? dayEnd : item.end;
    const top = Math.max(0, (clippedStart - dayStart) / 60000);
    const height = Math.max(24, (clippedEnd - clippedStart) / 60000);
    return `<button class="time-event" type="button" style="--event-top:${top}px;--event-height:${height}px" data-edit="calendarEvents" data-id="${item.event.id}" data-color="${escapeHtml(item.event.color)}" title="${escapeHtml(item.event.title)}"><strong>${escapeHtml(item.event.title)}</strong><span>${padNumber(item.start.getHours())}:${padNumber(item.start.getMinutes())}${item.event.location ? ` · ${escapeHtml(item.event.location)}` : ""}</span></button>`;
  }).join("");
  const now = new Date();
  const nowLine = sameCalendarDay(day, now) ? `<span class="current-time-line" style="--now-top:${now.getHours() * 60 + now.getMinutes()}px"><i></i></span>` : "";
  return `<div class="calendar-day-column ${sameCalendarDay(day, now) ? "is-today" : ""}">${slots}${eventButtons}${nowLine}</div>`;
}

function setCalendarView(view) {
  if (!["month", "week", "day"].includes(view)) return;
  state.calendar.view = view;
  state.calendar.scrollKey = "";
  localStorage.setItem("research-calendar-view", view);
  renderCalendar();
}

function moveCalendar(direction) {
  const cursor = new Date(state.calendar.cursor);
  if (state.calendar.view === "month") cursor.setMonth(cursor.getMonth() + direction);
  else cursor.setDate(cursor.getDate() + direction * (state.calendar.view === "week" ? 7 : 1));
  state.calendar.cursor = cursor;
  state.calendar.scrollKey = "";
  renderCalendar();
}

function openCalendarDay(value) {
  const dateValue = new Date(`${value}T12:00`);
  if (Number.isNaN(dateValue.getTime())) return;
  state.calendar.cursor = dateValue;
  state.calendar.view = "day";
  state.calendar.scrollKey = "";
  localStorage.setItem("research-calendar-view", "day");
  navigate("calendar");
}

function createCalendarEventAt(value) {
  const start = parseLocalDateTime(value);
  if (!start) return;
  const end = new Date(start.getTime() + 60 * 60000);
  openEditor("calendarEvents", null, { start_at: localDateTimeValue(start), end_at: localDateTimeValue(end), color: "blue", calendar_name: "个人日历" });
}

function emptyState(icon, title, description) {
  return `<div class="empty-state"><i data-lucide="${icon}"></i><strong>${title}</strong><p>${description}</p></div>`;
}

function priorityRank(value) { return { low: 1, medium: 2, high: 3 }[value] || 0; }
function compareDates(a, b) { return (a || "9999").localeCompare(b || "9999"); }
function parseDate(value) { return value ? new Date(`${value}T23:59:59`) : null; }
function isOverdue(task) { const due = parseDate(task.due_date); return task.status !== "done" && due && due < new Date(); }
function truncate(value, size) { const text = String(value || ""); return text.length > size ? `${text.slice(0, size)}…` : text; }
function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "打开链接"; } }

function formatDue(value) {
  if (!value) return "未设截止";
  const due = parseDate(value);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = Math.round((due.setHours(0, 0, 0, 0) - today.getTime()) / 86400000);
  if (day === 0) return "今天截止";
  if (day === 1) return "明天截止";
  if (day === -1) return "昨天截止";
  if (day < 0) return `逾期 ${Math.abs(day)} 天`;
  if (day <= 7) return `${day} 天后`;
  return value.slice(5).replace("-", "/");
}

function navigate(route) {
  const target = $(`[data-view="${route}"]`) ? route : "overview";
  const routeLabels = { overview: "概览", directory: "网址导航", links: "快捷入口", tasks: "任务推进", calendar: "日历", papers: "论文队列", focus: "专注计时" };
  $$("[data-view]").forEach((view) => view.classList.toggle("is-active", view.dataset.view === target));
  $$("[data-route]").forEach((item) => {
    const isCurrent = item.dataset.route === target;
    item.classList.toggle("is-active", isCurrent);
    if (isCurrent) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  $("#mobile-route-title").textContent = routeLabels[target];
  history.replaceState(null, "", `#${target}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (target === "focus") $("#focus-label").focus({ preventScroll: true });
  if (target === "calendar") renderCalendar();
}

function requireAuth(callback) {
  if (state.authenticated) callback();
  else showLogin();
}

function showLogin() {
  $("#login-error").textContent = "";
  $("#login-password").value = "";
  $("#login-modal").showModal();
  setTimeout(() => $("#login-password").focus(), 50);
}

function editorFields(kind, record = {}) {
  if (kind === "links" || kind === "directoryLinks") return `
    <label class="field"><span>名称 *</span><input name="title" maxlength="80" required value="${escapeHtml(record.title)}" placeholder="例如：Semantic Scholar"></label>
    <label class="field"><span>网址 *</span><input name="url" type="url" maxlength="1200" required value="${escapeHtml(record.url)}" placeholder="https://"></label>
    <div class="field-row"><label class="field"><span>分类</span><input name="category" maxlength="30" value="${escapeHtml(record.category || "工具")}" placeholder="论文 / 工具 / 课程"></label><label class="field"><span>图标</span><select name="icon">${iconOptions(record.icon)}</select></label></div>
    <label class="field"><span>一句备注</span><input name="note" maxlength="160" value="${escapeHtml(record.note)}" placeholder="这个入口用于什么"></label>
    <div class="field"><span>标识色</span><div class="color-options">${["blue", "red", "yellow", "green", "dark"].map((color) => `<label title="${color}"><input type="radio" name="color" value="${color}" ${(record.color || "blue") === color ? "checked" : ""}><span style="--swatch:var(--${color === "dark" ? "ink" : color})"></span></label>`).join("")}</div></div>`;
  if (kind === "tasks") return `
    <label class="field"><span>任务名称 *</span><input name="title" maxlength="160" required value="${escapeHtml(record.title)}" placeholder="写成一个明确的行动"></label>
    <div class="field-row"><label class="field"><span>领域 / 课程</span><input name="course" maxlength="50" value="${escapeHtml(record.course)}" placeholder="科研、深度学习…"></label><label class="field"><span>截止日期</span><input name="due_date" type="date" value="${escapeHtml(record.due_date)}"></label></div>
    <div class="field-row"><label class="field"><span>优先级</span><select name="priority"><option value="low" ${record.priority === "low" ? "selected" : ""}>低</option><option value="medium" ${!record.priority || record.priority === "medium" ? "selected" : ""}>中</option><option value="high" ${record.priority === "high" ? "selected" : ""}>高</option></select></label><label class="field"><span>状态</span><select name="status"><option value="todo" ${!record.status || record.status === "todo" ? "selected" : ""}>待处理</option><option value="doing" ${record.status === "doing" ? "selected" : ""}>推进中</option><option value="done" ${record.status === "done" ? "selected" : ""}>已完成</option></select></label></div>
    <label class="field"><span>备注</span><textarea name="notes" maxlength="1200" placeholder="记录交付标准或下一步">${escapeHtml(record.notes)}</textarea></label>`;
  if (kind === "papers") return `
    <label class="field"><span>论文标题 *</span><input name="title" maxlength="300" required value="${escapeHtml(record.title)}" placeholder="Paper title"></label>
    <label class="field"><span>作者</span><input name="authors" maxlength="220" value="${escapeHtml(record.authors)}" placeholder="Author et al."></label>
    <div class="field-row"><label class="field"><span>会议 / 期刊</span><input name="venue" maxlength="80" value="${escapeHtml(record.venue)}" placeholder="NeurIPS"></label><label class="field"><span>年份</span><input name="year" type="number" min="1900" max="${new Date().getFullYear() + 2}" value="${escapeHtml(record.year)}"></label></div>
    <label class="field"><span>论文链接</span><input name="url" type="url" maxlength="1200" value="${escapeHtml(record.url)}" placeholder="https://arxiv.org/abs/..."></label>
    <div class="field-row"><label class="field"><span>阅读状态</span><select name="status"><option value="queue" ${!record.status || record.status === "queue" ? "selected" : ""}>待读</option><option value="reading" ${record.status === "reading" ? "selected" : ""}>精读中</option><option value="done" ${record.status === "done" ? "selected" : ""}>已完成</option></select></label><label class="field"><span>标签（逗号分隔）</span><input name="tags" value="${escapeHtml((record.tags || []).join(", "))}" placeholder="LLM, Agent"></label></div>
    <label class="field"><span>阅读笔记</span><textarea name="notes" maxlength="4000" placeholder="核心问题、方法与待验证想法">${escapeHtml(record.notes)}</textarea></label>`;
  if (kind === "calendarEvents") {
    const defaultStart = parseLocalDateTime(record.start_at) || defaultCalendarStart();
    const defaultEnd = parseLocalDateTime(record.end_at) || new Date(defaultStart.getTime() + 60 * 60000);
    const start = eventEditorParts(localDateTimeValue(defaultStart));
    const end = eventEditorParts(localDateTimeValue(defaultEnd));
    return `
      <label class="field"><span>日程标题 *</span><input name="title" maxlength="160" required value="${escapeHtml(record.title)}" placeholder="例如：组会或论文精读"></label>
      <label class="check-field"><input name="all_day" type="checkbox" value="true" ${record.all_day ? "checked" : ""}><span><i data-lucide="sun"></i>全天日程</span></label>
      <div class="event-date-grid">
        <label class="field"><span>开始日期 *</span><input name="start_date" type="date" required value="${start.date}"></label>
        <label class="field event-time-field"><span>开始时间 *</span><input name="start_time" type="time" required value="${start.time}"></label>
        <label class="field"><span>结束日期 *</span><input name="end_date" type="date" required value="${end.date}"></label>
        <label class="field event-time-field"><span>结束时间 *</span><input name="end_time" type="time" required value="${end.time}"></label>
      </div>
      <div class="field-row"><label class="field"><span>重复</span><select name="repeat_rule"><option value="none" ${!record.repeat_rule || record.repeat_rule === "none" ? "selected" : ""}>不重复</option><option value="daily" ${record.repeat_rule === "daily" ? "selected" : ""}>每天</option><option value="weekly" ${record.repeat_rule === "weekly" ? "selected" : ""}>每周</option><option value="monthly" ${record.repeat_rule === "monthly" ? "selected" : ""}>每月</option><option value="yearly" ${record.repeat_rule === "yearly" ? "selected" : ""}>每年</option></select></label><label class="field"><span>重复截止日期</span><input name="repeat_until" type="date" value="${escapeHtml(record.repeat_until)}"></label></div>
      <div class="field-row"><label class="field"><span>所属日历</span><input name="calendar_name" maxlength="40" value="${escapeHtml(record.calendar_name || "个人日历")}" placeholder="个人日历"></label><label class="field"><span>地点</span><input name="location" maxlength="200" value="${escapeHtml(record.location)}" placeholder="教室、会议室或线上链接"></label></div>
      <label class="field"><span>说明</span><textarea name="description" maxlength="2000" placeholder="记录议程、材料或准备事项">${escapeHtml(record.description)}</textarea></label>
      <input name="timezone" type="hidden" value="${escapeHtml(record.timezone || "Asia/Shanghai")}">
      <div class="field"><span>日程颜色</span><div class="color-options">${["blue", "red", "yellow", "green", "dark"].map((color) => `<label title="${color}"><input type="radio" name="color" value="${color}" ${(record.color || "blue") === color ? "checked" : ""}><span style="--swatch:var(--${color === "dark" ? "ink" : color})"></span></label>`).join("")}</div></div>`;
  }
  if (kind === "settings") return `
    <div class="field-row"><label class="field"><span>页面称呼 *</span><input name="display_name" maxlength="40" required value="${escapeHtml(record.display_name)}"></label><label class="field"><span>本周专注目标（分钟）</span><input name="focus_target" type="number" min="30" max="5000" value="${escapeHtml(record.focus_target || 600)}"></label></div>
    <label class="field"><span>身份描述</span><input name="role" maxlength="80" value="${escapeHtml(record.role)}" placeholder="AI learner · Undergraduate"></label>
    <label class="field"><span>工作台简介</span><textarea name="bio" maxlength="180">${escapeHtml(record.bio)}</textarea></label>
    <label class="field"><span>GitHub 主页</span><input name="github" type="url" value="${escapeHtml(record.github)}" placeholder="https://github.com/username"></label>`;
  return "";
}

function iconOptions(selected) {
  const options = [
    ["link", "链接"], ["graduation-cap", "学术"], ["file-text", "文档"], ["code-2", "代码"],
    ["boxes", "模型"], ["github", "GitHub"], ["sigma", "数学"], ["book-open", "阅读"],
    ["brain-circuit", "AI"], ["database", "数据"], ["terminal", "终端"], ["globe-2", "网站"],
    ["notebook-pen", "笔记"], ["chart-no-axes-combined", "图表"], ["bot", "Agent"], ["folder-code", "项目"],
    ["user-round", "个人"], ["landmark", "学校"], ["building-2", "服务"], ["notebook-tabs", "课程"],
    ["school", "教学"], ["binary", "基础"], ["messages-square", "对话"], ["microscope", "科研"], ["wrench", "工具"],
  ];
  return options.map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`).join("");
}

function openEditor(kind, id = null, defaults = {}) {
  requireAuth(() => {
    const record = id === null ? defaults : state[kind].find((item) => item.id === Number(id)) || {};
    state.editor = { kind, id: id === null ? null : Number(id) };
    const nouns = { links: "快捷入口", directoryLinks: "导航站点", tasks: "任务", calendarEvents: "日程", papers: "论文", settings: "工作台设置" };
    $("#editor-code").textContent = kind === "settings" ? "WORKSPACE PROFILE" : id === null ? "NEW ITEM" : "EDIT ITEM";
    $("#editor-title").textContent = kind === "settings" ? nouns[kind] : `${id === null ? "新增" : "编辑"}${nouns[kind]}`;
    $("#editor-fields").innerHTML = editorFields(kind, record);
    $("#delete-button").style.visibility = id === null || kind === "settings" ? "hidden" : "visible";
    $("#save-button").textContent = id === null && kind !== "settings" ? "添加" : "保存更改";
    $("#editor-modal").showModal();
    refreshIcons();
    if (kind === "calendarEvents") syncEventAllDayFields();
    setTimeout(() => $("#editor-fields input")?.focus(), 30);
  });
}

async function saveEditor(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  const { kind, id } = state.editor;
  if (kind === "papers") data.tags = data.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
  if (kind === "calendarEvents") {
    data.all_day = data.all_day === "true";
    data.start_at = `${data.start_date}T${data.all_day ? "00:00" : data.start_time}`;
    data.end_at = `${data.end_date}T${data.all_day ? "23:59" : data.end_time}`;
    delete data.start_date;
    delete data.start_time;
    delete data.end_date;
    delete data.end_time;
  }
  const endpoint = endpointForKind(kind);
  const path = kind === "settings" ? "/api/settings" : `/api/${endpoint}${id === null ? "" : `/${id}`}`;
  const method = kind === "settings" ? "POST" : id === null ? "POST" : "PUT";
  const button = $("#save-button");
  button.disabled = true;
  button.textContent = "正在保存…";
  try {
    await api(path, { method, body: JSON.stringify(data) });
    $("#editor-modal").close();
    await loadData({ quiet: true });
    toast(kind === "settings" ? "工作台设置已更新" : id === null ? "已添加" : "更改已保存");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "保存更改";
  }
}

async function deleteEditor() {
  const { kind, id } = state.editor;
  if (!id || !confirm("确定删除这条记录吗？此操作无法撤销。")) return;
  try {
    const endpoint = endpointForKind(kind);
    await api(`/api/${endpoint}/${id}`, { method: "DELETE" });
    $("#editor-modal").close();
    await loadData({ quiet: true });
    toast("已删除");
  } catch (error) { toast(error.message, true); }
}

async function advanceTask(id) {
  requireAuth(async () => {
    const task = state.tasks.find((item) => item.id === Number(id));
    if (!task || task.status === "done") return;
    const updated = { ...task, status: task.status === "todo" ? "doing" : "done" };
    try {
      await api(`/api/tasks/${task.id}`, { method: "PUT", body: JSON.stringify(updated) });
      await loadData({ quiet: true });
      toast(updated.status === "done" ? "任务已完成" : "任务已进入推进中");
    } catch (error) { toast(error.message, true); }
  });
}

async function login(event) {
  event.preventDefault();
  const password = $("#login-password").value;
  const submit = $("#login-form button[type=submit]");
  submit.disabled = true;
  $("#login-error").textContent = "";
  try {
    const data = await api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
    state.csrfToken = data.csrf_token;
    $("#login-modal").close();
    await loadData({ quiet: true });
    toast("已进入编辑模式");
  } catch (error) {
    $("#login-error").textContent = error.message;
    $("#login-password").select();
  } finally { submit.disabled = false; }
}

async function logout() {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
    state.authenticated = false;
    state.csrfToken = "";
    await loadData({ quiet: true });
    toast("已退出编辑模式");
  } catch (error) { toast(error.message, true); }
}

async function exportData() {
  try {
    const response = await fetch("/api/export");
    if (!response.ok) throw new Error("导出失败，请重新登录");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `research-desk-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast("数据已导出");
  } catch (error) { toast(error.message, true); }
}

function updateClock() {
  const now = new Date();
  const hour = now.getHours();
  $("#greeting").textContent = hour < 6 ? "夜深了" : hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
  $("#clock").textContent = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const weekday = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][now.getDay()];
  const month = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][now.getMonth()];
  $("#today-label").textContent = `${weekday} · ${month} ${String(now.getDate()).padStart(2, "0")}`;
  const workday = Math.min(5, Math.max(1, now.getDay() || 5));
  $$(".pulse-node").forEach((node, index) => {
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;
    node.classList.toggle("is-done", index + 1 < workday || isWeekend);
    node.classList.toggle("is-current", index + 1 === workday && !isWeekend);
  });
}

function setTimerMinutes(minutes, isBreak = false) {
  const parsed = Math.max(1, Math.min(240, Math.round(Number(minutes))));
  if (!Number.isFinite(parsed)) return false;
  stopTimer();
  state.timer.total = parsed * 60;
  state.timer.remaining = state.timer.total;
  state.timer.isBreak = isBreak;
  $$('[data-minutes]', $("#timer-modes")).forEach((button) => button.classList.toggle("is-active", Number(button.dataset.minutes) === parsed && Boolean(button.dataset.break) === isBreak));
  if (!isBreak) $("#custom-focus-minutes").value = parsed;
  renderTimer();
  return true;
}

function renderTimer() {
  const minutes = Math.floor(state.timer.remaining / 60);
  const seconds = state.timer.remaining % 60;
  const value = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  $("#timer-display").textContent = value;
  $("#overview-focus-duration").textContent = `${padNumber(Math.round(state.timer.total / 60))}:00`;
  document.title = state.timer.running ? `${value} · Research Desk` : "Research Desk · AI 学习工作台";
  $("#timer-toggle").innerHTML = state.timer.running ? '<i data-lucide="pause"></i><span>暂停</span>' : '<i data-lucide="play"></i><span>开始专注</span>';
  refreshIcons();
}

function toggleTimer() {
  if (state.timer.running) { stopTimer(); renderTimer(); return; }
  state.timer.running = true;
  state.timer.interval = setInterval(() => {
    state.timer.remaining -= 1;
    if (state.timer.remaining <= 0) completeTimer(false);
    else renderTimer();
  }, 1000);
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  renderTimer();
}

function stopTimer() {
  clearInterval(state.timer.interval);
  state.timer.interval = null;
  state.timer.running = false;
}

async function completeTimer(manual = false) {
  const elapsedMinutes = Math.ceil((state.timer.total - state.timer.remaining) / 60);
  const completedMinutes = manual ? elapsedMinutes : Math.round(state.timer.total / 60);
  stopTimer();
  state.timer.remaining = state.timer.total;
  renderTimer();
  if (manual && completedMinutes < 1) {
    toast("尚未形成有效专注记录");
    return;
  }
  if ("Notification" in window && Notification.permission === "granted") new Notification("本轮专注完成", { body: "记录进度，休息一下再继续。" });
  if (state.timer.isBreak) {
    toast("休息结束，可以开始下一轮了");
    return;
  }
  if (state.authenticated) {
    try {
      await api("/api/focus-sessions", { method: "POST", body: JSON.stringify({ duration: completedMinutes, label: $("#focus-label").value }) });
      await loadData({ quiet: true });
      toast(`已记录 ${completedMinutes} 分钟专注`);
    } catch (error) { toast(error.message, true); }
  } else {
    toast("本轮专注完成；登录后可累计到周目标");
  }
}

function resetTimer() {
  stopTimer();
  state.timer.remaining = state.timer.total;
  renderTimer();
}

function applyCustomFocus() {
  const input = $("#custom-focus-minutes");
  const minutes = Number(input.value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) {
    input.focus();
    toast("专注时长需要设为 1 到 240 分钟", true);
    return;
  }
  setTimerMinutes(minutes, false);
  localStorage.setItem("research-focus-minutes", String(minutes));
  toast(`本轮专注已设为 ${minutes} 分钟`);
}

function commandItems(query = "") {
  const normalized = query.trim().toLowerCase();
  const pages = [
    { icon: "layout-dashboard", title: "概览", meta: "页面", route: "overview" },
    { icon: "panels-top-left", title: "快捷入口", meta: "页面", route: "links" },
    { icon: "compass", title: "网址导航", meta: "页面", route: "directory" },
    { icon: "list-checks", title: "任务推进", meta: "页面", route: "tasks" },
    { icon: "calendar-days", title: "日历", meta: "页面", route: "calendar" },
    { icon: "library", title: "论文队列", meta: "页面", route: "papers" },
    { icon: "timer-reset", title: "专注计时", meta: "页面", route: "focus" },
  ];
  const links = state.links.map((item) => ({ icon: safeIcon(item.icon), title: item.title, meta: `快捷入口 · ${item.category}`, url: item.url }));
  const directoryLinks = state.directoryLinks.map((item) => ({ icon: safeIcon(item.icon), title: item.title, meta: `网址导航 · ${item.category}`, url: item.url }));
  const tasks = state.tasks.map((item) => ({ icon: "circle-check", title: item.title, meta: `任务 · ${labels.taskStatus[item.status]}`, route: "tasks" }));
  const calendarEvents = state.calendarEvents.map((item) => ({ icon: "calendar-clock", title: item.title, meta: `日程 · ${item.start_at.replace("T", " ")}`, route: "calendar" }));
  const papers = state.papers.map((item) => ({ icon: "file-text", title: item.title, meta: `论文 · ${labels.paperStatus[item.status]}`, url: item.url, route: "papers" }));
  return [...pages, ...links, ...directoryLinks, ...tasks, ...calendarEvents, ...papers].filter((item) => !normalized || `${item.title} ${item.meta}`.toLowerCase().includes(normalized)).slice(0, 12);
}

function openCommand() {
  $("#command-modal").showModal();
  $("#command-input").value = "";
  state.commandIndex = 0;
  renderCommands();
  setTimeout(() => $("#command-input").focus(), 30);
}

function renderCommands() {
  state.commandItems = commandItems($("#command-input").value);
  if (state.commandIndex >= state.commandItems.length) state.commandIndex = 0;
  $("#command-results").innerHTML = state.commandItems.length ? state.commandItems.map((item, index) => `
    <button class="command-result ${index === state.commandIndex ? "is-selected" : ""}" type="button" data-command-index="${index}">
      <i><i data-lucide="${item.icon}"></i></i><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.meta)}</small></span><span>${item.url ? "打开" : "跳转"}</span>
    </button>`).join("") : emptyState("search-x", "没有搜索结果", "试试更短的关键词");
  refreshIcons();
}

function runCommand(index = state.commandIndex) {
  const item = state.commandItems[index];
  if (!item) return;
  $("#command-modal").close();
  if (item.url) window.open(item.url, "_blank", "noopener,noreferrer");
  else if (item.route) navigate(item.route);
}

function toast(message, error = false) {
  const element = document.createElement("div");
  element.className = `toast${error ? " is-error" : ""}`;
  element.innerHTML = `<i data-lucide="${error ? "circle-alert" : "circle-check"}"></i><span>${escapeHtml(message)}</span>`;
  $("#toast-region").append(element);
  refreshIcons();
  setTimeout(() => element.remove(), 3200);
}

function submitWebSearch(event) {
  event.preventDefault();
  const query = $("#web-search-input").value.trim();
  if (!query) {
    $("#web-search-input").focus();
    return;
  }
  const engines = {
    bing: ["https://www.bing.com/search", "q"],
    google: ["https://www.google.com/search", "q"],
    baidu: ["https://www.baidu.com/s", "wd"],
    duckduckgo: ["https://duckduckgo.com/", "q"],
  };
  const engineName = $("#search-engine").value;
  const [base, parameter] = engines[engineName] || engines.bing;
  localStorage.setItem("research-search-engine", engineName);
  window.open(`${base}?${parameter}=${encodeURIComponent(query)}`, "_blank", "noopener,noreferrer");
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const route = event.target.closest("[data-route]");
    if (route) { navigate(route.dataset.route); return; }
    const add = event.target.closest("[data-action=add]");
    if (add) { openEditor(add.dataset.kind); return; }
    const addStatus = event.target.closest("[data-action=add-task-status]");
    if (addStatus) { openEditor("tasks", null, { status: addStatus.dataset.status }); return; }
    const edit = event.target.closest("[data-edit]");
    if (edit) { openEditor(edit.dataset.edit, edit.dataset.id); return; }
    const advance = event.target.closest("[data-advance-task]");
    if (advance) { advanceTask(advance.dataset.advanceTask); return; }
    const linkFilter = event.target.closest("[data-link-filter]");
    if (linkFilter) { state.linkFilter = linkFilter.dataset.linkFilter; renderLinks(); return; }
    const directoryFilter = event.target.closest("[data-directory-filter]");
    if (directoryFilter) { state.directoryFilter = directoryFilter.dataset.directoryFilter; renderDirectory(); return; }
    const calendarDay = event.target.closest("[data-calendar-open-day]");
    if (calendarDay) { openCalendarDay(calendarDay.dataset.calendarOpenDay); return; }
    const calendarCreate = event.target.closest("[data-calendar-create]");
    if (calendarCreate) { createCalendarEventAt(calendarCreate.dataset.calendarCreate); return; }
    const calendarDate = event.target.closest("[data-calendar-date]");
    if (calendarDate) {
      state.calendar.cursor = new Date(`${calendarDate.dataset.calendarDate}T12:00`);
      state.calendar.scrollKey = "";
      renderCalendar();
      return;
    }
    const command = event.target.closest("[data-command-index]");
    if (command) runCommand(Number(command.dataset.commandIndex));
  });
  $$('[data-close-modal]').forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  $("#login-button").addEventListener("click", () => state.authenticated ? logout() : showLogin());
  $("#settings-button").addEventListener("click", () => openEditor("settings", null, state.settings));
  $("#export-button").addEventListener("click", exportData);
  $("#login-form").addEventListener("submit", login);
  $("#editor-form").addEventListener("submit", saveEditor);
  $("#editor-fields").addEventListener("change", (event) => { if (event.target.name === "all_day") syncEventAllDayFields(); });
  $("#delete-button").addEventListener("click", deleteEditor);
  $("#link-search").addEventListener("input", renderLinks);
  $("#directory-search").addEventListener("input", renderDirectory);
  $("#web-search-form").addEventListener("submit", submitWebSearch);
  $("#search-engine").addEventListener("change", (event) => localStorage.setItem("research-search-engine", event.target.value));
  $("#paper-search").addEventListener("input", renderPapers);
  $("#calendar-prev").addEventListener("click", () => moveCalendar(-1));
  $("#calendar-next").addEventListener("click", () => moveCalendar(1));
  $("#calendar-today").addEventListener("click", () => { state.calendar.cursor = new Date(); state.calendar.scrollKey = ""; renderCalendar(); });
  $("#calendar-view-switch").addEventListener("click", (event) => {
    const button = event.target.closest("[data-calendar-view]");
    if (button) setCalendarView(button.dataset.calendarView);
  });
  $("#task-filters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    state.taskFilter = button.dataset.filter;
    $$("button", event.currentTarget).forEach((item) => item.classList.toggle("is-active", item === button));
    renderTasks();
  });
  $("#paper-filters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    state.paperFilter = button.dataset.filter;
    $$("button", event.currentTarget).forEach((item) => item.classList.toggle("is-active", item === button));
    renderPapers();
  });
  $("#timer-modes").addEventListener("click", (event) => {
    const button = event.target.closest("[data-minutes]");
    if (!button) return;
    setTimerMinutes(button.dataset.minutes, button.dataset.break === "true");
  });
  $("#apply-custom-focus").addEventListener("click", applyCustomFocus);
  $("#custom-focus-minutes").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); applyCustomFocus(); } });
  $("#timer-toggle").addEventListener("click", toggleTimer);
  $("#timer-reset").addEventListener("click", resetTimer);
  $("#timer-skip").addEventListener("click", () => completeTimer(true));
  $("#command-trigger").addEventListener("click", openCommand);
  $("#command-input").addEventListener("input", () => { state.commandIndex = 0; renderCommands(); });
  $("#command-input").addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); state.commandIndex = Math.min(state.commandIndex + 1, state.commandItems.length - 1); renderCommands(); }
    if (event.key === "ArrowUp") { event.preventDefault(); state.commandIndex = Math.max(state.commandIndex - 1, 0); renderCommands(); }
    if (event.key === "Enter") { event.preventDefault(); runCommand(); }
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openCommand(); }
    if (event.key === "Escape") $$("dialog[open]").forEach((dialog) => dialog.close());
  });
  $$("dialog").forEach((dialog) => dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); }));
}

async function init() {
  bindEvents();
  $("#search-engine").value = localStorage.getItem("research-search-engine") || "bing";
  if (!localStorage.getItem("research-calendar-view") && window.innerWidth <= 560) state.calendar.view = "day";
  const savedFocusMinutes = Number(localStorage.getItem("research-focus-minutes"));
  if (Number.isInteger(savedFocusMinutes) && savedFocusMinutes >= 1 && savedFocusMinutes <= 240) setTimerMinutes(savedFocusMinutes);
  updateClock();
  setInterval(updateClock, 30000);
  navigate(location.hash.slice(1) || "overview");
  renderTimer();
  refreshIcons();
  await loadData();
}

init();
