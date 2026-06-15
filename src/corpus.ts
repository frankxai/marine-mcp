/**
 * Blue Life Commons corpus loader for marine-mcp.
 *
 * Reads review-gated, source-attributed artifacts from a local checkout of the
 * blue-life-commons repository (path via BLC_PATH). This module is the trust
 * boundary of the Ocean Intelligence System: it parses artifact frontmatter and
 * decides — via assertServable() — what an agent is allowed to receive AS FACT.
 *
 * Hard rules enforced here (from blue-life-commons/AGENTS.md, ETHICS.md, SOURCES.md):
 *  - Never serve unreviewed content as fact.
 *  - Every served artifact carries its sources through to the consumer.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";

/** Artifact types whose factual claims require science review before being served as fact. */
export const SCIENCE_SENSITIVE_TYPES = new Set([
  "species-page",
  "region-briefing",
  "research-summary",
  "dataset-card",
  "observation-guide",
  "field-mission",
]);

/** Statuses considered "review-complete" enough to serve a body as fact. */
const SERVABLE_STATUSES = new Set(["approved", "published"]);

export interface Source {
  url: string;
  title?: string;
  accessed?: string;
}

export interface ArtifactFrontmatter {
  id: string;
  type: string;
  title: string;
  status: string;
  species_group?: string[];
  species?: string[];
  region?: string[];
  sources?: Source[];
  review?: { science?: string; ethics?: string; editor?: string };
  outputs?: { website_path?: string; github_path?: string; map_layer?: boolean };
  difficulty?: string;
  [key: string]: unknown;
}

export interface Artifact {
  frontmatter: ArtifactFrontmatter;
  body: string;
  /** Repo-relative path, POSIX-normalized. */
  path: string;
}

export interface ServableVerdict {
  servable: boolean;
  status: string;
  reason: string;
}

const ATTRIBUTION =
  "Built on SIP · Blue Life Commons (CC-BY-4.0) · review-gated, source-attributed";

/** Resolve the blue-life-commons checkout. BLC_PATH wins; never hardcode a sibling. */
export function resolveCorpusRoot(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.BLC_PATH;
  if (!root) {
    throw new Error(
      "BLC_PATH is not set. Point it at a local checkout of blue-life-commons " +
        "(e.g. BLC_PATH=/path/to/blue-life-commons). marine-mcp never assumes a sibling directory.",
    );
  }
  if (!existsSync(root)) {
    throw new Error(`BLC_PATH does not exist: ${root}`);
  }
  return root;
}

/** Split YAML frontmatter from a Markdown body. Returns null if no frontmatter. */
export function splitFrontmatter(text: string): { fm: unknown; body: string } | null {
  if (!text.startsWith("---")) return null;
  const parts = text.split(/\r?\n---\r?\n/);
  // text starts with "---\n"; first split chunk is "---\n<yaml>"
  const firstBreak = text.indexOf("\n");
  const rest = text.slice(firstBreak + 1);
  const endIdx = rest.search(/\r?\n---\r?\n|\r?\n---\s*$/);
  if (endIdx === -1) return null;
  const yamlBlock = rest.slice(0, endIdx);
  const afterYaml = rest.slice(endIdx).replace(/^\r?\n---\r?\n?/, "");
  try {
    return { fm: parseYaml(yamlBlock), body: afterYaml.trimStart() };
  } catch {
    return null;
  }
}

function walkMarkdown(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkMarkdown(full, acc);
    else if (/\.(md|mdx)$/i.test(entry)) acc.push(full);
  }
  return acc;
}

/** Load every artifact with valid frontmatter from content/ and missions/. */
export function loadCorpus(root: string = resolveCorpusRoot()): Artifact[] {
  const artifacts: Artifact[] = [];
  for (const sub of ["content", "missions"]) {
    for (const file of walkMarkdown(join(root, sub))) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const split = splitFrontmatter(text);
      if (!split || typeof split.fm !== "object" || split.fm === null) continue;
      const fm = split.fm as ArtifactFrontmatter;
      if (!fm.id || !fm.type) continue; // not a real artifact (e.g. template README)
      artifacts.push({
        frontmatter: fm,
        body: split.body,
        path: relative(root, file).split(sep).join("/"),
      });
    }
  }
  return artifacts;
}

/**
 * The trust gate. Decide whether an artifact body may be returned AS FACT.
 * Science-sensitive types additionally require review.science === "approved".
 * Set BLC_ALLOW_UNREVIEWED=true ONLY for local preview — responses still flag it.
 */
export function assertServable(
  fm: ArtifactFrontmatter,
  env: NodeJS.ProcessEnv = process.env,
): ServableVerdict {
  const status = fm.status ?? "unknown";
  const allowUnreviewed = env.BLC_ALLOW_UNREVIEWED === "true";

  if (allowUnreviewed) {
    return { servable: true, status, reason: "BLC_ALLOW_UNREVIEWED override (local preview)" };
  }
  if (!SERVABLE_STATUSES.has(status)) {
    return {
      servable: false,
      status,
      reason: `Artifact status is "${status}". The Ocean Intelligence System serves only review-approved or published content as fact.`,
    };
  }
  if (SCIENCE_SENSITIVE_TYPES.has(fm.type) && fm.review?.science !== "approved") {
    return {
      servable: false,
      status,
      reason: `Science-sensitive type "${fm.type}" requires review.science=approved (currently "${fm.review?.science ?? "pending"}").`,
    };
  }
  return { servable: true, status, reason: "approved" };
}

/** Standard envelope. EVERY tool response carries sources + attribution + status. */
export function envelope(data: unknown, fm?: ArtifactFrontmatter, extra: Record<string, unknown> = {}) {
  return {
    data,
    sources: fm?.sources ?? [],
    status: fm?.status ?? null,
    attribution: ATTRIBUTION,
    ...extra,
  };
}
