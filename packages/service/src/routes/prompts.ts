/**
 * GET /api/prompts?review=:id (PRD §4.14).
 *
 * - Without `?review=`: every template with its variables marked
 *   (`PromptTemplate`: name, role, tier, variables, raw text).
 * - With `?review=`: plus the exact expanded text that would be sent now,
 *   with layers L0–L4 marked (`<!-- layer:… -->` spans), token counts per
 *   layer, and the cached part set apart (`cached` flags + `cachedTokens`).
 *
 * Review data arrives through the narrow `SnapshotProvider` interface
 * (`getSnapshot(reviewId)`). `createApp` wires it to the real
 * `ReviewStore` via `toPromptSnapshot`; without a provider, `?review=`
 * answers 501.
 *
 * Expansion rules (documented for the settings UI):
 * - Base templates (reader, base_pack, critic, hunk_pass, concept_*,
 *   update_pass, consolidate, second_opinion_*) expand against real review
 *   data: source blurb, diff section (with the same budget fallback the
 *   pipeline uses), pinned code, guide, concepts, hunk summaries, the log.
 * - Turn templates (explain, ask, depth, examples, diagram,
 *   go_deeper) have no live anchor "now": their L4 renders with the
 *   review's real change list plus clearly-marked `(…)` placeholders for
 *   the anchor quote, thread, card-under-edit and user message.
 * - Caching flags: spans served from a warm base (L0–L3 on a fork) are
 *   `cached`; fresh sessions (reader, hunk pass, consolidate,
 *   second opinions) and every L4 are not.
 */
import type { FastifyInstance } from "fastify";
import {
  PROMPT_TEMPLATE_NAMES,
  collectTargets,
  parseId,
  renderMarkdown,
  tokenizeLinks,
  type Block,
  type PromptExpanded,
  type PromptLayerSpan,
  type PromptsResponse,
  type PromptTemplate,
  type ReviewSnapshot,
} from "@unvibe/shared";
import {
  buildConceptsSection,
  buildGuideSection,
  buildHunkSummaries,
  buildL1bPinned,
  buildLadder,
  charTokenEstimator,
  DEFAULT_BASE_PROMPT_CAP_TOKENS,
  DEFAULT_LEFTOVER_FLOOR_TOKENS,
  filterChangeList,
  formatChangeList,
  formatHunk,
  hunkId,
  pinnedId,
  type ConceptIndexEntry,
  type ContextFile,
  type FindingInput,
  type GuideCardInput,
  type PromptReviewSnapshot,
} from "../context/index.js";
import {
  loadTemplatesDirSync,
  renderTemplate,
  resolvePromptsDir,
  type RenderValues,
  type TemplateLibrary,
} from "../prompts/index.js";
import { renderSystemPrompt } from "../prompts/access.js";
import { accessModeOf, isCustomGuidePage, type AccessMode } from "@unvibe/shared";
import { formatContributionLines } from "../sharedctx/contributions.js";
import { currentDescriptionHtml, parseDescriptionParagraphs } from "../ingest/description.js";

/** Narrow interface the supervisor wires to review state. */
export interface SnapshotProvider {
  getSnapshot(reviewId: string): Promise<PromptReviewSnapshot | null>;
}

/** True when a guide citation (diff range or hunk ID) touches this hunk. */
function hunkIsCited(
  fileKey: string,
  hunk: { contentHash: string; newStart: number; newEnd: number },
  cited: Set<string>,
): boolean {
  for (const target of cited) {
    const parsed = parseId(target);
    if (!parsed) continue;
    if (parsed.kind === "h" && parsed.fileKey === fileKey && parsed.contentHash === hunk.contentHash) {
      return true;
    }
    if (
      parsed.kind === "diff" &&
      parsed.fileKey === fileKey &&
      parsed.start <= hunk.newEnd &&
      parsed.end >= hunk.newStart
    ) {
      return true;
    }
  }
  return false;
}

/** Description HTML back to plain Markdown-ish text (context input). */

/**
 * M5 shared context (PRD §9.2, §9.4): the guide revision keying the base.
 *
 * Derived from guide *content* (pages, cards, revisions, block ids) — not
 * the snapshot rev, which bumps on every log append, contribution, or job
 * update. Log growth must append batches to the live base, not invalidate
 * it; only a regenerated guide (new cards, new revisions, rechecked
 * findings) keys a new base. Deterministic FNV-1a hex, platform-independent.
 *
 * Issue #110: the current description HTML (pending edit included) rides
 * the same revision as a second hash component, so an edited description
 * keys a new base the way a regenerated guide does — otherwise agents
 * would keep citing the paragraph text they started with. A description
 * edit surfaces as a "guide-regenerated" rebuild: the base content changed,
 * whatever the section.
 */
