/**
 * 功能：将扩展块外观保存在可读Markdown旁的受限元数据中，并安全恢复原结构。
 * 作者：xuanli
 * 创建时间：2026-10-30 00:08:04
 */
import { normalizeBlockAttrs } from './blockAppearance';
import type { DocNode } from './model';

/** 允许元数据恢复的节点类型，不能借元数据创建任意未知节点。 */
const TYPES = new Set([
  'callout',
  'columns',
  'column',
  'orderedList',
  'details',
  'image',
  'gallery',
  'pageCard',
  'bookmark',
]);
/** 元数据起始标识，仅用于解析期间，不进入持久文档。 */
const START = '_morrowBlockStart';
/** 元数据结束标识，仅用于解析期间。 */
const END = '_morrowBlockEnd';

/** 将受支持的扩展属性包裹在普通Markdown外，旧格式没有属性时保持原输出。 */
export function withBlockMetadata(
  node: DocNode,
  markdown: string,
  filePath?: (id: string) => string | null,
): string {
  if (!TYPES.has(node.type)) return markdown;
  /** 可持久化外观不包含默认值及任意注入属性。 */
  const attrs = normalizeBlockAttrs(node.type, node.attrs);
  if (node.type === 'bookmark' && typeof attrs.coverFileId === 'string' && filePath) {
    /** 导出时使用实际附件路径，重新导入时可映射成新附件ID。 */
    const cover = filePath(attrs.coverFileId);
    if (cover) {
      attrs.coverSrc = cover;
      delete attrs.coverFileId;
    }
  }
  if (!Object.keys(attrs).length && !['gallery', 'pageCard', 'bookmark'].includes(node.type)) return markdown;
  /** 转义HTML注释终止符，用户标题不能逃出元数据。 */
  const payload = JSON.stringify({ type: node.type, attrs })
    .replace(/</g, '\\u003c')
    .replace(/--/g, '\\u002d\\u002d');
  return `<!-- morrow:block ${payload} -->\n\n${markdown}\n\n<!-- /morrow:block -->`;
}

/** 只识别尺寸有限、类型已知的完整元数据注释。 */
export function metadataMarker(html: string): DocNode | null {
  if (html === '<!-- /morrow:block -->') return { type: END };
  /** 起始注释必须独占一个HTML块。 */
  const match = /^<!-- morrow:block (\{[^]*\}) -->$/.exec(html);
  if (!match || match[1]!.length > 20000) return null;
  try {
    /** JSON读取后仍按白名单逐项规范化，不信任序列化来源。 */
    const value = JSON.parse(match[1]!) as { type?: unknown; attrs?: unknown };
    if (
      typeof value.type !== 'string' ||
      !TYPES.has(value.type) ||
      !value.attrs ||
      typeof value.attrs !== 'object' ||
      Array.isArray(value.attrs)
    )
      return null;
    return { type: START, attrs: { blockType: value.type, values: value.attrs, source: html } };
  } catch {
    return null;
  }
}

