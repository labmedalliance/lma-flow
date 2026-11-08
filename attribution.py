# SPDX-License-Identifier: AGPL-3.0-or-later
"""LMA Flow — provenance, licence and mandatory LabMed Alliance attribution.

Copyright (C) 2026 Janne Cadamuro / LabMed Alliance Inc.

This program is free software: you can redistribute it and/or modify it
under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or (at your
option) any later version, together with the additional terms under
section 7 stated in the NOTICE file.

This program is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public
License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.

The constants below are the single source of truth for who built this app,
under which licence it may be used, and where its source lives. They are
hard-coded on purpose and rendered by `app.py` into the footer credit of
every page (`{{CREDIT}}`) and into `/about` (`static/about.html`). The
NOTICE file makes that credit a licence condition (AGPL section 7(b)):
forks must keep it visible. Add your own credits next to it — do not remove
or hide the original ones.
"""

from html import escape

APP_NAME = "LMA Flow"
VERSION = "1.0.0"

AUTHOR = "Janne Cadamuro"
ORGANIZATION = "LabMed Alliance Inc."
ORGANIZATION_SHORT = "LabMed Alliance"
ORGANIZATION_URL = "https://labmedalliance.com"
COPYRIGHT_HOLDER = f"{AUTHOR} / {ORGANIZATION}"
COPYRIGHT_YEAR = 2026

LICENSE_SPDX = "AGPL-3.0-or-later"
LICENSE_NAME = "GNU Affero General Public License v3.0 or later"
LICENSE_URL = "https://www.gnu.org/licenses/agpl-3.0.html"

#: Public source of this app — the AGPL section 13 source offer for network
#: users. Forks that run a modified version must point this at their own repo.
SOURCE_URL = "https://github.com/labmedalliance/lma-flow"

#: The LabMed Alliance logo (not covered by the AGPL, see NOTICE term 3).
LOGO_PATH = "img/lma-logo-mark.svg"


def credit_html():
    """Mandatory footer credit (NOTICE term 1(a)) - do not remove or hide."""
    return (
        '<span class="app-credit">'
        f'<a class="lma-credit" href="{escape(ORGANIZATION_URL)}" rel="noopener">'
        f'<img class="lma-logo" src="{LOGO_PATH}" alt="" width="16" height="16">'
        f"<span>Powered by {escape(ORGANIZATION_SHORT)}</span></a>"
        f' · <a href="about">Über {escape(APP_NAME)}</a>'
        f' · <a href="about">Open Source, {escape(LICENSE_SPDX)}</a>'
        "</span>"
    )


def placeholders():
    """Values for the {{…}} placeholders in the HTML pages."""
    return {
        "{{CREDIT}}": credit_html(),
        "{{APP_NAME}}": escape(APP_NAME),
        "{{VERSION}}": escape(VERSION),
        "{{AUTHOR}}": escape(AUTHOR),
        "{{ORGANIZATION}}": escape(ORGANIZATION),
        "{{ORGANIZATION_SHORT}}": escape(ORGANIZATION_SHORT),
        "{{ORGANIZATION_URL}}": escape(ORGANIZATION_URL),
        "{{COPYRIGHT}}": escape(f"Copyright © {COPYRIGHT_YEAR} {COPYRIGHT_HOLDER}"),
        "{{LICENSE_SPDX}}": escape(LICENSE_SPDX),
        "{{LICENSE_NAME}}": escape(LICENSE_NAME),
        "{{LICENSE_URL}}": escape(LICENSE_URL),
        "{{SOURCE_URL}}": escape(SOURCE_URL),
    }
