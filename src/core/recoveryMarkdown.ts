/**
 * 功能：为草稿导出和手动合并保留已知附件及页面引用，防止Markdown往返丢失媒体。
 * 作者：xuanli
 * 创建时间：2026-10-30 17:04:43
 */
import { walk } from './doc';
import { markdownToDoc } from './markdown/parse';
import { docToMarkdown } from './markdown/serialize';
import type { DocNode, WorkspaceState } from './model';

/** 草稿引用只使用应用专属的相对路径，不向外部服务发起请求。 */
const FILE_PREFIX = '__morrow_files__/';
/** 解析时区分普通附件链接与图片，避免同一图片ID作为附件时变成图片块。 */
const ATTACHMENT_PREFIX = '__morrow_attachments__/';

/** 导出仍为可读Markdown，附件ID及页面ID具有稳定、可逆的目标地址。 */
export function draftMarkdown(doc: DocNode): string {
  return docToMarkdown(doc, {
    filePath: (id) => `${FILE_PREFIX}${encodeURIComponent(id)}`,
    linkTarget: (id) => id,
  });
}

/** 仅允许原始文档已经引用的附件，手工猜测路径不能授权读取其他文件。 */
export function parseDraftMarkdown(
  text: string,
  references: DocNode[],
  pages: WorkspaceState['pages'],
): DocNode {
  /** 引用来源可同时包含本机、共同基准和服务器版本。 */
  const files = new Map<string, { fileId: string; name: string; image: boolean; size?: number }>();
  for (const doc of references) {
    walk(doc, (node) => {
      /** 图片与文件使用现有fileId；网页封面使用独立coverFileId。 */
      const id =
        node.type === 'bookmark'
          ? node.attrs?.coverFileId
          : ['image', 'fileAttachment'].includes(node.type)
            ? node.attrs?.fileId
            : null;
      if (typeof id !== 'string' || !id) return;
      /** 已知文件名优先使用附件名，其次保留图片的替代文字。 */
      const previous = files.get(id);
      files.set(id, {
        fileId: id,
        name:
          node.type === 'fileAttachment' && typeof node.attrs?.name === 'string'
            ? node.attrs.name
            : (previous?.name ??
              (typeof node.attrs?.alt === 'string' && node.attrs.alt ? node.attrs.alt : id)),
        image: previous?.image === true || node.type === 'image' || node.type === 'bookmark',
        ...(typeof node.attrs?.size === 'number'
          ? { size: node.attrs.size }
          : previous?.size !== undefined
            ? { size: previous.size }
            : {}),
      });
    });
  }
  /** 序列化器的普通文件链接与图片路径相同，在解析前仅为链接添加类型区分。 */
  const typed = text.replace(
    /(?<!!)(\[(?:\\.|[^\]\\\n])*\]\()(__morrow_files__\/[^)\s]+)(\))/g,
    (_match, before: string, href: string, after: string) =>
      `${before}${ATTACHMENT_PREFIX}${href.slice(FILE_PREFIX.length)}${after}`,
  );
  /** 文件解析只接受规范编码且存在于允许集合的ID。 */
  const resolveFile = (href: string) => {
    /** 普通附件链接不能按图片显示，封面与图片仍保持图片语义。 */
    const attachment = href.startsWith(ATTACHMENT_PREFIX);
    /** 不解析任意相对路径、绝对路径或远端地址。 */
    const prefix = attachment ? ATTACHMENT_PREFIX : FILE_PREFIX;
    if (!href.startsWith(prefix)) return null;
    try {
      /** 编码必须与导出器一致，拒绝额外路径层级及混淆编码。 */
      const encoded = href.slice(prefix.length);
      const id = decodeURIComponent(encoded);
      if (encodeURIComponent(id) !== encoded) return null;
      /** 返回新对象，解析器不能修改允许集合。 */
      const file = files.get(id);
      return file ? { fileId: file.fileId, name: file.name, image: attachment ? false : file.image } : null;
    } catch {
      return null;
    }
  };
  /** 页面只按已存在的稳定ID定位，不将同名标题误指向另一篇笔记。 */
  const result = markdownToDoc(typed, {
    resolveFile,
    resolvePage: (id) => (Object.hasOwn(pages, id) ? id : null),
    keepUnresolved: true,
  });
  /** 元数据可能被用户编辑，最终输出再次约束附件ID并恢复已知文件属性。 */
  const restore = (node: DocNode): DocNode => {
    /** 保留解析器已经检查过的正文与展示属性。 */
    const attrs = node.attrs ? { ...node.attrs } : undefined;
    if (
      attrs &&
      node.type === 'bookmark' &&
      typeof attrs.coverFileId === 'string' &&
      !files.has(attrs.coverFileId)
    )
      delete attrs.coverFileId;
    if (attrs && node.type === 'fileAttachment' && typeof attrs.fileId === 'string') {
      /** 原始元数据的名字和大小不依赖路径猜测。 */
      const file = files.get(attrs.fileId);
      if (file) {
        attrs.name = file.name;
        if (file.size !== undefined) attrs.size = file.size;
      } else attrs.fileId = null;
    }
    return {
      ...node,
      ...(attrs ? { attrs } : {}),
      ...(node.content ? { content: node.content.map(restore) } : {}),
    };
  };
  return restore(result);
}