/** 将已解析的可读正文恢复成扩展块；损坏或未闭合的标记保留为原文。 */
export function restoreBlockMetadata(
  doc: DocNode,
  resolveFile?: (path: string) => { fileId: string } | null,
): DocNode {
  /** 每层独立处理，避免跨分栏、引用或列表配对。 */
  const restore = (node: DocNode): DocNode => {
    if (!node.content) return node;
    /** 当前容器输出节点。 */
    const output: DocNode[] = [];
    /** 待闭合块栈，保存原标记用于异常回退。 */
    const frames: Array<{ marker: DocNode; children: DocNode[] }> = [];
    /** 将普通节点写入当前元数据容器或外层正文。 */
    const append = (child: DocNode) => (frames.at(-1)?.children ?? output).push(child);
    for (const original of node.content) {
      /** 子层先恢复，当前层只配对自己的标记。 */
      const child = restore(original);
      if (child.type === START && frames.length < 64) {
        frames.push({ marker: child, children: [] });
        continue;
      }
      if (child.type === END && frames.length) {
        /** 闭合的原始数据及其可读正文。 */
        const frame = frames.pop()!;
        /** 被白名单确认的目标类型。 */
        const type = String(frame.marker.attrs?.blockType);
        /** 元数据属性在此做最终规范化。 */
        const values = frame.marker.attrs?.values as Record<string, unknown>;
        /** 可用的目标外观。 */
        const attrs = normalizeBlockAttrs(type, values);
        /** 默认从可读Markdown中取回已解析好的节点。 */
        const target = frame.children.find((item) => item.type === type);
        /** 自动生成的图注只匹配完整斜体段落，其他用户正文必须保留。 */
        const isCaption = (item: DocNode): boolean =>
          typeof attrs.caption === 'string' &&
          item.type === 'paragraph' &&
          Boolean(item.content?.length) &&
          item.content!.every(
            (part) => part.type === 'text' && part.marks?.length === 1 && part.marks[0]?.type === 'italic',
          ) &&
          item.content!.map((part) => part.text ?? '').join('') === attrs.caption;
        /** 仅恢复完全符合导出结构的正文，不能吞掉外部工具新增的段落或链接。 */
        const expected = frame.children.every((item, index) => {
          if (type === 'gallery')
            return item.type === 'image' || (index === frame.children.length - 1 && isCaption(item));
          if (type === 'pageCard')
            return (
              frame.children.length === 1 &&
              item.type === 'paragraph' &&
              item.content?.length === 1 &&
              item.content[0]?.type === 'pageLink'
            );
          if (type === 'bookmark') {
            if (frame.children.length !== (typeof values.coverSrc === 'string' ? 2 : 1)) return false;
            if (item.type === 'image') return index === 0 && typeof values.coverSrc === 'string';
            /** 书签导出的可读标题、地址与摘要只占一个段落。 */
            const text = (item.content ?? []).map((part) => part.text ?? '').join('');
            const label = String(attrs.title || attrs.href || 'Link');
            return (
              item.type === 'paragraph' &&
              (!attrs.href ||
                item.content?.some((part) =>
                  part.marks?.some((mark) => mark.type === 'link' && mark.attrs?.href === attrs.href),
                )) &&
              text === label + (attrs.description ? ` — ${attrs.description}` : '')
            );
          }
          return item === target || (type === 'image' && isCaption(item));
        });
        if (!expected) {
          // 保留完整标记与正文，后续保存也不能丢失用户在标记内补充的内容。
          append({ type: 'rawBlock', attrs: { text: String(frame.marker.attrs?.source ?? '') } });
          frame.children.forEach(append);
          append({ type: 'rawBlock', attrs: { text: '<!-- /morrow:block -->' } });
          continue;
        }
        if (type === 'gallery')
          append({
            type,
            ...(Object.keys(attrs).length ? { attrs } : {}),
            content: frame.children.filter((item) => item.type === 'image'),
          });
        else if (type === 'pageCard') {
          /** 页面链接按导出后的wiki目标重新解析，而不是复用旧库的页面ID。 */
          const link = frame.children
            .flatMap((item) => (item.type === 'paragraph' ? (item.content ?? []) : [item]))
            .find((item) => item.type === 'pageLink');
          if (link) append({ type, content: [link] });
          else frame.children.forEach(append);
        } else if (type === 'bookmark') {
          /** 封面优先使用可读图片中的映射结果，其次使用元数据内路径。 */
          const cover = typeof values.coverSrc === 'string' ? resolveFile?.(values.coverSrc) : null;
          if (cover) attrs.coverFileId = cover.fileId;
          append({ type, attrs });
        } else if (target) append({ ...target, attrs: { ...target.attrs, ...attrs } });
        else frame.children.forEach(append);
        continue;
      }
      if (child.type === END || child.type === START)
        append({
          type: 'rawBlock',
          attrs: { text: child.type === END ? '<!-- /morrow:block -->' : String(child.attrs?.source ?? '') },
        });
      else append(child);
    }
    while (frames.length) {
      /** 未闭合元数据必须连同正文返回，不能吞掉后续用户内容。 */
      const frame = frames.pop()!;
      const recovered: DocNode[] = [
        { type: 'rawBlock', attrs: { text: String(frame.marker.attrs?.source ?? '') } },
        ...frame.children,
      ];
      recovered.forEach(append);
    }
    return { ...node, content: output };
  };
  return restore(doc);
}
