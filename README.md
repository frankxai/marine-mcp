# marine-mcp

**Model Context Protocol server for the Ocean Intelligence System.** It serves the
[Blue Life Commons](https://github.com/frankxai/blue-life-commons) corpus to AI agents
(Claude Desktop, Claude Code, Cursor, any MCP client) under two non-negotiable rules:

1. **Detail-serving is review-gated.** An artifact's prose body is returned *as fact* only
   when it is review-approved (`status ∈ {approved, published}`, and for science-sensitive
   types `review.science = approved`). Otherwise the tool returns a typed refusal
   (`servable: false`) carrying the artifact's status — never the unreviewed body.
2. **Every response carries its sources.** Tool results are wrapped in
   `{ data, sources, status, attribution }`. The IS never launders an unsourced claim.

This is the **IS-engine** layer of the Ocean Intelligence System triad:

| Layer | Repo | Role |
|---|---|---|
| Commons | `blue-life-commons` | The public, reviewed corpus (source of truth) |
| **IS-engine** | **`marine-mcp`** (this) + `marine-agent-skills` | Serves the corpus to agents; lets contributors author compliant artifacts |
| OS-runtime | `ocean-intelligence-system` | Dashboard, partner gateway — *consumes* this server |

## Install & run

```bash
npm install
npm run build
BLC_PATH=/path/to/blue-life-commons npm start
```

Dev (no build step):

```bash
BLC_PATH=/path/to/blue-life-commons npm run dev
```

## Configure in Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "marine": {
      "command": "node",
      "args": ["/abs/path/to/marine-mcp/dist/index.js"],
      "env": { "BLC_PATH": "/abs/path/to/blue-life-commons" }
    }
  }
}
```

## Tools

| Tool | Gated? | Purpose |
|---|---|---|
| `search_species` | no (metadata only) | Discover species pages by name/guild; returns id, title, status, servable flag |
| `get_species_details` | **yes** | Full reviewed body + sources, or a typed refusal |
| `get_region_briefing` | **yes** | Reviewed regional briefing + sources |
| `get_active_missions` | partial | List field missions (logistics surfaced; interaction guidance gated) |
| `lookup_source` | no | Provenance: which artifacts cite a URL/title |
| `validate_artifact` | n/a | Contributor self-check of frontmatter before a PR |
| `obis_gbif_passthrough` | external | Live OBIS occurrences, explicitly labelled `unreviewed: true` |

## Why a separate repo (not inside ocean-intelligence-system)

The OS repo previously embedded an MCP server that hardcoded a sibling path, ran a stale
protocol version, served `needs-expert-review` content as fact, and dropped sources from
responses. `marine-mcp` exists to do that job correctly and to keep the IS-engine ("serve
the corpus to any agent") cleanly separable from the OS-runtime ("render a dashboard").

## Test

```bash
npm test        # node:test over the trust-gate logic
npm run typecheck
```

## License

MIT (code). Served content is © its contributors under CC-BY-4.0 per the commons.

> Built on SIP · Blue Life Commons — an initiative of Starlight Intelligence Systems.
