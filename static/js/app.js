/*
 * Flow – editor page.
 *
 * Text on the left, live preview on the right. Rendering is done by the
 * open-source mermaid library (MIT, vendored in vendor/mermaid/). Everything
 * else – UI, storage, sharing, export – is this app's own code.
 * Diagrams live on the server (see app.py); the unsaved draft is kept in
 * localStorage so a reload loses nothing.
 */
(function () {
  "use strict";

  const { api, toast, svgSize, sizeSvg, initMermaid } = window.Flow;
  const STORE_CURRENT = "flow.current";
  const API = "api/diagrams";
  const RENDER_DELAY_MS = 300;
  const ROLE_LABEL = { owner: "Besitzer", edit: "Bearbeiten", view: "Lesen" };

  const $ = (id) => document.getElementById(id);
  const codeEl = $("code");
  const errorEl = $("error");
  const previewEl = $("preview");
  const viewportEl = $("viewport");
  const themeEl = $("theme");
  const lookEl = $("look");
  const exampleEl = $("example");
  const titleEl = $("title");

  // The diagram being edited. id is null until it was saved once.
  let doc = blankDoc();
  let me = null;
  let renderSeq = 0;
  let renderTimer = null;
  let zoom = null; // null = fit to viewport

  function blankDoc(fields) {
    return {
      id: null, name: "", code: "", theme: "default", look: "classic",
      version: null, role: "owner", owner: null, dirty: false, ...fields,
    };
  }

  // ---------- draft in the browser (localStorage can be blocked) ----------

  function readDraft() {
    try {
      return JSON.parse(localStorage.getItem(STORE_CURRENT) || "null");
    } catch (e) {
      return null;
    }
  }

  function persistDraft() {
    try {
      localStorage.setItem(STORE_CURRENT, JSON.stringify({ ...doc, user: me && me.id }));
    } catch (e) { /* draft is a convenience only */ }
  }

  // ---------- rendering ----------

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, RENDER_DELAY_MS);
  }

  async function render() {
    const seq = ++renderSeq;
    const code = doc.code;
    initMermaid(doc.theme, doc.look);

    if (!code.trim()) {
      previewEl.innerHTML = "";
      showError("");
      return;
    }
    try {
      await mermaid.parse(code);
      const { svg } = await mermaid.render("flow-svg-" + seq, code);
      if (seq !== renderSeq) return; // a newer render has started meanwhile
      previewEl.innerHTML = svg;
      previewEl.classList.remove("stale");
      showError("");
      applyZoom();
    } catch (err) {
      if (seq !== renderSeq) return;
      // Keep the last good diagram visible, but dimmed.
      previewEl.classList.add("stale");
      showError(String((err && err.message) || err));
    } finally {
      // mermaid leaves a temporary container behind when rendering fails
      const leftover = document.getElementById("dflow-svg-" + seq);
      if (leftover) leftover.remove();
    }
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = !message;
  }

  function currentSvg() {
    return previewEl.querySelector("svg");
  }

  function applyZoom() {
    const svg = currentSvg();
    if (svg) sizeSvg(svg, viewportEl, zoom);
  }

  function changeZoom(factor) {
    const svg = currentSvg();
    if (!svg) return;
    const current = parseFloat(svg.style.width) / svgSize(svg).w || 1;
    zoom = Math.min(Math.max(current * factor, 0.1), 8);
    applyZoom();
  }

  // ---------- export ----------

  function fileBase() {
    return (doc.name || "diagramm").replace(/[^\wäöüÄÖÜß.-]+/g, "_");
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** The diagram as standalone SVG markup at its natural size. */
  function svgMarkup() {
    const svg = currentSvg();
    if (!svg) return null;
    const clone = svg.cloneNode(true);
    const { w, h } = svgSize(svg);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", w);
    clone.setAttribute("height", h);
    clone.removeAttribute("style");
    return new XMLSerializer().serializeToString(clone);
  }

  function exportSvg() {
    const markup = svgMarkup();
    if (!markup) return toast("Kein Diagramm zum Exportieren.");
    download(new Blob([markup], { type: "image/svg+xml" }), fileBase() + ".svg");
  }

  function exportPng() {
    const markup = svgMarkup();
    if (!markup) return toast("Kein Diagramm zum Exportieren.");
    const { w, h } = svgSize(currentSvg());
    const scale = 2; // sharp on high-DPI screens and in documents
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(w * scale);
      canvas.height = Math.ceil(h * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = doc.theme === "dark" ? "#333333" : "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      try {
        canvas.toBlob((blob) => download(blob, fileBase() + ".png"), "image/png");
      } catch (e) {
        toast("PNG-Export hat der Browser blockiert – bitte SVG nutzen.");
      }
    };
    img.onerror = () => toast("PNG-Export fehlgeschlagen.");
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
  }

  // ---------- saving ----------

  function payload(extra) {
    return { name: doc.name, code: doc.code, theme: doc.theme, look: doc.look, ...extra };
  }

  function applyServer(d, keepEdits) {
    const fields = { id: d.id, name: d.name, version: d.version, role: d.role, owner: d.owner };
    if (keepEdits) {
      Object.assign(doc, fields);
    } else {
      loadDoc({ ...fields, code: d.code, theme: d.theme, look: d.look });
    }
  }

  async function save() {
    if (!doc.id) return saveCopy();
    if (doc.role === "view") return toast("Nur lesend freigegeben – nutze „Speichern unter …“.");
    try {
      const d = await api(API + "/" + doc.id, "PUT", payload({ version: doc.version }));
      applyServer(d, true);
      doc.dirty = false;
      afterSave();
    } catch (e) {
      if (e.status === 409) return showConflict(e.data.current);
      toast("Speichern fehlgeschlagen: " + e.message);
    }
  }

  /** Save as a new diagram owned by me (also for read-only diagrams). */
  async function saveCopy() {
    const suggestion = doc.id ? doc.name + " (Kopie)" : doc.name || "Neues Diagramm";
    const name = window.prompt("Name des Diagramms:", suggestion);
    if (!name || !name.trim()) return;
    try {
      const d = await api(API, "POST", payload({ name: name.trim() }));
      applyServer(d, true);
      doc.dirty = false;
      afterSave();
    } catch (e) {
      toast("Speichern fehlgeschlagen: " + e.message);
    }
  }

  function afterSave() {
    persistDraft();
    updateUi();
    toast("Gespeichert: " + doc.name);
  }

  function showConflict(current) {
    const when = new Date(current.updated).toLocaleString("de-AT");
    $("conflict-text").textContent =
      (current.updated_by || "Jemand") + " hat das Diagramm am " + when + " gespeichert, während du es bearbeitet hast.";
    const dlg = $("dlg-conflict");
    $("conflict-overwrite").onclick = async () => {
      dlg.close();
      doc.version = current.version;
      await save();
    };
    $("conflict-load").onclick = () => {
      dlg.close();
      applyServer(current, false);
    };
    $("conflict-copy").onclick = () => {
      dlg.close();
      saveCopy();
    };
    dlg.showModal();
  }

  async function openSaved(id) {
    try {
      applyServer(await api(API + "/" + id), false);
      return true;
    } catch (e) {
      toast(e.message);
      return false;
    }
  }

  // ---------- open dialog ----------

  function listItem(entry, showOwner) {
    const li = document.createElement("li");
    const open = document.createElement("button");
    open.className = "name";
    open.textContent = entry.name;
    open.addEventListener("click", async () => {
      if (!confirmDiscard()) return;
      if (await openSaved(entry.id)) $("dlg-open").close();
    });
    const meta = document.createElement("span");
    meta.className = "date";
    meta.textContent = (showOwner ? entry.owner + " · " + ROLE_LABEL[entry.role] + " · " : "")
      + new Date(entry.updated).toLocaleDateString("de-AT");
    li.append(open, meta);
    if (entry.role === "owner") {
      const del = document.createElement("button");
      del.textContent = "Löschen";
      del.addEventListener("click", async () => {
        if (!window.confirm("„" + entry.name + "“ löschen? Das gilt auch für alle, mit denen du es teilst.")) return;
        try {
          await api(API + "/" + entry.id, "DELETE");
        } catch (e) {
          return toast(e.message);
        }
        if (doc.id === entry.id) { doc.id = null; doc.version = null; doc.role = "owner"; doc.dirty = true; updateUi(); }
        openDialog();
      });
      li.append(del);
    }
    return li;
  }

  function fillList(el, entries, showOwner) {
    el.innerHTML = "";
    if (!entries.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "Keine.";
      el.appendChild(li);
    }
    entries.forEach((e) => el.appendChild(listItem(e, showOwner)));
  }

  async function openDialog() {
    let all;
    try {
      all = await api(API);
    } catch (e) {
      return toast(e.message);
    }
    fillList($("list-own"), all.filter((d) => d.role === "owner"), false);
    fillList($("list-shared"), all.filter((d) => d.role !== "owner"), true);
    if (!$("dlg-open").open) $("dlg-open").showModal();
  }

  // ---------- share dialog ----------

  function publicUrl(token) {
    return new URL("v/" + token, document.baseURI).href;
  }

  function showPublic(token) {
    $("public-on").hidden = !token;
    $("public-off").hidden = !!token;
    $("public-url").value = token ? publicUrl(token) : "";
  }

  function fillAccess(entries, users) {
    const list = $("access-list");
    list.innerHTML = "";
    if (!entries.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "Noch mit niemandem geteilt.";
      list.appendChild(li);
    }
    entries.forEach((a) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = a.username;
      const role = document.createElement("select");
      role.add(new Option("Lesen", "view"));
      role.add(new Option("Bearbeiten", "edit"));
      role.value = a.role;
      role.addEventListener("change", () => changeAccess(a.user_id, role.value, users));
      const del = document.createElement("button");
      del.textContent = "Entfernen";
      del.addEventListener("click", () => changeAccess(a.user_id, null, users));
      li.append(name, role, del);
      list.appendChild(li);
    });
    const taken = new Set(entries.map((a) => a.user_id));
    const sel = $("share-user");
    sel.innerHTML = "";
    users.filter((u) => !taken.has(u.id)).forEach((u) => sel.add(new Option(u.username, String(u.id))));
    $("share-add-row").hidden = sel.options.length === 0;
  }

  async function changeAccess(userId, role, users) {
    const path = API + "/" + doc.id + "/access/" + userId;
    try {
      const entries = role ? await api(path, "PUT", { role }) : await api(path, "DELETE");
      fillAccess(entries, users);
    } catch (e) {
      toast(e.message);
    }
  }

  async function openShare() {
    if (!doc.id) return toast("Bitte zuerst speichern.");
    if (doc.role !== "owner") return toast("Nur " + (doc.owner || "der Besitzer") + " kann dieses Diagramm teilen.");
    if (doc.dirty) toast("Hinweis: Geteilt wird die zuletzt gespeicherte Fassung.");
    try {
      const [entries, users, d] = await Promise.all([
        api(API + "/" + doc.id + "/access"), api("api/users"), api(API + "/" + doc.id),
      ]);
      fillAccess(entries, users);
      showPublic(d.public_token);
      $("share-add").onclick = () => changeAccess(Number($("share-user").value), $("share-role").value, users);
      $("dlg-share").showModal();
    } catch (e) {
      toast(e.message);
    }
  }

  async function createPublic() {
    try {
      showPublic((await api(API + "/" + doc.id + "/public", "POST", {})).public_token);
    } catch (e) {
      toast(e.message);
    }
  }

  async function revokePublic() {
    if (!window.confirm("Link deaktivieren? Wer ihn hat, sieht das Diagramm dann nicht mehr.")) return;
    try {
      await api(API + "/" + doc.id + "/public", "DELETE");
      showPublic(null);
    } catch (e) {
      toast(e.message);
    }
  }

  async function copyPublic() {
    try {
      await navigator.clipboard.writeText($("public-url").value);
      toast("Link kopiert.");
    } catch (e) {
      $("public-url").select();
    }
  }

  // ---------- user menu ----------

  async function changePassword(ev) {
    ev.preventDefault();
    try {
      await api("api/me/password", "PUT", { old: $("pw-old").value, new: $("pw-new").value });
      $("pw-form").reset();
      $("dlg-user").close();
      toast("Passwort geändert. Andere Sitzungen sind abgemeldet.");
    } catch (e) {
      toast(e.message);
    }
  }

  async function logout() {
    if (!confirmDiscard()) return;
    await api("api/logout", "POST", {}).catch(() => null);
    try {
      localStorage.removeItem(STORE_CURRENT); // no diagram content left on shared computers
    } catch (e) { /* storage blocked – nothing stored either */ }
    location.href = "login";
  }

  // ---------- state ----------

  function confirmDiscard() {
    return !doc.dirty || !doc.code.trim() || window.confirm("Ungespeicherte Änderungen verwerfen?");
  }

  function loadDoc(fields) {
    doc = blankDoc(fields);
    codeEl.value = doc.code;
    themeEl.value = doc.theme;
    lookEl.value = doc.look;
    zoom = null;
    updateUi();
    persistDraft();
    render();
  }

  /** Mark the diagram as changed and keep the draft safe in the browser. */
  function touch() {
    doc.dirty = true;
    persistDraft();
    updateUi();
  }

  /** Title, read-only state and URL (?id=… reopens a saved diagram later). */
  function updateUi() {
    const readOnly = doc.role === "view";
    codeEl.readOnly = readOnly;
    themeEl.disabled = lookEl.disabled = readOnly;
    $("btn-save").disabled = readOnly;
    $("btn-share").disabled = !!doc.id && doc.role !== "owner";

    const name = doc.id ? doc.name : "Neues Diagramm";
    let label = name;
    if (doc.id && doc.role !== "owner") label += " (" + doc.owner + ", " + ROLE_LABEL[doc.role].toLowerCase() + ")";
    titleEl.textContent = label + (doc.dirty ? " •" : "");
    document.title = name + " – Flow";
    const url = location.pathname + (doc.id ? "?id=" + doc.id : "");
    if (url !== location.pathname + location.search) history.replaceState(null, "", url);
  }

  // ---------- wiring ----------

  function bindEvents() {
    codeEl.addEventListener("input", () => {
      doc.code = codeEl.value;
      touch();
      scheduleRender();
    });

    // Tab inserts spaces instead of leaving the editor.
    codeEl.addEventListener("keydown", (e) => {
      if (e.key !== "Tab" || e.shiftKey || codeEl.readOnly) return;
      e.preventDefault();
      codeEl.setRangeText("    ", codeEl.selectionStart, codeEl.selectionEnd, "end");
      codeEl.dispatchEvent(new Event("input"));
    });

    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    });

    window.addEventListener("beforeunload", (e) => {
      if (doc.dirty && doc.id && doc.role !== "view") e.preventDefault();
    });

    themeEl.addEventListener("change", () => { doc.theme = themeEl.value; touch(); render(); });
    lookEl.addEventListener("change", () => { doc.look = lookEl.value; touch(); render(); });

    exampleEl.addEventListener("change", () => {
      const ex = window.FLOW_EXAMPLES[exampleEl.value];
      exampleEl.value = "";
      if (!ex || !confirmDiscard()) return;
      loadDoc({ code: ex.code, theme: doc.theme, look: doc.look, dirty: true });
    });

    $("btn-new").addEventListener("click", () => {
      if (!confirmDiscard()) return;
      loadDoc({ theme: doc.theme, look: doc.look });
      codeEl.focus();
    });
    $("btn-open").addEventListener("click", openDialog);
    $("btn-save").addEventListener("click", save);
    $("btn-copy").addEventListener("click", saveCopy);
    $("btn-share").addEventListener("click", openShare);
    $("btn-svg").addEventListener("click", exportSvg);
    $("btn-png").addEventListener("click", exportPng);
    $("zoom-in").addEventListener("click", () => changeZoom(1.25));
    $("zoom-out").addEventListener("click", () => changeZoom(0.8));
    $("zoom-fit").addEventListener("click", () => { zoom = null; applyZoom(); });
    $("public-create").addEventListener("click", createPublic);
    $("public-revoke").addEventListener("click", revokePublic);
    $("public-copy").addEventListener("click", copyPublic);
    $("btn-user").addEventListener("click", () => $("dlg-user").showModal());
    $("pw-form").addEventListener("submit", changePassword);
    $("btn-logout").addEventListener("click", logout);

    window.addEventListener("resize", () => { if (zoom === null) applyZoom(); });
  }

  function fillExamples() {
    exampleEl.add(new Option("Vorlage wählen …", ""));
    window.FLOW_EXAMPLES.forEach((ex, i) => exampleEl.add(new Option(ex.name, String(i))));
  }

  async function start() {
    try {
      me = await api("api/me");
    } catch (e) {
      return; // api() already redirects to the login page
    }
    $("btn-user").textContent = me.username;
    $("user-name").textContent = me.username;
    $("pw-user").value = me.username; // lets password managers match the account
    $("admin-link").hidden = !me.is_admin;
    fillExamples();
    bindEvents();

    // Priority: ?new=1 (blank) > ?id= (saved diagram) > last draft of this user > first template.
    let draft = readDraft();
    if (draft && draft.user !== me.id) draft = null; // never show another user's draft
    const params = new URLSearchParams(location.search);
    if (params.get("new")) {
      let example = null; // "Ausprobieren" on the help page hands its code over once
      if (params.get("from") === "help") {
        try {
          example = sessionStorage.getItem("flow.handoff");
          sessionStorage.removeItem("flow.handoff");
        } catch (e) { /* storage blocked – start blank */ }
      }
      const keepDraft = draft && draft.dirty && draft.code.trim()
        && !window.confirm("Es gibt einen ungespeicherten Entwurf. Verwerfen und neu beginnen?");
      if (keepDraft) return loadDoc(draft);
      return loadDoc(example ? { code: example, dirty: true } : {});
    }
    const idParam = params.get("id");
    if (idParam) {
      // An unsaved draft of this very diagram wins over the server copy.
      if (draft && String(draft.id) === idParam && draft.dirty) return loadDoc(draft);
      if (await openSaved(idParam)) return;
    }
    if (draft && typeof draft.code === "string") return loadDoc(draft);
    loadDoc({ code: window.FLOW_EXAMPLES[0].code });
  }

  start();
})();
