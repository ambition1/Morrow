import { docToPlainText } from './doc';
import { displayTitle } from './model';
import type { DocNode, PageId, PageMeta, WorkspaceState } from './model';
import { tagMatches, tagsOf } from './tags';
import { ancestorsOf, livePages } from './tree';

export interface SearchSnippet {
  before: string;
  match: string;
  after: string;
  /** 命中在可读正文中的起点，只有原文未改变时才使用。 */
  offset: number | null;
}

/** 搜索筛选只读取页面元数据及附件名称，不进行OCR或远端请求。 */
export interface SearchFilters {
  /** 限定此页面及其子页面；空值表示整个笔记库。 */
  rootId?: PageId | null;
  /** 标签与查询中的标签条件同时满足。 */
  tag?: string;
  /** 修改时间的闭区间，单位为毫秒。 */
  updatedAfter?: number;
  /** 修改时间的闭区间终点。 */
  updatedBefore?: number;
  /** 附件节点类型，PDF按文件名或MIME识别。 */
  attachment?: 'image' | 'pdf' | 'file';
}

/** 检查文档实际引用的附件类型；不会把普通正文中的文件名当成附件。 */
function hasAttachment(doc: DocNode | undefined, kind: NonNullable<SearchFilters['attachment']>): boolean {
  if (!doc) return false;
  if (kind === 'image' && doc.type === 'image') return true;
  if (
    doc.type === 'fileAttachment' &&
    (kind === 'file' ||
      (kind === 'pdf' &&
        (/\.pdf$/i.test(String(doc.attrs?.name ?? '')) || doc.attrs?.type === 'application/pdf')))
  )
    return true;
  return (doc.content ?? []).some((child) => hasAttachment(child, kind));
}

export interface SearchResult {
  page: PageMeta;
  score: number;
  titleMatch: boolean;
  snippet: SearchSnippet | null;
  // every place in the page that matched, up to the number asked for, in reading order
  snippets: SearchSnippet[];
  // text to highlight when the page opens
  firstMatch: string | null;
  path: string[];
}

// documents are immutable, so cached text stays valid for the life of the object
const textCache = new WeakMap<DocNode, { raw: string; folded: string }>();

export function foldText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// page records are immutable, so a folded title stays right for as long as its record lives
const titleCache = new WeakMap<PageMeta, string>();
function foldedTitle(page: PageMeta): string {
  let folded = titleCache.get(page);
  if (folded === undefined) {
    folded = foldText(displayTitle(page));
    titleCache.set(page, folded);
  }
  return folded;
}

function textOf(doc: DocNode | undefined): { raw: string; folded: string } {
  if (!doc) return { raw: '', folded: '' };
  let entry = textCache.get(doc);
  if (!entry) {
    const raw = docToPlainText(doc);
    // folding can change string length, so offsets are only trusted when lengths agree
    entry = { raw, folded: foldText(raw) };
    textCache.set(doc, entry);
  }
  return entry;
}

export function tokenize(query: string): string[] {
  return foldText(query)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, 12);
}

export interface ParsedQuery {
  // words and "quoted phrases" a page must all contain
  terms: string[];
  // -words and -"phrases" a page must not contain
  excluded: string[];
  // #tags a page must have
  tags: string[];
}

export function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = { terms: [], excluded: [], tags: [] };
  for (const match of foldText(query).matchAll(/(-?)"([^"]*)"?|(\S+)/g)) {
    if (match[2] !== undefined) {
      const phrase = match[2].trim().replace(/\s+/g, ' ');
      if (phrase) (match[1] ? parsed.excluded : parsed.terms).push(phrase);
      continue;
    }
    const word = match[3]!;
    if (/^#[^#\s]+$/.test(word)) parsed.tags.push(word.slice(1));
    else if (word.length > 1 && word.startsWith('-')) parsed.excluded.push(word.slice(1));
    else parsed.terms.push(word);
  }
  parsed.terms = parsed.terms.slice(0, 12);
  return parsed;
}

