"use strict";

const state = {
  authenticated: false,
  csrfToken: "",
  settings: {},
  directoryLinks: [],
  directoryCategories: [],
  tasks: [],
  calendarEvents: [],
  occurrences: [],
  reminders: [],
  inbox: [],
  history: [],
  researchItems: [],
  llmSettings: {},
  feedRefreshing: false,
  agendaDay: 0,
  researchTab: "week",
  researchSelected: null,
  researchBusy: false,
  historyTab: "all",
  inboxExpanded: false,
  loadSequence: 0,
  stats: {},
  directoryFilter: "全部",
  taskFilter: "all",
  editor: { kind: "", id: null },
  commandItems: [],
  commandIndex: 0,
  calendar: { view: localStorage.getItem("research-calendar-view") || "week", cursor: new Date() },
};

const labels = {
  taskStatus: { todo: "待处理", doing: "推进中", done: "已完成" },
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
  const sequence = ++state.loadSequence;
  try {
    const data = await api("/api/bootstrap");
    if (sequence !== state.loadSequence) return;
    state.authenticated = data.authenticated;
    state.csrfToken = data.csrf_token;
    state.settings = data.settings || {};
    state.directoryLinks = data.directory_links || [];
    state.directoryCategories = data.directory_categories || [...new Set(state.directoryLinks.map((link) => link.category).filter(Boolean))];
    state.tasks = data.tasks || [];
    state.calendarEvents = data.calendar_events || [];
    state.occurrences = data.occurrences || [];
    state.reminders = data.reminders || [];
    state.inbox = data.inbox || [];
    state.history = data.history || [];
    state.researchItems = data.research_items || [];
    state.llmSettings = data.llm_settings || {};
    state.feedRefreshing = data.feed_refreshing || false;
    state.stats = data.stats || {};
    renderAll();
    if (!data.authenticated) showLogin();
  } catch (error) {
    if (!quiet) toast(error.message, true);
  }
}

function renderAll() {
  document.body.classList.toggle("is-locked", !state.authenticated);
  document.body.classList.toggle("is-authenticated", state.authenticated);
  const loginButton = $("#login-button");
  loginButton.classList.toggle("is-authenticated", state.authenticated);
  loginButton.setAttribute("aria-label", state.authenticated ? "退出登录" : "登录工作台");
  loginButton.innerHTML = state.authenticated
    ? '<i data-lucide="log-out"></i><span>退出</span>'
    : '<i data-lucide="lock-keyhole"></i><span>登录</span>';

  const settings = state.settings;
  $("#display-name").textContent = settings.display_name || "LYH";
  $("#sidebar-name").textContent = settings.display_name || "LYH";
  $("#sidebar-role").textContent = settings.role || "个人日程";
  $("#profile-link").href = settings.github || "https://github.com/lyh843";
  $("#profile-link img").src = githubAvatar(settings.github);

  $("#task-nav-count").textContent = state.stats.open_tasks ?? 0;
  $("#directory-nav-count").textContent = state.stats.directory_links ?? state.directoryLinks.length;
  $("#directory-count").textContent = state.directoryLinks.length;
  renderOverview();
  renderDirectory();
  renderTasks();
  renderCalendar();
  renderWorkbench();
  refreshIcons();
}

