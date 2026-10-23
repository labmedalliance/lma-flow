/*
 * Help page: renders every example next to its code and adds
 * "Kopieren" and "Ausprobieren" (opens the example in the editor).
 */
(function () {
  "use strict";

  const { toast, initMermaid } = window.Flow;
  const HANDOFF = "flow.handoff"; // read once by the editor (app.js)
  let renderCount = 0;

  async function renderInto(box, code) {
    const id = "help-" + renderCount++;
    try {
      const { svg } = await mermaid.render(id, code);
      box.innerHTML = svg;
    } catch (e) {
      box.textContent = "Vorschau fehlgeschlagen";
      const leftover = document.getElementById("d" + id);
      if (leftover) leftover.remove();
    }
  }

  function tryInEditor(code) {
    try {
      sessionStorage.setItem(HANDOFF, code);
    } catch (e) {
      return toast("Der Browser blockiert den Speicher – bitte „Kopieren“ nutzen.");
    }
    location.href = "edit?new=1&from=help";
  }

  async function copy(code) {
    try {
      await navigator.clipboard.writeText(code);
      toast("Code kopiert.");
    } catch (e) {
      toast("Kopieren nicht möglich.");
    }
  }

  function buttons(code) {
    const row = document.createElement("div");
    row.className = "example-actions";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.textContent = "Kopieren";
    copyBtn.addEventListener("click", () => copy(code));
    const tryBtn = document.createElement("button");
    tryBtn.type = "button";
    tryBtn.textContent = "Ausprobieren";
    tryBtn.addEventListener("click", () => tryInEditor(code));
    row.append(copyBtn, tryBtn);
    return row;
  }

  /** Full examples: code on the left, preview on the right. */
  function prepareExamples() {
    return [...document.querySelectorAll(".example")].map((el) => {
      const code = el.querySelector(".example-code").textContent;
      const preview = document.createElement("div");
      preview.className = "example-preview";
      el.append(preview, buttons(code));
      return { box: preview, code };
    });
  }

  /** Shape tiles: the snippet is wrapped into a one-node flowchart. */
  function prepareShapes() {
    return [...document.querySelectorAll(".shape")].map((el) => {
      const snippet = el.querySelector("code").textContent;
      const code = "flowchart LR\n    " + snippet;
      const preview = document.createElement("div");
      preview.className = "shape-preview";
      el.prepend(preview);
      el.append(buttons(code));
      return { box: preview, code };
    });
  }

  async function start() {
    initMermaid("default", "classic");
    const jobs = [...prepareShapes(), ...prepareExamples()];
    for (const job of jobs) await renderInto(job.box, job.code); // mermaid renders one at a time
  }

  start();
})();
