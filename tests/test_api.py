"""API tests: accounts, permissions, sharing, conflicts, public links."""

import secrets
import sqlite3

import pytest
from werkzeug.security import generate_password_hash

from app import create_app

DIAGRAM = {"name": "Präanalytik", "code": "flowchart TD\n A --> B", "theme": "default", "look": "classic"}
# Generated per run, so no credential-like literals end up in the repository.
PASSWORD = secrets.token_urlsafe(16)
OTHER_PASSWORD = secrets.token_urlsafe(16)


@pytest.fixture
def app(tmp_path):
    app = create_app({"DB": str(tmp_path / "t.db"), "SECRET_KEY": "test", "SESSION_COOKIE_SECURE": False})
    with sqlite3.connect(app.config["DB"]) as conn:
        for name, admin in (("anna", 1), ("ben", 0), ("cleo", 0)):
            conn.execute(
                "INSERT INTO users (username, password_hash, is_admin, created) VALUES (?, ?, ?, '2026-01-01')",
                (name, generate_password_hash(PASSWORD), admin),
            )
    return app


def login(app, name):
    client = app.test_client()
    resp = client.post("/api/login", json={"username": name, "password": PASSWORD})
    assert resp.status_code == 200
    return client


def uid(client):
    return client.get("/api/me").json["id"]


@pytest.fixture
def anna(app):
    return login(app, "anna")


@pytest.fixture
def ben(app):
    return login(app, "ben")


@pytest.fixture
def cleo(app):
    return login(app, "cleo")


def create(client, **extra):
    resp = client.post("/api/diagrams", json={**DIAGRAM, **extra})
    assert resp.status_code == 201
    return resp.json


# ---------- login ----------


def test_needs_secret_key(tmp_path):
    with pytest.raises(RuntimeError):
        create_app({"DB": str(tmp_path / "t.db"), "SECRET_KEY": None})


def test_pages_and_api_need_login(app):
    client = app.test_client()
    assert client.get("/api/diagrams").status_code == 401
    assert client.get("/").status_code == 302
    assert client.get("/edit").status_code == 302
    assert client.get("/login").status_code == 200


def test_login_failure_does_not_reveal_users(app):
    client = app.test_client()
    known = client.post("/api/login", json={"username": "ben", "password": "x" * 12})
    unknown = client.post("/api/login", json={"username": "niemand", "password": "x" * 12})
    assert known.status_code == unknown.status_code == 401
    assert known.json == unknown.json


def test_ip_limit_blocks_even_right_password(app):
    client = app.test_client()
    for _ in range(10):
        assert client.post("/api/login", json={"username": "niemand", "password": "x" * 12}).status_code == 401
    # This IP is blocked for a while now – also for a real account with the right password.
    assert client.post("/api/login", json={"username": "ben", "password": PASSWORD}).status_code == 401


def test_account_lock_after_many_failures(app):
    with sqlite3.connect(app.config["DB"]) as conn:
        conn.execute("UPDATE users SET failed_logins = 49 WHERE username = 'ben'")
    client = app.test_client()
    client.post("/api/login", json={"username": "ben", "password": "x" * 12})
    other_ip = app.test_client()
    resp = other_ip.post(
        "/api/login", json={"username": "ben", "password": PASSWORD}, environ_base={"REMOTE_ADDR": "10.0.0.9"}
    )
    assert resp.status_code == 401


def test_password_change_ends_other_sessions(app):
    first, second = login(app, "ben"), login(app, "ben")
    resp = first.put("/api/me/password", json={"old": PASSWORD, "new": OTHER_PASSWORD})
    assert resp.status_code == 200
    assert first.get("/api/me").status_code == 200
    assert second.get("/api/me").status_code == 401


def test_rejects_non_json_writes(anna):
    resp = anna.post("/api/diagrams", data='{"name":"x","code":""}', content_type="text/plain")
    assert resp.status_code == 415


