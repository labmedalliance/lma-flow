# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Janne Cadamuro / LabMed Alliance Inc. — see LICENSE and NOTICE
"""LMA Flow – self-hosted diagram editor with accounts, sharing and SQLite storage.

Serves the static pages from ``static/`` and a JSON API.

Roles per diagram:
    owner  – full access, manages sharing, can delete
    edit   – may change name, code, theme and look
    view   – read only (may still save a copy of their own)
A diagram can also get a public read-only link (``v/<token>``) that works
without login. Saving uses optimistic locking: a stale ``version`` gets 409.

Configuration (environment variables or ``.env`` next to this file):

``FLOW_SECRET_KEY``  signs the session cookie (required)
``FLOW_DB``          SQLite file, default ``instance/flow.db``
``FLOW_BASE_PATH``   URL prefix the app is served under, default ``/``
``FLOW_DEV=1``       local development: allows the session cookie over plain HTTP
``FLOW_PROXY_HOPS``  number of trusted reverse proxies in front (Uberspace 8: 2), for the client IP

Create the first admin with ``flask --app app create-user <name> --admin``.
"""

import os
import posixpath
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path

import click
from flask import Flask, abort, g, jsonify, redirect, request, send_from_directory, session
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

import attribution

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
HTML_PAGES = {"home.html", "index.html", "login.html", "admin.html", "view.html", "help.html", "about.html"}

MAX_CODE_CHARS = 50_000  # mermaid's default maxTextSize – longer code would not render anyway
MAX_NAME_CHARS = 200
MIN_PASSWORD_CHARS = 10
MAX_FAILED_LOGINS = 50  # per account – high, so nobody can lock others out easily
MAX_IP_FAILURES = 10  # per client IP and window
LOCK_MINUTES = 15
LOGIN_FAILED = "Anmeldung fehlgeschlagen. Prüfe Benutzername und Passwort. Nach vielen Fehlversuchen ist die Anmeldung für 15 Minuten gesperrt."
# Mermaid needs inline styles; no inline scripts anywhere. img-src blocks external (tracking) images in diagrams.
# frame-ancestors 'self': the craft overview on the same host may embed Flow, foreign sites may not.
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
    "connect-src 'self'; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; "
    "form-action 'self'; frame-ancestors 'self'"
)
THEMES = {"default", "neutral", "forest", "dark", "base"}
LOOKS = {"classic", "handDrawn"}
ROLES = {"view", "edit"}

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    session_gen   INTEGER NOT NULL DEFAULT 0,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until  TEXT,
    created       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS diagrams (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    code         TEXT NOT NULL,
    theme        TEXT NOT NULL DEFAULT 'default',
    look         TEXT NOT NULL DEFAULT 'classic',
    version      INTEGER NOT NULL DEFAULT 1,
    public_token TEXT UNIQUE,
    created      TEXT NOT NULL,
    updated      TEXT NOT NULL,
    updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS diagram_access (
    diagram_id INTEGER NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('view', 'edit')),
    PRIMARY KEY (diagram_id, user_id)
);
"""


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_env_file(path):
    """Read KEY=VALUE lines from ``path`` into os.environ (existing values win)."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def connect(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA secure_delete = ON")  # overwrite deleted diagrams in the file
    return conn


class IpThrottle:
    """Counts failed logins per client IP in memory (per worker process, reset on restart)."""

    def __init__(self, limit, window_seconds):
        self.limit, self.window = limit, window_seconds
        self.failures = {}
        self.lock = threading.Lock()

    def _recent(self, ip, now_ts):
        return [t for t in self.failures.get(ip, []) if now_ts - t < self.window]

    def blocked(self, ip):
        with self.lock:
            recent = self._recent(ip, time.monotonic())
            self.failures[ip] = recent
            return len(recent) >= self.limit

    def fail(self, ip):
        with self.lock:
            now_ts = time.monotonic()
            self.failures[ip] = self._recent(ip, now_ts) + [now_ts]


