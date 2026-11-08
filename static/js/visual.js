// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Janne Cadamuro / LabMed Alliance Inc. — see LICENSE and NOTICE
/*
 * Flow – edit flowcharts with the mouse.
 *
 * Every action is turned into a small text change by FlowEdit (flowedit.js) and
 * written back through FlowApp.setCode – the Mermaid code stays the only source.
 * Before applying, the new code is checked with Mermaid's parser; invalid results
 * are never applied.
 */
(function () {
  "use strict";

  const F = window.FlowEdit;
  const App = window.FlowApp;
  const { toast } = window.Flow;
  const $ = (id) => document.getElementById(id);

  const viewport = $("viewport");
  const preview = $("preview");
  const bar = $("visual-bar");
  const hint = $("visual-hint");
  const inspector = $("inspector");
  const handle = $("handle");
  const dragLine = $("drag-line");
  const codeEl = $("code");

  const SWATCHES = {
    fill: ["#d1fae5", "#fee2e2", "#fef3c7", "#dbeafe", "#ede9fe", "#f3f4f6", "#ffffff"],
    stroke: ["#059669", "#dc2626", "#d97706", "#2563eb", "#7c3aed", "#6b7280", "#111827"],
    color: ["#064e3b", "#7f1d1d", "#78350f", "#1e3a8a", "#111827", "#ffffff"],
  };
  const SWATCH_NAMES = {
    "#d1fae5": "grün", "#fee2e2": "rot", "#fef3c7": "gelb", "#dbeafe": "blau", "#ede9fe": "violett",
    "#f3f4f6": "grau", "#ffffff": "weiß", "#059669": "grün", "#dc2626": "rot", "#d97706": "orange",
    "#2563eb": "blau", "#7c3aed": "violett", "#6b7280": "grau", "#111827": "schwarz", "#064e3b": "dunkelgrün",
    "#7f1d1d": "dunkelrot", "#78350f": "braun", "#1e3a8a": "dunkelblau",
  };

  let active = false; // flowchart + editable + valid render
  let model = null; // { nodes: Map(id → {text, shape, styles}), edges: [{from,to,text,kind,color}] }
  let selection = null; // { type: "node", id } | { type: "edge", index }
  let connectFrom = null; // "Pfeil zu …" mode
  let history = [];
  let future = [];
  let lastStable = null;
  let typingTimer = null;
  let inspectorShown = false;
  let ready = Promise.resolve(); // resolves once the latest render is read and decorated

  // ---------- reading the diagram ----------

  /** Mermaid keeps entities encoded in parsed labels; turn them back into text. */
  function decodeLabel(text) {
    const named = { quot: '"', amp: "&", lt: "<", gt: ">", nbsp: " " };
    return String(text || "")
      .replace(/ﬂ°°(\d+)¶ß/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/ﬂ°(\w+)¶ß/g, (_, n) => named[n] || "#" + n + ";")
      .replace(/#quot;/g, '"')
      .replace(/<br\s*\/?>/gi, "\n");
  }

  function parseStyles(list) {
    const props = {};
    (list || []).forEach((s) => {
      const k = s.indexOf(":");
      if (k > 0) props[s.slice(0, k).trim()] = s.slice(k + 1).trim().replace(/;$/, "");
    });
    return props;
  }

  function edgeKind(e) {
    if (e.stroke === "dotted") return "dotted";
    if (e.stroke === "thick") return "thick";
    return e.type === "arrow_open" ? "line" : "arrow";
  }

  function edgeColors(code) {
    const colors = {};
    code.split("\n").forEach((l) => {
      const m = l.match(/^\s*linkStyle\s+(\d+)\s+(.*)$/);
      if (m) colors[Number(m[1])] = parseStyles(m[2].split(",")).stroke || null;
    });
    return colors;
  }

  async function readModel(code) {
    const d = await mermaid.mermaidAPI.getDiagramFromText(code);
    const v = d.db.getVertices();
    const nodes = new Map();
    for (const x of v instanceof Map ? v.values() : Object.values(v)) {
      nodes.set(x.id, { text: decodeLabel(x.text), shape: F.shapeFromParserType(x.type), styles: parseStyles(x.styles) });
    }
    const colors = edgeColors(code);
    const edges = d.db.getEdges().map((e, i) => ({
      from: e.start, to: e.end, text: decodeLabel(e.text), kind: edgeKind(e), color: colors[i] || null,
    }));
    // Edge actions work by number: only allowed if FlowEdit counts the arrows exactly like Mermaid.
    let trusted = false;
    try {
      const own = F.scan(code).edges;
      trusted = own.length === edges.length && own.every((e, i) => e.from === edges[i].from && e.to === edges[i].to);
    } catch (e) {
      trusted = false;
    }
    return { nodes, edges, trusted, code };
  }

  const UNSAFE = "Diese Stelle ist für die Maus-Bearbeitung zu komplex – bitte im Code ändern.";

  function edgeOpsAllowed() {
    if (App.getCode() !== model.code) {
      // Code was typed since the last render – arrow numbers may be outdated.
      toast("Die Vorschau wird gerade aktualisiert – bitte gleich noch einmal.");
      return false;
    }
    if (model.trusted) return true;
    toast(UNSAFE);
    return false;
  }

  function expectEdge(i) {
    return { from: model.edges[i].from, to: model.edges[i].to };
  }

  // ---------- applying changes ----------

  function snapshot(code) {
    history.push(code);
    if (history.length > 100) history.shift();
    future = [];
  }

  /** Runs a FlowEdit operation; checks the result with Mermaid before applying it. */
  async function apply(op, select) {
    const before = App.getCode();
    let after;
    try {
      after = op(before);
    } catch (e) {
      toast(e instanceof F.FlowEditError ? e.message : "Änderung nicht möglich.");
      return false;
    }
    if (after === before) return true;
    try {
      await mermaid.parse(after);
    } catch (e) {
      toast("Diese Änderung ergäbe ungültigen Code und wurde nicht übernommen.");
      return false;
    }
    clearTimeout(typingTimer);
    snapshot(before);
    lastStable = after;
    if (select !== undefined) selection = select;
    await App.setCode(after);
    await ready;
    return true;
  }

  async function undo() {
    if (!history.length) return;
    future.push(App.getCode());
    const code = history.pop();
    lastStable = code;
    await App.setCode(code);
    await ready;
  }

  async function redo() {
    if (!future.length) return;
    history.push(App.getCode());
    const code = future.pop();
    lastStable = code;
    await App.setCode(code);
    await ready;
  }

  // ---------- decorating the rendered SVG ----------

  function nodeIdFromElement(el) {
    const m = el.id.match(/-flowchart-(.+)-\d+$/);
    return m ? m[1] : null;
  }

  function decorate() {
    const svg = preview.querySelector("svg");
    if (!svg) return;
    svg.querySelectorAll("g.node").forEach((g) => {
      const id = nodeIdFromElement(g);
      if (id && model.nodes.has(id)) g.dataset.flowId = id;
    });
    const paths = [...svg.querySelectorAll('path[data-id^="L_"]')];
    if (paths.length === model.edges.length) {
      paths.forEach((p, i) => {
        // A wide transparent copy makes thin lines easy to click.
        const hit = p.cloneNode(false);
        hit.removeAttribute("id");
        hit.removeAttribute("marker-end");
        hit.removeAttribute("marker-start");
        hit.removeAttribute("style");
        hit.setAttribute("class", "flow-hit");
        hit.dataset.edge = String(i);
        p.dataset.edge = String(i);
        p.after(hit);
      });
      // Edge labels carry the same data-id as their path ("L_A_B_0").
      const byDataId = new Map(paths.map((p, i) => [p.getAttribute("data-id"), i]));
      svg.querySelectorAll(".edgeLabels > g.edgeLabel").forEach((l) => {
        const inner = l.querySelector("[data-id]");
        const i = inner ? byDataId.get(inner.getAttribute("data-id")) : undefined;
        if (i !== undefined) l.dataset.edge = String(i);
      });
    }
    showSelection();
  }

  function showSelection() {
    preview.querySelectorAll(".flow-selected").forEach((el) => el.classList.remove("flow-selected"));
    preview.querySelectorAll(".flow-connect-source").forEach((el) => el.classList.remove("flow-connect-source"));
    if (connectFrom) {
      const src = preview.querySelector(`g.node[data-flow-id="${CSS.escape(connectFrom)}"]`);
      if (src) src.classList.add("flow-connect-source");
    }
    if (selection && selection.type === "node" && !model.nodes.has(selection.id)) selection = null;
    if (selection && selection.type === "edge" && !model.edges[selection.index]) selection = null;
    if (!selection) {
      setInspector(false);
      return;
    }
    if (selection.type === "node") {
      const g = preview.querySelector(`g.node[data-flow-id="${CSS.escape(selection.id)}"]`);
      if (g) g.classList.add("flow-selected");
    } else {
      preview.querySelectorAll(`path[data-edge="${selection.index}"]:not(.flow-hit)`)
        .forEach((p) => p.classList.add("flow-selected"));
    }
    fillInspector();
  }

  // ---------- inspector ----------

  function fillSwatches() {
    document.querySelectorAll(".color-row").forEach((row) => {
      const prop = row.dataset.prop;
      const list = row.dataset.edge ? SWATCHES.stroke : SWATCHES[prop];
      list.forEach((c) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "swatch";
        b.style.background = c;
        b.title = SWATCH_NAMES[c] || c;
        b.setAttribute("aria-label", row.firstElementChild.textContent + " " + (SWATCH_NAMES[c] || c));
        b.dataset.color = c;
        row.appendChild(b);
      });
      // Native color picker, opened by a text button (its own swatch looked like "black").
      const custom = document.createElement("input");
      custom.type = "color";
      custom.className = "color-picker";
      custom.tabIndex = -1;
      custom.setAttribute("aria-hidden", "true");
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "swatch-reset";
      pick.textContent = "Eigene …";
      pick.addEventListener("click", () => custom.click());
      row.append(custom, pick);
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "swatch-reset";
      reset.textContent = "Standard";
      reset.dataset.color = "";
      row.appendChild(reset);
    });
  }

  function markSwatch(row, value) {
    row.querySelectorAll("[data-color]").forEach((b) => {
      b.classList.toggle("on", (b.dataset.color || "") === (value || "").toLowerCase());
    });
    const custom = row.querySelector('input[type="color"]');
    if (value && /^#[0-9a-f]{6}$/i.test(value)) custom.value = value;
  }

  /** Shows or hides the side panel; the preview makes room for it instead of being covered. */
  function setInspector(show) {
    inspector.hidden = !show;
    viewport.closest(".pane-view").classList.toggle("has-inspector", show);
    if (show) inspector.style.top = viewport.offsetTop + 8 + "px"; // below the toolbar, however tall it is
    if (show !== inspectorShown) {
      inspectorShown = show;
      window.dispatchEvent(new Event("resize")); // let the preview re-fit to its new width
    }
  }

  function fillInspector() {
    setInspector(true);
    const isNode = selection.type === "node";
    $("insp-node").hidden = !isNode;
    $("insp-edge").hidden = isNode;
    if (isNode) {
      const n = model.nodes.get(selection.id);
      $("insp-node-id").textContent = selection.id;
      if (document.activeElement !== $("insp-text")) $("insp-text").value = n.text;
      $("insp-shape").value = n.shape;
      document.querySelectorAll("#insp-node .color-row").forEach((row) => markSwatch(row, n.styles[row.dataset.prop]));
      $("insp-connect").classList.toggle("on", connectFrom === selection.id);
    } else {
      const e = model.edges[selection.index];
      $("insp-edge-id").textContent = e.from + " → " + e.to;
      if (document.activeElement !== $("insp-label")) $("insp-label").value = e.text;
      $("insp-kind").value = e.kind;
      markSwatch(document.querySelector("#insp-edge .color-row"), e.color);
    }
  }

  function currentNode() {
    return selection && selection.type === "node" ? model.nodes.get(selection.id) : null;
  }

  function bindInspector() {
    Object.entries(F.SHAPES).forEach(([key, s]) => $("insp-shape").add(new Option(s.label, key)));
    Object.entries(F.EDGE_KINDS).forEach(([key, k]) => $("insp-kind").add(new Option(k.label, key)));
    fillSwatches();

    const commitText = () => {
      const n = currentNode();
      if (!n || $("insp-text").value === n.text) return;
      const id = selection.id;
      apply((c) => F.setNode(c, id, n.shape, $("insp-text").value.trim() || id));
    };
    $("insp-text").addEventListener("change", commitText);
    $("insp-text").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        commitText();
      }
    });
    $("insp-shape").addEventListener("change", () => {
      const n = currentNode();
      if (!n) return;
      const id = selection.id;
      apply((c) => F.setNode(c, id, $("insp-shape").value, n.text || id));
    });

    const commitLabel = () => {
      if (!selection || selection.type !== "edge") return;
      const i = selection.index;
      if ($("insp-label").value === model.edges[i].text || !edgeOpsAllowed()) return;
      const expect = expectEdge(i);
      apply((c) => F.setEdge(c, i, { label: $("insp-label").value.trim() }, expect));
    };
    $("insp-label").addEventListener("change", commitLabel);
    $("insp-label").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitLabel();
      }
    });
    $("insp-kind").addEventListener("change", () => {
      const i = selection.index;
      if (!edgeOpsAllowed()) return;
      const expect = expectEdge(i);
      apply((c) => F.setEdge(c, i, { kind: $("insp-kind").value }, expect));
    });

    inspector.addEventListener("click", (e) => {
      const b = e.target.closest("[data-color]");
      if (!b) return;
      setColor(b.closest(".color-row"), b.dataset.color || null);
    });
    inspector.addEventListener("change", (e) => {
      if (e.target.type === "color") setColor(e.target.closest(".color-row"), e.target.value);
    });

    $("insp-node-delete").addEventListener("click", deleteSelection);
    $("insp-edge-delete").addEventListener("click", deleteSelection);
    $("insp-connect").addEventListener("click", () => {
      if (!selection || selection.type !== "node") return;
      connectFrom = connectFrom === selection.id ? null : selection.id;
      if (connectFrom) toast("Jetzt den Zielknoten anklicken.");
      showSelection();
    });
    $("insp-close").addEventListener("click", () => {
      selection = null;
      connectFrom = null;
      showSelection();
    });
  }

  function setColor(row, color) {
    if (!selection) return;
    if (selection.type === "node") {
      const id = selection.id;
      apply((c) => F.setNodeStyle(c, id, { [row.dataset.prop]: color }));
    } else {
      const i = selection.index;
      if (!edgeOpsAllowed()) return;
      const expect = expectEdge(i);
      apply((c) => F.setEdgeStyle(c, i, { stroke: color }, expect));
    }
  }

  function deleteSelection() {
    if (!selection) return;
    if (!edgeOpsAllowed()) return; // deleting a node removes its arrows by number, too
    if (selection.type === "node") {
      const id = selection.id;
      apply((c) => F.deleteNode(c, id), null);
    } else {
      const i = selection.index;
      const expect = expectEdge(i);
      apply((c) => F.deleteEdge(c, i, expect), null);
    }
  }

  // ---------- adding nodes (palette) ----------

  async function addNode(shape, connectTo) {
    let newId = null;
    const ok = await apply((c) => {
      const r = F.addNode(c, shape, "Neu", connectTo || null);
      newId = r.id;
      return r.code;
    });
    if (!ok) return;
    selection = { type: "node", id: newId };
    showSelection();
    const text = $("insp-text");
    text.focus();
    text.select();
  }

  function nodeAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const g = el && el.closest && el.closest("g.node[data-flow-id]");
    return g ? g.dataset.flowId : null;
  }

  function bindPalette() {
    $("palette").addEventListener("click", (e) => {
      const b = e.target.closest(".pal");
      if (!b || !active) return;
      // With a node selected, the new node is attached to it.
      addNode(b.dataset.shape, selection && selection.type === "node" ? selection.id : null);
    });
    $("palette").addEventListener("dragstart", (e) => {
      const b = e.target.closest(".pal");
      if (!b) return;
      e.dataTransfer.setData("text/x-flow-shape", b.dataset.shape);
      e.dataTransfer.effectAllowed = "copy";
    });
    viewport.addEventListener("dragover", (e) => {
      if (!active || !e.dataTransfer.types.includes("text/x-flow-shape")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      viewport.classList.add("drop-target");
    });
    viewport.addEventListener("dragleave", () => viewport.classList.remove("drop-target"));
    viewport.addEventListener("drop", (e) => {
      viewport.classList.remove("drop-target");
      const shape = e.dataTransfer.getData("text/x-flow-shape");
      if (!active || !shape) return;
      e.preventDefault();
      addNode(shape, nodeAt(e.clientX, e.clientY));
    });
  }

  // ---------- selecting and connecting ----------

  function bindPreview() {
    preview.addEventListener("click", (e) => {
      if (!active) return;
      const g = e.target.closest("g.node[data-flow-id]");
      const edgeEl = e.target.closest("[data-edge]");
      if (g) {
        const id = g.dataset.flowId;
        if (connectFrom && connectFrom !== id) {
          const from = connectFrom;
          connectFrom = null;
          apply((c) => F.addEdge(c, from, id, "arrow"), { type: "node", id });
          return;
        }
        connectFrom = null;
        selection = { type: "node", id };
      } else if (edgeEl) {
        connectFrom = null;
        selection = { type: "edge", index: Number(edgeEl.dataset.edge) };
      } else {
        connectFrom = null;
        selection = null;
      }
      showSelection();
    });

    // Drag handle on the right edge of the hovered node: drag it onto another node to connect.
    let hoverId = null;
    preview.addEventListener("mouseover", (e) => {
      if (!active || dragging) return;
      const g = e.target.closest("g.node[data-flow-id]");
      if (!g) return;
      hoverId = g.dataset.flowId;
      const r = g.getBoundingClientRect();
      const v = viewport.getBoundingClientRect();
      handle.style.left = r.right - v.left + viewport.scrollLeft - 7 + "px";
      handle.style.top = r.top + r.height / 2 - v.top + viewport.scrollTop - 7 + "px";
      handle.hidden = false;
    });
    viewport.addEventListener("mouseleave", () => { if (!dragging) handle.hidden = true; });

    let dragging = false;
    let start = null;
    handle.addEventListener("pointerdown", (e) => {
      if (!hoverId) return;
      e.preventDefault();
      dragging = true;
      start = { id: hoverId, x: e.clientX, y: e.clientY };
      handle.setPointerCapture(e.pointerId);
      dragLine.hidden = false;
      moveLine(e);
    });
    const moveLine = (e) => {
      const v = viewport.getBoundingClientRect();
      const line = dragLine.firstElementChild;
      dragLine.style.width = viewport.scrollWidth + "px";
      dragLine.style.height = viewport.scrollHeight + "px";
      line.setAttribute("x1", start.x - v.left + viewport.scrollLeft);
      line.setAttribute("y1", start.y - v.top + viewport.scrollTop);
      line.setAttribute("x2", e.clientX - v.left + viewport.scrollLeft);
      line.setAttribute("y2", e.clientY - v.top + viewport.scrollTop);
    };
    handle.addEventListener("pointermove", (e) => { if (dragging) moveLine(e); });
    handle.addEventListener("pointerup", (e) => {
      if (!dragging) return;
      dragging = false;
      dragLine.hidden = true;
      handle.hidden = true;
      const target = nodeAt(e.clientX, e.clientY);
      if (target && target !== start.id) {
        const from = start.id;
        apply((c) => F.addEdge(c, from, target, "arrow"), { type: "node", id: target });
      }
    });
  }

  // ---------- keyboard, toolbar ----------

  function typingIn(el) {
    return el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT");
  }

  function bindKeys() {
    document.addEventListener("keydown", (e) => {
      if (!active || typingIn(document.activeElement)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selection) {
        e.preventDefault();
        deleteSelection();
      } else if (e.key === "Escape") {
        selection = null;
        connectFrom = null;
        showSelection();
      }
    });
    $("undo").addEventListener("click", undo);
    $("redo").addEventListener("click", redo);
    $("direction").addEventListener("change", () => apply((c) => F.setDirection(c, $("direction").value)));

    // Typing in the code also goes into the history (one step per pause).
    codeEl.addEventListener("input", () => {
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        const now = App.getCode();
        if (lastStable !== null && now !== lastStable) snapshot(lastStable);
        lastStable = now;
      }, 800);
    });
  }

  // ---------- life cycle ----------

  async function onRendered(code) {
    const isFlow = code !== null && F.isFlowchart(code);
    const editable = App.isEditable();
    active = isFlow && editable;
    bar.hidden = !isFlow || !editable;
    hint.hidden = !(code !== null && !isFlow && editable && App.getCode().trim());
    hint.textContent = "Bearbeiten mit der Maus gibt es für Flussdiagramme (erste Zeile flowchart).";
    handle.hidden = true;
    if (!active) {
      setInspector(false);
      return;
    }
    if (lastStable === null) lastStable = code;
    $("undo").disabled = !history.length;
    $("redo").disabled = !future.length;
    const dir = F.getDirection(code);
    $("direction").value = dir === "TB" ? "TD" : dir;
    try {
      model = await readModel(code);
    } catch (e) {
      active = false;
      return;
    }
    decorate();
  }

  document.addEventListener("flow:rendered", (e) => { ready = onRendered(e.detail.code); });
  document.addEventListener("flow:loaded", () => {
    history = [];
    future = [];
    lastStable = null;
    selection = null;
    connectFrom = null;
  });

  bindInspector();
  bindPalette();
  bindPreview();
  bindKeys();
})();