export function guideRevisionForSnapshot(snap: ReviewSnapshot): string {
  // Custom guides are not part of the main guide: their cards streaming
  // in must not key a new base for every later fork.
  const shape = snap.pages.filter((p) => !isCustomGuidePage(p)).map((p) => [
    p.id,
    p.kind,
    p.title,
    p.confidence ?? "",
    p.summary ?? "",
    p.cards.map((c) => [
      c.id,
      c.title,
      c.level,
      c.revision,
      c.blocks.map((b) => [b.id, b.type]),
    ]),
  ]);
  return `guide-${fnv1aHex(JSON.stringify(shape))}-${descriptionRevisionForSnapshot(snap)}`;
}

/**
 * Short content hash of the description the agents see (issue #110): the
 * pending edit when there is one (`currentDescriptionHtml`, issue #96).
 * Part of the base key (via `guideRevisionForSnapshot`) and of the
 * second-opinion base key, so a later edit invalidates the base.
 */
export function descriptionRevisionForSnapshot(snap: ReviewSnapshot): string {
  return fnv1aHex(currentDescriptionHtml(snap.description ?? null));
}

function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}function descToMarkdown(html: string): string {
  let s = html
    .replace(/<h3>([\s\S]*?)<\/h3>/gi, "### $1\n\n")
    .replace(/<li>([\s\S]*?)<\/li>/gi, "- $1\n")
    .replace(/<\/?(ul|ol|div|pre|p)[^>]*>/gi, "\n")
    .replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<[^>]+>/g, "");
  s = s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
  return s
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function plainText(html: string, max = 160): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Adapt a stored `ReviewSnapshot` to the context builder's narrow input so
 * `GET /api/prompts?review=` expands against real review data. Block
 * content travels back through the reply Markdown format (`renderMarkdown`,
 * the inverse of the content parser); hunk summaries come from hunk state;
 * `citedByGuide` is recomputed from the guide's citation targets.
 */
