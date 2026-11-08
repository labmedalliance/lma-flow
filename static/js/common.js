// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Janne Cadamuro / LabMed Alliance Inc. — see LICENSE and NOTICE
/* Helpers shared by all Flow pages. */
window.Flow = (function () {
  "use strict";

  /**
   * Call the JSON API. Throws an Error with .status and .data on HTTP errors.
   * A 401 sends the browser to the login page unless noRedirect is set.
   */
  async function api(path, method, body, noRedirect) {
    const opts = { method: method || "GET", headers: {}, credentials: "same-origin" };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch(path, opts);
    const data = resp.status === 204 ? null : await resp.json().catch(() => null);
    if (resp.status === 401 && !noRedirect) {
      location.href = "login";
      throw new Error("Nicht angemeldet.");
    }
    if (!resp.ok) {
      const err = new Error((data && data.error) || "Fehler " + resp.status);
      err.status = resp.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  let toastTimer = null;
  function toast(message) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
  }

  /** Natural size of a rendered diagram, taken from its viewBox. */
  function svgSize(svg) {
    const vb = svg.viewBox && svg.viewBox.baseVal;
    if (vb && vb.width) return { w: vb.width, h: vb.height };
    const box = svg.getBoundingClientRect();
    return { w: box.width, h: box.height };
  }

  /** Scale an SVG; scale null = fit into container (max 1.5x). */
  function sizeSvg(svg, container, scale) {
    const { w, h } = svgSize(svg);
    if (scale === null || scale === undefined) {
      const pad = 32;
      scale = Math.min((container.clientWidth - pad) / w, (container.clientHeight - pad) / h, 1.5);
      scale = Math.max(scale, 0.1);
    }
    svg.style.width = Math.round(w * scale) + "px";
    svg.style.height = Math.round(h * scale) + "px";
    svg.style.maxWidth = "none";
  }

  function initMermaid(theme, look) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: theme, look: look });
  }

  return { api, toast, svgSize, sizeSvg, initMermaid };
})();