function githubAvatar(url) {
  const match = String(url || "").match(/github\.com\/([^/?#]+)/i);
  return match ? `https://github.com/${encodeURIComponent(match[1])}.png?size=96` : "https://github.com/lyh843.png?size=96";
}

function renderOverview() {
  const today = startOfCalendarDay(new Date());
  const tomorrow = addCalendarDays(today, 1);
  const activeTasks = state.tasks
    .filter((task) => task.status !== "done")
    .sort((a, b) => (taskDeadline(a)?.getTime() ?? Infinity) - (taskDeadline(b)?.getTime() ?? Infinity) || priorityRank(b.priority) - priorityRank(a.priority));
  $("#open-task-count").textContent = activeTasks.length;
  $("#due-today-count").textContent = activeTasks.filter((task) => {
    const due = taskDeadline(task);
    return due && due >= today && due < tomorrow;
  }).length;
  $("#overdue-count").textContent = activeTasks.filter(isOverdue).length;
  $("#today-event-count").textContent = calendarOccurrences(today, tomorrow).length;

  $("#overview-tasks").innerHTML = activeTasks.length
    ? activeTasks.slice(0, 4).map((task) => `
      <article class="priority-item">
        <span class="priority-dot ${escapeHtml(task.priority)}" aria-hidden="true"></span>
        <div class="priority-copy"><button class="priority-title" type="button" data-edit="tasks" data-id="${task.id}">${escapeHtml(task.title)}</button><span class="${isOverdue(task) ? "overdue" : ""}">${escapeHtml(task.course || "未分类")} · ${formatTaskTiming(task)}</span></div>
        <button class="status-button auth-gated" type="button" data-advance-task="${task.id}" aria-label="${task.status === "todo" ? "开始" : "完成"}任务：${escapeHtml(task.title)}"><i data-lucide="arrow-right"></i>${labels.taskStatus[task.status]}</button>
      </article>`).join("")
    : emptyState("circle-check-big", "当前没有待办", "");

  renderOverviewCalendar();
}

function renderOverviewCalendar() {
  const now = new Date();
  const rangeStart = addCalendarDays(startOfCalendarDay(now), state.agendaDay);
  const upcoming = calendarOccurrences(rangeStart, addCalendarDays(rangeStart, 1))
    .filter((item) => !item.event.task_done);
  const container = $("#overview-calendar-list");
  if (!upcoming.length) {
    container.innerHTML = `<div class="overview-calendar-empty"><i data-lucide="calendar-plus"></i><span><strong>${state.agendaDay ? "明天" : "今天"}没有安排</strong></span><button class="text-button auth-gated" type="button" data-action="add" data-kind="calendarEvents">新建日程 <i data-lucide="plus"></i></button></div>`;
    return;
  }
  container.innerHTML = upcoming.map((item) => {
    const ongoing = item.start <= now && item.end > now;
    const dateLabel = overviewCalendarDateLabel(item.start, now);
    const timeLabel = item.event.all_day ? "全天" : `${padNumber(item.start.getHours())}:${padNumber(item.start.getMinutes())}`;
    const sourceLabel = item.event._source === "task"
      ? ["任务", item.event.location].filter(Boolean).join(" · ")
      : item.event.location || item.event.calendar_name || "个人日历";
    return `<button class="overview-calendar-item ${ongoing ? "is-ongoing" : ""}" type="button" data-occurrence-key="${escapeHtml(item.key)}" data-color="${escapeHtml(item.event.color)}">
      <span class="overview-calendar-date"><small>${escapeHtml(dateLabel.label)}</small><strong>${padNumber(item.start.getDate())}</strong><em>${escapeHtml(dateLabel.month)}</em></span>
      <span class="overview-calendar-copy"><small>${ongoing ? "进行中" : timeLabel}${item.event.repeat_rule !== "none" ? " · 重复" : ""}</small><strong>${escapeHtml(item.event.title)}</strong><em>${escapeHtml(sourceLabel)}</em></span>
      <i data-lucide="chevron-right"></i>
    </button>`;
  }).join("");
}

function overviewCalendarDateLabel(value, today) {
  if (sameCalendarDay(value, today)) return { label: "今天", month: `${value.getMonth() + 1} 月` };
  if (sameCalendarDay(value, addCalendarDays(today, 1))) return { label: "明天", month: `${value.getMonth() + 1} 月` };
  return { label: `周${calendarWeekdays[(value.getDay() + 6) % 7]}`, month: `${value.getMonth() + 1} 月` };
}

function renderDirectory() {
  const categories = state.directoryCategories;
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
  }).join("") : state.directoryFilter !== "全部" && !query && counts[state.directoryFilter] === 0
    ? emptyState("folder-open", "这个分类还没有站点", "")
    : emptyState("search-x", "没有匹配的站点", "换一个关键词或分类试试");
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
      const due = taskDeadline(task);
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
  const timingIcon = task.end_at ? "clock-3" : "calendar-days";
  return `<article class="task-card">
    <div class="task-card-top"><span class="priority-mark ${escapeHtml(task.priority)}" title="${labels.priority[task.priority]}优先级"></span><button class="task-edit auth-only" type="button" data-edit="tasks" data-id="${task.id}" aria-label="编辑任务"><i data-lucide="more-horizontal"></i></button></div>
    <h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(task.notes || task.course || "暂无备注")}</p>
    <div class="task-card-meta"><span class="due ${dueClass}"><i data-lucide="${timingIcon}"></i>${formatTaskTiming(task)}</span><button class="advance-button auth-gated" type="button" data-advance-task="${task.id}" ${task.status === "done" ? "disabled" : ""}>${task.skipped ? "已跳过" : nextLabel}<i data-lucide="chevron-right"></i></button></div>
    ${task.status !== "done" ? `<div class="row-actions"><button type="button" class="text-button" data-plan-task="${task.id}"><i data-lucide="calendar-plus"></i>安排时间</button>${task.repeat_rule && task.repeat_rule !== "none" ? `<button type="button" class="text-button" data-skip-task="${task.id}"><i data-lucide="skip-forward"></i>跳过本次</button>` : ""}</div>` : ""}
  </article>`;
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
  return { directoryLinks: "directory-links", directoryCategories: "directory-categories", calendarEvents: "calendar-events" }[kind] || kind;
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

function calendarOccurrences(rangeStart, rangeEnd) {
  return state.occurrences.map((item) => ({ ...item, start: parseLocalDateTime(item.event.start_at), end: parseLocalDateTime(item.event.end_at) }))
    .filter((item) => item.start < rangeEnd && item.end > rangeStart);
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
  if (!$('[data-view="calendar"]').classList.contains("is-active")) return;
  if (!state.authenticated) return;
  if (!["month", "week", "day", "list"].includes(state.calendar.view)) state.calendar.view = "week";
  const range = calendarVisibleRange();
  $("#calendar-range-title").textContent = calendarRangeTitle(range);
  $$('[data-calendar-view]', $("#calendar-view-switch")).forEach((button) => button.classList.toggle("is-active", button.dataset.calendarView === state.calendar.view));
  renderMiniCalendar(range);
  renderCalendarUpcoming();
  renderInteractiveCalendar();
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
    <button class="upcoming-event" type="button" data-occurrence-key="${escapeHtml(item.key)}" data-color="${escapeHtml(item.event.color)}">
      <span class="upcoming-date"><strong>${padNumber(item.start.getDate())}</strong><small>${item.start.getMonth() + 1} 月</small></span>
      <span><strong>${escapeHtml(item.event.title)}</strong><small>${item.event.all_day ? "全天" : `${padNumber(item.start.getHours())}:${padNumber(item.start.getMinutes())}`}${item.event._source === "task" ? " · 任务" : ""} ${item.event.location ? `· ${escapeHtml(item.event.location)}` : ""}</small></span>
    </button>`).join("") : `<div class="calendar-empty"><i data-lucide="calendar-check-2"></i><span>近期没有日程</span></div>`;
}

function setCalendarView(view) {
  if (!["month", "week", "day", "list"].includes(view)) return;
  state.calendar.view = view;
  localStorage.setItem("research-calendar-view", view);
  renderCalendar();
}

function moveCalendar(direction) {
  const cursor = new Date(state.calendar.cursor);
  if (state.calendar.view === "month") { cursor.setDate(1); cursor.setMonth(cursor.getMonth() + direction); }
  else cursor.setDate(cursor.getDate() + direction * (["week", "list"].includes(state.calendar.view) ? 7 : 1));
  state.calendar.cursor = cursor;
  renderCalendar();
}

function openCalendarDay(value) {
  const dateValue = new Date(`${value}T12:00`);
  if (Number.isNaN(dateValue.getTime())) return;
  state.calendar.cursor = dateValue;
  state.calendar.view = "day";
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
function parseDate(value) { return value ? new Date(`${value}T23:59:59`) : null; }
function taskDeadline(task) { return parseLocalDateTime(task.deadline_at) || parseDate(task.due_date); }
function isOverdue(task) { const due = taskDeadline(task); return task.status !== "done" && due && due < new Date(); }
function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "打开链接"; } }

function formatTaskTiming(task) {
  const end = parseLocalDateTime(task.deadline_at);
  if (!end) return formatDue(task.due_date);
  const endLabel = `${padNumber(end.getMonth() + 1)}/${padNumber(end.getDate())} ${padNumber(end.getHours())}:${padNumber(end.getMinutes())}`;
  return `${endLabel} 前`;
}

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
  const routeLabels = { overview: "概览", directory: "网址导航", tasks: "任务", calendar: "日历", research: "论文发现", settings: "设置" };
  const target = Object.hasOwn(routeLabels, route) ? route : "overview";
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
  if (target === "calendar") renderCalendar();
  if (target === "settings") renderSettings(true);
  if (target === "research") renderResearch();
  refreshIcons();
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
  if (kind === "inbox") return `<label class="field"><span>收集内容</span><textarea name="title" maxlength="1000" required>${escapeHtml(record.title)}</textarea></label>`;
  if (kind === "directoryCategories") return `
    <label class="field"><span>分类名称 *</span><input name="name" maxlength="30" required placeholder="例如：科研工具"></label>`;
  if (kind === "directoryLinks") return `
    <label class="field"><span>名称 *</span><input name="title" maxlength="80" required value="${escapeHtml(record.title)}" placeholder="例如：Semantic Scholar"></label>
    <label class="field"><span>网址 *</span><input name="url" type="url" maxlength="1200" required value="${escapeHtml(record.url)}" placeholder="https://"></label>
    <div class="field-row"><label class="field"><span>分类</span><select name="category" required><option value="">请选择分类</option>${state.directoryCategories.map((category) => `<option value="${escapeHtml(category)}" ${category === (record.category || state.directoryFilter) ? "selected" : ""}>${escapeHtml(category)}</option>`).join("")}</select></label><label class="field"><span>图标</span><select name="icon">${iconOptions(record.icon)}</select></label></div>
    <label class="field"><span>一句备注</span><input name="note" maxlength="160" value="${escapeHtml(record.note)}" placeholder="这个入口用于什么"></label>
    <div class="field"><span>标识色</span><div class="color-options">${["blue", "red", "yellow", "green", "dark"].map((color) => `<label title="${color}"><input type="radio" name="color" value="${color}" ${(record.color || "blue") === color ? "checked" : ""}><span style="--swatch:var(--${color === "dark" ? "ink" : color})"></span></label>`).join("")}</div></div>`;
  if (kind === "tasks") return taskEditorFields(record);
  if (kind === "calendarEvents") {
    const defaultStart = parseLocalDateTime(record.start_at) || defaultCalendarStart();
    const defaultEnd = parseLocalDateTime(record.end_at) || new Date(defaultStart.getTime() + 60 * 60000);
    const start = eventEditorParts(localDateTimeValue(defaultStart));
    const end = eventEditorParts(localDateTimeValue(defaultEnd));
    return `
      <label class="field"><span>日程标题 *</span><input name="title" maxlength="160" required value="${escapeHtml(record.title)}" placeholder="例如：课程、会议或预约"></label>
      <label class="check-field"><input name="all_day" type="checkbox" value="true" ${record.all_day ? "checked" : ""}><span><i data-lucide="sun"></i>全天日程</span></label>
      <div class="event-date-grid">
        <label class="field"><span>开始日期 *</span><input name="start_date" type="date" required value="${start.date}"></label>
        <label class="field event-time-field"><span>开始时间 *</span><input name="start_time" type="time" required value="${start.time}"></label>
        <label class="field"><span>结束日期 *</span><input name="end_date" type="date" required value="${end.date}"></label>
        <label class="field event-time-field"><span>结束时间 *</span><input name="end_time" type="time" required value="${end.time}"></label>
      </div>
      ${repeatEditorFields(record)}
      ${record.id && record.repeat_rule !== "none" ? `<label class="field"><span>修改范围</span><select name="_scope"><option value="one">仅本次</option><option value="following">本次及以后</option><option value="all">整个系列（清除已有例外）</option></select></label>` : ""}
      <div class="field-row"><label class="field"><span>关联任务</span><select name="task_id"><option value="">无</option>${state.tasks.filter((task) => task.status !== "done" || task.id === record.task_id).map((task) => `<option value="${task.id}" ${task.id === Number(record.task_id) ? "selected" : ""}>${escapeHtml(task.title)}</option>`).join("")}</select></label><label class="field"><span>站内提醒</span><select name="reminder_minutes">${[[-1,"不提醒"],[0,"开始时"],[5,"提前 5 分钟"],[15,"提前 15 分钟"],[30,"提前 30 分钟"],[60,"提前 1 小时"],[1440,"提前 1 天"]].map(([value,label]) => `<option value="${value}" ${Number(record.reminder_minutes ?? 15) === value ? "selected" : ""}>${label}</option>`).join("")}</select></label></div>
      <div class="field-row"><label class="field"><span>所属日历</span><input name="calendar_name" maxlength="40" value="${escapeHtml(record.calendar_name || "个人日历")}" placeholder="个人日历"></label><label class="field"><span>地点</span><input name="location" maxlength="200" value="${escapeHtml(record.location)}" placeholder="教室、会议室或线上链接"></label></div>
      <label class="field"><span>说明</span><textarea name="description" maxlength="2000" placeholder="记录议程、材料或准备事项">${escapeHtml(record.description)}</textarea></label>
      <input name="timezone" type="hidden" value="${escapeHtml(record.timezone || "Asia/Shanghai")}">
      <div class="field"><span>日程颜色</span><div class="color-options">${["blue", "red", "yellow", "green", "dark"].map((color) => `<label title="${color}"><input type="radio" name="color" value="${color}" ${(record.color || "blue") === color ? "checked" : ""}><span style="--swatch:var(--${color === "dark" ? "ink" : color})"></span></label>`).join("")}</div></div>`;
  }
  if (kind === "settings") return `
    <label class="field"><span>页面称呼 *</span><input name="display_name" maxlength="40" required value="${escapeHtml(record.display_name)}"></label>
    <label class="field"><span>身份描述</span><input name="role" maxlength="80" value="${escapeHtml(record.role)}" placeholder="个人日程"></label>
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
    const base = id === null ? {} : state[kind].find((item) => item.id === Number(id)) || {};
    const record = { ...base, ...defaults };
    state.editor = { kind, id: id === null ? null : Number(id), version: base.updated_at, occurrence: defaults._occurrence || base.start_at, inboxId: defaults._inbox_id, inboxVersion: defaults._inbox_version };
    const nouns = { directoryLinks: "导航站点", directoryCategories: "分类", tasks: "任务", calendarEvents: "日程", settings: "工作台设置", inbox: "收集内容" };
    $("#editor-code").textContent = kind === "settings" ? "WORKSPACE PROFILE" : id === null ? "NEW ITEM" : "EDIT ITEM";
    $("#editor-title").textContent = kind === "settings" ? nouns[kind] : `${id === null ? "新增" : "编辑"}${nouns[kind]}`;
    $("#editor-fields").innerHTML = editorFields(kind, record);
    $("#delete-button").hidden = id === null || kind === "settings";
    $("#duplicate-button").hidden = kind !== "calendarEvents" || id === null;
    $("#save-button").textContent = id === null && kind !== "settings" ? "添加" : "保存更改";
    $("#editor-modal").showModal();
    refreshIcons();
    if (kind === "calendarEvents") syncEventAllDayFields();
    syncRepeatFields();
    setTimeout(() => $("#editor-fields input")?.focus(), 30);
  });
}

