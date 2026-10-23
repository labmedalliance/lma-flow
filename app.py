"""Flow – self-hosted diagram editor with server-side storage.

Serves the static editor from ``static/`` and a small JSON API that keeps
diagrams in SQLite.

Configuration (environment variables):

``FLOW_DB``
    Path to the SQLite file. Default: ``instance/flow.db``.
``FLOW_USER`` / ``FLOW_PASSWORD_HASH``
    Login for HTTP Basic Auth. Create the hash with
    ``uv run python -m flow_hash``. Both are required, unless
    ``FLOW_NO_AUTH=1`` is set (only for local development).
"""

import os
import sqlite3
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

from flask import Flask, abort, g, jsonify, request, send_from_directory
from werkzeug.security import check_password_hash

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
MAX_CODE_CHARS = 200_000
MAX_NAME_CHARS = 200
THEMES = {"default", "neutral", "forest", "dark", "base"}
LOOKS = {"classic", "handDrawn"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS diagrams (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT NOT NULL,
    code    TEXT NOT NULL,
    theme   TEXT NOT NULL DEFAULT 'default',
    look    TEXT NOT NULL DEFAULT 'classic',
    created TEXT NOT NULL,
    updated TEXT NOT NULL
);
"""


def create_app(config=None):
    """Build the Flask app. ``config`` overrides environment settings (tests)."""
    app = Flask(__name__, static_folder=None)
    app.config.update(
        DB=os.environ.get("FLOW_DB", str(BASE_DIR / "instance" / "flow.db")),
        USER=os.environ.get("FLOW_USER"),
        PASSWORD_HASH=os.environ.get("FLOW_PASSWORD_HASH"),
        NO_AUTH=os.environ.get("FLOW_NO_AUTH") == "1",
        MAX_CONTENT_LENGTH=1024 * 1024,
    )
    app.config.update(config or {})

    # Fail closed: never run without a login by accident.
    if not app.config["NO_AUTH"] and not (app.config["USER"] and app.config["PASSWORD_HASH"]):
        raise RuntimeError("Set FLOW_USER and FLOW_PASSWORD_HASH, or FLOW_NO_AUTH=1 for local development.")

    Path(app.config["DB"]).parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(app.config["DB"]) as conn:
        conn.executescript(SCHEMA)

    def get_db():
        if "db" not in g:
            g.db = sqlite3.connect(app.config["DB"])
            g.db.row_factory = sqlite3.Row
        return g.db

    @app.teardown_appcontext
    def close_db(_exc):
        db = g.pop("db", None)
        if db is not None:
            db.close()

    @app.before_request
    def require_login():
        if app.config["NO_AUTH"]:
            return None
        auth = request.authorization
        if (
            auth
            and auth.username == app.config["USER"]
            and check_password_hash(app.config["PASSWORD_HASH"], auth.password or "")
        ):
            return None
        return ("Login erforderlich", 401, {"WWW-Authenticate": 'Basic realm="Flow"'})

    @app.after_request
    def security_headers(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        return resp

    def json_api(view):
        """Only accept real JSON bodies on writes – blocks cross-site form posts."""

        @wraps(view)
        def wrapper(*args, **kwargs):
            if request.method in ("POST", "PUT") and not request.is_json:
                abort(415)
            return view(*args, **kwargs)

        return wrapper

    def validate(data):
        """Check and normalise a diagram payload. Aborts with 400 on bad input."""
        if not isinstance(data, dict):
            abort(400)
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

    def now():
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    def fetch(diagram_id):
        row = get_db().execute("SELECT * FROM diagrams WHERE id = ?", (diagram_id,)).fetchone()
        if row is None:
            abort(404)
        return dict(row)

    # ---------- pages ----------

    @app.get("/")
    def index():
        return send_from_directory(STATIC_DIR, "index.html")

    @app.get("/licenses")
    def licenses():
        return send_from_directory(BASE_DIR, "THIRD_PARTY_NOTICES.md", mimetype="text/plain")

    @app.get("/<path:filename>")
    def static_files(filename):
        return send_from_directory(STATIC_DIR, filename)

    # ---------- API ----------

    @app.get("/api/diagrams")
    def list_diagrams():
        rows = get_db().execute("SELECT id, name, updated FROM diagrams ORDER BY updated DESC").fetchall()
        return jsonify([dict(r) for r in rows])

    @app.get("/api/diagrams/<int:diagram_id>")
    def get_diagram(diagram_id):
        return jsonify(fetch(diagram_id))

    @app.post("/api/diagrams")
    @json_api
    def create_diagram():
        d = validate(request.get_json())
        ts = now()
        db = get_db()
        cur = db.execute(
            "INSERT INTO diagrams (name, code, theme, look, created, updated) VALUES (?, ?, ?, ?, ?, ?)",
            (d["name"], d["code"], d["theme"], d["look"], ts, ts),
        )
        db.commit()
        return jsonify(fetch(cur.lastrowid)), 201

    @app.put("/api/diagrams/<int:diagram_id>")
    @json_api
    def update_diagram(diagram_id):
        fetch(diagram_id)
        d = validate(request.get_json())
        db = get_db()
        db.execute(
            "UPDATE diagrams SET name = ?, code = ?, theme = ?, look = ?, updated = ? WHERE id = ?",
            (d["name"], d["code"], d["theme"], d["look"], now(), diagram_id),
        )
        db.commit()
        return jsonify(fetch(diagram_id))

    @app.delete("/api/diagrams/<int:diagram_id>")
    def delete_diagram(diagram_id):
        fetch(diagram_id)
        db = get_db()
        db.execute("DELETE FROM diagrams WHERE id = ?", (diagram_id,))
        db.commit()
        return "", 204

    return app


if __name__ == "__main__":
    create_app().run(host="127.0.0.1", port=int(os.environ.get("FLOW_PORT", "5190")))