export function toPromptSnapshot(
  snap: ReviewSnapshot,
  opts?: { model?: string },
): PromptReviewSnapshot {
  const { review, version } = snap;
  const states = new Map(snap.hunkStates.map((s) => [s.contentHash, s]));
  const cited = new Set<string>();
  for (const page of snap.pages) {
    if (isCustomGuidePage(page)) continue;
    for (const card of page.cards) {
      const targets = collectTargets(card.blocks);
      for (const t of [...targets.citations, ...targets.links]) cited.add(t);
    }
  }

  const files: ContextFile[] = snap.files.map((f) => ({
    fileKey: f.fileKey,
    path: f.path,
    category: f.category,
    hunks: f.hunks.map((h) => {
      const summary = states.get(h.contentHash)?.summary;
      return {
        contentHash: h.contentHash,
        fileKey: f.fileKey,
        header: h.header,
        ...(h.context !== undefined ? { context: h.context } : {}),
        newStart: h.newStart,
        oldStart: h.oldStart,
        lines: h.lines.map((l) => ({ kind: l.kind, text: l.text })),
        ...(h.hiddenReason !== undefined ? { hiddenReason: h.hiddenReason } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(hunkIsCited(f.fileKey, h, cited) ? { citedByGuide: true as const } : {}),
      };
    }),
  }));

  const root = snap.pages.find((p) => p.kind === "root");
  const cards: GuideCardInput[] = (root?.cards ?? []).map((c) => ({
    id: c.id,
    title: c.title,
    level: c.level,
    revision: c.revision,
    markdown: renderMarkdown(c.blocks).trim(),
  }));
  const findings: FindingInput[] = snap.pages
    .filter((p) => p.kind === "finding")
    .map((p) => ({
      pageId: p.id,
      title: p.title,
      confidence: p.confidence ?? "",
      summary: p.summary ?? "",
      markdown: p.cards
        .map((c) => `### ${c.title ?? "Untitled"}\n\n${renderMarkdown(c.blocks).trim()}`)
        .join("\n\n"),
    }));
  const concepts: ConceptIndexEntry[] = snap.pages
    .filter((p) => p.kind === "concept")
    .map((p) => {
      const first = p.cards[0]?.blocks.find((b: Block) => b.type === "paragraph");
      return {
        slug: p.id.startsWith("c-") ? p.id.slice(2) : p.id,
        title: p.title,
        oneLine:
          first && first.type === "paragraph" ? plainText(first.text.standard) : "",
      };
    });

  // Issue #110: the base reads the description the agents see — the pending
  // edit when there is one — and carries its paragraphs with the IDs ingest
  // assigned, parsed with the single source (`parseDescriptionParagraphs`,
  // issue #96) the MCP tools and the validator read.
  const descHtml = snap.description ? currentDescriptionHtml(snap.description) : "";
  const description = descHtml ? descToMarkdown(descHtml) : undefined;
  const descriptionParagraphs = parseDescriptionParagraphs(descHtml);
  // Reader-pinned excerpts (PRD §9.1 L1b). The stored shape carries
  // refresh bookkeeping (`needsRepining`, remapped location) the prompt
  // builder does not take, so map to the narrow excerpt shape explicitly.
  const pinnedCode = (snap.pinnedCode ?? []).map((p) => ({
    path: p.path,
    start: p.start,
    end: p.end,
    sha: p.sha,
    text: p.text,
    ...(p.language !== undefined ? { language: p.language } : {}),
  }));
  return {
    reviewId: review.id,
    title:
      review.prNumber !== undefined
        ? `PR #${review.prNumber} on ${review.repoId}`
        : `${review.repoId}@${review.branch}`,
    repo: review.repoId,
    branch: review.branch,
    ...(review.prNumber !== undefined ? { prNumber: review.prNumber } : {}),
    version: version.n,
    headSha: version.headSha,
    baseRef: version.baseRef,
    guideRevision: guideRevisionForSnapshot(snap),
    model: opts?.model ?? "main",
    sourceKind: review.prNumber !== undefined ? "pr" : "branch",
    ...(description ? { description } : {}),
    ...(descriptionParagraphs.length > 0 ? { descriptionParagraphs } : {}),
    // Issue #193: commit evidence for plotlines (subjects, bodies, files/hunks).
    ...((snap.commits ?? []).length > 0
      ? {
          commits: (snap.commits ?? []).map((c) => ({
            sha: c.sha,
            subject: c.subject,
            body: c.body,
            files: [...c.files],
            hunks: [...c.hunks],
          })),
        }
      : {}),
    // Branch reviews: the commit log the L1 head shows when there is no PR description.
    ...(review.prNumber === undefined && (snap.commits ?? []).length > 0
      ? {
          commitLog: (snap.commits ?? [])
            .map((c) => `${c.sha.slice(0, 7)} ${c.subject}${c.body ? `\n${c.body}` : ""}`)
            .join("\n\n"),
        }
      : {}),
    files,
    pinnedCode,
    cards,
    findings,
    concepts,
    // Issue #168: absent until first fetched (menu or refresh); the agents
    // see every fetched comment whether or not the diff shows them.
    existingComments: (snap.existingComments ?? []).map((c) => ({
      id: c.id,
      ...(c.path !== undefined ? { path: c.path } : {}),
      ...(c.line !== undefined ? { line: c.line } : {}),
      ...(c.author !== undefined ? { author: c.author } : {}),
      body: c.body,
    })),
    log: snap.logTail,
    contributions: snap.contributions,
  };
}

export interface PromptsRouteDeps {
  /** Defaults to `resolvePromptsDir()` (env `UNVIBE_PROMPTS_DIR` or walk-up). */
  promptsDir?: string;
  /** When absent, `?review=` answers 501 until wired. */
  snapshots?: SnapshotProvider;
  /**
   * Issue #160: stored settings, so the `?review=` expansion previews the
   * L0 variant the setting selects. Absent → the lock-down preview.
   */
  settings?: { get(): { fullAccess: boolean } };
}

/** An expanded prompt with its layer spans (extends the shared contract). */
export interface ExpandedPrompt extends PromptExpanded {
  spans: PromptLayerSpan[];
}

interface Span {
  layer: PromptLayerSpan["layer"];
  label: string;
  text: string;
  cached: boolean;
}

function assemble(name: string, spans: Span[]): ExpandedPrompt {
  const parts: string[] = [];
  const fullSpans: PromptLayerSpan[] = spans.map((s) => ({
    layer: s.layer,
    label: s.label,
    tokens: charTokenEstimator.estimateTokens(s.text),
    cached: s.cached,
  }));
  let cachedTokens = 0;
  fullSpans.forEach((info, i) => {
    const text = spans[i].text;
    const flag = info.cached ? "cached:yes" : "cached:no";
    parts.push(
      `<!-- layer:${info.layer} label:${info.label} tokens:${info.tokens} ${flag} -->\n` +
        `${text}` +
        (text.endsWith("\n") ? "" : "\n") +
        `<!-- /layer:${info.layer} -->\n`,
    );
    if (info.cached) cachedTokens += info.tokens;
  });
  const layers = fullSpans.map(({ layer, tokens }) => ({ layer, tokens }));
  return { name, expanded: parts.join("\n"), layers, cachedTokens, spans: fullSpans };
}

function toTemplate(name: string, lib: TemplateLibrary): PromptTemplate {
  const t = lib.get(name);
  if (!t) throw new Error(`prompt template missing: ${name}`);
  return { name, role: t.role, tier: t.tier, variables: t.variables, template: t.body };
}

/** Values that are genuinely "now"; turn-specific ones stay placeholders. */
const PH = {
  anchorQuote: "(no text selected — open this template from Explain/Ask/Note)",
  anchorBlock: "(the host block is attached when the action runs)",
  thread: "(no thread yet)",
  message: "(the reader's message is attached when the action runs)",
  card: "(no card selected)",
  level: "(target level)",
  direction: "(no placeholder selected)",
  changedHunks: "(no newer version — the update pass lists changed hunks here)",
  staleCards: "(guide is current — affected cards are listed here after a refresh)",
  citedCode: "(cited excerpts are attached when the action runs)",
  topic: "(select a card or finding)",
  claim: "(select a card or finding)",
  mentions: "(mentions resolve when the action runs)",
  contributions: "(no contributions yet)",
  plotlines: "(the reader names plotlines when the guide runs)",
  unassignedHunks: "(hunks the reader did not see are listed here after the guide runs)",
  commits: "(the review's commits are listed here when the assign step runs)",
};

/**
 * Citation IDs (`code:`/`diff:`) mentioned in Markdown, via shared tokens.
 * Used to attach real cited excerpts to the second-opinion expansion.
 */
function citedCodeIds(markdown: string): string[] {
  const ids: string[] = [];
  for (const token of tokenizeLinks(markdown)) {
    if (/^(code|diff):/.test(token.idText)) ids.push(token.idText);
  }
  return ids;
}

/** Rendered excerpts for the given IDs from reader-pinned code. */
function excerptsFor(snapshot: PromptReviewSnapshot, ids: string[]): string {
  // Index by full ID and by short form (PRD §7.2: prompts may drop @sha).
  const byId = new Map<string, (typeof snapshot.pinnedCode)[number]>();
  for (const pin of snapshot.pinnedCode) {
    const full = pinnedId(pin);
    byId.set(full, pin);
    const short = full.split("@")[0];
    if (!byId.has(short)) byId.set(short, pin);
  }
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const pin = byId.get(id);
    if (pin) parts.push(`### [[${pinnedId(pin)}]]\n\n${pin.text}\n`);
  }
  return parts.length > 0 ? parts.join("\n") : PH.citedCode;
}

