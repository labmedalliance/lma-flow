// Tests for static/js/flowedit.js – run with: node --test tests/js/
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../../static/js/flowedit.js");

const BASE = `flowchart TD
    %% Kommentar bleibt
    A[Probe eingegangen] --> B{Barcode lesbar?}
    B -- ja --> C[Zentrifugieren]
    B -- nein --> D[Manuell erfassen]
    D --> C
    style A fill:#d1fae5`;

test("isFlowchart and direction", () => {
  assert.equal(F.isFlowchart(BASE), true);
  assert.equal(F.isFlowchart("sequenceDiagram\n A->>B: x"), false);
  assert.equal(F.isFlowchart("---\ntitle: X\n---\nflowchart LR\n A-->B"), true);
  assert.equal(F.getDirection(BASE), "TD");
  assert.equal(F.setDirection(BASE, "LR").split("\n")[0], "flowchart LR");
  assert.equal(F.setDirection("graph", "LR"), "graph LR");
});

test("scan finds edges in Mermaid order, also chains and &", () => {
  const { edges } = F.scan("flowchart LR\n A --> B & C --> D\n D -.-> E\n E ==>|x| F\n F --- G");
  assert.deepEqual(edges.map((e) => e.from + ">" + e.to), ["A>B", "A>C", "B>D", "C>D", "D>E", "E>F", "F>G"]);
  assert.deepEqual(edges.map((e) => e.op), ["-->", "-->", "-->", "-->", "-.->", "==>", "---"]);
  assert.equal(edges[5].label, "x");
});

test("scan handles inline labels, ids with dash, classes and @{} shapes", () => {
  const { edges } = F.scan('flowchart LR\n X-1[Eins]:::k -- Text mit Wort --> Y_2@{ shape: doc, label: "Zwei" }');
  assert.deepEqual(edges.map((e) => [e.from, e.to, e.op, e.label]), [["X-1", "Y_2", "-->", "Text mit Wort"]]);
});

test("addNode appends before the style block and picks a free id", () => {
  const r = F.addNode(BASE, "doc", "Befund", null);
  assert.equal(r.id, "N1");
  const lines = r.code.split("\n");
  assert.equal(lines[lines.length - 2], '    N1@{ shape: doc, label: "Befund" }');
  assert.equal(lines[lines.length - 1], "    style A fill:#d1fae5");
  const r2 = F.addNode(r.code, "diamond", "OK?", "C");
  assert.equal(r2.id, "N2");
  assert.ok(r2.code.includes("    C --> N2{OK?}"));
});

test("short form where possible, quotes for special characters", () => {
  assert.equal(F.formatNode("A", "rect", "Probe"), "A[Probe]");
  assert.equal(F.formatNode("A", "rect", "Kalium (K+)"), 'A["Kalium (K+)"]');
  assert.equal(F.formatNode("A", "cyl", "LIS"), "A[(LIS)]");
  assert.equal(F.formatNode("A", "lean-l", "Aus"), "A[\\Aus\\]");
  assert.equal(F.formatNode("A", "rect", 'Er sagte "ja"'), 'A["Er sagte #quot;ja#quot;"]');
  assert.equal(F.formatNode("A", "delay", "Warten"), 'A@{ shape: delay, label: "Warten" }');
});

test("setNode replaces the definition in place and keeps the rest", () => {
  const out = F.setNode(BASE, "C", "cyl", "Zentrifuge");
  assert.ok(out.includes("B -- ja --> C[(Zentrifuge)]"));
  assert.ok(out.includes("    D --> C\n"));
  assert.ok(out.includes("%% Kommentar bleibt"));
});

test("setNode on a node with several definitions keeps only the last one", () => {
  const code = "flowchart LR\n A[Alt] --> B\n A[Neuer] --> C";
  const out = F.setNode(code, "A", "rounded", "Final");
  assert.equal(out, "flowchart LR\n A --> B\n A(Final) --> C");
});

