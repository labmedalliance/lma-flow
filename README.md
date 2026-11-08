# LMA Flow

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg)](LICENSE)

Free open-source software by Janne Cadamuro / [LabMed Alliance](https://labmedalliance.com), licensed under the GNU
Affero General Public License v3.0 or later with additional terms in [NOTICE](NOTICE). Details in the section
[License](#license).

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
- Flowcharts can be edited with the mouse: drag shapes in, click nodes/arrows to change text, shape and colors, drag
  arrows between nodes, delete, undo/redo. Every action rewrites the Mermaid code (see `static/js/flowedit.js`)
- Help page (`help`) with shapes, colors and live examples
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
| Name, version, licence, footer credit, `/about` | `attribution.py`, `static/about.html` |
| Editor | `static/index.html`, `static/js/app.js` |
| Login, admin, public view | `static/login.html`, `static/admin.html`, `static/view.html` + `static/js/*.js` |
| Templates | `static/js/examples.js` |
| Mouse editing: text edits / UI | `static/js/flowedit.js` (pure, tested with Node) / `static/js/visual.js` |

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
| `FLOW_PROXY_HOPS` | Trusted reverse proxies in front, for the client IP of the login limit. Uberspace 8: `2` (its proxy adds an internal hop) |

Create the first admin: `uv run flask --app app create-user <name> --admin` (prompts for the password).

## Run locally

```sh
uv sync
export FLOW_SECRET_KEY=dev FLOW_DEV=1
uv run flask --app app create-user me --admin
uv run python app.py                     # http://127.0.0.1:5190/
uv run pytest
node --test tests/js/flowedit.test.js   # text-edit module
```

## Deploy (umbriel, flow.cadamu.ro)

- Code: `~/lma-flow` (git clone of `labmedalliance/lma-flow`)
- Config: `~/lma-flow/.env` (mode 600) with `FLOW_SECRET_KEY`, `FLOW_BASE_PATH=/`, `FLOW_PROXY_HOPS=2`
- Service: `~/.config/systemd/user/lma-flow.service` (gunicorn on port 5190)
- Web backend: `uberspace web backend add flow.cadamu.ro PORT 5190` (until 2026-11-08: `craft.cadamu.ro/flow` with
  `--remove-prefix`; the craft site now redirects `/flow/…` to `https://flow.cadamu.ro/…`)

Update (backup first, fast-forward only, locked dependencies, health check):

```sh
ssh umbriel.uberspace.de 'set -e; cd ~/lma-flow \
  && sqlite3 instance/flow.db ".backup $HOME/backups/lma-flow/pre-deploy-$(date +%Y%m%d-%H%M%S).db" \
  && git pull --ff-only && uv sync --no-dev --locked \
  && systemctl --user restart lma-flow && sleep 2 && systemctl --user is-active lma-flow \
  && curl -s -o /dev/null -w "%{http_code}\n" https://flow.cadamu.ro/login'
```

If `deploy/lma-flow.service` changed: copy it to `~/.config/systemd/user/` and run `systemctl --user daemon-reload`
first. The schema is created with `CREATE TABLE IF NOT EXISTS` – new columns need a manual migration.

Back up `~/lma-flow/instance/flow.db`. Flow has its own login and its own origin, separate from the password-protected
craft site; old public links under `craft.cadamu.ro/flow/` redirect without the craft password.

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

## Who built it

LMA Flow was designed and developed by **Janne Cadamuro / LabMed Alliance Inc.**

Copyright © 2026 Janne Cadamuro / LabMed Alliance Inc.

The app says so itself: every page carries the credit *Powered by LabMed Alliance* with the LMA logo in its footer,
next to a link to `about`. That page names the authors, the licence and the link to the source code, and works
without login. The details are hard-coded in [`attribution.py`](attribution.py), not stored in the database; no
setting removes them. The server fills them into every page (`{{CREDIT}}`). Header logo, favicons and app icons
(`static/img/`) come from the LMA logo. `tests/test_attribution.py` checks that all of this stays in place.

## License

LMA Flow is free open-source software under the **GNU Affero General Public License v3.0 or later**
(`AGPL-3.0-or-later`), with additional terms under AGPL section 7. The licence text is in [LICENSE](LICENSE), the
additional terms in [NOTICE](NOTICE).

You may:

- run LMA Flow for yourself or your organization, commercially or not;
- read, adapt and build on the source code;
- pass the software on, modified or unmodified.

Under these conditions:

- **Same licence.** Whatever you build on it must also be under the AGPL.
- **Also when you only run it.** If you run a modified version as a web service, offer its users the source code
  (AGPL section 13). Set `SOURCE_URL` in `attribution.py` to your repo.
- **The LabMed Alliance credit stays.** The credit *Powered by LabMed Alliance* and the page `about` stay visible on
  every page (NOTICE, term 1). You may add your own credits next to it.
- **Mark your changes.** State that your version is modified. Do not present it as the original or as endorsed by
  LabMed Alliance (NOTICE, term 2).
- **New name for modified versions.** "LabMed Alliance", "LMA", "LMA Flow" and the LMA logo are not licensed
  (NOTICE, term 3). Unmodified copies may run as *LMA Flow*. A modified version needs its own name, its own icons and
  its own header logo; it may call itself "based on LMA Flow". Logo and icons in `static/img/` are not covered by the
  AGPL.
- **No warranty.** The software is provided without any warranty.

### Built on

| Component | License |
|---|---|
| mermaid (vendored, with the libraries listed in `THIRD_PARTY_NOTICES.md`) | MIT |
| Flask, Werkzeug, click | BSD-3-Clause |
| gunicorn | MIT |

## Contributing

Issues and pull requests are welcome. Code, comments and commit messages are in English. By contributing you agree
that your contribution is licensed under the same terms (`AGPL-3.0-or-later` with the NOTICE terms).