// #tag keeps only pages with that tag, "a phrase" matches those words together, -word leaves pages out
export function searchWorkspace(
  state: WorkspaceState,
  query: string,
  limit = 50,
  snippetCount = 1,
  filters: SearchFilters = {},
): SearchResult[] {
  const { terms, excluded, tags: wantedTags } = parseQuery(query);
  if (filters.tag?.trim()) wantedTags.push(foldText(filters.tag.trim().replace(/^#/, '')));
  if (
    terms.length === 0 &&
    wantedTags.length === 0 &&
    !filters.rootId &&
    filters.updatedAfter === undefined &&
    filters.updatedBefore === undefined &&
    !filters.attachment
  )
    return [];
  const phrase = terms.join(' ');
  const scored: Array<{
    page: PageMeta;
    score: number;
    titleMatch: boolean;
    body: { raw: string; folded: string };
    bodyTerms: string[];
  }> = [];

  for (const page of livePages(state.pages)) {
    if (
      filters.rootId &&
      page.id !== filters.rootId &&
      !ancestorsOf(state.pages, page.id).some((ancestor) => ancestor.id === filters.rootId)
    )
      continue;
    if (filters.updatedAfter !== undefined && page.updatedAt < filters.updatedAfter) continue;
    if (filters.updatedBefore !== undefined && page.updatedAt > filters.updatedBefore) continue;
    if (filters.attachment && !hasAttachment(state.docs[page.id], filters.attachment)) continue;
    if (wantedTags.length > 0) {
      const tags = tagsOf(page, state.docs[page.id]);
      if (!wantedTags.every((wanted) => tags.some((tag) => tagMatches(foldText(tag), wanted)))) continue;
    }
    const title = foldedTitle(page);
    const body = textOf(state.docs[page.id]);
    if (excluded.some((term) => title.includes(term) || body.folded.includes(term))) continue;
    let score = 0;
    let matchedAll = true;
    for (const term of terms) {
      const inTitle = title.includes(term);
      const inBody = body.folded.includes(term);
      if (!inTitle && !inBody) {
        matchedAll = false;
        break;
      }
      if (inTitle) score += title.startsWith(term) ? 12 : 8;
      if (inBody) score += Math.min(5, countOccurrences(body.folded, term));
    }
    if (!matchedAll) continue;
    const titleMatch = terms.every((term) => title.includes(term));
    if (phrase && title === phrase) score += 30;
    else if (phrase && title.startsWith(phrase)) score += 15;
    if (phrase && body.folded.includes(phrase)) score += 6;
    // small recency bonus so fresh notes win ties
    score += Math.max(0, 2 - (Date.now() - page.updatedAt) / (1000 * 60 * 60 * 24 * 30));
    const bodyTerms = [
      ...(phrase && terms.length > 1 && body.folded.includes(phrase) ? [phrase] : []),
      ...terms.filter((term) => body.folded.includes(term)),
    ];
    scored.push({ page, score, titleMatch, body, bodyTerms });
  }

  // snippets and paths only for the results shown, a common word can match thousands of pages
  return scored
    .sort((a, b) => b.score - a.score || b.page.updatedAt - a.page.updatedAt)
    .slice(0, limit)
    .map(({ page, score, titleMatch, body, bodyTerms }) => {
      const snippets = makeSnippets(body, bodyTerms, Math.max(1, snippetCount));
      const snippet = snippets[0] ?? null;
      return {
        page,
        score,
        titleMatch,
        snippet,
        snippets: snippetCount > 1 ? snippets : snippets.slice(0, 1),
        firstMatch: snippet?.match ?? null,
        path: ancestorsOf(state.pages, page.id)
          .reverse()
          .map((ancestor) => displayTitle(ancestor)),
      };
    });
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1 && count < 50) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

// the first matches of the terms, earlier terms first, each from a different part of the page
function makeSnippets(
  body: { raw: string; folded: string },
  terms: string[],
  count: number,
): SearchSnippet[] {
  const found: Array<{ index: number; snippet: SearchSnippet; end: number }> = [];
  for (const term of terms) {
    let index = body.folded.indexOf(term);
    while (index !== -1 && found.length < count) {
      const taken = found.some((item) => index >= item.index - 60 && index <= item.end);
      if (!taken)
        found.push({ index, end: index + term.length + 60, snippet: makeSnippet(body, term, index) });
      index = body.folded.indexOf(term, index + term.length);
    }
    if (found.length >= count) break;
  }
  return found.sort((a, b) => a.index - b.index).map((item) => item.snippet);
}

function makeSnippet(
  body: { raw: string; folded: string },
  term: string,
  at = body.folded.indexOf(term),
  radius = 60,
): SearchSnippet {
  const aligned = body.raw.length === body.folded.length;
  const source = aligned ? body.raw : body.folded;
  const index = at;
  const lineStart = source.lastIndexOf('\n', index) + 1;
  const lineEndRaw = source.indexOf('\n', index + term.length);
  const lineEnd = lineEndRaw === -1 ? source.length : lineEndRaw;
  const start = Math.max(lineStart, index - radius);
  const end = Math.min(lineEnd, index + term.length + radius);
  return {
    offset: aligned ? index : null,
    before: (start > lineStart ? '…' : '') + source.slice(start, index).trimStart(),
    match: source.slice(index, index + term.length),
    after: source.slice(index + term.length, end).trimEnd() + (end < lineEnd ? '…' : ''),
  };
}

export function findPagesByTitle(state: WorkspaceState, query: string, limit = 8): PageMeta[] {
  const folded = foldText(query.trim());
  const pages = livePages(state.pages);
  if (!folded) {
    return [...pages]
      .sort((a, b) => (b.lastOpenedAt ?? b.updatedAt) - (a.lastOpenedAt ?? a.updatedAt))
      .slice(0, limit);
  }
  return pages
    .map((page) => ({ page, title: foldedTitle(page) }))
    .filter((entry) => entry.title.includes(folded))
    .sort(
      (a, b) =>
        Number(b.title.startsWith(folded)) - Number(a.title.startsWith(folded)) ||
        a.title.length - b.title.length,
    )
    .slice(0, limit)
    .map((entry) => entry.page);
}

export function pageIdByTitle(state: WorkspaceState, title: string): PageId | null {
  const folded = foldText(title.trim());
  const match = livePages(state.pages).find((page) => foldedTitle(page) === folded);
  return match?.id ?? null;
}

// a written [[target]] to a page: by title, by file name, or by the last part of a path
export function resolveLinkTarget(state: WorkspaceState, target: string): PageId | null {
  const clean = target.trim().replace(/\.(md|canvas)$/i, '');
  if (!clean) return null;
  return pageIdByTitle(state, clean) ?? pageIdByTitle(state, clean.split('/').pop() ?? clean);
}