test("setNode on a bare node adds a definition after its first mention (stays in its group)", () => {
  const code = "flowchart LR\n  subgraph G\n    A --> B\n  end\n  B --> C";
  const out = F.setNode(code, "B", "diamond", "Prüfen");
  assert.equal(out, "flowchart LR\n  subgraph G\n    A --> B\n    B{Prüfen}\n  end\n  B --> C");
});

test("setNodeStyle merges and removes properties", () => {
  let out = F.setNodeStyle(BASE, "A", { stroke: "#059669" });
  assert.ok(out.endsWith("    style A fill:#d1fae5,stroke:#059669"));
  out = F.setNodeStyle(out, "A", { fill: null, stroke: null });
  assert.ok(!out.includes("style A"));
  out = F.setNodeStyle(BASE, "B", { fill: "#fee2e2" });
  assert.ok(out.endsWith("    style B fill:#fee2e2"));
  assert.throws(() => F.setNodeStyle(BASE, "B", { fill: "red;}<script>" }), F.FlowEditError);
});

test("setEdge changes label and kind, and explodes chains first", () => {
  let out = F.setEdge(BASE, 1, { label: "ja, sicher" });
  assert.ok(out.includes("B -->|ja, sicher| C[Zentrifugieren]"));
  out = F.setEdge(BASE, 0, { kind: "dotted" });
  assert.ok(out.includes("A[Probe eingegangen] -.-> B{Barcode lesbar?}"));
  out = F.setEdge("flowchart LR\n A --> B & C", 1, { label: "zwei" });
  assert.equal(out, "flowchart LR\n A --> B\n A -->|zwei| C");
  out = F.setEdge("flowchart LR\n A -->|alt| B", 0, { label: "" });
  assert.equal(out, "flowchart LR\n A --> B");
});

test("deleteEdge keeps node definitions and shifts linkStyle numbers", () => {
  const code = "flowchart LR\n A[Eins] --> B\n B --> C\n C --> D\n linkStyle 1 stroke:red\n linkStyle 2 stroke:blue";
  const out = F.deleteEdge(code, 1);
  assert.equal(out, "flowchart LR\n A[Eins] --> B\n C --> D\n linkStyle 1 stroke:blue");
  assert.equal(F.deleteEdge("flowchart LR\n A[Eins] --> B[Zwei]", 0), "flowchart LR\n A[Eins]\n B[Zwei]");
});

test("setEdgeStyle adds, updates and refuses shared linkStyle lines", () => {
  let out = F.setEdgeStyle(BASE, 2, { stroke: "#dc2626" });
  assert.ok(out.endsWith("    linkStyle 2 stroke:#dc2626"));
  out = F.setEdgeStyle(out, 2, { stroke: null });
  assert.ok(!out.includes("linkStyle"));
  assert.throws(() => F.setEdgeStyle(BASE + "\n linkStyle 1,2 stroke:red", 2, { stroke: "blue" }), F.FlowEditError);
});

test("deleteNode removes edges, styles and class assignments", () => {
  const code = "flowchart LR\n A --> B & C\n B --> D\n style B fill:red\n class B,C warn\n classDef warn fill:#fee";
  const out = F.deleteNode(code, "B");
  assert.equal(out, "flowchart LR\n A --> C\n class C warn\n classDef warn fill:#fee");
  assert.equal(F.deleteNode("flowchart LR\n A --> B\n C", "C"), "flowchart LR\n A --> B");
});

test("unsafe lines are refused instead of guessed", () => {
  const code = "flowchart LR\n A --> B; B --> C";
  assert.throws(() => F.setNode(code, "B", "rect", "x"), F.FlowEditError);
  assert.throws(() => F.deleteNode(code, "B"), F.FlowEditError);
  // Nodes not mentioned on the complex line still work.
  assert.ok(F.setNode(code + "\n D[Alt] --> E", "D", "rect", "Neu").includes("D[Neu] --> E"));
});

