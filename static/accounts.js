"use strict";

let memberProjectId = null;

function renderAccount() {
  $("#account-identity").textContent = state.user ? `${state.user.username} · ${state.user.is_admin ? "管理员" : "成员"}` : "";
  $("#account-admin").hidden = !state.user?.is_admin;
}

async function refreshAccounts() {
  if (!state.user?.is_admin) return;
  const users = await api("/api/accounts");
  $("#account-list").innerHTML = users.map((user) => `<div class="settings-section"><div class="row-actions"><strong>${escapeHtml(user.username)}</strong><span>${user.enabled ? "已启用" : "已停用"}</span>${user.is_admin ? "" : `<button class="secondary-button" type="button" data-account-toggle="${user.id}" data-enabled="${user.enabled ? "false" : "true"}">${user.enabled ? "停用" : "启用"}</button>`}</div><form class="settings-form" data-account-reset="${user.id}"><label class="field"><span>重置密码（会退出该账户所有设备）</span><input name="password" type="password" minlength="10" maxlength="256" autocomplete="new-password" required></label><button class="secondary-button" type="submit">重置密码</button></form></div>`).join("");
}

function renderMembers(members) {
  $("#member-list").innerHTML = members.length ? members.map((member) => `<p>${escapeHtml(member.username)} · ${member.permission === "edit" ? "可编辑" : "仅查看"}${member.enabled ? "" : " · 已停用"}</p>`).join("") : '<p class="muted">项目目前仅自己可见。</p>';
}

function bindAccounts() {
  $("#refresh-accounts").addEventListener("click", () => refreshAccounts().catch((error) => toast(error.message, true)));
  $("#create-account-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button"); button.disabled = true;
    try {
      await api("/api/accounts", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset(); await refreshAccounts(); toast("账户已创建");
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });
  $("#password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/password", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      clearAccountState(); showLogin(); toast("密码已更新，请重新登录");
    } catch (error) { toast(error.message, true); }
  });
  $("#account-list").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-account-toggle]");
    if (!button) return;
    button.disabled = true;
    try {
      await api(`/api/accounts/${button.dataset.accountToggle}`, { method: "POST", body: JSON.stringify({ enabled: button.dataset.enabled === "true" }) });
      await refreshAccounts(); toast("账户状态已更新");
    } catch (error) { toast(error.message, true); button.disabled = false; }
  });
  $("#account-list").addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-account-reset]");
    if (!form) return;
    event.preventDefault();
    try {
      await api(`/api/accounts/${form.dataset.accountReset}`, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset();
      if (Number(form.dataset.accountReset) === state.user.id) { clearAccountState(); showLogin(); }
      toast("密码已重置，原会话已退出");
    } catch (error) { toast(error.message, true); }
  });
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-project-members]");
    if (!button) return;
    try {
      memberProjectId = Number(button.dataset.projectMembers);
      renderMembers(await api(`/api/projects/${memberProjectId}/members`));
      $("#member-form").reset(); $("#members-modal").showModal();
    } catch (error) { toast(error.message, true); }
  });
  $("#member-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button"); button.disabled = true;
    try {
      renderMembers(await api(`/api/projects/${memberProjectId}/members`, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }));
      event.target.reset(); toast("成员权限已更新");
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });
}
