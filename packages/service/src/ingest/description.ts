/**
 * Description rendering (ingest, PRD §§4.11/11.1).
 *
 * - For a PR: the body rendered to HTML with stable paragraph ids, so
 *   `desc:<paragraph>@<rev>` tokens resolve to elements.
 * - For a branch without a PR: the commit messages instead, read-only.
 *
 * Pure. The markdown subset is deliberately small (headings, lists, fences,
 * inline code/bold/links): PR bodies round-trip through GitHub anyway, and
 * the Submit path converts edited HTML back to Markdown (M4).
 */

export interface DescriptionParagraph {
  /** Stable id, e.g. `d-p3` (the `<paragraph>` in `desc:<paragraph>@<rev>`). */
  id: string;
  /** Plain text of the block (for search/anchors). */
  text: string;
}

export interface RenderedDescription {
  html: string;
  paragraphs: DescriptionParagraph[];
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inline markdown: code spans, bold, italic, `[label](url)`. */
export function renderInline(src: string): string {
  const codes: string[] = [];
  // Private-use placeholder: cannot collide with real text or markdown.
  const mark = (i: number): string => `\uE000${i}\uE001`;
  const noCode = escapeHtml(src).replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(`<code>${code}</code>`);
    return mark(codes.length - 1);
  });
  const linked = noCode
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|\W)_([^_\n]+)_/g, "$1<em>$2</em>");
  return linked.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => codes[Number(i)] ?? "");
}

interface Block {
  kind: "heading" | "list" | "code" | "para";
  lines: string[];
  ordered?: boolean;
}

function splitBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  const pushPara = (lines: string[]): void => {
    if (lines.join("").trim() !== "") blocks.push({ kind: "para", lines });
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: "heading", lines: [heading[2]] });
      i += 1;
      continue;
    }
    if (/^```/.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // consume closing fence (or EOF)
      blocks.push({ kind: "code", lines: body });
      continue;
    }
    const listMatch = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (listMatch) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [listMatch[1]];
      i += 1;
      while (i < lines.length) {
        const m = lines[i].match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
        if (!m || /^\s*$/.test(lines[i])) break;
        items.push(m[1]);
        i += 1;
      }
      blocks.push({ kind: "list", lines: items, ordered });
      continue;
    }
    const para: string[] = [line];
    i += 1;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4}\s|```)/.test(lines[i])) {
      const m = lines[i].match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
      if (m) break;
      para.push(lines[i]);
      i += 1;
    }
    pushPara(para);
  }
  return blocks;
}

/**
 * Render markdown-ish text to HTML. Every paragraph/list/code block gets a
 * stable id `d-p<n>` (document order); headings don't (they carry no
 * anchors in the prototype either).
 */
export function renderMarkdownBlocks(src: string): RenderedDescription {
  const parts: string[] = [];
  const paragraphs: DescriptionParagraph[] = [];
  let n = 0;
  for (const b of splitBlocks(src)) {
    if (b.kind === "heading") {
      parts.push(`<h3>${renderInline(b.lines[0].trim())}</h3>`);
      continue;
    }
    n += 1;
    const id = `d-p${n}`;
    if (b.kind === "code") {
      const code = escapeHtml(b.lines.join("\n"));
      parts.push(`<pre class="para" id="${id}"><code>${code}</code></pre>`);
      paragraphs.push({ id, text: b.lines.join("\n") });
      continue;
    }
    if (b.kind === "list") {
      const tag = b.ordered ? "ol" : "ul";
      const items = b.lines.map((l) => `<li>${renderInline(l.trim())}</li>`).join("");
      parts.push(`<${tag} class="para" id="${id}">${items}</${tag}>`);
      paragraphs.push({ id, text: b.lines.join("\n") });
      continue;
    }
    const text = b.lines.join(" ").trim();
    parts.push(`<p class="para" id="${id}">${renderInline(text)}</p>`);
    paragraphs.push({ id, text });
  }
  return { html: `<div class="desc">${parts.join("")}</div>`, paragraphs };
}

/**
 * Single source of description paragraph IDs (issue #96).
 *
 * `renderMarkdownBlocks` assigns one `d-p<n>` per block (headings get no
 * ID, a whole list is one ID) and persists them as `id="..."` attributes
 * in the stored HTML. Everything that maps `desc:` IDs back to text —
 * MCP `search`/`resolve`, the citation validator, second-opinion excerpts,
 * comment anchors — reads the IDs back from the stored HTML here instead
 * of counting again, so the IDs always agree with ingest.
 */
function decodeDescEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function descBlockText(inner: string): string {
  return decodeDescEntities(inner.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Stored description HTML as agents see it: the pending edit when there is one. */
export function currentDescriptionHtml(
  desc: { html?: string; pendingHtml?: string } | null | undefined,
): string {
  return desc?.pendingHtml ?? desc?.html ?? "";
}

/**
 * Parse stored description HTML back into paragraphs in document order.
 * Blocks keep the `id="..."` ingest wrote; headings (which carry no ID)
 * are skipped.
 */
export function parseDescriptionParagraphs(html: string): DescriptionParagraph[] {
  if (!html) return [];
  const inner = html.replace(/^[\s\S]*?<div class="desc"[^>]*>/i, "").replace(/<\/div>\s*$/, "");
  const re = /<(p|ul|ol|pre|h1|h2|h3|h4|h5|h6)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  const blocks: { tag: string; id: string | null; text: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const tag = m[1].toLowerCase();
    const id = m[2].match(/\bid=["']([^"']+)["']/i)?.[1] ?? null;
    blocks.push({ tag, id, text: descBlockText(m[3]) });
  }
  if (blocks.some((b) => b.id !== null)) {
    return blocks.filter((b) => b.id !== null && b.text !== "").map((b) => ({ id: b.id!, text: b.text }));
  }
  return [];
}

/** Plain text of one description paragraph by ID, or null when unknown. */
export function descriptionParagraphText(html: string, paragraphId: string): string | null {
  const found = parseDescriptionParagraphs(html).find((p) => p.id === paragraphId);
  return found ? found.text : null;
}

export interface CommitMessage {
  sha: string;
  subject: string;
  body: string;
  /** Author name, and author / committer dates (ISO 8601 with offset). */
  author: string;
  authorDate: string;
  committerDate: string;
}

/** Render branch commit messages (read-only description tab, PRD §4.11). */
export function renderCommitMessages(commits: CommitMessage[]): RenderedDescription {
  if (commits.length === 0) {
    return {
      html: `<div class="desc"><p class="para" id="d-p1">No commits in this range.</p></div>`,
      paragraphs: [{ id: "d-p1", text: "No commits in this range." }],
    };
  }
  const parts: string[] = [];
  const paragraphs: DescriptionParagraph[] = [];
  let n = 0;
  for (const c of commits) {
    const short = c.sha.slice(0, 7);
    parts.push(
      `<h3><span class="commit-sha">${escapeHtml(short)}</span> ${renderInline(c.subject.trim())}</h3>`,
    );
    const rendered = renderMarkdownBlocks(c.body.trim());
    for (const p of rendered.paragraphs) {
      n += 1;
      const id = `d-p${n}`;
      paragraphs.push({ id, text: p.text });
      rendered.html = rendered.html.replace(`id="${p.id}"`, `id="${id}"`);
    }
    parts.push(rendered.html.replace(/^<div class="desc">|<\/div>$/g, ""));
  }
  return { html: `<div class="desc">${parts.join("")}</div>`, paragraphs };
}
