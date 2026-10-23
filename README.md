# Flow

A small, self-hosted diagram editor: write diagram code on the left, see the diagram on the right. Same idea as the
public mermaid live editor, but with its own UI, accounts, sharing and server-side storage.

- Live preview with error display (last good diagram stays visible, dimmed)
- 10 starter templates (flowchart, sequence, class, state, ER, Gantt, pie, mindmap, timeline, git graph)
- Themes and a hand-drawn look
- Accounts with login; an admin creates users on the admin page (`admin`)
- Diagrams saved on the server (SQLite): New, Open, Save, Save as copy, Delete
- Share a diagram with other users to read or edit; everyone else does not see it
- Public read-only link (`v/<token>`) for people without an account, can be switched off again
- Editing by turns: if someone else saved in the meantime, Flow warns instead of overwriting
- Each saved diagram has its own URL (`?id=<n>`); the unsaved draft survives a reload; `Cmd/Ctrl+S` saves
- Export as SVG or PNG (2x)

## How it works

Rendering is done by the open-source [mermaid](https://github.com/mermaid-js/mermaid) library (MIT), vendored
unmodified in `static/vendor/mermaid/`. It parses the text into a diagram model, lays it out (dagre, ELK, cytoscape,
d3) and outputs SVG. Everything around it – editor, storage, export, share links – is this app's own code. Diagram
code is rendered with `securityLevel: "strict"` (no scripts or click handlers from diagram code).
Third-party licenses: `THIRD_PARTY_NOTICES.md`.

| Part | File |
|---|---|
| Backend: Flask, JSON API, SQLite, login, sharing | `app.py` |
| Editor | `static/index.html`, `static/js/app.js` |
| Login, admin, public view | `static/login.html`, `static/admin.html`, `static/view.html` + `static/js/*.js` |
| Templates | `static/js/examples.js` |

Roles per diagram: owner (everything, sharing, delete), edit, view. Saving sends the diagram's `version`; a stale
version gets HTTP 409 and the editor offers: save mine, load theirs, or save as copy.

Security: session cookie (HttpOnly, SameSite=Lax, Secure), password hashes (Werkzeug), Content-Security-Policy
(no external scripts or images), equal login timing for known and unknown users, login limit per client IP
(10 failures / 15 min) and per account (50), password change ends all other sessions, logout clears the local draft.
API writes accept only `application/json`. Do not store patient data or other personal data of third parties.

## Configuration

Environment variables, or a `.env` file next to `app.py` (git-ignored):

| Variable | Meaning |
|---|---|
| `FLOW_SECRET_KEY` | Signs the session cookie – required, e.g. `python3 -c "import secrets; print(secrets.token_hex(32))"` |
| `FLOW_DB` | SQLite file. Default `instance/flow.db` (git-ignored) |
| `FLOW_BASE_PATH` | URL prefix, e.g. `/flow/`. Default `/` |
| `FLOW_DEV=1` | Local development: session cookie also over plain HTTP |
| `FLOW_PROXY_HOPS` | Trusted reverse proxies in front, for the client IP of the login limit. Uberspace: `1` |

Create the first admin: `uv run flask --app app create-user <name> --admin` (prompts for the password).

## Run locally

```sh
uv sync
export FLOW_SECRET_KEY=dev FLOW_DEV=1
uv run flask --app app create-user me --admin
uv run python app.py                     # http://127.0.0.1:5190/
uv run pytest
```

## Deploy (umbriel, craft.cadamu.ro/flow/)

- Code: `~/lma-flow` (git clone via deploy key, host alias `github-lma-flow`)
- Config: `~/lma-flow/.env` (mode 600) with `FLOW_SECRET_KEY`, `FLOW_BASE_PATH=/flow/`, `FLOW_PROXY_HOPS=1`
- Service: `~/.config/systemd/user/lma-flow.service` (gunicorn on port 5190)
- Web backend: `uberspace web backend add craft.cadamu.ro/flow PORT 5190 --remove-prefix`

Update (backup first, fast-forward only, locked dependencies, health check):

```sh
ssh umbriel.uberspace.de 'set -e; cd ~/lma-flow \
  && sqlite3 instance/flow.db ".backup $HOME/backups/lma-flow/pre-deploy-$(date +%Y%m%d-%H%M%S).db" \
  && git pull --ff-only && uv sync --no-dev --locked \
  && systemctl --user restart lma-flow && sleep 2 && systemctl --user is-active lma-flow \
  && curl -s -o /dev/null -w "%{http_code}\n" https://craft.cadamu.ro/flow/login'
```

If `deploy/lma-flow.service` changed: copy it to `~/.config/systemd/user/` and run `systemctl --user daemon-reload`
first. The schema is created with `CREATE TABLE IF NOT EXISTS` – new columns need a manual migration.

Back up `~/lma-flow/instance/flow.db`. The craft site's Apache Basic Auth does not apply under `/flow/` – Flow has
its own login, so public links work.

## Command-line client

`tools/flow-diagram` (Python standard library only) creates and updates diagrams through the API, e.g. for Claude.
It reads `FLOW_URL`, `FLOW_USER` and `FLOW_PASSWORD` from `~/.config/flow/credentials`, refuses to run if that file
is readable by others, and never puts the password on a command line.

```sh
ln -sf "$PWD/tools/flow-diagram" ~/.local/bin/flow-diagram
printf 'flowchart LR\n  A --> B\n' | flow-diagram create "My diagram"   # prints the editor URL
flow-diagram list | get ID | update ID [FILE] | share ID USER view|edit | public ID | delete ID
```

`update` saves on top of the current server version – run `get` first when others edit the same diagram.

## Update mermaid

```sh
npm pack mermaid@<version> && tar xzf mermaid-<version>.tgz
cp package/dist/mermaid.min.js package/LICENSE static/vendor/mermaid/
echo <version> > static/vendor/mermaid/VERSION
```

Then update version and SHA-256 in `THIRD_PARTY_NOTICES.md` and check all templates still render.