function firstFindingTopic(snapshot: PromptReviewSnapshot): { topic: string; claim: string } {
  const f = snapshot.findings[0];
  if (!f) return { topic: PH.topic, claim: PH.claim };
  return {
    topic: `${f.title} (${f.confidence}): ${f.summary}`,
    claim: `${f.title}: ${f.summary}`,
  };
}

function firstFindingCitedCode(snapshot: PromptReviewSnapshot): string {
  const f = snapshot.findings[0];
  if (!f) return PH.citedCode;
  return excerptsFor(snapshot, citedCodeIds(`${f.summary}\n${f.markdown}`));
}

/** Expand every template against the snapshot. Pure given the library. */
export function expandAll(lib: TemplateLibrary, snapshot: PromptReviewSnapshot, access: AccessMode = "lockdown"): ExpandedPrompt[] {
  const render = (name: string, values: RenderValues): string => {
    const t = lib.get(name);
    if (!t) throw new Error(`prompt template missing: ${name}`);
    return renderTemplate(t, values);
  };

  // Issue #160: the L0 preview shows the variant the setting selects —
  // the lock-down wording, or the full-access allowed/forbidden list.
  const l0 = renderSystemPrompt(lib, access);
  // One ladder call (issue #107): the preview shows the same capped halves
  // the pipeline sends, from the same rung.
  const ladder = buildLadder(snapshot);
  const blurb = ladder.source;
  const diff = ladder.diff;
  const l1full = { text: ladder.text };
  const l1b = buildL1bPinned(snapshot.pinnedCode);
  const guide = buildGuideSection(snapshot);
  const concepts = buildConceptsSection(snapshot);
  // Same leftover budgeting as the base pack (issue #107): the preview's
  // L2 span assembles guide + concepts + summaries into one message.
  const previewUsed =
    charTokenEstimator.estimateTokens(ladder.text) +
    charTokenEstimator.estimateTokens(l1b) +
    charTokenEstimator.estimateTokens(`${guide}\n${concepts}`);
  const hunkSummaries = buildHunkSummaries(snapshot, {
    baseCapTokens: Math.max(DEFAULT_LEFTOVER_FLOOR_TOKENS, DEFAULT_BASE_PROMPT_CAP_TOKENS - previewUsed),
  });
  const changeList = formatChangeList(
    filterChangeList(snapshot.log, { lastSeenSeq: 0 }).slice(-10),
  );
  const recentLog = changeList === "(no changes)" ? "(log is empty)" : changeList;

  const firstHunk = snapshot.files.flatMap((f) =>
    f.hunks.map((h) => ({ file: f, hunk: h })),
  )[0];
  const hunkText = firstHunk
    ? `${formatHunk(firstHunk.hunk)}\n${firstHunk.hunk.citedByGuide === true ? "\nCITED-BY-GUIDE\n" : ""}`
    : "(no hunks)";
  const hunkPath = firstHunk ? firstHunk.file.path : "(no files)";
  const hunkLabel = firstHunk ? `hunk ${hunkId(firstHunk.hunk.fileKey, firstHunk.hunk.contentHash)}` : "hunk";

  const firstCard = snapshot.cards[0];
  const cardText = firstCard
    ? `### ${firstCard.title ?? "(untitled)"} [[card:${firstCard.id}]]\n\n${firstCard.markdown}\n`
    : PH.card;
  const firstConcept = snapshot.concepts[0];
  const conceptText = firstConcept
    ? `${firstConcept.slug} — ${firstConcept.title}: ${firstConcept.oneLine}`
    : PH.topic;
  const contributionLines = formatContributionLines(snapshot.contributions ?? []);
  const contributionsText = contributionLines !== "" ? contributionLines : PH.contributions;

  const { topic, claim } = firstFindingTopic(snapshot);
  const findingCited = firstFindingCitedCode(snapshot);
  const findingsText = snapshot.findings
    .map((f) => `### ${f.title} (${f.confidence}) [[page:${f.pageId}]]\n\n${f.summary}\n`)
    .join("\n");

  const baseSpans = (cached: boolean): Span[] => [
    { layer: "L0", label: "instructions", text: l0, cached },
    { layer: "L1", label: "source", text: l1full.text, cached },
    { layer: "L1b", label: "pinned", text: l1b, cached },
    { layer: "L2", label: "guide", text: `${guide}\n${concepts}\n${hunkSummaries}`, cached },
  ];

  const l3span = (cached: boolean): Span => ({
    layer: "L3",
    label: "log",
    text: recentLog,
    cached,
  });

  const out: ExpandedPrompt[] = [];
  const push = (name: string, spans: Span[]): void => {
    out.push(assemble(name, spans));
  };

  push("instructions", [{ layer: "L0", label: "instructions", text: l0, cached: false }]);
  push("reader", [
    { layer: "L0", label: "instructions", text: l0, cached: false },
    {
      layer: "L1",
      label: "reader task",
      text: render("reader", { source: blurb, diff_inline: diff.text, repo_path: "(worktree path)" }),
      cached: false,
    },
  ]);
  push("base_pack", [
    { layer: "L0", label: "instructions", text: l0, cached: true },
    { layer: "L1", label: "source", text: l1full.text, cached: true },
    { layer: "L1b", label: "pinned", text: l1b, cached: true },
    { layer: "L2", label: "guide", text: `${guide}\n${concepts}\n${hunkSummaries}`, cached: true },
    {
      layer: "L4",
      label: "base_pack",
      text: render("base_pack", {
        source: blurb,
        diff_inline: diff.text,
        pinned_code: l1b,
        guide,
        concepts,
        hunk_summaries: hunkSummaries,
      }),
      cached: false,
    },
  ]);
  const forked = (name: string, l4values: RenderValues): void =>
    push(name, [...baseSpans(true), l3span(true), { layer: "L4", label: name, text: render(name, l4values), cached: false }]);

  forked("critic", {});
  forked("concept_page", { concept: conceptText, mentions: PH.mentions });
  forked("ask", {
    anchor: { quote: PH.anchorQuote, block: PH.anchorBlock },
    card: cardText,
    thread: PH.thread,
    change_list: changeList,
    message: PH.message,
  });
  forked("ask_turn", { change_list: changeList, message: PH.message });
  forked("depth", { card: cardText, level: PH.level });
  forked("examples", { card: cardText, level: PH.level });
  forked("diagram", { card: cardText, level: PH.level });
  forked("go_deeper", { direction: PH.direction });
  forked("update_pass", {
    changed_hunks: PH.changedHunks,
    stale_cards: PH.staleCards,
    findings: findingsText === "" ? "(no findings)" : findingsText,
  });

  push("hunk_pass", [
    {
      layer: "L1",
      label: hunkLabel,
      text: render("hunk_pass", { hunk: hunkText, path: hunkPath, plotline: "(none assigned yet)" }),
      cached: false,
    },
  ]);
  push("plotline_assign", [
    {
      layer: "L2",
      label: "plotline_assign",
      text: render("plotline_assign", { plotlines: PH.plotlines, hunks: PH.unassignedHunks, commits: PH.commits }),
      cached: false,
    },
  ]);
  push("consolidate", [
    {
      layer: "L3",
      label: "contributions",
      text: render("consolidate", { contributions: contributionsText }),
      cached: false,
    },
  ]);
  push("second_opinion_blind", [
    { layer: "L0", label: "instructions", text: l0, cached: false },
    { layer: "L1", label: "source", text: `${blurb}\n${diff.text}`, cached: false },
    {
      layer: "L4",
      label: "blind review",
      text: render("second_opinion_blind", { topic, cited_code: findingCited }),
      cached: false,
    },
  ]);
  push("second_opinion_check", [
    { layer: "L0", label: "instructions", text: l0, cached: false },
    { layer: "L1", label: "source", text: `${blurb}\n${diff.text}`, cached: false },
    {
      layer: "L4",
      label: "claim check",
      text: render("second_opinion_check", { claim, cited_code: findingCited }),
      cached: false,
    },
  ]);

  return out;
}