def test_static_files_do_not_expose_server_files(anna):
    assert anna.get("/js/app.js").status_code == 200
    assert anna.get("/app.py").status_code == 404
    assert anna.get("/index.html").status_code == 404  # only via "/", with <base> filled in
    assert b'<base href="/">' in anna.get("/").data
    assert anna.get("/css/../index.html").status_code == 404
    assert "img-src 'self' data: blob:" in anna.get("/").headers["Content-Security-Policy"]
    assert "frame-ancestors 'self'" in anna.get("/").headers["Content-Security-Policy"]
    assert anna.get("/").headers["X-Frame-Options"] == "SAMEORIGIN"


# ---------- diagrams and permissions ----------


@pytest.mark.parametrize(
    "payload",
    [{**DIAGRAM, "name": "  "}, {**DIAGRAM, "name": "x" * 201}, {**DIAGRAM, "code": "x" * 50_001}, {**DIAGRAM, "theme": "evil"}, {**DIAGRAM, "code": 42}],
)
def test_rejects_invalid_payload(anna, payload):
    assert anna.post("/api/diagrams", json=payload).status_code == 400


def test_private_by_default(anna, ben):
    d = create(anna)
    assert ben.get(f"/api/diagrams/{d['id']}").status_code == 404
    assert ben.put(f"/api/diagrams/{d['id']}", json={**DIAGRAM, "version": 1}).status_code == 404
    assert ben.get("/api/diagrams").json == []


def test_view_role_reads_but_cannot_write(anna, ben):
    d = create(anna)
    anna.put(f"/api/diagrams/{d['id']}/access/{uid(ben)}", json={"role": "view"})
    got = ben.get(f"/api/diagrams/{d['id']}").json
    assert got["role"] == "view" and "public_token" not in got
    assert ben.put(f"/api/diagrams/{d['id']}", json={**DIAGRAM, "version": 1}).status_code == 403
    assert ben.delete(f"/api/diagrams/{d['id']}").status_code == 403
    assert ben.get(f"/api/diagrams/{d['id']}/access").status_code == 403


def test_edit_role_writes_but_cannot_share_or_delete(anna, ben, cleo):
    d = create(anna)
    anna.put(f"/api/diagrams/{d['id']}/access/{uid(ben)}", json={"role": "edit"})
    resp = ben.put(f"/api/diagrams/{d['id']}", json={**DIAGRAM, "code": "pie\n \"a\" : 1", "version": 1})
    assert resp.status_code == 200 and resp.json["version"] == 2 and resp.json["updated_by"] == "ben"
    assert ben.put(f"/api/diagrams/{d['id']}/access/{uid(cleo)}", json={"role": "edit"}).status_code == 403
    assert ben.post(f"/api/diagrams/{d['id']}/public", json={}).status_code == 403
    assert ben.delete(f"/api/diagrams/{d['id']}").status_code == 403
    assert ben.get("/api/diagrams").json[0]["role"] == "edit"


def test_remove_access(anna, ben):
    d = create(anna)
    anna.put(f"/api/diagrams/{d['id']}/access/{uid(ben)}", json={"role": "edit"})
    anna.delete(f"/api/diagrams/{d['id']}/access/{uid(ben)}")
    assert ben.get(f"/api/diagrams/{d['id']}").status_code == 404


def test_version_conflict(anna, ben):
    d = create(anna)
    anna.put(f"/api/diagrams/{d['id']}/access/{uid(ben)}", json={"role": "edit"})
    assert ben.put(f"/api/diagrams/{d['id']}", json={**DIAGRAM, "code": "von ben", "version": 1}).status_code == 200
    stale = anna.put(f"/api/diagrams/{d['id']}", json={**DIAGRAM, "code": "von anna", "version": 1})
    assert stale.status_code == 409
    assert stale.json["current"]["code"] == "von ben" and stale.json["current"]["version"] == 2
    # Overwrite on purpose with the version just received.
    assert anna.put(f"/api/diagrams/{d['id']}", json={**DIAGRAM, "code": "von anna", "version": 2}).status_code == 200


# ---------- public links ----------


