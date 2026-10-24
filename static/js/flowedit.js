/*
 * FlowEdit – targeted text edits on Mermaid flowchart code.
 *
 * The code stays the single source of truth: every mouse action in the editor
 * is translated into a small change of the text. Lines that are not touched stay
 * exactly as they were (comments, indentation, groups, Claude's formatting).
 * When a line cannot be changed safely, a FlowEditError is thrown and nothing
 * is changed.
 *
 * Pure string functions, no DOM – usable in the browser (window.FlowEdit) and
 * in Node for the tests (module.exports).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FlowEdit = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  class FlowEditError extends Error {}

  // Shapes offered in the editor. `short` = Mermaid's bracket form, used where it exists.
  const SHAPES = {
    rect: { label: "Rechteck", short: ["[", "]"] },
    rounded: { label: "Abgerundet", short: ["(", ")"] },
    stadium: { label: "Start/Ende", short: ["([", "])"] },
    diamond: { label: "Entscheidung", short: ["{", "}"] },
    circle: { label: "Kreis", short: ["((", "))"] },
    "dbl-circ": { label: "Doppelkreis", short: ["(((", ")))"] },
    cyl: { label: "Datenbank", short: ["[(", ")]"] },
    "fr-rect": { label: "Unterprozess", short: ["[[", "]]"] },
    hex: { label: "Vorbereitung", short: ["{{", "}}"] },
    "lean-r": { label: "Eingabe", short: ["[/", "/]"] },
    "lean-l": { label: "Ausgabe", short: ["[\\", "\\]"] },
    odd: { label: "Fähnchen", short: [">", "]"] },
    doc: { label: "Dokument" },
    docs: { label: "Mehrere Dokumente" },
    procs: { label: "Mehrere Schritte" },
    delay: { label: "Wartezeit" },
    "sl-rect": { label: "Manuelle Eingabe" },
    "trap-t": { label: "Manueller Schritt" },
    tri: { label: "Auszug" },
    hourglass: { label: "Sammeln" },
    flag: { label: "Etikett" },
    "sm-circ": { label: "Start (klein)" },
    "framed-circle": { label: "Stopp" },
    text: { label: "Nur Text" },
  };

  // Mermaid parser vertex types → our shape keys (new-style shapes keep their name).
  const PARSER_TYPES = {
    square: "rect", round: "rounded", stadium: "stadium", diamond: "diamond", circle: "circle",
    doublecircle: "dbl-circ", cylinder: "cyl", subroutine: "fr-rect", hexagon: "hex",
    lean_right: "lean-r", lean_left: "lean-l", odd: "odd",
  };

  const EDGE_KINDS = {
    arrow: { label: "Pfeil", op: "-->" },
    line: { label: "Linie", op: "---" },
    dotted: { label: "Gepunktet", op: "-.->" },
    thick: { label: "Dick", op: "==>" },
  };

  // Openers of the bracket shapes, longest first so "((" wins over "(".
  const OPENERS = [
    ["(((", [")))"]], ["([", ["])"]], ["((", ["))"]], ["[(", [")]"]], ["[[", ["]]"]],
    ["[/", ["/]", "\\]"]], ["[\\", ["\\]", "/]"]], ["{{", ["}}"]],
    ["[", ["]"]], ["(", [")"]], ["{", ["}"]], [">", ["]"]],
  ];

  const KEYWORD_LINE = /^\s*(style|classDef|class|linkStyle|click|subgraph|end|direction|accTitle|accDescr)\b/;
  const HEADER = /^(\s*)(flowchart|graph)(?![\w-])[ \t]*([A-Za-z]{2}(?![\w-]))?(.*)$/;
  const ID_START = /[A-Za-z0-9_]/;
  const ID_CHAR = /[A-Za-z0-9_]/;

  function shapeFromParserType(type) {
    if (!type) return "rect";
    return PARSER_TYPES[type] || (SHAPES[type] ? type : "rect");
  }

  // ---------- small helpers ----------

  function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  }

  function needsQuotes(text) {
    return !/^[\wÄÖÜäöüß .,!?+\-]*$/.test(text) || /^\s|\s$/.test(text) || text === "";
  }

  function escapeLabel(text) {
    return String(text).replace(/"/g, "#quot;").replace(/\r?\n/g, "<br>");
  }

  function formatNode(id, shape, label) {
    const def = SHAPES[shape] || SHAPES.rect;
    const text = escapeLabel(label);
    if (def.short) {
      const body = needsQuotes(text) || /[[\](){}<>|]/.test(text) ? '"' + text + '"' : text;
      return id + def.short[0] + body + def.short[1];
    }
    return id + "@{ shape: " + (SHAPES[shape] ? shape : "rect") + ', label: "' + text + '" }';
  }

  function formatEdgeLabel(text) {
    const t = escapeLabel(text);
    return /[|"[\](){}]/.test(t) || needsQuotes(t) ? '"' + t + '"' : t;
  }

  /** Index of the first line after the header and any front matter / directives. */
  function headerIndex(lines) {
    let i = 0;
    if (lines[0] && lines[0].trim() === "---") {
      i = 1;
      while (i < lines.length && lines[i].trim() !== "---") i++;
      i++;
    }
    for (; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t || t.startsWith("%%")) continue;
      return HEADER.test(lines[i]) ? i : -1;
    }
    return -1;
  }

  function isFlowchart(code) {
    return headerIndex(String(code).split("\n")) >= 0;
  }

  function indentOf(lines, hdr) {
    for (let i = hdr + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(\s+)\S/);
      if (m && !lines[i].trim().startsWith("%%")) return m[1];
    }
    return "    ";
  }

  // ---------- statement scanner ----------
  // A statement line is parsed into node references and links:
  //   A[Text]:::cls & B --> C -- label --> D
  // Node refs remember where their shape definition sits in the line.

  function skipSpaces(s, i) {
    while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
    return i;
  }

  function readId(s, i) {
    if (!ID_START.test(s[i] || "")) return null;
    let j = i + 1;
    while (j < s.length) {
      if (ID_CHAR.test(s[j])) j++;
      else if (s[j] === "-" && ID_CHAR.test(s[j + 1] || "") && s[j - 1] !== "-") j++;
      else break;
    }
    return { id: s.slice(i, j), end: j };
  }

  /** End index (exclusive) of a quoted string starting at i, or -1. */
  function skipQuoted(s, i) {
    const q = s.indexOf('"', i + 1);
    return q < 0 ? -1 : q + 1;
  }

  /** Reads a shape definition at i ("[...]", "@{...}" etc.). Returns { end } or null. */
  function readShape(s, i) {
    if (s.startsWith("@{", i)) {
      let j = i + 2;
      while (j < s.length && s[j] !== "}") {
        if (s[j] === '"') {
          j = skipQuoted(s, j);
          if (j < 0) return null;
        } else j++;
      }
      return j < s.length ? { end: j + 1 } : null;
    }
    for (const [open, closers] of OPENERS) {
      if (!s.startsWith(open, i)) continue;
      let j = skipSpaces(s, i + open.length);
      if (s[j] === '"') {
        j = skipQuoted(s, j);
        if (j < 0) return null;
        j = skipSpaces(s, j);
        for (const c of closers) if (s.startsWith(c, j)) return { end: j + c.length };
        return null;
      }
      let best = -1;
      let closeLen = 0;
      for (const c of closers) {
        const k = s.indexOf(c, i + open.length);
        if (k >= 0 && (best < 0 || k < best)) {
          best = k;
          closeLen = c.length;
        }
      }
      return best >= 0 ? { end: best + closeLen } : null;
    }
    return null;
  }

  const LINK_INLINE = /^([<ox]?)(--|==|-\.)\s+([^|]*?)\s+(-{2,}[>ox]|-{3,}|={2,}[>ox]|={3,}|\.+-[>ox]?)/;
  const LINK_PLAIN = /^(?:[A-Za-z0-9_]+@)?([<ox]?)(-{2,}[>ox]|-{3,}|={2,}[>ox]|={3,}|-\.+-[>ox]?|~{3,})/;

  /** Reads a link at i. Returns { end, op, label } – op without label, e.g. "-->". */
  function readLink(s, i) {
    const rest = s.slice(i);
    let m = rest.match(LINK_INLINE);
    if (m) {
      const closing = m[4];
      let op;
      if (m[2] === "-.") op = "-" + closing; // "-. text .->" → "-.->"
      else op = closing;
      return { end: i + m[0].length, op: m[1] + op, label: m[3] };
    }
    m = rest.match(LINK_PLAIN);
    if (!m) return null;
    let end = i + m[0].length;
    let label = null;
    const j = skipSpaces(s, end);
    if (s[j] === "|") {
      let k;
      const q = skipSpaces(s, j + 1);
      if (s[q] === '"') {
        // quoted label may contain "|": |"ja | nein"|
        const close = skipQuoted(s, q);
        if (close < 0) return null;
        k = skipSpaces(s, close);
        if (s[k] !== "|") return null;
        label = s.slice(q + 1, close - 1);
      } else {
        k = s.indexOf("|", j + 1);
        if (k < 0) return null;
        label = s.slice(j + 1, k);
      }
      end = k + 1;
    }
    return { end, op: m[1] + m[2], label, opStart: i + m[0].length - m[2].length - m[1].length };
  }

  /**
   * Parses one statement line. Returns null for lines that are not node/link statements.
   * Result: { groups: [[ref…]…], links: [{start,end,op,label}…] }, ref = {id, defStart, defEnd, start, end}
   */
  function parseStatement(line) {
    const t = line.trim();
    if (!t || t.startsWith("%%") || KEYWORD_LINE.test(line) || HEADER.test(line)) return null;
    const s = line;
    let i = skipSpaces(s, 0);
    const groups = [];
    const links = [];
    for (;;) {
      const group = [];
      for (;;) {
        const r = readId(s, i);
        if (!r) throw new FlowEditError("unreadable");
        const ref = { id: r.id, start: i, defStart: -1, defEnd: -1 };
        i = r.end;
        const shape = readShape(s, i);
        if (shape) {
          ref.defStart = i;
          ref.defEnd = shape.end;
          i = shape.end;
        }
        if (s.startsWith(":::", i)) {
          const c = readId(s, i + 3);
          if (!c) throw new FlowEditError("unreadable");
          i = c.end;
        }
        ref.end = i;
        group.push(ref);
        i = skipSpaces(s, i);
        if (s[i] === "&") {
          i = skipSpaces(s, i + 1);
          continue;
        }
        break;
      }
      groups.push(group);
      if (i >= s.length || s[i] === ";" && s.slice(i + 1).trim() === "") break;
      const link = readLink(s, i);
      if (!link) throw new FlowEditError("unreadable");
      links.push({ start: i, end: link.end, op: link.op, label: link.label });
      i = skipSpaces(s, link.end);
    }
    return { groups, links };
  }

  /** Every statement with its edges, in Mermaid's order (left × right per link, lines top to bottom). */
  function scan(code) {
    const lines = String(code).split("\n");
    const hdr = headerIndex(lines);
    if (hdr < 0) throw new FlowEditError("Kein Flussdiagramm.");
    const statements = [];
    const edges = [];
    for (let li = hdr + 1; li < lines.length; li++) {
      let st;
      try {
        st = parseStatement(lines[li]);
      } catch (e) {
        st = { complex: true };
      }
      if (!st) continue;
      st.line = li;
      statements.push(st);
      if (st.complex) continue;
      st.edgeIndexes = [];
      st.links.forEach((link, k) => {
        for (const a of st.groups[k]) {
          for (const b of st.groups[k + 1]) {
            st.edgeIndexes.push(edges.length);
            edges.push({ from: a.id, to: b.id, line: li, link: k, op: link.op, label: link.label });
          }
        }
      });
    }
    return { lines, hdr, statements, edges };
  }

  function complexLinesMention(info, id) {
    const re = new RegExp("(^|[^A-Za-z0-9_-])" + escapeRegex(id) + "($|[^A-Za-z0-9_-])");
    return info.statements.some((st) => st.complex && re.test(info.lines[st.line]));
  }

  function unsafe() {
    return new FlowEditError("Diese Stelle ist für die Maus-Bearbeitung zu komplex – bitte im Code ändern.");
  }

  // ---------- reading ----------

  function allIds(code) {
    const info = scan(code);
    const ids = new Set();
    for (const st of info.statements) if (!st.complex) st.groups.flat().forEach((r) => ids.add(r.id));
    return ids;
  }

  function nextId(code) {
    let n = 1;
    const text = String(code);
    while (new RegExp("(^|[^A-Za-z0-9_])N" + n + "($|[^A-Za-z0-9_])").test(text)) n++;
    return "N" + n;
  }

  function getDirection(code) {
    const lines = String(code).split("\n");
    const hdr = headerIndex(lines);
    if (hdr < 0) return null;
    return (lines[hdr].match(HEADER)[3] || "TB").toUpperCase();
  }

  // ---------- writing helpers ----------

  /** Line index after which new statements go: before the trailing style/class block. */
  function appendIndex(lines) {
    let i = lines.length;
    while (i > 0 && lines[i - 1].trim() === "") i--;
    let j = i;
    while (j > 0 && /^\s*(style|classDef|class|linkStyle|click)\b/.test(lines[j - 1])) j--;
    return j === 0 ? i : j;
  }

  function insertLine(lines, at, text) {
    lines.splice(at, 0, text);
  }

  /** Splits a statement with more than one edge into one line per edge (keeps definitions). */
  function explode(info, st) {
    if (st.edgeIndexes.length <= 1) return false;
    const line = info.lines[st.line];
    const indent = line.match(/^\s*/)[0];
    const seen = new Set();
    const nodeText = (ref) => {
      if (seen.has(ref.id)) return ref.id;
      seen.add(ref.id);
      return line.slice(ref.start, ref.end);
    };
    const out = [];
    st.links.forEach((link, k) => {
      const opText = link.label != null ? link.op + "|" + formatEdgeLabel(link.label) + "|" : link.op;
      for (const a of st.groups[k]) for (const b of st.groups[k + 1]) {
        out.push(indent + nodeText(a) + " " + opText + " " + nodeText(b));
      }
    });
    info.lines.splice(st.line, 1, ...out);
    return true;
  }

  /** Re-scans after a structural change; returns the info for the single-edge line of edge `index`. */
  /**
   * Edge numbers follow Mermaid's order only if every statement line could be read –
   * otherwise a click could hit the wrong arrow. `expect` ({from, to}) double-checks it.
   */
  function trustedEdges(info) {
    if (info.statements.some((st) => st.complex)) throw unsafe();
    return info.edges;
  }

  function isolateEdge(code, index, expect) {
    let info = scan(code);
    const edge = trustedEdges(info)[index];
    if (!edge) throw new FlowEditError("Pfeil nicht gefunden.");
    if (expect && (edge.from !== expect.from || edge.to !== expect.to)) throw unsafe();
    const st = info.statements.find((s) => s.line === edge.line);
    if (explode(info, st)) info = scan(info.lines.join("\n"));
    const e = info.edges[index];
    return { info, edge: e, st: info.statements.find((s) => s.line === e.line) };
  }

  function linkStyleShift(lines, removed) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*linkStyle\s+)([\d,\s]+?)(\s+\S.*)$/);
      if (!m) continue;
      const nums = m[2].split(",").map((x) => parseInt(x.trim(), 10)).filter((x) => x !== removed)
        .map((x) => (x > removed ? x - 1 : x));
      if (!nums.length) {
        lines.splice(i, 1);
        i--;
      } else lines[i] = m[1] + nums.join(",") + m[3];
    }
  }

  /** Splits "fill:rgb(1,2,3),stroke:#000" at top-level commas only. */
  function splitStyle(text) {
    const parts = [];
    let depth = 0;
    let cur = "";
    for (const ch of text) {
      if (ch === "(") depth++;
      if (ch === ")") depth = Math.max(0, depth - 1);
      if (ch === "," && depth === 0) {
        parts.push(cur);
        cur = "";
      } else cur += ch;
    }
    parts.push(cur);
    return parts;
  }

  function parseStyle(text) {
    const props = {};
    splitStyle(text).forEach((part) => {
      const k = part.indexOf(":");
      if (k > 0) props[part.slice(0, k).trim()] = part.slice(k + 1).trim();
    });
    return props;
  }

  function formatStyle(props) {
    return Object.entries(props).filter(([, v]) => v != null && v !== "").map(([k, v]) => k + ":" + v).join(",");
  }

  const COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/;

  function checkColors(props) {
    for (const v of Object.values(props)) {
      if (v != null && v !== "" && !COLOR.test(v) && !/^\d+px$/.test(v)) throw new FlowEditError("Ungültige Farbe.");
    }
  }

  // ---------- operations ----------

  /** Adds a node; optionally connected from an existing node. Returns { code, id }. */
  function addNode(code, shape, label, connectFrom) {
    const lines = String(code).split("\n");
    const hdr = headerIndex(lines);
    if (hdr < 0) throw new FlowEditError("Kein Flussdiagramm.");
    const id = nextId(code);
    const node = formatNode(id, shape, label);
    const text = indentOf(lines, hdr) + (connectFrom ? connectFrom + " --> " + node : node);
    insertLine(lines, appendIndex(lines), text);
    return { code: lines.join("\n"), id };
  }

  function addEdge(code, from, to, kind) {
    const lines = String(code).split("\n");
    const hdr = headerIndex(lines);
    if (hdr < 0) throw new FlowEditError("Kein Flussdiagramm.");
    const op = (EDGE_KINDS[kind] || EDGE_KINDS.arrow).op;
    insertLine(lines, appendIndex(lines), indentOf(lines, hdr) + from + " " + op + " " + to);
    return lines.join("\n");
  }

  /** Sets text and shape of a node; the last definition is replaced, earlier ones become bare IDs. */
  function setNode(code, id, shape, label) {
    const info = scan(code);
    if (complexLinesMention(info, id)) throw unsafe();
    const refs = [];
    let firstMention = -1;
    for (const st of info.statements) {
      if (st.complex) continue;
      for (const ref of st.groups.flat()) {
        if (ref.id !== id) continue;
        if (firstMention < 0) firstMention = st.line;
        if (ref.defStart >= 0) refs.push({ line: st.line, ref });
      }
    }
    if (firstMention < 0) throw new FlowEditError("Knoten nicht gefunden.");
    const lines = info.lines;
    const formatted = formatNode(id, shape, label);
    if (!refs.length) {
      // Only bare mentions so far: define it right after its first mention (keeps it in its group).
      const indent = lines[firstMention].match(/^\s*/)[0];
      insertLine(lines, firstMention + 1, indent + formatted);
      return lines.join("\n");
    }
    // Replace from the end so earlier offsets in the same line stay valid.
    for (let k = refs.length - 1; k >= 0; k--) {
      const { line, ref } = refs[k];
      const s = lines[line];
      const replacement = k === refs.length - 1 ? formatted : id;
      lines[line] = s.slice(0, ref.start) + replacement + s.slice(ref.defEnd);
    }
    return lines.join("\n");
  }

  /** Merges fill/stroke/color into the node's `style` line; null removes a property. */
  function setNodeStyle(code, id, changes) {
    checkColors(changes);
    const lines = String(code).split("\n");
    if (headerIndex(lines) < 0) throw new FlowEditError("Kein Flussdiagramm.");
    const re = new RegExp("^(\\s*style\\s+)" + escapeRegex(id) + "(\\s+)(.*?)\\s*;?\\s*$");
    let found = -1;
    let props = {};
    lines.forEach((l, i) => {
      const m = l.match(re);
      if (m) {
        found = i;
        props = Object.assign(props, parseStyle(m[3]));
      }
    });
    Object.assign(props, changes);
    const text = formatStyle(props);
    const hdr = headerIndex(lines);
    if (found >= 0) {
      // Keep one style line for the node: the last one, updated.
      for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i]) && i !== found) lines.splice(i, 1);
      const idx = lines.findIndex((l) => re.test(l));
      if (text) lines[idx] = lines[idx].match(/^\s*/)[0] + "style " + id + " " + text;
      else lines.splice(idx, 1);
    } else if (text) {
      let at = lines.length;
      while (at > 0 && lines[at - 1].trim() === "") at--;
      insertLine(lines, at, indentOf(lines, hdr) + "style " + id + " " + text);
    }
    return lines.join("\n");
  }

  /** Changes label and/or kind of edge `index` (Mermaid order). kind: arrow|line|dotted|thick. */
  function setEdge(code, index, changes, expect) {
    const { info, edge, st } = isolateEdge(code, index, expect);
    const link = st.links[edge.link];
    const op = changes.kind ? (EDGE_KINDS[changes.kind] || EDGE_KINDS.arrow).op : link.op;
    const label = "label" in changes ? changes.label : link.label;
    const opText = label ? op + "|" + formatEdgeLabel(label) + "|" : op;
    const s = info.lines[edge.line];
    info.lines[edge.line] = s.slice(0, link.start) + opText + " " + s.slice(link.end).replace(/^\s+/, "");
    return info.lines.join("\n");
  }

  /** Sets the color of edge `index` via linkStyle; null color removes it. */
  function setEdgeStyle(code, index, changes, expect) {
    checkColors(changes);
    const lines = String(code).split("\n");
    const hdr = headerIndex(lines);
    if (hdr < 0) throw new FlowEditError("Kein Flussdiagramm.");
    const edge = trustedEdges(scan(code))[index];
    if (!edge) throw new FlowEditError("Pfeil nicht gefunden.");
    if (expect && (edge.from !== expect.from || edge.to !== expect.to)) throw unsafe();
    let props = {};
    let found = -1;
    lines.forEach((l, i) => {
      const m = l.match(/^\s*linkStyle\s+([\d,\s]+?)\s+(\S.*?)\s*;?\s*$/);
      if (!m) return;
      const nums = m[1].split(",").map((x) => parseInt(x.trim(), 10));
      if (nums.length === 1 && nums[0] === index) {
        found = i;
        props = Object.assign(props, parseStyle(m[2]));
      } else if (nums.includes(index)) {
        throw unsafe(); // shared linkStyle line – leave it to the code
      }
    });
    Object.assign(props, changes);
    const text = formatStyle(props);
    if (found >= 0) {
      if (text) lines[found] = lines[found].match(/^\s*/)[0] + "linkStyle " + index + " " + text;
      else lines.splice(found, 1);
    } else if (text) {
      let at = lines.length;
      while (at > 0 && lines[at - 1].trim() === "") at--;
      insertLine(lines, at, indentOf(lines, hdr) + "linkStyle " + index + " " + text);
    }
    return lines.join("\n");
  }

  function deleteEdge(code, index, expect) {
    const { info, edge, st } = isolateEdge(code, index, expect);
    const line = info.lines[edge.line];
    const [a] = st.groups[edge.link];
    const [b] = st.groups[edge.link + 1];
    // Keep node definitions that live in this line: "A[Text] --> B" becomes "A[Text]".
    const keep = [a, b].filter((r) => r.defStart >= 0).map((r) => line.slice(r.start, r.end));
    const indent = line.match(/^\s*/)[0];
    if (keep.length) info.lines.splice(edge.line, 1, ...keep.map((k) => indent + k));
    else info.lines.splice(edge.line, 1);
    linkStyleShift(info.lines, index);
    return info.lines.join("\n");
  }

  /** Removes a node with all its edges, styles and class assignments. */
  function deleteNode(code, id) {
    let info = scan(code);
    if (complexLinesMention(info, id)) throw unsafe();
    trustedEdges(info);
    for (let k = info.edges.length - 1; k >= 0; k--) {
      const e = info.edges[k];
      if (e.from === id || e.to === id) {
        code = deleteEdge(code, k);
      }
    }
    info = scan(code);
    const lines = info.lines;
    const drop = new Set();
    for (const st of info.statements) {
      if (st.complex) continue;
      const refs = st.groups.flat();
      if (st.links.length === 0 && refs.every((r) => r.id === id)) drop.add(st.line);
      else if (refs.some((r) => r.id === id)) {
        // "A & B" without links: remove B from the group
        if (st.links.length === 0) {
          const kept = refs.filter((r) => r.id !== id).map((r) => lines[st.line].slice(r.start, r.end));
          lines[st.line] = lines[st.line].match(/^\s*/)[0] + kept.join(" & ");
        } else throw unsafe();
      }
    }
    const esc = escapeRegex(id);
    const styleRe = new RegExp("^\\s*(style|click)\\s+" + esc + "\\b");
    lines.forEach((l, i) => {
      if (styleRe.test(l)) drop.add(i);
      const m = l.match(/^(\s*class\s+)([^\s]+)(\s+\S+.*)$/);
      if (m) {
        const ids = m[2].split(",").filter((x) => x.trim() !== id);
        if (!ids.length) drop.add(i);
        else lines[i] = m[1] + ids.join(",") + m[3];
      }
    });
    return lines.filter((_, i) => !drop.has(i)).join("\n");
  }

  function setDirection(code, dir) {
    if (!/^(TB|TD|BT|LR|RL)$/.test(dir)) throw new FlowEditError("Ungültige Richtung.");
    const lines = String(code).split("\n");
    const hdr = headerIndex(lines);
    if (hdr < 0) throw new FlowEditError("Kein Flussdiagramm.");
    const m = lines[hdr].match(HEADER);
    lines[hdr] = m[1] + m[2] + " " + dir + m[4];
    return lines.join("\n");
  }

  return {
    FlowEditError, SHAPES, EDGE_KINDS, shapeFromParserType, isFlowchart, getDirection, nextId, allIds,
    scan, trustedEdges, splitStyle, addNode, addEdge, setNode, setNodeStyle, setEdge, setEdgeStyle, deleteEdge, deleteNode, setDirection,
    formatNode,
  };
});
