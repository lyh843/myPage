"use strict";

let interactiveCalendar = null;
let calendarData = [];
let calendarRenderKey = "";
let calendarDataKey = "";
let settingsLoaded = false;
let notifiedReminders = null;
const calendarViews = { month: "dayGridMonth", week: "timeGridWeek", day: "timeGridDay", list: "listWeek" };
const eventColors = { blue: "#2155d9", red: "#be402e", green: "#24866f", yellow: "#807b00", dark: "#343942" };

function repeatEditorFields(record) {
  return `<div class="field-row"><label class="field"><span>重复</span><select name="repeat_rule">${[["none","不重复"],["daily","按天"],["weekly","按周"],["monthly","按月"],["yearly","按年"]].map(([key,label]) => `<option value="${key}" ${(record.repeat_rule || "none") === key ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    <label class="field repeat-options"><span>间隔</span><input name="repeat_interval" type="number" min="1" max="365" value="${Number(record.repeat_interval) || 1}" required></label></div>
    <fieldset class="repeat-weekdays"><legend>每周</legend>${calendarWeekdays.map((day, index) => `<label class="check-field"><input name="repeat_weekdays" type="checkbox" value="${index}" ${String(record.repeat_weekdays || "").split(",").includes(String(index)) ? "checked" : ""}><span>${day}</span></label>`).join("")}</fieldset>
    <label class="field repeat-options"><span>重复截止日期</span><input name="repeat_until" type="date" value="${escapeHtml(record.repeat_until)}"></label>`;
}

function syncRepeatFields() {
  const rule = $('#editor-fields [name="repeat_rule"]')?.value;
  if (!rule) return;
  $$(".repeat-options").forEach((element) => { element.hidden = rule === "none"; });
  const weekdays = $(".repeat-weekdays");
  if (weekdays) {
    weekdays.hidden = rule !== "weekly";
    $$("input", weekdays).forEach((input) => { input.disabled = rule !== "weekly"; });
  }
}

function taskEditorFields(record) {
  return `<label class="field"><span>任务名称 *</span><input name="title" maxlength="160" required value="${escapeHtml(record.title)}"></label>
    <div class="field-row"><label class="field"><span>分类</span><input name="course" maxlength="50" value="${escapeHtml(record.course)}"></label><label class="field"><span>截止日期</span><input name="due_date" type="date" value="${escapeHtml(record.due_date)}"></label></div>
    <label class="field"><span>精确截止时间（可选）</span><input name="deadline_at" type="datetime-local" value="${escapeHtml(record.deadline_at)}"></label>
    <div class="field-row"><label class="field"><span>优先级</span><select name="priority">${Object.entries(labels.priority).map(([key, value]) => `<option value="${key}" ${(record.priority || "medium") === key ? "selected" : ""}>${value}</option>`).join("")}</select></label><label class="field"><span>状态</span><select name="status">${Object.entries(labels.taskStatus).map(([key, value]) => `<option value="${key}" ${(record.status || "todo") === key ? "selected" : ""}>${value}</option>`).join("")}</select></label></div>
    ${repeatEditorFields(record)}
    ${record.id && record.repeat_rule !== "none" ? `<label class="field"><span>修改范围</span><select name="_scope"><option value="following">本次及以后</option><option value="one">仅本次</option></select></label>` : ""}
    <label class="field"><span>备注</span><textarea name="notes" maxlength="1200">${escapeHtml(record.notes)}</textarea></label>`;
}

function eventToCalendar(item) {
  const event = item.event;
  const deadline = event._source === "deadline";
  const color = eventColors[event.color] || eventColors.blue;
  return {
    id: item.key, title: `${deadline ? "截止 · " : ""}${event.title}`,
    start: event.all_day ? event.start_at.slice(0, 10) : event.start_at,
    end: event.all_day ? localDateKey(addCalendarDays(startOfCalendarDay(new Date(deadline ? event.start_at : event.end_at)), 1)) : event.end_at,
    allDay: Boolean(event.all_day), editable: !deadline && !event.task_done,
    durationEditable: !deadline, backgroundColor: color, borderColor: color,
    classNames: [event.task_done ? "completed-event" : "", deadline ? "deadline-event" : ""],
    extendedProps: { occurrence: item },
  };
}

function renderInteractiveCalendar() {
  if (!window.FullCalendar) {
    $("#calendar-canvas").innerHTML = emptyState("triangle-alert", "日历组件未加载", "请刷新页面");
    return;
  }
  const key = `${state.calendar.view}:${localDateKey(state.calendar.cursor)}`;
  const dataKey = JSON.stringify([state.calendarEvents, state.tasks, state.occurrences]);
  if (!interactiveCalendar) {
    interactiveCalendar = new window.FullCalendar.Calendar($("#calendar-canvas"), {
      initialView: calendarViews[state.calendar.view], initialDate: state.calendar.cursor,
      locale: "zh-cn", firstDay: 1, headerToolbar: false,
      height: 690, nowIndicator: true, editable: true, selectable: true, selectMirror: true,
      slotDuration: "00:30:00", snapDuration: "00:15:00", scrollTime: "08:00:00",
      scrollTimeReset: false, slotEventOverlap: false, eventMinHeight: 24,
      dayMaxEvents: 3, allDayText: "全天", noEventsText: "这段时间没有安排",
      eventTimeFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
      slotLabelFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
      select: (info) => {
        if ($("dialog[open]")) return;
        openEditor("calendarEvents", null, {
          start_at: localDateTimeValue(info.start),
          end_at: localDateTimeValue(info.allDay ? new Date(info.end.getTime() - 60000) : info.end),
          all_day: info.allDay,
        });
        interactiveCalendar.unselect();
      },
      eventClick: (info) => openOccurrence(info.event.extendedProps.occurrence),
      eventDrop: updateDraggedEvent,
      eventResize: updateDraggedEvent,
      eventDidMount: (info) => {
        info.el.title = info.event.title;
        info.el.setAttribute("tabindex", "0");
        info.el.setAttribute("aria-label", info.event.title);
        info.el.addEventListener("keydown", (event) => {
          if (event.key === "Enter") { event.preventDefault(); openOccurrence(info.event.extendedProps.occurrence); }
        });
      },
      datesSet: (info) => { $("#calendar-range-title").textContent = info.view.title; },
      events: async (info, success, failure) => {
        try {
          const params = new URLSearchParams({ start: localDateTimeValue(info.start), end: localDateTimeValue(info.end) });
          calendarData = await api(`/api/calendar?${params}`);
          const category = $("#calendar-category").value;
          const hideDone = $("#calendar-hide-done").checked;
          success(calendarData.filter((item) => (!category || item.event.calendar_name === category) && (!hideDone || !item.event.task_done)).map(eventToCalendar));
        } catch (error) { failure(error); toast(error.message, true); }
      },
    });
    interactiveCalendar.render();
  } else {
    if (calendarRenderKey !== key) {
      interactiveCalendar.changeView(calendarViews[state.calendar.view], state.calendar.cursor);
    } else if (calendarDataKey !== dataKey) {
      interactiveCalendar.refetchEvents();
    }
    interactiveCalendar.updateSize();
  }
  calendarRenderKey = key;
  calendarDataKey = dataKey;
  $("#calendar-range-title").textContent = interactiveCalendar.view.title;
}

function openOccurrence(item) {
  if (!item) return;
  if (item.event._source === "deadline") openEditor("tasks", item.event.id);
  else openEditor("calendarEvents", item.event.id, { ...item.event, _occurrence: item.occurrence });
}

async function confirmCalendarConflicts(event, id) {
  if (!event.start_at || !event.end_at || event.end_at <= event.start_at) throw new Error("结束时间必须晚于开始时间");
  if (event.all_day) return true;
  const params = new URLSearchParams({ start: event.start_at, end: event.end_at });
  const items = await api(`/api/calendar?${params}`);
  const conflicts = items.filter((item) => item.event._source !== "deadline" && item.event.id !== id && !item.event.task_done && !item.event.all_day);
  return !conflicts.length || confirm(`与 ${conflicts.slice(0, 3).map((item) => item.event.title).join("、")} 时间重叠。仍然保存？`);
}

async function updateDraggedEvent(info) {
  const item = info.oldEvent.extendedProps.occurrence;
  const event = {
    ...item.event,
    start_at: localDateTimeValue(info.event.start),
    end_at: localDateTimeValue(info.event.allDay ? new Date(info.event.end.getTime() - 60000) : info.event.end),
    all_day: info.event.allDay,
  };
  if (item.event.repeat_rule !== "none") {
    info.revert();
    openEditor("calendarEvents", item.event.id, { ...event, _occurrence: item.occurrence });
    return;
  }
  try {
    if (!await confirmCalendarConflicts(event, item.event.id)) { info.revert(); return; }
    const result = await api(`/api/calendar-events/${item.event.id}/occurrence`, {
      method: "POST", body: JSON.stringify({ event, occurrence: item.occurrence, scope: "all", _version: item.event.updated_at }),
    });
    await loadData({ quiet: true });
    toast("日程已改期", false, result.history_id);
  } catch (error) { info.revert(); toast(error.message, true); }
}

function renderWorkbench() {
  renderInbox();
  renderReminders();
  renderResearch();
  renderSettings();
  const select = $("#calendar-category");
  const chosen = select.value;
  const categories = [...new Set([...state.calendarEvents.map((item) => item.calendar_name), "截止事项"])];
  select.innerHTML = `<option value="">全部分类</option>${categories.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}`;
  select.value = categories.includes(chosen) ? chosen : "";
}

function renderInbox() {
  $("#inbox-count").textContent = state.inbox.length;
  $("#inbox-toggle").textContent = state.inboxExpanded ? "收起" : "展开全部";
  const items = state.inboxExpanded ? state.inbox : state.inbox.slice(0, 3);
  $("#inbox-list").innerHTML = items.map((item) => `<div class="inbox-item"><button class="inbox-title" type="button" data-edit="inbox" data-id="${item.id}">${escapeHtml(item.title)}</button><div class="row-actions">
    <button class="icon-button" type="button" data-convert-inbox="${item.id}" data-kind="tasks" aria-label="转为任务" data-tooltip="转为任务"><i data-lucide="list-plus"></i></button>
    <button class="icon-button" type="button" data-convert-inbox="${item.id}" data-kind="calendarEvents" aria-label="转为日程" data-tooltip="转为日程"><i data-lucide="calendar-plus"></i></button>
    <button class="icon-button" type="button" data-delete-inbox="${item.id}" aria-label="删除收集内容" data-tooltip="删除"><i data-lucide="trash-2"></i></button></div></div>`).join("");
}

function renderReminders() {
  const count = state.reminders.length;
  $("#reminder-count").textContent = count > 99 ? "99+" : count;
  $("#reminder-count").hidden = !count;
  $("#reminders-button").setAttribute("aria-label", `站内提醒，${count} 项`);
  const keys = new Set(state.reminders.map((item) => item.reminder_key));
  if (notifiedReminders && state.authenticated) {
    const fresh = state.reminders.filter((item) => !notifiedReminders.has(item.reminder_key));
    if (fresh.length) toast(fresh.length === 1 ? `日程提醒：${fresh[0].event.title}` : `有 ${fresh.length} 项新的站内提醒`);
  }
  notifiedReminders = state.authenticated ? keys : null;
  $("#reminders-list").innerHTML = count ? state.reminders.map((item) => {
    const event = item.event;
    const label = event._source === "deadline" ? "截止事项" : item.overdue ? "已开始" : "即将开始";
    return `<article class="reminder-item"><span class="muted">${label} · ${escapeHtml(event.start_at.replace("T", " "))}</span><button class="inbox-title" type="button" data-reminder-open="${escapeHtml(item.reminder_key)}">${escapeHtml(event.title)}</button><div class="row-actions"><button class="text-button" type="button" data-reminder-dismiss="${escapeHtml(item.reminder_key)}"><i data-lucide="check"></i>已知晓</button><button class="text-button" type="button" data-reminder-snooze="${escapeHtml(item.reminder_key)}"><i data-lucide="alarm-clock"></i>10 分钟后</button></div></article>`;
  }).join("") : emptyState("bell-off", "没有待处理提醒", "");
}

function renderSettings(force = false) {
  const form = $("#llm-form");
  if (!form) return;
  if (force || !settingsLoaded) {
    for (const key of ["llm_endpoint", "llm_model", "llm_daily_limit"]) form.elements.namedItem(key).value = state.llmSettings[key] || (key === "llm_daily_limit" ? "20" : "");
    form.elements.namedItem("llm_enabled").checked = state.llmSettings.llm_enabled === "true";
    form.elements.namedItem("api_key").value = "";
    form.elements.namedItem("delete_key").checked = false;
    $("#feed-settings-form").elements.namedItem("research_auto").checked = state.llmSettings.research_auto !== "false";
    settingsLoaded = state.authenticated;
  }
  $("#llm-key-status").textContent = state.llmSettings.llm_key_configured ? "Key 已保存" : "未配置 Key";
  $("#settings-profile").textContent = [state.settings.display_name, state.settings.role].filter(Boolean).join(" · ");
  const items = state.history.filter((item) => state.historyTab !== "trash" || item.deleted);
  $("#history-list").innerHTML = items.length ? items.map((item) => `<div class="history-item"><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(new Date(item.created_at).toLocaleString("zh-CN"))}${item.undone ? " · 已恢复" : ""}</small></div><button class="icon-button" type="button" data-undo="${item.id}" ${item.undone ? "disabled" : ""} aria-label="撤销或恢复 ${escapeHtml(item.label)}" data-tooltip="撤销 / 恢复"><i data-lucide="undo-2"></i></button></div>`).join("") : emptyState("history", "暂无操作记录", "");
}

function renderResearch() {
  if (!$("#research-list") || state.researchBusy) return;
  const query = $("#research-search").value.trim().toLowerCase();
  const cutoff = localDateKey(addCalendarDays(new Date(), -6));
  const items = state.researchItems.filter((item) => {
    const visible = state.researchTab === "favorites" ? item.favorite : state.researchTab === "links" ? item.source !== "Hugging Face" : item.source === "Hugging Face" && item.source_date >= cutoff;
    return visible && (!query || [item.title, item.authors, item.abstract].join(" ").toLowerCase().includes(query));
  });
  $("#refresh-papers").disabled = state.feedRefreshing;
  $("#refresh-papers").innerHTML = `<i data-lucide="refresh-cw"></i>${state.feedRefreshing ? "更新中…" : "更新论文"}`;
  const last = state.llmSettings.research_feed_checked;
  $("#feed-status").textContent = [
    `Hugging Face · AI / ML · ${cutoff} 至 ${localDateKey(new Date())} 收录 · 按当前赞数`,
    last ? `检查于 ${new Date(last).toLocaleString("zh-CN")}` : "尚未更新",
    state.llmSettings.research_feed_error || "",
  ].filter(Boolean).join(" / ");
  $("#feed-status").classList.toggle("is-error", Boolean(state.llmSettings.research_feed_error));
  $("#research-list").innerHTML = items.length ? items.map((item) => `<article class="paper-row ${item.id === state.researchSelected ? "is-selected" : ""}">
    <button class="paper-select" type="button" data-paper-select="${item.id}"><span class="paper-meta">${escapeHtml(item.source)} ${item.source_date ? "· " + escapeHtml(item.source_date) : ""}</span><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.authors || domainOf(item.url))}</p></button>
    <div class="paper-tools"><span class="paper-votes" title="社区赞数"><i data-lucide="thumbs-up"></i>${item.votes}</span><button class="icon-button ${item.favorite ? "is-saved" : ""}" type="button" data-favorite="${item.id}" aria-label="${item.favorite ? "取消收藏" : "收藏"} ${escapeHtml(item.title)}" data-tooltip="${item.favorite ? "取消收藏" : "收藏"}"><i data-lucide="bookmark${item.favorite ? "-check" : ""}"></i></button></div></article>`).join("") : emptyState("telescope", "暂无匹配内容", state.researchTab === "week" ? "等待更新结果" : "");
  renderResearchDetail();
  refreshIcons();
}

function renderResearchDetail() {
  const item = state.researchItems.find((item) => item.id === state.researchSelected);
  const detail = $("#research-detail");
  if (!item) { detail.hidden = true; return; }
  const ready = state.llmSettings.llm_enabled === "true" && state.llmSettings.llm_key_configured && state.llmSettings.llm_endpoint && state.llmSettings.llm_model;
  detail.hidden = false;
  detail.innerHTML = `<div class="row-actions"><span class="section-code">${escapeHtml(item.content_scope || "论文摘要")}</span><button class="icon-button" type="button" id="close-research-detail" aria-label="关闭阅读详情"><i data-lucide="x"></i></button></div>
    <h2>${escapeHtml(item.title)}</h2><p class="muted">${escapeHtml(item.authors)}</p>
    <div class="row-actions"><a class="text-button" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer"><i data-lucide="external-link"></i>原文</a><button class="text-button" type="button" data-favorite="${item.id}"><i data-lucide="bookmark"></i>${item.favorite ? "取消收藏" : "收藏"}</button><button class="text-button" type="button" data-delete-research="${item.id}"><i data-lucide="trash-2"></i>移除</button></div>
    <p class="paper-abstract">${escapeHtml(item.abstract || "暂无来源摘要")}</p>
    <div class="summary-section"><h3>简要概述</h3><div class="summary-text">${escapeHtml(item.summary || "尚未生成")}</div>${item.summary ? `<p class="muted">${escapeHtml(item.summary_model)} · ${escapeHtml(new Date(item.summarized_at).toLocaleString("zh-CN"))}</p>` : ""}
    ${ready ? `<form id="summarize-form"><label class="check-field"><input type="checkbox" name="consent" required><span>同意将所选${escapeHtml(item.content_scope || "摘要")}发送至 ${escapeHtml(domainOf(state.llmSettings.llm_endpoint))}</span></label><button class="primary-button" type="submit"><i data-lucide="sparkles"></i>${item.summary ? "重新概括" : "生成概述"}</button></form>` : '<button class="secondary-button" type="button" data-route="settings"><i data-lucide="settings-2"></i>配置摘要服务</button>'}</div>`;
}

async function mutate(path, method, body, message) {
  const result = await api(path, { method, body: JSON.stringify(body) });
  await loadData({ quiet: true });
  toast(message, false, result.history_id || result._history_id);
  return result;
}

function planTask(id) {
  const task = state.tasks.find((item) => item.id === Number(id));
  openEditor("calendarEvents", null, task ? { title: task.title, task_id: task.id, calendar_name: task.course || "任务" } : {});
}

function bindWorkbench() {
  $("#capture-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      await mutate("/api/inbox", "POST", { title: $("#capture-input").value }, "已收集");
      $("#capture-input").value = "";
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });
  $("#inbox-toggle").addEventListener("click", () => { state.inboxExpanded = !state.inboxExpanded; renderInbox(); refreshIcons(); });
  $("#reminders-button").addEventListener("click", async () => {
    await loadData({ quiet: true });
    if (state.authenticated) $("#reminders-modal").showModal();
  });
  $("#agenda-days").addEventListener("click", (event) => {
    const button = event.target.closest("[data-agenda-day]");
    if (!button) return;
    state.agendaDay = Number(button.dataset.agendaDay);
    $$("button", event.currentTarget).forEach((item) => item.classList.toggle("is-active", item === button));
    renderOverviewCalendar(); refreshIcons();
  });
  for (const id of ["calendar-category", "calendar-hide-done"]) {
    $(`#${id}`).addEventListener("change", () => interactiveCalendar?.refetchEvents());
  }
  $("#duplicate-button").addEventListener("click", () => {
    const data = Object.fromEntries(new FormData($("#editor-form")));
    const allDay = data.all_day === "true";
    openEditor("calendarEvents", null, { ...data, title: data.title, repeat_rule: "none", all_day: allDay,
      start_at: `${data.start_date}T${allDay ? "00:00" : data.start_time}`,
      end_at: `${data.end_date}T${allDay ? "23:59" : data.end_time}` });
  });
  $("#edit-profile").addEventListener("click", () => openEditor("settings", null, state.settings));
  $("#settings-logout").addEventListener("click", logout);
  $("#settings-export").addEventListener("click", exportData);
  for (const formId of ["llm-form", "feed-settings-form"]) {
    $(`#${formId}`).addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = $('button[type="submit"]', form);
      const data = Object.fromEntries(new FormData(form));
      $$('input[type="checkbox"]', form).forEach((input) => { data[input.name] = input.checked; });
      button.disabled = true;
      try {
        state.llmSettings = await api("/api/llm-settings", { method: "POST", body: JSON.stringify(data) });
        renderSettings(true); renderResearch();
        toast("设置已保存");
      } catch (error) { toast(error.message, true); }
      finally { button.disabled = false; }
    });
  }
  $("#history-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-history-tab]");
    if (!button) return;
    state.historyTab = button.dataset.historyTab;
    $$("button", event.currentTarget).forEach((item) => item.classList.toggle("is-active", item === button));
    renderSettings(); refreshIcons();
  });
  $("#research-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-research-tab]");
    if (!button) return;
    state.researchTab = button.dataset.researchTab;
    $$("button", event.currentTarget).forEach((item) => item.classList.toggle("is-active", item === button));
    renderResearch();
  });
  $("#research-search").addEventListener("input", renderResearch);
  $("#refresh-papers").addEventListener("click", async () => {
    try {
      await api("/api/research/refresh", { method: "POST", body: "{}" });
      state.feedRefreshing = true;
      renderResearch();
    } catch (error) { toast(error.message, true); }
  });
  $("#inspect-link-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    button.disabled = true; button.textContent = "读取中…";
    try {
      const item = await api("/api/research/inspect", { method: "POST", body: JSON.stringify({ url: $("#research-url").value }) });
      state.researchSelected = item.id;
      await loadData({ quiet: true });
      $("#research-detail").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; button.innerHTML = '<i data-lucide="link"></i>读取链接'; refreshIcons(); }
  });
  $("#research-detail").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.target.id !== "summarize-form") return;
    const button = $('button[type="submit"]', event.target);
    button.disabled = true; button.textContent = "概括中…";
    state.researchBusy = true;
    try {
      await api(`/api/research/${state.researchSelected}/summarize`, { method: "POST", body: JSON.stringify({ consent: event.target.elements.namedItem("consent").checked }) });
      toast("概述已保存");
    } catch (error) { toast(error.message, true); }
    finally { state.researchBusy = false; await loadData({ quiet: true }); }
  });
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    try {
      if (button.dataset.occurrenceKey) openOccurrence(state.occurrences.find((item) => item.key === button.dataset.occurrenceKey) || calendarData.find((item) => item.key === button.dataset.occurrenceKey));
      if (button.dataset.planTask || button.dataset.action === "plan-task") planTask(button.dataset.planTask);
      if (button.dataset.convertInbox) {
        const item = state.inbox.find((item) => item.id === Number(button.dataset.convertInbox));
        openEditor(button.dataset.kind, null, { title: item.title.slice(0, 160), notes: item.title, description: item.title, _inbox_id: item.id, _inbox_version: item.updated_at });
      }
      if (button.dataset.deleteInbox) {
        const item = state.inbox.find((item) => item.id === Number(button.dataset.deleteInbox));
        await mutate(`/api/inbox/${item.id}`, "DELETE", { _version: item.updated_at }, "已移入回收站");
      }
      if (button.dataset.skipTask) {
        const task = state.tasks.find((item) => item.id === Number(button.dataset.skipTask));
        await mutate(`/api/tasks/${task.id}`, "PUT", { ...task, _version: task.updated_at, _skip: true, status: "done" }, "已跳过本次");
      }
      if (button.dataset.undo) {
        button.disabled = true;
        await mutate(`/api/history/${button.dataset.undo}/undo`, "POST", {}, "已恢复");
      }
      if (button.dataset.reminderDismiss || button.dataset.reminderSnooze) {
        const key = button.dataset.reminderDismiss || button.dataset.reminderSnooze;
        await mutate("/api/reminders/state", "POST", { key, snooze: Boolean(button.dataset.reminderSnooze) }, "提醒已更新");
      }
      if (button.dataset.reminderOpen) {
        const item = state.reminders.find((item) => item.reminder_key === button.dataset.reminderOpen);
        $("#reminders-modal").close(); openOccurrence(item);
      }
      if (button.dataset.paperSelect) {
        state.researchSelected = Number(button.dataset.paperSelect);
        renderResearch();
        if (window.innerWidth <= 1100) $("#research-detail").scrollIntoView({ behavior: "smooth", block: "start" });
      }
      if (button.id === "close-research-detail") { state.researchSelected = null; renderResearch(); }
      if (button.dataset.favorite) {
        const item = state.researchItems.find((item) => item.id === Number(button.dataset.favorite));
        await mutate(`/api/research-items/${item.id}`, "PUT", { favorite: !item.favorite, _version: item.updated_at }, item.favorite ? "已取消收藏" : "已收藏");
      }
      if (button.dataset.deleteResearch && confirm("移除这条论文或链接？可在操作历史恢复。")) {
        const item = state.researchItems.find((item) => item.id === Number(button.dataset.deleteResearch));
        await mutate(`/api/research-items/${item.id}`, "DELETE", { _version: item.updated_at }, "已移除");
      }
    } catch (error) { toast(error.message, true); button.disabled = false; }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.authenticated && !$("dialog[open]") && !state.researchBusy) loadData({ quiet: true });
  });
}