def test_public_link_lifecycle(app, anna):
    d = create(anna)
    token = anna.post(f"/api/diagrams/{d['id']}/public", json={}).json["public_token"]
    guest = app.test_client()
    assert guest.get(f"/api/public/{token}").json["code"] == DIAGRAM["code"]
    assert guest.get(f"/v/{token}").status_code == 200
    assert guest.get(f"/api/diagrams/{d['id']}").status_code == 401
    anna.delete(f"/api/diagrams/{d['id']}/public")
    assert guest.get(f"/api/public/{token}").status_code == 404


# ---------- admin ----------


def test_admin_only(ben):
    assert ben.get("/api/admin/users").status_code == 403
    assert ben.post("/api/admin/users", json={"username": "x", "password": PASSWORD}).status_code == 403


def test_admin_manages_users(app, anna):
    assert anna.post("/api/admin/users", json={"username": "dora", "password": "x" * 5}).status_code == 400
    assert anna.post("/api/admin/users", json={"username": "dora", "password": PASSWORD}).status_code == 201
    assert anna.post("/api/admin/users", json={"username": "DORA", "password": PASSWORD}).status_code == 409
    dora = login(app, "dora")
    dora_id = uid(dora)
    create(dora)
    assert anna.put(f"/api/admin/users/{dora_id}/password", json={"password": OTHER_PASSWORD}).status_code == 200
    assert dora.get("/api/me").status_code == 401  # reset ends her sessions
    assert anna.delete(f"/api/admin/users/{dora_id}").status_code == 204
    assert anna.delete(f"/api/admin/users/{uid(anna)}").status_code == 400
    with sqlite3.connect(app.config["DB"]) as conn:
        assert conn.execute("SELECT COUNT(*) FROM diagrams").fetchone()[0] == 0


def test_cli_create_user(app):
    runner = app.test_cli_runner()
    result = runner.invoke(args=["create-user", "eva", "--admin", "--password", PASSWORD])
    assert result.exit_code == 0, result.output
    assert login(app, "eva").get("/api/me").json["is_admin"] is True


def test_proxy_without_forwarded_for_skips_ip_limit(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOW_PROXY_HOPS", "1")
    app = create_app({"DB": str(tmp_path / "p.db"), "SECRET_KEY": "test", "SESSION_COOKIE_SECURE": False})
    with sqlite3.connect(app.config["DB"]) as conn:
        conn.execute(
            "INSERT INTO users (username, password_hash, created) VALUES ('ben', ?, '2026-01-01')",
            (generate_password_hash(PASSWORD),),
        )
    client = app.test_client()
    for _ in range(12):
        client.post("/api/login", json={"username": "niemand", "password": "x" * 12})
    assert client.post("/api/login", json={"username": "ben", "password": PASSWORD}).status_code == 200
    # With the header, the real client IP is limited.
    hdr = {"X-Forwarded-For": "203.0.113.7"}
    for _ in range(10):
        client.post("/api/login", json={"username": "niemand", "password": "x" * 12}, headers=hdr)
    assert client.post("/api/login", json={"username": "ben", "password": PASSWORD}, headers=hdr).status_code == 401
    other = {"X-Forwarded-For": "203.0.113.8"}
    assert client.post("/api/login", json={"username": "ben", "password": PASSWORD}, headers=other).status_code == 200


def test_start_page_and_editor_routes(anna):
    assert b'src="js/home.js"' in anna.get("/").data
    assert b'src="js/app.js"' in anna.get("/edit").data
    assert anna.get("/home.html").status_code == 404
    old_link = anna.get("/?id=7")  # editor links from before the start page existed
    assert old_link.status_code == 302 and old_link.headers["Location"].endswith("/edit?id=7")
    assert anna.get("/?id=%C2%B2").status_code == 200  # non-ASCII digits: start page, no redirect


def test_help_page_is_public(app):
    resp = app.test_client().get("/help")
    assert resp.status_code == 200 and b'src="js/help.js"' in resp.data
