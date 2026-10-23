/*
 * Flow – a small, self-hosted diagram editor.
 *
 * Text on the left, live preview on the right. Rendering is done by the
 * open-source mermaid library (MIT, vendored in vendor/mermaid/). Everything
 * else – UI, storage, export, share links – is this app's own code.
 * Nothing leaves the browser: drafts and saved diagrams live in localStorage.
 */
(function () {
  "use strict";

  const STORE_CURRENT = "flow.current";
  const STORE_SAVED = "flow.saved";
  const RENDER_DELAY_MS = 300;

  const $ = (id) => document.getElementById(id);
  const codeEl = $("code");
  const errorEl = $("error");
  const previewEl = $("preview");
  const viewportEl = $("viewport");
  const themeEl = $("theme");
  const lookEl = $("look");
  const exampleEl = $("example");
  const titleEl = $("title");

  // The diagram being edited. id/name are set once it was saved.
  let doc = { id: null, name: "", code: "", theme: "default", look: "classic" };
  let renderSeq = 0;
  let renderTimer = null;
  let zoom = null; // null = fit to viewport

  // ---------- storage (localStorage can be blocked, so never trust it) ----------

  function readStore(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeStore(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------- share links: diagram compressed into the URL fragment ----------

  async function encodeShare(data) {
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    const packed = new Uint8Array(await new Response(stream).arrayBuffer());
    let bin = "";
    packed.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function decodeShare(text) {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return JSON.parse(await new Response(stream).text());
  }

  // ---------- rendering ----------

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, RENDER_DELAY_MS);
  }

  async function render() {
    const seq = ++renderSeq;
    const code = doc.code;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: doc.theme,
      look: doc.look,
    });

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

  /** Natural size of the rendered diagram, taken from its viewBox. */
  function svgSize(svg) {
    const vb = svg.viewBox && svg.viewBox.baseVal;
    if (vb && vb.width) return { w: vb.width, h: vb.height };
    const box = svg.getBoundingClientRect();
    return { w: box.width, h: box.height };
  }

  function applyZoom() {
    const svg = currentSvg();
    if (!svg) return;
    const { w, h } = svgSize(svg);
    let scale = zoom;
    if (scale === null) {
      const pad = 32;
      scale = Math.min((viewportEl.clientWidth - pad) / w, (viewportEl.clientHeight - pad) / h, 1.5);
      scale = Math.max(scale, 0.1);
    }
    svg.style.width = Math.round(w * scale) + "px";
    svg.style.height = Math.round(h * scale) + "px";
    svg.style.maxWidth = "none";
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

  // ---------- saved diagrams ----------

  function saveDiagram() {
    let name = doc.name;
    if (!doc.id) {
      name = window.prompt("Name des Diagramms:", name || "Neues Diagramm");
      if (!name) return;
    }
    const saved = readStore(STORE_SAVED, []);
    const entry = {
      id: doc.id || String(Date.now()),
      name: name.trim(),
      code: doc.code,
      theme: doc.theme,
      look: doc.look,
      updated: new Date().toISOString(),
    };
    const idx = saved.findIndex((s) => s.id === entry.id);
    if (idx >= 0) saved[idx] = entry; else saved.unshift(entry);
    if (!writeStore(STORE_SAVED, saved)) return toast("Speichern im Browser nicht möglich.");
    doc.id = entry.id;
    doc.name = entry.name;
    persistCurrent();
    updateTitle();
    toast("Gespeichert: " + entry.name);
  }

  function openDialog() {
    const list = $("saved-list");
    list.innerHTML = "";
    const saved = readStore(STORE_SAVED, []);
    if (!saved.length) {
      const li = document.createElement("li");
      li.textContent = "Noch nichts gespeichert.";
      list.appendChild(li);
    }
    saved.forEach((entry) => {
      const li = document.createElement("li");
      const open = document.createElement("button");
      open.className = "name";
      open.textContent = entry.name;
      open.addEventListener("click", () => {
        loadDoc({ ...entry });
        $("dlg-open").close();
      });
      const date = document.createElement("span");
      date.className = "date";
      date.textContent = new Date(entry.updated).toLocaleDateString("de-AT");
      const del = document.createElement("button");
      del.textContent = "Löschen";
      del.addEventListener("click", () => {
        if (!window.confirm("„" + entry.name + "“ löschen?")) return;
        writeStore(STORE_SAVED, readStore(STORE_SAVED, []).filter((s) => s.id !== entry.id));
        if (doc.id === entry.id) { doc.id = null; persistCurrent(); updateTitle(); }
        openDialog();
      });
      li.append(open, date, del);
      list.appendChild(li);
    });
    if (!$("dlg-open").open) $("dlg-open").showModal();
  }

  async function copyShareLink() {
    try {
      const packed = await encodeShare({ c: doc.code, t: doc.theme, l: doc.look });
      const url = location.href.split("#")[0] + "#d=" + packed;
      await navigator.clipboard.writeText(url);
      toast("Link in die Zwischenablage kopiert.");
    } catch (e) {
      toast("Link konnte nicht kopiert werden.");
    }
  }

  // ---------- state ----------

  function loadDoc(next) {
    doc = { id: null, name: "", theme: "default", look: "classic", ...next };
    codeEl.value = doc.code;
    themeEl.value = doc.theme;
    lookEl.value = doc.look;
    zoom = null;
    updateTitle();
    persistCurrent();
    render();
  }

  function persistCurrent() {
    writeStore(STORE_CURRENT, doc);
  }

  function updateTitle() {
    titleEl.textContent = doc.id ? doc.name : "";
  }

  let toastTimer = null;
  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
  }

  // ---------- wiring ----------

  function bindEvents() {
    codeEl.addEventListener("input", () => {
      doc.code = codeEl.value;
      persistCurrent();
      scheduleRender();
    });

    // Tab inserts spaces instead of leaving the editor.
    codeEl.addEventListener("keydown", (e) => {
      if (e.key !== "Tab" || e.shiftKey) return;
      e.preventDefault();
      const { selectionStart: s, selectionEnd: end } = codeEl;
      codeEl.setRangeText("    ", s, end, "end");
      codeEl.dispatchEvent(new Event("input"));
    });

    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveDiagram();
      }
    });

    themeEl.addEventListener("change", () => { doc.theme = themeEl.value; persistCurrent(); render(); });
    lookEl.addEventListener("change", () => { doc.look = lookEl.value; persistCurrent(); render(); });

    exampleEl.addEventListener("change", () => {
      const ex = window.FLOW_EXAMPLES[exampleEl.value];
      exampleEl.value = "";
      if (!ex) return;
      if (doc.code.trim() && !window.confirm("Aktuellen Code durch die Vorlage ersetzen?")) return;
      loadDoc({ code: ex.code, theme: doc.theme, look: doc.look });
    });

    $("btn-save").addEventListener("click", saveDiagram);
    $("btn-open").addEventListener("click", openDialog);
    $("btn-share").addEventListener("click", copyShareLink);
    $("btn-svg").addEventListener("click", exportSvg);
    $("btn-png").addEventListener("click", exportPng);
    $("zoom-in").addEventListener("click", () => changeZoom(1.25));
    $("zoom-out").addEventListener("click", () => changeZoom(0.8));
    $("zoom-fit").addEventListener("click", () => { zoom = null; applyZoom(); });

    window.addEventListener("resize", () => { if (zoom === null) applyZoom(); });
  }

  function fillExamples() {
    const placeholder = new Option("Vorlage wählen …", "");
    exampleEl.add(placeholder);
    window.FLOW_EXAMPLES.forEach((ex, i) => exampleEl.add(new Option(ex.name, String(i))));
  }

  async function start() {
    fillExamples();
    bindEvents();

    // Priority: share link in the URL > last draft > first template.
    const match = location.hash.match(/^#d=(.+)$/);
    if (match) {
      try {
        const data = await decodeShare(match[1]);
        history.replaceState(null, "", location.pathname + location.search);
        loadDoc({ code: data.c || "", theme: data.t || "default", look: data.l || "classic" });
        return;
      } catch (e) {
        toast("Der Link ist ungültig.");
      }
    }
    const draft = readStore(STORE_CURRENT, null);
    if (draft && typeof draft.code === "string") {
      loadDoc(draft);
    } else {
      loadDoc({ code: window.FLOW_EXAMPLES[0].code });
    }
  }

  start();
})();
