#!/usr/bin/env node
/**
 * marine-mcp — Model Context Protocol server for the Ocean Intelligence System.
 *
 * Serves the Blue Life Commons corpus to AI agents under two rules that are not
 * negotiable (see corpus.ts):
 *   1. Detail-serving is review-gated: unapproved artifacts return a typed
 *      refusal (servable:false), never the prose body presented as fact.
 *   2. Every response carries sources[] + attribution + status.
 *
 * External data (OBIS) is passed through clearly labelled `unreviewed: true` so
 * a consumer can never conflate live occurrence data with curated commons content.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  loadCorpus,
  assertServable,
  envelope,
  resolveCorpusRoot,
  type Artifact,
} from "./corpus.js";

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function byType(corpus: Artifact[], type: string) {
  return corpus.filter((a) => a.frontmatter.type === type);
}

function matchesQuery(a: Artifact, q: string): boolean {
  const hay = [
    a.frontmatter.title,
    a.frontmatter.id,
    ...(a.frontmatter.species ?? []),
    ...(a.frontmatter.species_group ?? []),
    ...(a.frontmatter.region ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q.toLowerCase());
}

const server = new McpServer({ name: "marine-mcp", version: "0.1.0" });

/* ---- Discovery: metadata only, safe to surface regardless of review state ---- */
server.registerTool(
  "search_species",
  {
    title: "Search species",
    description:
      "Discover species pages in the commons. Returns metadata (id, title, status, review state) — NOT factual claims. Use get_species_details to retrieve a reviewed body.",
    inputSchema: {
      query: z.string().optional().describe("Free text: common/scientific name, region, or guild"),
      species_group: z
        .enum(["cetaceans", "pinnipeds", "turtles", "sharks-rays", "reefs"])
        .optional(),
    },
  },
  async ({ query, species_group }) => {
    const corpus = loadCorpus();
    let pages = byType(corpus, "species-page");
    if (species_group)
      pages = pages.filter((a) => (a.frontmatter.species_group ?? []).includes(species_group));
    if (query) pages = pages.filter((a) => matchesQuery(a, query));
    const results = pages.map((a) => ({
      id: a.frontmatter.id,
      title: a.frontmatter.title,
      species: a.frontmatter.species ?? [],
      species_group: a.frontmatter.species_group ?? [],
      status: a.frontmatter.status,
      review: a.frontmatter.review ?? {},
      servable: assertServable(a.frontmatter).servable,
    }));
    return text(envelope(results, undefined, { count: results.length }));
  },
);

/* ---- Detail-serving: REVIEW-GATED ---- */
server.registerTool(
  "get_species_details",
  {
    title: "Get species details",
    description:
      "Retrieve the full reviewed body of a species page WITH its sources. Returns servable:false (no body) if the artifact is not review-approved.",
    inputSchema: { species_id: z.string().describe("Artifact id, e.g. 'humpback-whale'") },
  },
  async ({ species_id }) => {
    const corpus = loadCorpus();
    const a = byType(corpus, "species-page").find(
      (x) =>
        x.frontmatter.id === species_id ||
        (x.frontmatter.species ?? []).some((s) => s.toLowerCase() === species_id.toLowerCase()),
    );
    if (!a) return text(envelope(null, undefined, { found: false, species_id }));
    const verdict = assertServable(a.frontmatter);
    if (!verdict.servable) {
      return text(
        envelope({ id: a.frontmatter.id, title: a.frontmatter.title }, a.frontmatter, {
          servable: false,
          refused: verdict.reason,
        }),
      );
    }
    return text(
      envelope({ ...a.frontmatter, body: a.body }, a.frontmatter, { servable: true }),
    );
  },
);

server.registerTool(
  "get_region_briefing",
  {
    title: "Get region briefing",
    description: "Retrieve a reviewed regional ocean briefing with sources. Review-gated.",
    inputSchema: { region_id: z.string() },
  },
  async ({ region_id }) => {
    const corpus = loadCorpus();
    const a = byType(corpus, "region-briefing").find(
      (x) => x.frontmatter.id === region_id || matchesQuery(x, region_id),
    );
    if (!a) return text(envelope(null, undefined, { found: false, region_id }));
    const verdict = assertServable(a.frontmatter);
    if (!verdict.servable)
      return text(envelope({ id: a.frontmatter.id }, a.frontmatter, { servable: false, refused: verdict.reason }));
    return text(envelope({ ...a.frontmatter, body: a.body }, a.frontmatter, { servable: true }));
  },
);

