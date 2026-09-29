import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertServable,
  splitFrontmatter,
  envelope,
  SPECIES_GROUPS,
  type ArtifactFrontmatter,
} from "../src/corpus.js";

const base: ArtifactFrontmatter = {
  id: "x",
  type: "species-page",
  title: "X",
  status: "needs-expert-review",
  sources: [{ url: "https://iucnredlist.org/x" }],
  review: { science: "pending", ethics: "approved", editor: "pending" },
};

test("needs-expert-review species page is NOT servable", () => {
  const v = assertServable(base, {} as NodeJS.ProcessEnv);
  assert.equal(v.servable, false);
  assert.match(v.reason, /review-approved/);
});

test("approved status but science pending => still NOT servable for science-sensitive type", () => {
  const v = assertServable({ ...base, status: "approved" }, {} as NodeJS.ProcessEnv);
  assert.equal(v.servable, false);
  assert.match(v.reason, /review\.science/);
});

test("approved status AND science approved => servable", () => {
  const v = assertServable(
    { ...base, status: "approved", review: { science: "approved", ethics: "approved", editor: "approved" } },
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(v.servable, true);
});

test("non-science-sensitive type only needs approved/published status", () => {
  const v = assertServable(
    { ...base, type: "partner-profile", status: "published" },
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(v.servable, true);
});

test("BLC_ALLOW_UNREVIEWED override serves but flags reason", () => {
  const v = assertServable(base, { BLC_ALLOW_UNREVIEWED: "true" } as unknown as NodeJS.ProcessEnv);
  assert.equal(v.servable, true);
  assert.match(v.reason, /override/);
});

test("splitFrontmatter parses YAML and body", () => {
  const doc = "---\nid: a\ntype: species-page\ntitle: A\nstatus: draft\n---\n\n# Body here\ntext";
  const out = splitFrontmatter(doc);
  assert.ok(out);
  assert.equal((out!.fm as ArtifactFrontmatter).id, "a");
  assert.match(out!.body, /# Body here/);
});

test("splitFrontmatter returns null when no frontmatter", () => {
  assert.equal(splitFrontmatter("# just markdown"), null);
});

test("envelope always carries sources + attribution", () => {
  const e = envelope({ ok: 1 }, base);
  assert.equal(e.sources.length, 1);
  assert.match(e.attribution, /Blue Life Commons/);
  assert.equal(e.status, "needs-expert-review");
});

test("welfare and clinical types need review.science=approved, matching the commons lint", () => {
  for (const type of [
    "welfare-assessment",
    "stranding-protocol",
    "release-criteria",
    "husbandry-guide",
    "necropsy-summary",
  ]) {
    const v = assertServable({ ...base, type, status: "approved" }, {} as NodeJS.ProcessEnv);
    assert.equal(v.servable, false, type);
    assert.match(v.reason, /review\.science/, type);
  }
});

test("override verdict is marked so responses can flag unreviewed content", () => {
  const v = assertServable(base, { BLC_ALLOW_UNREVIEWED: "true" } as unknown as NodeJS.ProcessEnv);
  assert.equal(v.override, true);
  assert.equal(assertServable({ ...base, status: "approved", review: { science: "approved" } }, {} as NodeJS.ProcessEnv).override, undefined);
});

test("species group filter covers every guild in the commons artifact schema", () => {
  assert.deepEqual(
    [...SPECIES_GROUPS].sort(),
    ["cetaceans", "marine-reptiles", "pinnipeds", "reefs", "sharks-rays", "sirenians", "turtles"],
  );
});
