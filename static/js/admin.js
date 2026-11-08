// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Janne Cadamuro / LabMed Alliance Inc. — see LICENSE and NOTICE
/* Admin page: create users, reset passwords, delete users. */
(function () {
  "use strict";

  const { api, toast } = window.Flow;
  const $ = (id) => document.getElementById(id);
  let me = null;

  function render(users) {
    const body = $("user-rows");
    body.innerHTML = "";
    users.forEach((u) => {
      const tr = document.createElement("tr");
      const cells = [u.username, u.is_admin ? "Admin" : "Benutzer", String(u.diagrams),
        new Date(u.created).toLocaleDateString("de-AT")];
      cells.forEach((text) => {
        const td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      });
      const actions = document.createElement("td");
      actions.className = "actions";
      const reset = document.createElement("button");
      reset.textContent = "Passwort setzen";
      reset.addEventListener("click", () => resetPassword(u));
      actions.appendChild(reset);
      if (u.id !== me.id) {
        const del = document.createElement("button");
        del.textContent = "Löschen";
        del.addEventListener("click", () => removeUser(u));
        actions.appendChild(del);
      }
      tr.appendChild(actions);
      body.appendChild(tr);
    });
  }

  async function load() {
    render(await api("api/admin/users"));
  }

  async function resetPassword(u) {
    const pw = window.prompt("Neues Passwort für " + u.username + " (mind. 10 Zeichen):");
    if (!pw) return;
    try {
      await api("api/admin/users/" + u.id + "/password", "PUT", { password: pw });
      toast("Passwort gesetzt. " + u.username + " ist überall abgemeldet.");
    } catch (e) {
      toast(e.message);
    }
  }

  async function removeUser(u) {
    const msg = "„" + u.username + "“ löschen? Damit verschwinden auch " + u.diagrams + " eigene Diagramme.";
    if (!window.confirm(msg)) return;
    try {
      await api("api/admin/users/" + u.id, "DELETE");
      await load();
    } catch (e) {
      toast(e.message);
    }
  }

  $("create-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      render(await api("api/admin/users", "POST", {
        username: $("new-username").value,
        password: $("new-password").value,
        is_admin: $("new-admin").checked,
      }));
      toast("Benutzer angelegt.");
      $("create-form").reset();
    } catch (e) {
      toast(e.message);
    }
  });

  (async function start() {
    me = await api("api/me");
    if (!me.is_admin) {
      location.href = "./";
      return;
    }
    await load();
  })();
})();
