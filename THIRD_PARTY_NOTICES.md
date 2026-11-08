# Third-party notices

LMA Flow's own code (`app.py`, `attribution.py`, `static/*.html`, `static/css/`, `static/js/`, `static/favicon.svg`,
`tools/`, `tests/`) is original work by Janne Cadamuro / LabMed Alliance Inc., licensed under AGPL-3.0-or-later with
the additional terms in `NOTICE`. The LabMed Alliance logo and the icons in `static/img/` are not covered by the AGPL
(see `NOTICE`, term 3).

The only third-party code is the vendored mermaid bundle in `static/vendor/mermaid/`. Python dependencies (Flask,
Werkzeug, click, gunicorn) are installed via `uv` and not part of the repository.

## mermaid 12.1.0

- File: `static/vendor/mermaid/mermaid.min.js` (unmodified, from the npm package `mermaid@12.1.0`)
- SHA-256: `6484afc32872a3aa16cac9a76ba1816a1ed4cc870a6593cc2e17757750f518b2`
- License: MIT, Copyright (c) 2014 - 2022 Knut Sveidqvist – full text in `static/vendor/mermaid/LICENSE`
- Source: https://github.com/mermaid-js/mermaid

"Mermaid" is the name of the upstream open-source project. LMA Flow is an independent app and is not affiliated with or
endorsed by the mermaid project or Mermaid Chart.

## Libraries bundled inside mermaid.min.js

The bundle contains these open-source libraries under their own licenses:

| Library | License | Source |
|---|---|---|
| d3, d3-sankey | ISC / BSD-3-Clause | https://github.com/d3/d3 |
| dagre-d3-es | MIT | https://github.com/tbo47/dagre-es |
| DOMPurify | Apache-2.0 or MPL-2.0 | https://github.com/cure53/DOMPurify |
| cytoscape, cytoscape-cose-bilkent, cytoscape-fcose | MIT | https://github.com/cytoscape/cytoscape.js |
| elkjs (Eclipse Layout Kernel) | EPL-2.0 | https://github.com/kieler/elkjs |
| KaTeX | MIT | https://github.com/KaTeX/KaTeX |
| marked | MIT | https://github.com/markedjs/marked |
| roughjs | MIT | https://github.com/rough-stuff/rough |
| khroma | MIT | https://github.com/fabiospampinato/khroma |
| stylis | MIT | https://github.com/thysultan/stylis |
| dayjs | MIT | https://github.com/iamkun/dayjs |
| chevrotain | Apache-2.0 | https://github.com/Chevrotain/chevrotain |
| @braintree/sanitize-url | MIT | https://github.com/braintree/sanitize-url |
| @iconify/utils | MIT | https://github.com/iconify/iconify |
| @upsetjs/venn.js | MIT | https://github.com/upsetjs/venn.js |
| es-toolkit, ts-dedent, uuid | MIT | npm |
| lodash-es | MIT | https://github.com/lodash/lodash |
| langium, vscode-languageserver, vscode-jsonrpc | MIT | https://github.com/eclipse-langium/langium, https://github.com/microsoft/vscode-languageserver-node |

elkjs is EPL-2.0: its source code is available at the link above. cytoscape also bundles small MIT-licensed parts
(Thenable, jQuery event code, bezier helpers); their license headers are kept inside the bundle.