server.registerTool(
  "get_active_missions",
  {
    title: "Get field missions",
    description:
      "List citizen-science / travel field missions. Mission logistics are surfaced; any wildlife-interaction guidance is review-gated.",
    inputSchema: {
      region: z.string().optional(),
      difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
    },
  },
  async ({ region, difficulty }) => {
    const corpus = loadCorpus();
    let missions = byType(corpus, "field-mission");
    if (region) missions = missions.filter((a) => matchesQuery(a, region));
    if (difficulty) missions = missions.filter((a) => a.frontmatter.difficulty === difficulty);
    const results = missions.map((a) => ({
      id: a.frontmatter.id,
      title: a.frontmatter.title,
      region: a.frontmatter.region ?? [],
      difficulty: a.frontmatter.difficulty,
      status: a.frontmatter.status,
      servable: assertServable(a.frontmatter).servable,
    }));
    return text(envelope(results, undefined, { count: results.length }));
  },
);

server.registerTool(
  "lookup_source",
  {
    title: "Look up source",
    description:
      "Provenance check: find which artifacts cite a given URL or source title, and list their sources.",
    inputSchema: { query: z.string().describe("URL fragment or source title") },
  },
  async ({ query }) => {
    const corpus = loadCorpus();
    const q = query.toLowerCase();
    const hits = corpus
      .filter((a) =>
        (a.frontmatter.sources ?? []).some(
          (s) => (s.url ?? "").toLowerCase().includes(q) || (s.title ?? "").toLowerCase().includes(q),
        ),
      )
      .map((a) => ({ id: a.frontmatter.id, title: a.frontmatter.title, sources: a.frontmatter.sources ?? [] }));
    return text(envelope(hits, undefined, { count: hits.length }));
  },
);

server.registerTool(
  "validate_artifact",
  {
    title: "Validate artifact frontmatter",
    description:
      "Self-check tool for contributors/agents: verify artifact frontmatter has the required fields before opening a PR. Mirrors the commons' schema gate.",
    inputSchema: { frontmatter_json: z.string().describe("Artifact frontmatter as JSON") },
  },
  async ({ frontmatter_json }) => {
    const required = ["id", "type", "title", "status", "sources", "review", "outputs", "contributors", "license"];
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(frontmatter_json);
    } catch (e) {
      return text(envelope(null, undefined, { valid: false, errors: [`invalid JSON: ${(e as Error).message}`] }));
    }
    const errors = required.filter((k) => !(k in parsed)).map((k) => `missing required field: ${k}`);
    if (Array.isArray(parsed.sources) && parsed.sources.length === 0)
      errors.push("sources is empty — every factual artifact needs at least one source");
    return text(envelope({ valid: errors.length === 0 }, undefined, { errors }));
  },
);