/** GET /api/prompts?review=:id */
export async function registerPrompts(
  app: FastifyInstance,
  deps: PromptsRouteDeps = {},
): Promise<void> {
  const dir = deps.promptsDir ?? resolvePromptsDir();
  let lib: TemplateLibrary | null = null;
  let loadError: string | null = null;
  if (dir) {
    try {
      lib = loadTemplatesDirSync(dir);
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
  }

  app.get("/api/prompts", async (req, reply) => {
    if (!lib) {
      return reply
        .code(501)
        .send({ error: "prompts unavailable", detail: loadError ?? `no prompts dir (set UNVIBE_PROMPTS_DIR)` });
    }
    const query = req.query as { review?: string };
    const templates: PromptTemplate[] = PROMPT_TEMPLATE_NAMES.map((name) => toTemplate(name, lib));
    const body: PromptsResponse = { templates };
    if (query.review !== undefined) {
      if (!deps.snapshots) {
        return reply.code(501).send({ error: "not available in this build" });
      }
      let snapshot: PromptReviewSnapshot | null;
      try {
        snapshot = await deps.snapshots.getSnapshot(query.review);
      } catch (err) {
        return reply
          .code(500)
          .send({ error: "snapshot failed", detail: err instanceof Error ? err.message : String(err) });
      }
      if (!snapshot) return reply.code(404).send({ error: `unknown review ${query.review}` });
      try {
        const access = deps.settings ? accessModeOf(deps.settings.get()) : "lockdown";
        (body as PromptsResponse & { expanded: ExpandedPrompt[] }).expanded = expandAll(lib, snapshot, access);
      } catch (err) {
        return reply
          .code(500)
          .send({ error: "expansion failed", detail: err instanceof Error ? err.message : String(err) });
      }
    }
    return body;
  });
}
