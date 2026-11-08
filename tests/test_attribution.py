# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Janne Cadamuro / LabMed Alliance Inc. — see LICENSE and NOTICE
"""Licence, attribution and LMA branding stay in place (see NOTICE)."""

import secrets
import sqlite3
import tomllib
from pathlib import Path

import pytest
from werkzeug.security import generate_password_hash

import attribution
from app import HTML_PAGES, create_app

ROOT = Path(__file__).resolve().parent.parent
ICONS = ["lma-logo-mark.svg", "favicon-16.png", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png"]
PASSWORD = secrets.token_urlsafe(16)  # generated per run, no credential-like literal


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


@pytest.fixture
def client(tmp_path):
    app = create_app({"DB": str(tmp_path / "t.db"), "SECRET_KEY": "test", "SESSION_COOKIE_SECURE": False})
    with sqlite3.connect(app.config["DB"]) as conn:
        conn.execute(
            "INSERT INTO users (username, password_hash, is_admin, created) VALUES ('anna', ?, 1, '2026-01-01')",
            (generate_password_hash(PASSWORD),),
        )
    client = app.test_client()
    assert client.post("/api/login", json={"username": "anna", "password": PASSWORD}).status_code == 200
    return client


def test_version_and_licence_match_pyproject():
    project = tomllib.loads(read("pyproject.toml"))["project"]
    assert attribution.VERSION == project["version"]
    assert attribution.LICENSE_SPDX == project["license"]


def test_licence_notice_and_logo_files_exist():
    assert "GNU AFFERO GENERAL PUBLIC LICENSE" in read("LICENSE")
    assert "Powered by LabMed Alliance" in read("NOTICE")
    for name in ICONS:
        assert (ROOT / "static" / "img" / name).is_file(), name


def test_every_page_has_the_credit_placeholder():
    for name in HTML_PAGES:
        assert read(f"static/{name}").count("{{CREDIT}}") == 1, name


@pytest.mark.parametrize("path", ["/", "/edit", "/admin", "/help", "/login", "/about", "/v/unknown"])
def test_every_page_renders_the_credit(client, path):
    resp = client.get(path)
    assert resp.status_code == 200
    html = resp.get_data(as_text=True)
    assert "Powered by LabMed Alliance" in html
    assert 'href="about"' in html
    assert attribution.LOGO_PATH in html
    assert "{{" not in html.split("<main")[0]  # all placeholders in the page head and header are filled


def test_about_page_needs_no_login_and_offers_the_source(tmp_path):
    app = create_app({"DB": str(tmp_path / "t.db"), "SECRET_KEY": "test"})
    html = app.test_client().get("/about").get_data(as_text=True)
    assert f"{attribution.APP_NAME} {attribution.VERSION}" in html
    assert attribution.SOURCE_URL in html
    assert attribution.LICENSE_SPDX in html
    assert "Copyright © 2026 Janne Cadamuro / LabMed Alliance Inc." in html


def test_every_source_file_carries_the_spdx_header():
    files = [ROOT / "app.py", ROOT / "attribution.py", ROOT / "tools" / "flow-diagram", ROOT / "static" / "css" / "app.css"]
    files += sorted((ROOT / "static" / "js").glob("*.js"))
    files += sorted((ROOT / "tests").glob("*.py")) + sorted((ROOT / "tests" / "js").glob("*.js"))
    missing = [str(f.relative_to(ROOT)) for f in files if "SPDX-License-Identifier: AGPL-3.0-or-later" not in f.read_text()]
    assert missing == []
