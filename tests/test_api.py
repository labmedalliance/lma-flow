"""API tests for the diagram store."""

import base64

import pytest
from werkzeug.security import generate_password_hash

from app import create_app

DIAGRAM = {"name": "Präanalytik", "code": "flowchart TD\n A --> B", "theme": "default", "look": "classic"}


@pytest.fixture
def client(tmp_path):
    app = create_app({"DB": str(tmp_path / "t.db"), "NO_AUTH": True})
    return app.test_client()


def test_crud_roundtrip(client):
    created = client.post("/api/diagrams", json=DIAGRAM)
    assert created.status_code == 201
    diagram_id = created.json["id"]

    assert client.get("/api/diagrams").json[0]["name"] == "Präanalytik"

    changed = client.put(f"/api/diagrams/{diagram_id}", json={**DIAGRAM, "code": "pie\n \"a\" : 1"})
    assert changed.status_code == 200
    assert client.get(f"/api/diagrams/{diagram_id}").json["code"].startswith("pie")

    assert client.delete(f"/api/diagrams/{diagram_id}").status_code == 204
    assert client.get(f"/api/diagrams/{diagram_id}").status_code == 404


@pytest.mark.parametrize(
    "payload",
    [
        {**DIAGRAM, "name": "  "},
        {**DIAGRAM, "name": "x" * 201},
        {**DIAGRAM, "theme": "evil"},
        {**DIAGRAM, "code": 42},
        ["not", "a", "dict"],
    ],
)
def test_rejects_invalid_payload(client, payload):
    assert client.post("/api/diagrams", json=payload).status_code == 400


def test_rejects_non_json_writes(client):
    # A cross-site HTML form can only send form or text bodies, never application/json.
    resp = client.post("/api/diagrams", data='{"name":"x","code":""}', content_type="text/plain")
    assert resp.status_code == 415


def test_static_files_do_not_expose_server_files(client):
    assert client.get("/").status_code == 200
    assert client.get("/js/app.js").status_code == 200
    assert client.get("/app.py").status_code == 404
    assert client.get("/../app.py").status_code == 404


def test_requires_configured_login(tmp_path):
    with pytest.raises(RuntimeError):
        create_app({"DB": str(tmp_path / "t.db"), "NO_AUTH": False, "USER": None, "PASSWORD_HASH": None})


def test_basic_auth(tmp_path):
    app = create_app(
        {
            "DB": str(tmp_path / "t.db"),
            "NO_AUTH": False,
            "USER": "janne",
            "PASSWORD_HASH": generate_password_hash("geheim"),
        }
    )
    client = app.test_client()

    def auth(user, pw):
        token = base64.b64encode(f"{user}:{pw}".encode()).decode()
        return {"Authorization": f"Basic {token}"}

    assert client.get("/api/diagrams").status_code == 401
    assert client.get("/", headers=auth("janne", "falsch")).status_code == 401
    assert client.get("/api/diagrams", headers=auth("janne", "geheim")).status_code == 200
