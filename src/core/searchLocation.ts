/**
 * 功能：将全文搜索命中编码为精确正文位置，文档变化时安全退回文字查找。
 * 作者：xuanli
 * 创建时间：2026-10-30 16:43:20
 */
import { docToPlainText, inlineText } from './doc';
import type { DocNode } from './model';

/** 搜索定位信息不携带正文副本，只保存校验和与节点路径。 */
export interface SearchLocation {
  /** 点击时使用的回退搜索词。 */
  match: string;
  /** 可读正文中的偏移。 */
  offset: number;
  /** 原文校验和；任何修改都使精确位置失效。 */
  fingerprint: string;
}

/** 对可读正文及节点结构计算校验和，避免把过期位置应用到新内容。 */
export function searchFingerprint(doc: DocNode): string {
  /** 节点类型与层级共同检查路径，默认展示属性不参与计算。 */
  const shape = (node: DocNode): string => `${node.type}[${(node.content ?? []).map(shape).join(',')}]`;
  /** 默认属性标准化不影响定位，只校验可读文本及节点树结构。 */
  const source = `${docToPlainText(doc)}\n${shape(doc)}`;
  /** FNV整数摘要只用于检测变化，不作为安全或版本校验。 */
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++)
    hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
  return `${source.length}:${hash >>> 0}`;
}

/** 将精确命中放入现有find参数，旧的普通文字链接继续兼容。 */
export function encodeSearchLocation(doc: DocNode, match: string, offset: number | null): string {
  if (offset === null) return match;
  return `morrow-search:${JSON.stringify({ match, offset, fingerprint: searchFingerprint(doc) })}`;
}

/** 非法或普通find参数按原始文字处理，不执行任何内容。 */
export function decodeSearchLocation(value: string): SearchLocation | null {
  if (!value.startsWith('morrow-search:')) return null;
  try {
    /** 地址栏内容不可信，只接受有限长度文字与非负整数。 */
    const parsed = JSON.parse(value.slice(14)) as Partial<SearchLocation>;
    return typeof parsed.match === 'string' &&
      parsed.match.length > 0 &&
      parsed.match.length <= 10000 &&
      Number.isSafeInteger(parsed.offset) &&
      parsed.offset! >= 0 &&
      typeof parsed.fingerprint === 'string'
      ? (parsed as SearchLocation)
      : null;
  } catch {
    return null;
  }
}

/** 遍历可读文本顺序，返回包含指定全文偏移的文本块路径及块内偏移。 */
export function locateSearchText(
  doc: DocNode,
  target: SearchLocation,
): { path: number[]; offset: number } | null {
  if (target.fingerprint !== searchFingerprint(doc)) return null;
  /** 复用可读正文作为所有节点片段的顺序基准。 */
  const source = docToPlainText(doc);
  if (source.slice(target.offset, target.offset + target.match.length) !== target.match) return null;
  /** 每一节点在父级中的索引用于编辑器按真实节点尺寸解析位置。 */
  let found: { path: number[]; offset: number } | null = null;
  /** 已消耗的可读正文长度。 */
  let cursor = 0;
  /** 按照docToPlainText相同的原子节点边界推进；文字块不继续拆成文本节点。 */
  const visit = (node: DocNode, path: number[]) => {
    if (found) return;
    /** 这些节点的inlineText与全文检索使用相同的表示。 */
    const textBlock = ['paragraph', 'heading', 'codeBlock', 'detailsSummary'].includes(node.type);
    if (textBlock || !node.content?.length) {
      /** 原子节点可能产生多行可搜索说明，仍计入后续正文位置。 */
      const text = textBlock ? inlineText(node) : docToPlainText(node);
      if (!text) return;
      /** 当前片段是全文拼接的下一项，因此不能跳过相同内容的前一处。 */
      const start = source.indexOf(text, cursor);
      if (start < 0) return;
      if (textBlock && target.offset >= start && target.offset + target.match.length <= start + text.length)
        found = { path, offset: target.offset - start };
      cursor = start + text.length + 1;
      return;
    }
    // 图册说明位于图片之前，必须先消耗，不能把同名图注误认为正文。
    if (node.type === 'gallery' && node.attrs?.caption) {
      /** 说明与正文复用同一全文拼接分隔符。 */
      const caption = String(node.attrs.caption);
      cursor = source.indexOf(caption, cursor) + caption.length + 1;
    }
    for (const [index, child] of (node.content ?? []).entries()) visit(child, [...path, index]);
  };
  visit(doc, []);
  return found;
}