server.registerTool(
  "obis_gbif_passthrough",
  {
    title: "OBIS occurrence passthrough (unreviewed)",
    description:
      "Live occurrence records from OBIS (Ocean Biodiversity Information System). Returns external, UNREVIEWED data labelled as such — never to be conflated with curated commons content. Cite OBIS + the underlying dataset.",
    inputSchema: {
      scientific_name: z.string().describe("e.g. 'Megaptera novaeangliae'"),
      size: z.number().int().min(1).max(20).optional(),
    },
  },
  async ({ scientific_name, size }) => {
    const url = `https://api.obis.org/v3/occurrence?scientificname=${encodeURIComponent(
      scientific_name,
    )}&size=${size ?? 5}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "marine-mcp/0.1 (Ocean Intelligence System)" } });
      if (!res.ok) throw new Error(`OBIS HTTP ${res.status}`);
      const json = (await res.json()) as { total?: number; results?: unknown[] };
      const records = (json.results ?? []).map((r) => {
        const rec = r as Record<string, unknown>;
        return {
          scientificName: rec.scientificName,
          decimalLatitude: rec.decimalLatitude,
          decimalLongitude: rec.decimalLongitude,
          eventDate: rec.eventDate,
          dataset_id: rec.dataset_id,
          // NOTE: precise coords come straight from OBIS; do NOT republish for sensitive taxa.
        };
      });
      return text({
        data: { total: json.total ?? records.length, records },
        unreviewed: true,
        source: "OBIS — https://obis.org (per-dataset license; verify before reuse)",
        attribution: "External data via OBIS API. NOT curated Blue Life Commons content.",
        warning:
          "Precise coordinates are external & unreviewed. Apply the commons' sensitivity policy before publishing locations for vulnerable taxa.",
      });
    } catch (e) {
      return text({ data: null, unreviewed: true, source: "OBIS", error: (e as Error).message });
    }
  },
);

/* ---- Sustainable Practices (BLC content/practices/) ---- */
server.registerTool(
  "get_practice_guide",
  {
    title: "Get sustainable practice guide",
    description:
      "Retrieve a reviewed sustainable ocean practice guide from the commons (coral gardening, kelp restoration, seagrass regeneration, mangrove restoration, sustainable aquaculture, MPAs, ocean plastic removal, blue carbon, artificial reef design). Review-gated.",
    inputSchema: {
      practice_id: z
        .string()
        .describe("Artifact id, e.g. 'coral-gardening' or 'kelp-forest-restoration'"),
    },
  },
  async ({ practice_id }) => {
    const corpus = loadCorpus();
    const practices = corpus.filter(
      (a) => a.frontmatter.type === "practice-guide" || a.path.includes("/practices/"),
    );
    const a = practices.find(
      (x) =>
        x.frontmatter.id === practice_id ||
        x.path.endsWith(`${practice_id}.md`) ||
        matchesQuery(x, practice_id),
    );
    if (!a) {
      const available = practices.map((p) => p.frontmatter.id);
      return text(envelope(null, undefined, { found: false, practice_id, available }));
    }
    const verdict = assertServable(a.frontmatter);
    if (!verdict.servable)
      return text(
        envelope({ id: a.frontmatter.id, title: a.frontmatter.title }, a.frontmatter, {
          servable: false,
          refused: verdict.reason,
        }),
      );
    return text(envelope({ ...a.frontmatter, body: a.body }, a.frontmatter, { servable: true }));
  },
);

/* ---- Wisdom Library (BLC content/wisdom/) ---- */
server.registerTool(
  "get_wisdom_article",
  {
    title: "Get ocean wisdom article",
    description:
      "Retrieve a curated ocean wisdom article from the commons (ocean-climate-connection, ocean-acidification, 30x30 goal, indigenous stewardship, noise pollution, deep-sea mining, five key metrics). Review-gated.",
    inputSchema: {
      article_id: z
        .string()
        .optional()
        .describe("Artifact id or keyword, e.g. 'ocean-climate-connection' or 'acidification'"),
    },
  },
  async ({ article_id }) => {
    const corpus = loadCorpus();
    const wisdom = corpus.filter(
      (a) => a.frontmatter.type === "wisdom" || a.path.includes("/wisdom/"),
    );
    if (!article_id) {
      return text(
        envelope(
          wisdom.map((a) => ({
            id: a.frontmatter.id,
            title: a.frontmatter.title,
            status: a.frontmatter.status,
            servable: assertServable(a.frontmatter).servable,
          })),
          undefined,
          { count: wisdom.length },
        ),
      );
    }
    const a = wisdom.find(
      (x) =>
        x.frontmatter.id === article_id ||
        x.path.endsWith(`${article_id}.md`) ||
        matchesQuery(x, article_id),
    );
    if (!a) {
      const available = wisdom.map((w) => w.frontmatter.id);
      return text(envelope(null, undefined, { found: false, article_id, available }));
    }
    const verdict = assertServable(a.frontmatter);
    if (!verdict.servable)
      return text(
        envelope({ id: a.frontmatter.id, title: a.frontmatter.title }, a.frontmatter, {
          servable: false,
          refused: verdict.reason,
        }),
      );
    return text(envelope({ ...a.frontmatter, body: a.body }, a.frontmatter, { servable: true }));
  },
);

/* ---- Guardian Query (OIS REST gateway passthrough) ---- */
server.registerTool(
  "guardian_query",
  {
    title: "Query Guardian instances",
    description:
      "Query live Ocean Guardian instances through the OIS REST gateway. Returns guardian status, last-run briefings, and active signal counts. Requires OIS_GATEWAY_URL pointing to a running ocean-intelligence-system gateway (default: http://localhost:3000).",
    inputSchema: {
      guardian_id: z
        .string()
        .optional()
        .describe(
          "Guardian instance id (e.g. 'gbr-reef-guardian'). Omit to list all active guardians.",
        ),
      include_briefing: z
        .boolean()
        .optional()
        .describe("Include last generated briefing text in the response (default: false)."),
    },
  },
  async ({ guardian_id, include_briefing }) => {
    const base = (process.env.OIS_GATEWAY_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const path = guardian_id ? `/guardians/${encodeURIComponent(guardian_id)}` : "/guardians";
    const url = `${base}${path}`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "marine-mcp/0.1 (Ocean Intelligence System)" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`OIS gateway HTTP ${res.status} ${res.statusText}`);
      const json = await res.json();
      const data = include_briefing ? json : stripBriefingBodies(json);
      return text({
        data,
        source: `OIS REST gateway (${url})`,
        unreviewed: false,
        note: "Guardian briefings are derived from reviewed BLC commons artifacts + live connector signals.",
      });
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      return text({
        data: null,
        source: `OIS REST gateway (${url})`,
        error: errorMessage,
        hint: "Is the OIS gateway running? Set OIS_GATEWAY_URL=https://your-deployed-ois to reach a remote instance.",
      });
    }
  },
);

/** Strip large briefing body text when include_briefing is false. */
function stripBriefingBodies(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripBriefingBodies);
  if (obj !== null && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      out[k] = k === "briefing_body" || k === "full_briefing" ? "[use include_briefing:true to retrieve]" : stripBriefingBodies(v);
    }
    return out;
  }
  return obj;
}

async function main() {
  // Fail fast with a clear message if the corpus path is misconfigured.
  resolveCorpusRoot();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs on a stdio server (stdout is the protocol channel).
  console.error("marine-mcp v0.1.0 connected (stdio). Serving Blue Life Commons, review-gated.");
}

main().catch((err) => {
  console.error("marine-mcp fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
