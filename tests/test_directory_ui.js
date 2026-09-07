"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const elements = Object.fromEntries(
  ["#directory-filters", "#directory-search", "#directory-result-note", "#directory-groups"]
    .map((selector) => [selector, { value: "", innerHTML: "", textContent: "" }])
);
const context = vm.createContext({
  localStorage: { getItem: () => null },
  document: { querySelector: (selector) => elements[selector] },
  window: {},
});
const source = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");
assert.match(source, /\ninit\(\);\s*$/);
// Load the production renderers without starting browser event binding or network requests.
vm.runInContext(source.replace(/\ninit\(\);\s*$/, "\n"), context);
const evaluate = (code) => vm.runInContext(code, context);
const fields = (kind, record = {}) => evaluate(`editorFields(${JSON.stringify(kind)}, ${JSON.stringify(record)})`);
const specialName = 'Quotes "<&>';
evaluate(`state.directoryCategories = ${JSON.stringify(["Existing", "Empty", specialName])}`);
evaluate('state.directoryFilter = "Empty"');

let html = fields("directoryLinks");
assert.match(html, /<select name="category" required>/);
assert.doesNotMatch(html, /<input name="category"/);
assert.match(html, /<option value="Empty" selected>/);
assert.ok(html.includes('value="Quotes &quot;&lt;&amp;&gt;"'));
assert.ok(!html.includes(specialName));

html = fields("directoryLinks", { category: "Existing" });
assert.match(html, /<option value="Existing" selected>/);
assert.doesNotMatch(html, /<option value="Empty" selected>/);
assert.match(fields("directoryCategories"), /name="name" maxlength="30" required/);
assert.match(fields("links"), /<input name="category"/);
assert.equal(evaluate('endpointForKind("directoryCategories")'), "directory-categories");

evaluate("renderDirectory()");
assert.equal(evaluate("state.directoryFilter"), "Empty");
assert.ok(elements["#directory-filters"].innerHTML.includes('data-directory-filter="Empty"'));
assert.match(elements["#directory-filters"].innerHTML, /<strong>Empty<\/strong><span>0<\/span>/);
assert.match(elements["#directory-groups"].innerHTML, /data-lucide="folder-open"/);

evaluate('state.directoryLinks = [{ id: 1, title: "Example", url: "https://example.com", category: "Empty" }]');
evaluate("renderDirectory()");
assert.match(elements["#directory-filters"].innerHTML, /<strong>Empty<\/strong><span>1<\/span>/);
assert.match(elements["#directory-groups"].innerHTML, /class="directory-site"/);
assert.match(elements["#directory-groups"].innerHTML, />Example<\/strong>/);

evaluate('state.directoryFilter = "\u5168\u90e8"');
assert.doesNotMatch(fields("directoryLinks"), /<option[^>]* selected>/);
const page = fs.readFileSync(path.join(__dirname, "../static/index.html"), "utf8");
assert.match(page, /<button[^>]*auth-gated[^>]*data-action="add" data-kind="directoryCategories"/);

console.log("PASS: directory dropdown, default/edit selection, escaping, empty categories and category button");
