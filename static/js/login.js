// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Janne Cadamuro / LabMed Alliance Inc. — see LICENSE and NOTICE
/* Login page: send credentials, then go to the editor. */
(function () {
  "use strict";

  const form = document.getElementById("login-form");
  const errorEl = document.getElementById("login-error");

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    errorEl.hidden = true;
    try {
      await window.Flow.api("api/login", "POST", {
        username: document.getElementById("username").value,
        password: document.getElementById("password").value,
      }, true);
      location.href = "./";
    } catch (e) {
      errorEl.textContent = e.message;
      errorEl.hidden = false;
    }
  });
})();
