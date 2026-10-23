# Flow

A small, self-hosted diagram editor: write diagram code on the left, see the diagram on the right. Same idea as the
public mermaid live editor, but with its own UI, server-side storage and no external services.

- Live preview with error display (last good diagram stays visible, dimmed)
- 10 starter templates (flowchart, sequence, class, state, ER, Gantt, pie, mindmap, timeline, git graph)
- Themes and a hand-drawn look
- Diagrams saved on the server (SQLite): New, Open, Save, Save as copy, Delete
- Each saved diagram has its own URL (`?id=<n>`) to reopen and edit it later
- Unsaved draft kept in the browser, so a reload loses nothing; `Cmd/Ctrl+S` saves
- Export as SVG or PNG (2x)
- Share link: the diagram is compressed into the URL fragment and needs no saving

## How it works

Rendering is done by the open-source [mermaid](https://github.com/mermaid-js/mermaid) library (MIT), vendored
unmodified in `static/vendor/mermaid/`. It parses the text into a diagram model, lays it out (dagre, ELK, cytoscape,
d3) and outputs SVG. Everything around it – editor, storage, export, share links – is this app's own code. Diagram
code is rendered with `securityLevel: "strict"` (no scripts or click handlers from diagram code).
Third-party licenses: `THIRD_PARTY_NOTICES.md`.

| Part | File |
|---|---|
| Backend: Flask, JSON API, SQLite, Basic Auth | `app.py` |
| Frontend | `static/index.html`, `static/js/app.js`, `static/css/app.css` |
| Templates | `static/js/examples.js` |

API: `GET/POST /api/diagrams`, `GET/PUT/DELETE /api/diagrams/<id>`. Writes accept only `application/json`, which
blocks cross-site form posts.

## Configuration

| Variable | Meaning |
|---|---|
| `FLOW_DB` | SQLite file. Default `instance/flow.db` (git-ignored) |
| `FLOW_USER` | Login name for HTTP Basic Auth |
| `FLOW_PASSWORD_HASH` | Password hash, create with `uv run python -m flow_hash` |
| `FLOW_NO_AUTH=1` | Disable login – local development only |

The app refuses to start without login settings unless `FLOW_NO_AUTH=1` is set.

## Run locally

```sh
uv sync
FLOW_NO_AUTH=1 uv run python app.py      # http://127.0.0.1:5190/
uv run pytest
```

## Deploy (Uberspace)

```sh
git clone <repo> ~/lma-flow && cd ~/lma-flow && uv sync --no-dev
uv run python -m flow_hash               # copy the hash
```

Run it as a service, for example `~/etc/services.d/lma-flow.ini`:

```ini
[program:lma-flow]
directory=%(ENV_HOME)s/lma-flow
command=%(ENV_HOME)s/lma-flow/.venv/bin/gunicorn -b 0.0.0.0:<PORT> "app:create_app()"
environment=FLOW_USER="<user>",FLOW_PASSWORD_HASH="<hash>"
autorestart=true
```

Then point a web backend at the port, e.g. `uberspace web backend set <domain>/flow --http --port <PORT>`.
The frontend uses relative paths, so it works under a sub path like `/flow/`. Back up `instance/flow.db`.

## Update mermaid

```sh
npm pack mermaid@<version> && tar xzf mermaid-<version>.tgz
cp package/dist/mermaid.min.js package/LICENSE static/vendor/mermaid/
echo <version> > static/vendor/mermaid/VERSION
```

Then update version and SHA-256 in `THIRD_PARTY_NOTICES.md` and check all templates still render.
