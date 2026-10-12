"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const elements = new Map();
function element(selector) {
  if (!elements.has(selector)) elements.set(selector, { innerHTML: "", value: "", textContent: "", reset() {}, classList: { toggle() {} } });
  return elements.get(selector);
}
const context = vm.createContext({
  localStorage: { getItem: () => null }, window: {},
  document: { querySelector: element, querySelectorAll: () => [] },
});
for (const file of ["workbench.js", "accounts.js", "app.js"]) {
  const source = fs.readFileSync(path.join(__dirname, "../static", file), "utf8");
  vm.runInContext(source.replace(/\ninit\(\);\s*$/, "\n"), context);
}
const evaluate = (source) => vm.runInContext(source, context);
const request = (url, body, method = "PUT") => JSON.parse(evaluate(`JSON.stringify(accountRequest(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, body: ${JSON.stringify(JSON.stringify(body))} }))`));
assert.equal(evaluate('recordId("shared:1:4:9")'), "shared:1:4:9");
assert.equal(evaluate('recordId("9")'), 9);
let routed = request("/api/tasks/shared:1:4:9", { project_id: "shared:1:4", title: "Task" });
assert.equal(routed[0], "/api/shared/1/4/tasks/9");
assert.equal(JSON.parse(routed[1].body).project_id, 4);
routed = request("/api/tasks", { project_id: "shared:2:7", title: "New task" }, "POST");
assert.equal(routed[0], "/api/shared/2/7/tasks");
assert.equal(routed[1].method, "POST");
assert.equal(request("/api/projects/shared:2:7", { title: "Project" })[0], "/api/shared/2/7/projects/7");
assert.equal(request("/api/tasks/9", { project_id: "4" })[0], "/api/tasks/9");
evaluate('state.projects = [{id:1,title:"Private"}, {id:"shared:2:4", title:"Readonly",permission:"view",shared:true}, {id:"shared:3:5", title:"Editable",permission:"edit",shared:true}];');
let fields = evaluate('taskEditorFields({})');
assert.match(fields, /Editable/); assert.doesNotMatch(fields, /Readonly/);
fields = evaluate('taskEditorFields({id:2,project_id:1})');
assert.doesNotMatch(fields, /Editable|Readonly/);
fields = evaluate('taskEditorFields({id:"shared:3:5:9",shared:true,project_id:"shared:3:5"})');
assert.match(fields, /value="shared:3:5" selected/);
assert.doesNotMatch(fields, /Private|Readonly|未归类/);
evaluate('state.tasks = [{id:"shared:2:4:9",project_id:"shared:2:4",title:"Visible shared task",status:"todo",permission:"view",shared:true}]; state.selectedProjectId="shared:2:4"; renderProjectDetail();');
assert.match(element("#project-detail").innerHTML, /Visible shared task/);
assert.match(element("#project-detail").innerHTML, /仅查看/);
assert.doesNotMatch(element("#project-detail").innerHTML, /data-project-add|data-project-members/);
assert.match(element("#project-detail").innerHTML, /data-advance-task="shared:2:4:9" disabled/);
evaluate('state.authenticated=true; state.user={id:2,is_admin:0}; state.csrfToken="secret"; state.settings={display_name:"Alice"}; state.llmSettings={llm_model:"secret-model"}; state.researchItems=[{summary:"Private summary"}]; state.history=[{label:"Private history"}]; renderAll=()=>{}; clearAccountState();');
assert.equal(evaluate('state.user'), null);
assert.equal(evaluate('state.authenticated'), false);
assert.equal(evaluate('state.csrfToken'), "");
for (const key of ["projects", "tasks", "researchItems", "history", "calendarEvents"]) assert.equal(evaluate(`state.${key}.length`), 0);
assert.equal(evaluate('Object.keys(state.llmSettings).length'), 0);
console.log("PASS: shared identifiers and routing, private task associations, readonly controls and immediate account data clearing");