test("nextId skips ids already used", () => {
  assert.equal(F.nextId("flowchart LR\n N1 --> N2\n N3"), "N4");
  assert.equal(F.nextId("flowchart LR\n N10 --> A"), "N1");
});

test("quoted edge labels may contain a pipe", () => {
  const code = F.setEdge("flowchart LR\n A --> B\n B --> C", 0, { label: "ja | nein" });
  assert.equal(code, 'flowchart LR\n A -->|"ja | nein"| B\n B --> C');
  assert.equal(F.scan(code).edges[0].label, "ja | nein");
  assert.equal(F.deleteNode(code, "A"), "flowchart LR\n B --> C");
});

test("edge numbers are not trusted when a line cannot be read (would hit the wrong arrow)", () => {
  const semi = "flowchart TD\n A --> B; B --> C\n C --> D\n D --> E";
  assert.throws(() => F.setEdge(semi, 1, { label: "X" }), F.FlowEditError);
  assert.throws(() => F.deleteEdge(semi, 0), F.FlowEditError);
  assert.throws(() => F.deleteNode(semi, "D"), F.FlowEditError);
  assert.throws(() => F.setEdgeStyle(semi, 1, { stroke: "red" }), F.FlowEditError);
  const comment = "flowchart TD\n A --> B %% Kommentar\n C --> D";
  assert.throws(() => F.deleteEdge(comment, 0), F.FlowEditError);
  // "A--text-->B" without spaces is no longer misread as two arrows via a phantom node "text"
  const tight = "flowchart LR\n A--text-->B\n B --> C";
  assert.ok(F.scan(tight).statements.some((s) => s.complex));
  assert.throws(() => F.deleteEdge(tight, 0), F.FlowEditError);
  // Node edits on readable lines still work.
  assert.ok(F.setNode(semi, "E", "rect", "Ende").includes("E[Ende]"));
});

test("expected start and end must match the edge", () => {
  const code = "flowchart LR\n A --> B\n B --> C";
  assert.throws(() => F.deleteEdge(code, 0, { from: "B", to: "C" }), F.FlowEditError);
  assert.equal(F.deleteEdge(code, 0, { from: "A", to: "B" }), "flowchart LR\n B --> C");
});

test("style values with commas inside parentheses stay intact", () => {
  const code = "flowchart LR\n A --> B\n style A fill:rgb(1,2,3),stroke:#000";
  assert.ok(F.setNodeStyle(code, "A", { color: "red" }).endsWith("style A fill:rgb(1,2,3),stroke:#000,color:red"));
});

test("flowchart-elk is not treated as a plain flowchart", () => {
  assert.equal(F.isFlowchart("flowchart-elk TD\n A --> B"), false);
  assert.equal(F.isFlowchart("flowchart TD\n A --> B"), true);
});

test("long arrows (---> and ===>) are read as one arrow", () => {
  const code = "flowchart LR\n A ---> B\n B ===> C\n C -.-> D";
  const info = F.scan(code);
  assert.ok(!info.statements.some((s) => s.complex));
  assert.deepEqual(info.edges.map((e) => e.from + ">" + e.to + ":" + e.op), ["A>B:--->", "B>C:===>", "C>D:-.->"]);
  assert.equal(F.deleteEdge(code, 0, { from: "A", to: "B" }), "flowchart LR\n B ===> C\n C -.-> D");
});

test("setEdgeStyle checks the expected edge", () => {
  const code = "flowchart LR\n A --> B\n B --> C";
  assert.throws(() => F.setEdgeStyle(code, 0, { stroke: "red" }, { from: "B", to: "C" }), F.FlowEditError);
  assert.ok(F.setEdgeStyle(code, 1, { stroke: "red" }, { from: "B", to: "C" }).endsWith("linkStyle 1 stroke:red"));
});