def create_app(config=None):
    """Build the Flask app. ``config`` overrides environment settings (tests)."""
    load_env_file(BASE_DIR / ".env")
    app = Flask(__name__, static_folder=None)
    dev = os.environ.get("FLOW_DEV") == "1"
    app.config.update(
        SECRET_KEY=os.environ.get("FLOW_SECRET_KEY"),
        DB=os.environ.get("FLOW_DB", str(BASE_DIR / "instance" / "flow.db")),
        BASE_PATH=os.environ.get("FLOW_BASE_PATH", "/"),
        MAX_CONTENT_LENGTH=1024 * 1024,
        SESSION_COOKIE_NAME="flow_session",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=not dev,
        PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    )
    app.config.update(config or {})
    if not app.config["SECRET_KEY"]:
        raise RuntimeError("FLOW_SECRET_KEY is not set (see README).")
    base = app.config["BASE_PATH"].rstrip("/") + "/"
    app.config["SESSION_COOKIE_PATH"] = base
    hops = int(os.environ.get("FLOW_PROXY_HOPS", "0"))
    if hops:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=hops)
    throttle = IpThrottle(MAX_IP_FAILURES, LOCK_MINUTES * 60)
    dummy_hash = generate_password_hash(secrets.token_urlsafe(16))  # equal timing for unknown users

    Path(app.config["DB"]).parent.mkdir(parents=True, exist_ok=True)
    with connect(app.config["DB"]) as conn:
        conn.executescript(SCHEMA)

    # ---------- helpers ----------

    def db():
        if "db" not in g:
            g.db = connect(app.config["DB"])
        return g.db

    @app.teardown_appcontext
    def close_db(_exc):
        conn = g.pop("db", None)
        if conn is not None:
            conn.close()

    def current_user():
        """The logged-in user row, or None. Sessions die when the password changes."""
        if "user" in g:
            return g.user
        g.user = None
        uid = session.get("uid")
        if uid is not None:
            row = db().execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
            if row and row["session_gen"] == session.get("gen"):
                g.user = row
            else:
                session.clear()
        return g.user

    def login_required(view):
        @wraps(view)
        def wrapper(*args, **kwargs):
            if current_user() is None:
                abort(401)
            return view(*args, **kwargs)

        return wrapper

    def admin_required(view):
        @wraps(view)
        @login_required
        def wrapper(*args, **kwargs):
            if not current_user()["is_admin"]:
                abort(403)
            return view(*args, **kwargs)

        return wrapper

    @app.before_request
    def json_only_writes():
        """API writes must be JSON. Cross-site HTML forms cannot send that."""
        if request.path.startswith("/api/") and request.method in ("POST", "PUT") and not request.is_json:
            abort(415)

    @app.after_request
    def security_headers(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        resp.headers.setdefault("X-Robots-Tag", "noindex, nofollow")
        resp.headers.setdefault("Content-Security-Policy", CSP)
        if request.path.startswith("/api/"):
            resp.headers.setdefault("Cache-Control", "no-store")
        return resp

    @app.errorhandler(400)
    @app.errorhandler(401)
    @app.errorhandler(403)
    @app.errorhandler(404)
    @app.errorhandler(409)
    @app.errorhandler(415)
    def json_error(err):
        if request.path.startswith("/api/"):
            return jsonify(error=err.description), err.code
        return err

    def body():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            abort(400, "Ungültige Anfrage.")
        return data

    def page(name):
        """Serve an HTML page with the right <base href>, the LMA credit and the app details filled in."""
        html = (STATIC_DIR / name).read_text(encoding="utf-8").replace("{{BASE}}", base)
        for key, value in attribution.placeholders().items():
            html = html.replace(key, value)
        return html, 200, {"Content-Type": "text/html; charset=utf-8"}

    def validate_password(pw):
        if not isinstance(pw, str) or len(pw) < MIN_PASSWORD_CHARS:
            abort(400, f"Das Passwort braucht mindestens {MIN_PASSWORD_CHARS} Zeichen.")
        return pw

    def validate_diagram(data):
        name = str(data.get("name", "")).strip()
        code = data.get("code", "")
        theme = data.get("theme", "default")
        look = data.get("look", "classic")
        if not name or len(name) > MAX_NAME_CHARS:
            abort(400, "Name fehlt oder ist zu lang.")
        if not isinstance(code, str) or len(code) > MAX_CODE_CHARS:
            abort(400, "Code fehlt oder ist zu lang.")
        if theme not in THEMES or look not in LOOKS:
            abort(400, "Unbekanntes Theme oder Stil.")
        return {"name": name, "code": code, "theme": theme, "look": look}

    def role_for(diagram, user):
        if diagram["owner_id"] == user["id"]:
            return "owner"
        row = db().execute(
            "SELECT role FROM diagram_access WHERE diagram_id = ? AND user_id = ?", (diagram["id"], user["id"])
        ).fetchone()
        return row["role"] if row else None

    def load_diagram(diagram_id, need="view"):
        """Fetch a diagram the current user may access. 404 if they may not even see it."""
        row = db().execute("SELECT * FROM diagrams WHERE id = ?", (diagram_id,)).fetchone()
        role = role_for(row, current_user()) if row else None
        if role is None:
            abort(404, "Diagramm nicht gefunden.")
        allowed = {"view": {"view", "edit", "owner"}, "edit": {"edit", "owner"}, "owner": {"owner"}}[need]
        if role not in allowed:
            abort(403, "Dafür fehlt dir die Berechtigung.")
        return row, role

    def diagram_json(row, role):
        names = db().execute(
            "SELECT (SELECT username FROM users WHERE id = ?) AS owner, (SELECT username FROM users WHERE id = ?) AS by",
            (row["owner_id"], row["updated_by"]),
        ).fetchone()
        data = {
            "id": row["id"],
            "name": row["name"],
            "code": row["code"],
            "theme": row["theme"],
            "look": row["look"],
            "version": row["version"],
            "updated": row["updated"],
            "updated_by": names["by"],
            "owner": names["owner"],
            "role": role,
        }
        if role == "owner":
            data["public_token"] = row["public_token"]
        return data

    # ---------- pages ----------

    @app.get("/")
    def home():
        """Start page: the latest diagrams. Old editor links (?id=…) move on to the editor."""
        old_id = request.args.get("id", "")
        if old_id.isascii() and old_id.isdigit():
            return redirect(base + "edit?id=" + old_id)
        if current_user() is None:
            return redirect(base + "login")
        return page("home.html")

    @app.get("/edit")
    def editor():
        if current_user() is None:
            return redirect(base + "login")
        return page("index.html")

    @app.get("/login")
    def login_page():
        return page("login.html")

    @app.get("/admin")
    def admin_page():
        if current_user() is None:
            return redirect(base + "login")
        return page("admin.html")

    @app.get("/help")
    def help_page():
        """Syntax help with live examples – no data, so no login needed."""
        return page("help.html")

    @app.get("/v/<token>")
    def public_page(token):
        return page("view.html")

    @app.get("/about")
    def about_page():
        """Name, authors, licence and source offer (NOTICE term 1(b), AGPL section 13) - no login needed."""
        return page("about.html")

    @app.get("/licenses")
    def licenses():
        return send_from_directory(BASE_DIR, "THIRD_PARTY_NOTICES.md", mimetype="text/plain")

    @app.get("/<path:filename>")
    def static_files(filename):
        if posixpath.basename(posixpath.normpath(filename)) in HTML_PAGES:
            abort(404)  # pages only via their routes, with <base> filled in
        return send_from_directory(STATIC_DIR, filename)

    # ---------- session ----------

    @app.post("/api/login")
    def login():
        data = body()
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        # Behind a proxy without X-Forwarded-For all clients share one address – then skip the IP limit
        # rather than let one attacker lock everybody out. The per-account lock still applies.
        ip = None if hops and "X-Forwarded-For" not in request.headers else request.remote_addr
        if ip and throttle.blocked(ip):
            abort(401, LOGIN_FAILED)
        conn = db()
        user = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        # Always hash once, so response time does not tell whether the user exists.
        password_ok = check_password_hash(user["password_hash"] if user else dummy_hash, password)
        locked = bool(user and user["locked_until"] and user["locked_until"] > now())
        if not password_ok or locked:
            if ip:
                throttle.fail(ip)
            if user and not password_ok:
                conn.execute("UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ?", (user["id"],))
                lock_until = (datetime.now(timezone.utc) + timedelta(minutes=LOCK_MINUTES)).isoformat(
                    timespec="seconds"
                )
                conn.execute(
                    "UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ? AND failed_logins >= ?",
                    (lock_until, user["id"], MAX_FAILED_LOGINS),
                )
                conn.commit()
            abort(401, LOGIN_FAILED)  # same message for every failure reason
        conn.execute("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?", (user["id"],))
        conn.commit()
        session.clear()
        session.permanent = True
        session["uid"] = user["id"]
        session["gen"] = user["session_gen"]
        return jsonify(username=user["username"])

    @app.post("/api/logout")
    def logout():
        session.clear()
        return jsonify(ok=True)

    @app.get("/api/me")
    @login_required
    def me():
        user = current_user()
        return jsonify(id=user["id"], username=user["username"], is_admin=bool(user["is_admin"]))

    @app.put("/api/me/password")
    @login_required
    def change_password():
        data = body()
        user = current_user()
        if not check_password_hash(user["password_hash"], str(data.get("old", ""))):
            abort(400, "Das bisherige Passwort stimmt nicht.")
        new_hash = generate_password_hash(validate_password(data.get("new")))
        conn = db()
        conn.execute(
            "UPDATE users SET password_hash = ?, session_gen = session_gen + 1 WHERE id = ?", (new_hash, user["id"])
        )
        conn.commit()
        session["gen"] = user["session_gen"] + 1  # stay logged in here, end all other sessions
        return jsonify(ok=True)

    @app.get("/api/users")
    @login_required
    def list_usernames():
        """All other users – for the share dialog."""
        rows = db().execute(
            "SELECT id, username FROM users WHERE id != ? ORDER BY username", (current_user()["id"],)
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    # ---------- diagrams ----------

    @app.get("/api/diagrams")
    @login_required
    def list_diagrams():
        uid = current_user()["id"]
        rows = db().execute(
            """
            SELECT d.id, d.name, d.updated, u.username AS owner,
                   CASE WHEN d.owner_id = ? THEN 'owner' ELSE a.role END AS role
            FROM diagrams d
            JOIN users u ON u.id = d.owner_id
            LEFT JOIN diagram_access a ON a.diagram_id = d.id AND a.user_id = ?
            WHERE d.owner_id = ? OR a.user_id IS NOT NULL
            ORDER BY d.updated DESC
            """,
            (uid, uid, uid),
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.get("/api/diagrams/<int:diagram_id>")
    @login_required
    def get_diagram(diagram_id):
        return jsonify(diagram_json(*load_diagram(diagram_id)))

    @app.post("/api/diagrams")
    @login_required
    def create_diagram():
        d = validate_diagram(body())
        ts, uid = now(), current_user()["id"]
        conn = db()
        cur = conn.execute(
            "INSERT INTO diagrams (owner_id, name, code, theme, look, created, updated, updated_by)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (uid, d["name"], d["code"], d["theme"], d["look"], ts, ts, uid),
        )
        conn.commit()
        return jsonify(diagram_json(*load_diagram(cur.lastrowid))), 201

    @app.put("/api/diagrams/<int:diagram_id>")
    @login_required
    def update_diagram(diagram_id):
        data = body()
        row, role = load_diagram(diagram_id, need="edit")
        d = validate_diagram(data)
        if data.get("version") != row["version"]:
            # Someone else saved in between – hand back their version.
            return jsonify(error="conflict", current=diagram_json(row, role)), 409
        conn = db()
        cur = conn.execute(
            "UPDATE diagrams SET name = ?, code = ?, theme = ?, look = ?, version = version + 1,"
            " updated = ?, updated_by = ? WHERE id = ? AND version = ?",
            (d["name"], d["code"], d["theme"], d["look"], now(), current_user()["id"], diagram_id, row["version"]),
        )
        conn.commit()
        if cur.rowcount == 0:
            # A parallel save won the race between the check above and this update.
            return jsonify(error="conflict", current=diagram_json(*load_diagram(diagram_id))), 409
        return jsonify(diagram_json(*load_diagram(diagram_id)))

    @app.delete("/api/diagrams/<int:diagram_id>")
    @login_required
    def delete_diagram(diagram_id):
        load_diagram(diagram_id, need="owner")
        conn = db()
        conn.execute("DELETE FROM diagrams WHERE id = ?", (diagram_id,))
        conn.commit()
        return "", 204

    # ---------- sharing ----------

    @app.get("/api/diagrams/<int:diagram_id>/access")
    @login_required
    def list_access(diagram_id):
        load_diagram(diagram_id, need="owner")
        rows = db().execute(
            "SELECT u.id AS user_id, u.username, a.role FROM diagram_access a JOIN users u ON u.id = a.user_id"
            " WHERE a.diagram_id = ? ORDER BY u.username",
            (diagram_id,),
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.put("/api/diagrams/<int:diagram_id>/access/<int:user_id>")
    @login_required
    def set_access(diagram_id, user_id):
        row, _ = load_diagram(diagram_id, need="owner")
        role = body().get("role")
        if role not in ROLES:
            abort(400, "Unbekannte Rolle.")
        if user_id == row["owner_id"]:
            abort(400, "Du bist bereits Besitzer.")
        conn = db()
        if not conn.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone():
            abort(404, "Benutzer nicht gefunden.")
        conn.execute(
            "INSERT INTO diagram_access (diagram_id, user_id, role) VALUES (?, ?, ?)"
            " ON CONFLICT (diagram_id, user_id) DO UPDATE SET role = excluded.role",
            (diagram_id, user_id, role),
        )
        conn.commit()
        return list_access(diagram_id)

    @app.delete("/api/diagrams/<int:diagram_id>/access/<int:user_id>")
    @login_required
    def remove_access(diagram_id, user_id):
        load_diagram(diagram_id, need="owner")
        conn = db()
        conn.execute("DELETE FROM diagram_access WHERE diagram_id = ? AND user_id = ?", (diagram_id, user_id))
        conn.commit()
        return list_access(diagram_id)

    @app.post("/api/diagrams/<int:diagram_id>/public")
    @login_required
    def create_public_link(diagram_id):
        row, _ = load_diagram(diagram_id, need="owner")
        token = row["public_token"] or secrets.token_urlsafe(18)
        conn = db()
        conn.execute("UPDATE diagrams SET public_token = ? WHERE id = ?", (token, diagram_id))
        conn.commit()
        return jsonify(public_token=token)

    @app.delete("/api/diagrams/<int:diagram_id>/public")
    @login_required
    def revoke_public_link(diagram_id):
        load_diagram(diagram_id, need="owner")
        conn = db()
        conn.execute("UPDATE diagrams SET public_token = NULL WHERE id = ?", (diagram_id,))
        conn.commit()
        return "", 204

    @app.get("/api/public/<token>")
    def public_diagram(token):
        row = db().execute("SELECT name, code, theme, look FROM diagrams WHERE public_token = ?", (token,)).fetchone()
        if row is None:
            abort(404, "Dieser Link ist ungültig oder wurde deaktiviert.")
        return jsonify(dict(row))

    # ---------- admin ----------

    @app.get("/api/admin/users")
    @admin_required
    def admin_list_users():
        rows = db().execute(
            "SELECT u.id, u.username, u.is_admin, u.created,"
            " (SELECT COUNT(*) FROM diagrams d WHERE d.owner_id = u.id) AS diagrams"
            " FROM users u ORDER BY u.username"
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.post("/api/admin/users")
    @admin_required
    def admin_create_user():
        data = body()
        username = str(data.get("username", "")).strip()
        if not username or len(username) > 64:
            abort(400, "Benutzername fehlt oder ist zu lang.")
        pw_hash = generate_password_hash(validate_password(data.get("password")))
        conn = db()
        try:
            conn.execute(
                "INSERT INTO users (username, password_hash, is_admin, created) VALUES (?, ?, ?, ?)",
                (username, pw_hash, 1 if data.get("is_admin") else 0, now()),
            )
        except sqlite3.IntegrityError:
            abort(409, "Diesen Benutzernamen gibt es schon.")
        conn.commit()
        return admin_list_users(), 201

    @app.put("/api/admin/users/<int:user_id>/password")
    @admin_required
    def admin_reset_password(user_id):
        pw_hash = generate_password_hash(validate_password(body().get("password")))
        conn = db()
        cur = conn.execute(
            "UPDATE users SET password_hash = ?, session_gen = session_gen + 1, failed_logins = 0,"
            " locked_until = NULL WHERE id = ?",
            (pw_hash, user_id),
        )
        if cur.rowcount == 0:
            abort(404, "Benutzer nicht gefunden.")
        conn.commit()
        if user_id == current_user()["id"]:
            session["gen"] = current_user()["session_gen"] + 1
        return jsonify(ok=True)

    @app.delete("/api/admin/users/<int:user_id>")
    @admin_required
    def admin_delete_user(user_id):
        if user_id == current_user()["id"]:
            abort(400, "Du kannst dich nicht selbst löschen.")
        conn = db()
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
        return "", 204

    # ---------- CLI ----------

    @app.cli.command("create-user")
    @click.argument("username")
    @click.option("--admin", is_flag=True, help="Give admin rights.")
    @click.password_option()
    def create_user_cmd(username, admin, password):
        """Create a user account (prompts for the password)."""
        if len(password) < MIN_PASSWORD_CHARS:
            raise click.ClickException(f"Password needs at least {MIN_PASSWORD_CHARS} characters.")
        with connect(app.config["DB"]) as conn:
            try:
                conn.execute(
                    "INSERT INTO users (username, password_hash, is_admin, created) VALUES (?, ?, ?, ?)",
                    (username, generate_password_hash(password), 1 if admin else 0, now()),
                )
            except sqlite3.IntegrityError as exc:
                raise click.ClickException("User exists already.") from exc
        click.echo(f"Created user {username}{' (admin)' if admin else ''}.")

    return app


if __name__ == "__main__":
    os.environ.setdefault("FLOW_DEV", "1")
    create_app().run(host="127.0.0.1", port=int(os.environ.get("FLOW_PORT", "5190")))
