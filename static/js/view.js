// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Janne Cadamuro / LabMed Alliance Inc. — see LICENSE and NOTICE
/* Public read-only view: v/<token>, works without login. */
(function () {
  "use strict";

  const { svgSize, sizeSvg, initMermaid } = window.Flow;
  const $ = (id) => document.getElementById(id);
  const viewport = $("viewport");
  let zoom = null;

  function svg() {
    return $("preview").querySelector("svg");
  }

  function apply() {
    if (svg()) sizeSvg(svg(), viewport, zoom);
  }

  function changeZoom(factor) {
    if (!svg()) return;
    const current = parseFloat(svg().style.width) / svgSize(svg()).w || 1;
    zoom = Math.min(Math.max(current * factor, 0.1), 8);
    apply();
  }

  function fail(message) {
    viewport.hidden = true;
    $("view-error").textContent = message;
    $("view-error").hidden = false;
  }

  async function start() {
    const token = location.pathname.split("/").filter(Boolean).pop();
    let d;
    try {
      const resp = await fetch("api/public/" + encodeURIComponent(token));
      d = await resp.json();
      if (!resp.ok) return fail(d.error || "Diagramm nicht gefunden.");
    } catch (e) {
      return fail("Diagramm konnte nicht geladen werden.");
    }
    $("view-title").textContent = d.name;
    document.title = d.name + " – LMA Flow";
    try {
      initMermaid(d.theme, d.look);
      const out = await mermaid.render("flow-view", d.code);
      $("preview").innerHTML = out.svg;
      apply();
    } catch (e) {
      fail("Das Diagramm enthält einen Fehler und kann nicht angezeigt werden.");
    }
  }

  $("zoom-in").addEventListener("click", () => changeZoom(1.25));
  $("zoom-out").addEventListener("click", () => changeZoom(0.8));
  $("zoom-fit").addEventListener("click", () => { zoom = null; apply(); });
  window.addEventListener("resize", () => { if (zoom === null) apply(); });
  start();
})();
