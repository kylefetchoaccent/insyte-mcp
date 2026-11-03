// Ranked keyword search over a folder of Markdown or plain-text files, split by heading. The folder is
// named by INSYTE_DOCS_DIR. The index is built once per folder per process.

import fs from "node:fs";
import path from "node:path";

export interface Section {
  file: string;
  heading: string;
  text: string;
  terms: Map<string, number>;
  length: number;
}

export interface Hit {
  file: string;
  heading: string;
  snippet: string;
  score: number;
}

export interface DocsIndex {
  sections: Section[];
  files: number;
  avgLength: number;
  df: Map<string, number>;
}

const MAX_FILES = 3000;
const MAX_FILE_BYTES = 2_000_000;
const SNIPPET_CHARS = 240;
const HEADING_WEIGHT = 3;
const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "it", "how", "do", "i", "with", "what", "are"]);

const cache = new Map<string, DocsIndex>();

export function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => !STOP.has(t));
}

function* markdownFiles(dir: string): Generator<string> {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".") && e.name !== "node_modules") stack.push(full);
      } else if (e.isFile() && /\.(md|markdown|txt)$/i.test(e.name)) yield full;
    }
  }
}

export function splitSections(file: string, md: string): { heading: string; text: string }[] {
  const out: { heading: string; text: string }[] = [];
  let heading = path.basename(file).replace(/\.(md|markdown)$/i, "");
  let body: string[] = [];
  let fence = false;
  const flush = () => {
    const text = body.join("\n").trim();
    if (text) out.push({ heading, text });
    body = [];
  };
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      heading = h[1];
    } else body.push(line);
  }
  flush();
  return out;
}

// Plain-text pages (the Confluence export) have no headings: the first line is the page
// title, and the body splits into paragraph chunks so a long page ranks by its relevant part.
const TEXT_CHUNK_CHARS = 2000;

export function splitText(file: string, txt: string): { heading: string; text: string }[] {
  const lines = txt.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return [];
  const title = lines[first].trim() || path.basename(file).replace(/\.txt$/i, "");
  const out: { heading: string; text: string }[] = [];
  let chunk = "";
  for (const para of lines.slice(first + 1).join("\n").split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (chunk && chunk.length + p.length > TEXT_CHUNK_CHARS) {
      out.push({ heading: title, text: chunk });
      chunk = "";
    }
    chunk = chunk ? `${chunk}\n\n${p}` : p;
  }
  if (chunk || !out.length) out.push({ heading: title, text: chunk || title });
  return out;
}

export function buildIndex(dir: string): DocsIndex {
  const sections: Section[] = [];
  let files = 0;
  for (const full of markdownFiles(dir)) {
    if (files >= MAX_FILES) break;
    let md: string;
    try {
      if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
      md = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    files++;
    const rel = path.relative(dir, full).split(path.sep).join("/");
    for (const s of /\.txt$/i.test(rel) ? splitText(rel, md) : splitSections(rel, md)) {
      const terms = new Map<string, number>();
      const body = tokens(s.text);
      const head = tokens(s.heading);
      for (const t of body) terms.set(t, (terms.get(t) ?? 0) + 1);
      for (const t of head) terms.set(t, (terms.get(t) ?? 0) + HEADING_WEIGHT);
      sections.push({ file: rel, heading: s.heading, text: s.text, terms, length: body.length + head.length });
    }
  }
  const df = new Map<string, number>();
  for (const s of sections) for (const t of s.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avgLength = sections.length ? sections.reduce((n, s) => n + s.length, 0) / sections.length : 1;
  return { sections, files, avgLength: Math.max(avgLength, 1), df };
}

// Lazy: the first search of a folder reads it; later searches reuse the index.
export function indexFor(dir: string): DocsIndex {
  const key = path.resolve(dir);
  let idx = cache.get(key);
  if (!idx) {
    idx = buildIndex(key);
    cache.set(key, idx);
  }
  return idx;
}

// Term frequency saturated and divided by section length (BM25 shape, fixed constants).
export function search(idx: DocsIndex, query: string, limit: number): Hit[] {
  const q = [...new Set(tokens(query))];
  if (!q.length) return [];
  const n = idx.sections.length;
  const hits: Hit[] = [];
  for (const s of idx.sections) {
    let score = 0;
    for (const t of q) {
      const tf = s.terms.get(t);
      if (!tf) continue;
      const df = idx.df.get(t) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (s.length / idx.avgLength)));
    }
    if (score > 0) hits.push({ file: s.file, heading: s.heading, snippet: snippet(s.text, q), score });
  }
  hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.heading.localeCompare(b.heading));
  return hits.slice(0, limit);
}

function snippet(text: string, q: string[]): string {
  const flat = text.replace(/\s+/g, " ");
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of q) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, at - 60);
  const piece = flat.slice(start, start + SNIPPET_CHARS).trim();
  return `${start > 0 ? "..." : ""}${piece}${start + SNIPPET_CHARS < flat.length ? "..." : ""}`;
}
