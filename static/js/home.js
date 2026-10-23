/* Start page: the three latest diagrams as cards with a preview, then the full list. */
(function () {
  "use strict";

  const { api, initMermaid } = window.Flow;
  const $ = (id) => document.getElementById(id);
  const ROLE_LABEL = { owner: "Besitzer", edit: "Bearbeiten", view: "Lesen" };
  const RECENT = 3;

  function editUrl(id) {
    return "edit?id=" + encodeURIComponent(id);
  }

  function date(iso) {
    return new Date(iso).toLocaleString("de-AT", { dateStyle: "medium", timeStyle: "short" });
  }

  /** Render one diagram into its card; render one at a time, mermaid is not re-entrant. */
  async function renderPreview(entry, box, n) {
    try {
      const d = await api("api/diagrams/" + entry.id);
      initMermaid(d.theme, d.look);
      const { svg } = await mermaid.render("home-preview-" + n, d.code);
      box.innerHTML = svg;
    } catch (e) {
      box.textContent = "Keine Vorschau";
      box.classList.add("no-preview");
      const leftover = document.getElementById("dhome-preview-" + n);
      if (leftover) leftover.remove();
    }
  }

  function card(entry) {
    const a = document.createElement("a");
    a.className = "card recent-card";
    a.href = editUrl(entry.id);
    const preview = document.createElement("div");
    preview.className = "recent-preview";
    const name = document.createElement("div");
    name.className = "recent-name";
    name.textContent = entry.name;
    const meta = document.createElement("div");
    meta.className = "muted";
    meta.textContent = (entry.role === "owner" ? "" : entry.owner + " · " + ROLE_LABEL[entry.role] + " · ")
      + date(entry.updated);
    a.append(preview, name, meta);
    return { el: a, preview };
  }

  function row(entry) {
    const tr = document.createElement("tr");
    const nameCell = document.createElement("td");
    const link = document.createElement("a");
    link.href = editUrl(entry.id);
    link.textContent = entry.name;
    nameCell.appendChild(link);
    tr.appendChild(nameCell);
    [entry.owner, ROLE_LABEL[entry.role], date(entry.updated)].forEach((text) => {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    });
    return tr;
  }

  async function start() {
    const me = await api("api/me");
    $("user-name").textContent = me.username;
    $("admin-link").hidden = !me.is_admin;

    const all = await api("api/diagrams"); // newest first
    $("empty").hidden = all.length > 0;
    $("all-section").hidden = all.length <= RECENT;
    all.forEach((entry) => $("all-rows").appendChild(row(entry)));

    const cards = all.slice(0, RECENT).map(card);
    cards.forEach((c) => $("recent").appendChild(c.el));
    for (let i = 0; i < cards.length; i++) {
      await renderPreview(all[i], cards[i].preview, i);
    }
  }

  $("btn-logout").addEventListener("click", async () => {
    await api("api/logout", "POST", {}).catch(() => null);
    try {
      localStorage.removeItem("flow.current");
    } catch (e) { /* storage blocked */ }
    location.href = "login";
  });

  start().catch(() => { /* api() already redirected to login on 401 */ });
})();