async function saveEditor(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const { kind, id } = state.editor;
  if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  data._version = state.editor.version;
  data._inbox_id = state.editor.inboxId;
  data._inbox_version = state.editor.inboxVersion;
  data.repeat_weekdays = new FormData(form).getAll("repeat_weekdays").join(",");
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
  const scoped = kind === "calendarEvents" && id !== null;
  const path = scoped ? `/api/calendar-events/${id}/occurrence` : kind === "settings" ? "/api/settings" : `/api/${endpoint}${id === null ? "" : `/${id}`}`;
  const method = scoped || kind === "settings" || id === null ? "POST" : "PUT";
  const button = $("#save-button");
  button.disabled = true;
  button.textContent = "正在保存…";
  try {
    if (kind === "calendarEvents" && !await confirmCalendarConflicts(data, id)) return;
    const body = scoped ? { event: data, occurrence: state.editor.occurrence, scope: data._scope || "all", _version: state.editor.version } : data;
    const saved = await api(path, { method, body: JSON.stringify(body) });
    if (kind === "directoryCategories") {
      state.directoryFilter = saved.name;
      $("#directory-search").value = "";
    }
    $("#editor-modal").close();
    await loadData({ quiet: true });
    toast(kind === "settings" ? "工作台设置已更新" : id === null ? "已添加" : "更改已保存", false, saved._history_id || saved.history_id);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "保存更改";
  }
}

