# Flow

A small, self-hosted diagram editor: write diagram code on the left, see the diagram on the right. Same idea as the
public mermaid live editor, but with its own UI and no external services.

- Live preview with error display (last good diagram stays visible, dimmed)
- 10 starter templates (flowchart, sequence, class, state, ER, Gantt, pie, mindmap, timeline, git graph)
- Themes and a hand-drawn look
- Export as SVG or PNG (2x)
- Share link: the diagram is compressed into the URL fragment, so it never reaches the server
- Save diagrams by name (browser `localStorage`), autosave of the current draft, `Cmd/Ctrl+S`

## How it works

Rendering is done by the open-source [mermaid](https://github.com/mermaid-js/mermaid) library (MIT), vendored
unmodified in `vendor/mermaid/`. It parses the text into a diagram model, lays it out (dagre, ELK, cytoscape, d3)
and outputs SVG. Everything around it – editor, storage, export, share links – is this app's own code
(`js/app.js`). Third-party licenses: `THIRD_PARTY_NOTICES.md`.

The app is purely static: no build step, no backend, no CDN. Diagram code is rendered with
`securityLevel: "strict"` (no scripts or click handlers from diagram code).

## Run locally

```sh
python3 -m http.server 5190 --bind 127.0.0.1
# open http://127.0.0.1:5190/
```

## Deploy

Copy the folder to any web server's document root or a subfolder – all paths are relative. Exclude `.git` and
`.playwright-mcp`:

```sh
rsync -av --delete --exclude .git --exclude .playwright-mcp ./ HOST:/path/to/docroot/flow/
```

## Update mermaid

```sh
npm pack mermaid@<version> && tar xzf mermaid-<version>.tgz
cp package/dist/mermaid.min.js package/LICENSE vendor/mermaid/
echo <version> > vendor/mermaid/VERSION
```

Then update version and SHA-256 in `THIRD_PARTY_NOTICES.md` and check all templates still render.
