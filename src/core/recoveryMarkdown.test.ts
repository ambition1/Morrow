/**
 * 功能：验证恢复Markdown的附件白名单、富内容往返与未知路径隔离。
 * 作者：xuanli
 * 创建时间：2026-10-30 17:04:43
 */
import { describe, expect, it } from 'vitest';
import { fileIdsInDoc, walk } from './doc';
import type { DocNode, WorkspaceState } from './model';
import { draftMarkdown, parseDraftMarkdown } from './recoveryMarkdown';

/** 完整页面记录由正常应用提供，本测试只用其键进行稳定ID解析。 */
const pages = { 'page-id': { title: '原文' } } as unknown as WorkspaceState['pages'];
/** 混合样本包含编码敏感附件ID、富块、封面及页面锚点。 */
const rich: DocNode = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: '到期 ' },
        { type: 'inlineDate', attrs: { date: '2026-10-30', time: '18:30' } },
        { type: 'pageLink', attrs: { id: 'page-id', label: '原文', alias: '引用', anchor: '^section' } },
      ],
    },
    {
      type: 'callout',
      attrs: { tone: 'note', background: 'blue', border: 'thin' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '重要提示' }] }],
    },
    {
      type: 'gallery',
      attrs: { layout: 'carousel', caption: '相册说明' },
      content: [
        { type: 'image', attrs: { fileId: 'photo 中文/1', alt: '照片', caption: '图片说明', width: 70 } },
        { type: 'image', attrs: { fileId: 'second', alt: '第二张' } },
      ],
    },
    { type: 'fileAttachment', attrs: { fileId: 'pdf-file', name: '资料.pdf', size: 123 } },
    {
      type: 'bookmark',
      attrs: { href: 'https://example.com', title: '资料网页', description: '说明', coverFileId: 'cover' },
    },
  ],
};

/** 收集指定节点类型，避免依赖解析器省略默认属性的细节。 */
function nodes(doc: DocNode, type: string): DocNode[] {
  /** 只读收集结果。 */
  const result: DocNode[] = [];
  walk(doc, (node) => {
    if (node.type === type) result.push(node);
  });
  return result;
}

describe('恢复Markdown引用', () => {
  it('导出为可读的编码路径，日期、图册、文件、封面和页面引用往返保留', () => {
    /** 导出文本允许用户人工合并，附件仍有可逆地址。 */
    const markdown = draftMarkdown(rich);
    expect(markdown).toContain('__morrow_files__/photo%20%E4%B8%AD%E6%96%87%2F1');
    expect(markdown).toContain('[[page-id#^section|引用]]');
    /** 只从提供的原始文档建立附件允许集合。 */
    const result = parseDraftMarkdown(markdown, [rich], pages);
    expect(fileIdsInDoc(result).sort()).toEqual(fileIdsInDoc(rich).sort());
    expect(nodes(result, 'inlineDate')[0]?.attrs).toEqual({ date: '2026-10-30', time: '18:30' });
    expect(nodes(result, 'gallery')[0]?.attrs).toMatchObject({ layout: 'carousel', caption: '相册说明' });
    expect(nodes(result, 'image')[0]?.attrs).toMatchObject({
      fileId: 'photo 中文/1',
      caption: '图片说明',
      width: 70,
    });
    expect(nodes(result, 'fileAttachment')[0]?.attrs).toEqual({
      fileId: 'pdf-file',
      name: '资料.pdf',
      size: 123,
    });
    expect(nodes(result, 'pageLink')[0]?.attrs).toMatchObject({
      id: 'page-id',
      anchor: '^section',
      alias: '引用',
    });
    expect(nodes(result, 'callout')[0]?.attrs).toMatchObject({ background: 'blue', border: 'thin' });
    expect(nodes(result, 'bookmark')[0]?.attrs?.coverFileId).toBe('cover');
  });
  it('同一图片ID可同时作为图片和附件链接，不因文件类型而吞掉附件名', () => {
    /** 一个已知文件可以在不同位置以不同形式引用。 */
    const source: DocNode = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { fileId: 'same', alt: '图' } },
        { type: 'fileAttachment', attrs: { fileId: 'same', name: '原始图片.png', size: 4 } },
      ],
    };
    /** 区分来自图片语法与普通链接语法的引用。 */
    const result = parseDraftMarkdown(draftMarkdown(source), [source], pages);
    expect(nodes(result, 'image')).toHaveLength(1);
    expect(nodes(result, 'fileAttachment')[0]?.attrs).toEqual({
      fileId: 'same',
      name: '原始图片.png',
      size: 4,
    });
  });
  it('允许两份原始文档的文件，但拒绝未知文件、伪造封面和非规范路径', () => {
    /** 手动合并可能从服务器及本机各保留一张图。 */
    const other: DocNode = {
      type: 'doc',
      content: [{ type: 'image', attrs: { fileId: 'other', alt: '另一张' } }],
    };
    const edited = `${draftMarkdown(rich)}\n${draftMarkdown(other)}\n![未知](__morrow_files__/unknown)\n\n![混淆](__morrow_files__/%6fther)\n\n<!-- morrow:block {"type":"bookmark","attrs":{"title":"伪造","coverFileId":"secret"}} -->\n\n伪造\n\n<!-- /morrow:block -->`;
    const result = parseDraftMarkdown(edited, [rich, other], pages);
    expect(fileIdsInDoc(result)).toContain('other');
    expect(fileIdsInDoc(result)).not.toContain('unknown');
    expect(fileIdsInDoc(result)).not.toContain('secret');
    expect(nodes(result, 'image').filter((node) => node.attrs?.fileId === 'other')).toHaveLength(1);
    expect(nodes(result, 'bookmark').at(-1)?.attrs?.coverFileId).toBeUndefined();
  });
});