async function deleteEditor() {
  const { kind, id } = state.editor;
  if (!id || !confirm("删除这条记录？30 天内可从操作历史恢复。")) return;
  try {
    const endpoint = endpointForKind(kind);
    const scoped = kind === "calendarEvents";
    const result = await api(scoped ? `/api/calendar-events/${id}/occurrence` : `/api/${endpoint}/${id}`, {
      method: scoped ? "POST" : "DELETE",
      body: JSON.stringify(scoped ? { delete: true, occurrence: state.editor.occurrence, scope: $("#editor-form").elements.namedItem("_scope")?.value || "all", _version: state.editor.version } : { _version: state.editor.version }),
    });
    $("#editor-modal").close();
    await loadData({ quiet: true });
    toast("已删除", false, result.history_id);
  } catch (error) { toast(error.message, true); }
}

async function advanceTask(id) {
  requireAuth(async () => {
    const task = state.tasks.find((item) => item.id === Number(id));
    if (!task || task.status === "done") return;
    const updated = { ...task, _version: task.updated_at, status: task.status === "todo" ? "doing" : "done" };
    try {
      const result = await api(`/api/tasks/${task.id}`, { method: "PUT", body: JSON.stringify(updated) });
      await loadData({ quiet: true });
      toast(updated.status === "done" ? "任务已完成" : "任务已进入推进中", false, result._history_id);
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
    const data = await api("/api/login", { method: "POST", body: JSON.stringify({ password, remember: $("#remember-browser").checked }) });
    state.csrfToken = data.csrf_token;
    $("#login-modal").close();
    await loadData({ quiet: true });
    toast("已登录");
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
    toast("已退出登录");
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
}

function commandItems(query = "") {
  const normalized = query.trim().toLowerCase();
  const pages = [
    { icon: "layout-dashboard", title: "概览", meta: "页面", route: "overview" },
    { icon: "calendar-days", title: "日历", meta: "页面", route: "calendar" },
    { icon: "list-checks", title: "任务", meta: "页面", route: "tasks" },
    { icon: "compass", title: "网址导航", meta: "页面", route: "directory" },
    { icon: "telescope", title: "论文发现", meta: "页面", route: "research" },
    { icon: "settings-2", title: "设置", meta: "页面", route: "settings" },
  ];
  const directoryLinks = state.directoryLinks.map((item) => ({ icon: safeIcon(item.icon), title: item.title, meta: `网址导航 · ${item.category}`, url: item.url }));
  const tasks = state.tasks.map((item) => ({ icon: "circle-check", title: item.title, meta: `任务 · ${labels.taskStatus[item.status]}`, route: "tasks" }));
  const calendarEvents = state.calendarEvents.map((item) => ({ icon: "calendar-clock", title: item.title, meta: `日程 · ${item.start_at.replace("T", " ")}`, route: "calendar" }));
  return [...pages, ...directoryLinks, ...tasks, ...calendarEvents].filter((item) => !normalized || `${item.title} ${item.meta}`.toLowerCase().includes(normalized)).slice(0, 12);
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

function toast(message, error = false, historyId = null) {
  const element = document.createElement("div");
  element.className = `toast${error ? " is-error" : ""}`;
  element.innerHTML = `<i data-lucide="${error ? "circle-alert" : "circle-check"}"></i><span>${escapeHtml(message)}</span>${historyId ? `<button type="button" data-undo="${historyId}" aria-label="撤销" title="撤销"><i data-lucide="undo-2"></i></button>` : ""}`;
  $("#toast-region").append(element);
  while ($("#toast-region").children.length > (window.innerWidth < 560 ? 1 : 2)) $("#toast-region").firstElementChild.remove();
  refreshIcons();
  setTimeout(() => element.remove(), historyId ? 10000 : 4200);
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
  bindWorkbench();
  window.addEventListener("hashchange", () => navigate(location.hash.slice(1)));
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
    const directoryFilter = event.target.closest("[data-directory-filter]");
    if (directoryFilter) { state.directoryFilter = directoryFilter.dataset.directoryFilter; renderDirectory(); return; }
    const calendarDay = event.target.closest("[data-calendar-open-day]");
    if (calendarDay) { openCalendarDay(calendarDay.dataset.calendarOpenDay); return; }
    const calendarCreate = event.target.closest("[data-calendar-create]");
    if (calendarCreate) { createCalendarEventAt(calendarCreate.dataset.calendarCreate); return; }
    const calendarDate = event.target.closest("[data-calendar-date]");
    if (calendarDate) {
      state.calendar.cursor = new Date(`${calendarDate.dataset.calendarDate}T12:00`);
      renderCalendar();
      return;
    }
    const command = event.target.closest("[data-command-index]");
    if (command) runCommand(Number(command.dataset.commandIndex));
  });
  $$('[data-close-modal]').forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  $("#login-button").addEventListener("click", () => state.authenticated ? logout() : showLogin());
  $("#settings-button").addEventListener("click", () => navigate("settings"));
  $("#export-button").addEventListener("click", exportData);
  $("#login-form").addEventListener("submit", login);
  $("#editor-form").addEventListener("submit", saveEditor);
  $("#editor-fields").addEventListener("change", (event) => { if (event.target.name === "all_day") syncEventAllDayFields(); syncRepeatFields(); });
  $("#delete-button").addEventListener("click", deleteEditor);
  $("#directory-search").addEventListener("input", renderDirectory);
  $("#web-search-form").addEventListener("submit", submitWebSearch);
  $("#search-engine").addEventListener("change", (event) => localStorage.setItem("research-search-engine", event.target.value));
  $("#calendar-prev").addEventListener("click", () => moveCalendar(-1));
  $("#calendar-next").addEventListener("click", () => moveCalendar(1));
  $("#calendar-today").addEventListener("click", () => { state.calendar.cursor = new Date(); renderCalendar(); });
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
  $("#command-trigger").addEventListener("click", openCommand);
  $("#command-input").addEventListener("input", () => { state.commandIndex = 0; renderCommands(); });
  $("#command-input").addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); state.commandIndex = Math.min(state.commandIndex + 1, state.commandItems.length - 1); renderCommands(); }
    if (event.key === "ArrowUp") { event.preventDefault(); state.commandIndex = Math.max(state.commandIndex - 1, 0); renderCommands(); }
    if (event.key === "Enter") { event.preventDefault(); runCommand(); }
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openCommand(); }
    if (event.key === "Escape") $$("dialog[open]").filter((dialog) => dialog.id !== "login-modal").forEach((dialog) => dialog.close());
  });
  $$("dialog").forEach((dialog) => dialog.addEventListener("click", (event) => { if (event.target === dialog && dialog.id !== "login-modal") dialog.close(); }));
  $("#login-modal").addEventListener("cancel", (event) => event.preventDefault());
}

async function init() {
  bindEvents();
  $("#search-engine").value = localStorage.getItem("research-search-engine") || "bing";
  if (!localStorage.getItem("research-calendar-view") && window.innerWidth <= 560) state.calendar.view = "day";
  updateClock();
  setInterval(() => {
    updateClock();
    renderOverview();
    refreshIcons();
    if (state.authenticated && !document.hidden && !$("dialog[open]") && !state.researchBusy && !$("#llm-form").contains(document.activeElement)) loadData({ quiet: true });
  }, 30000);
  navigate(location.hash.slice(1) || "overview");
  refreshIcons();
  await loadData();
}

init();
