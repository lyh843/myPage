"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const page = fs.readFileSync(path.join(__dirname, "../static/index.html"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");
const extra = fs.readFileSync(path.join(__dirname, "../static/workbench.js"), "utf8");
const routes = ["overview", "calendar", "tasks", "directory", "research", "settings"];
assert.deepEqual([...page.matchAll(/data-view="([^"]+)"/g)].map((match) => match[1]).sort(), [...routes].sort());
for (const retired of ["links", "papers", "focus"]) assert.ok(!page.includes(`data-route="${retired}"`));
const elements = Object.fromEntries([...page.matchAll(/\bid="([^"]+)"/g)].map((match) =>
  [`#${match[1]}`, { innerHTML: "", textContent: "", value: "", addEventListener() {}, classList: { toggle() {}, contains: () => false } }]));
const views = routes.map((route) => ({ dataset: { view: route }, classList: { toggle() {} } }));
let currentHash = "";
const now = new Date(2026, 8, 12, 12);
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
  static now() { return now.getTime(); }
}
const context = vm.createContext({
  Date: FixedDate, URL, URLSearchParams,
  localStorage: { getItem: () => null, setItem() {} },
  document: {
    querySelector: (selector) => elements[selector] || null,
    querySelectorAll: (selector) => selector === "[data-view]" ? views : [],
    addEventListener() {},
  },
  window: { scrollTo() {}, addEventListener() {} },
  location: { hash: "" },
  history: { replaceState: (_state, _title, hash) => { currentHash = hash; } },
  requestAnimationFrame: (callback) => callback(),
});
vm.runInContext(extra, context);
vm.runInContext(source.replace(/\ninit\(\);\s*$/, "\n"), context);
const evaluate = (code) => vm.runInContext(code, context);
assert.deepEqual(Array.from(evaluate('commandItems().map((item) => item.route)')).sort(), [...routes].sort());
for (const retired of ["links", "papers", "focus", 'invalid"]', "__proto__"]) {
  evaluate(`navigate(${JSON.stringify(retired)})`);
  assert.equal(currentHash, "#overview");
}
evaluate(`state.tasks = ${JSON.stringify([
  { id: 1, title: "Overdue <script>", status: "todo", priority: "low", due_date: "2026-09-11" },
  { id: 2, title: "Morning deadline", status: "doing", priority: "medium", deadline_at: "2026-09-12T09:00" },
  { id: 3, title: "Due today", status: "todo", priority: "high", due_date: "2026-09-12" },
  { id: 4, title: "Tomorrow", status: "todo", priority: "high", due_date: "2026-09-13" },
  { id: 5, title: "Completed", status: "done", priority: "high", due_date: "2026-09-12" },
  { id: 6, title: "Unscheduled", status: "todo", priority: "low", end_at: "2026-09-12T11:00" },
])}`);
evaluate(`state.occurrences = ${JSON.stringify([
  { key: "event:1:2026-09-12T14:00", occurrence: "2026-09-12T14:00", event: { id: 1, title: "Today's meeting", start_at: "2026-09-12T14:00", end_at: "2026-09-12T15:00", repeat_rule: "daily" } },
  { key: "event:2:2026-09-13T10:00", occurrence: "2026-09-13T10:00", event: { id: 2, title: "Tomorrow meeting", start_at: "2026-09-13T10:00", end_at: "2026-09-13T11:00", repeat_rule: "none" } },
])}`);
evaluate("renderOverview()");
assert.equal(elements["#open-task-count"].textContent, 5);
assert.equal(elements["#due-today-count"].textContent, 2);
assert.equal(elements["#overdue-count"].textContent, 2);
assert.equal(elements["#today-event-count"].textContent, 1);
const html = elements["#overview-tasks"].innerHTML;
assert.ok(html.indexOf("Overdue") < html.indexOf("Morning deadline"));
assert.ok(html.indexOf("Morning deadline") < html.indexOf("Due today"));
assert.match(html, /Overdue &lt;script&gt;/);
assert.doesNotMatch(html, /Completed|<script>/);
assert.match(elements["#overview-calendar-list"].innerHTML, /Today&#039;s meeting/);
assert.doesNotMatch(elements["#overview-calendar-list"].innerHTML, /Tomorrow meeting/);
evaluate("state.agendaDay = 1; renderOverviewCalendar()");
assert.match(elements["#overview-calendar-list"].innerHTML, /Tomorrow meeting/);
assert.equal(evaluate("taskDeadline(state.tasks[5])"), null);
assert.doesNotMatch(evaluate('editorFields("tasks")'), /name="start_at"|name="end_at"/);
assert.match(evaluate('editorFields("tasks")'), /name="deadline_at"/);
assert.match(evaluate('editorFields("calendarEvents")'), /name="task_id"/);
assert.match(evaluate('repeatEditorFields({repeat_rule:"weekly", repeat_weekdays:"0,2"})'), /name="repeat_weekdays"/);
assert.equal(evaluate('eventToCalendar({key:"deadline:1", event:{id:1,title:"Deadline",start_at:"2026-09-12T23:59",end_at:"2026-09-13T00:00",_source:"deadline", all_day:true}}).editable'), false);
assert.equal(evaluate('eventToCalendar({key:"deadline:1", event:{id:1,title:"Deadline",start_at:"2026-09-12T23:59",end_at:"2026-09-13T00:00",_source:"deadline", all_day:true}}).end'), "2026-09-13");
evaluate('state.tasks = []; state.occurrences = []; renderOverview()');
assert.match(elements["#overview-tasks"].innerHTML, /empty-state/);
assert.match(elements["#overview-calendar-list"].innerHTML, /overview-calendar-empty/);
evaluate('state.inbox = [{id:1,title:"<img onerror=alert(1)>"}]; renderInbox()');
assert.match(elements["#inbox-list"].innerHTML, /&lt;img/);
assert.doesNotMatch(elements["#inbox-list"].innerHTML, /<img/);
assert.equal(evaluate('editorFields("papers")'), "");
assert.equal(evaluate('editorFields("links")'), "");
console.log("PASS: new routes, retired route fallback, independent deadlines, today/tomorrow agendas, recurring fields, task links, safe rendering and empty states");
