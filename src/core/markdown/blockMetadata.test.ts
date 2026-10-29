/**
 * 功能：验证扩展文档块的Markdown往返、附件映射与损坏元数据回退。
 * 作者：xuanli
 * 创建时间：2026-10-30 00:08:04
 */
import { describe, expect, it } from 'vitest';
import { fileIdsInDoc, remapFileIds } from '../doc';
import { normalizeBackground, normalizeWidths, normalizeBookmarkHref } from '../blockAppearance';
import type { DocNode } from '../model';
import { emptyWorkspace, newPageMeta } from '../model';
import { buildSite } from '../site';
import { docToMarkdown } from './serialize';
import { markdownToDoc } from './parse';

/** 简单段落样本。 */
const paragraph = (text: string): DocNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });
/** 用真实可读路径重新映射附件和页面。 */
const parseOptions = {
  resolveFile: (href: string) =>
    href.includes('.png') ? { fileId: href.split('/').pop()!, name: href, image: true } : null,
  resolvePage: () => 'new-page',
};
/** 测试导出路径始终与当前库ID分离。 */
const serializeOptions = { filePath: (id: string) => `attachments/${id}`, linkTarget: () => '旅行计划' };
/** 执行一次文档保存、读取往返。 */
const roundTrip = (content: DocNode[]) =>
  markdownToDoc(docToMarkdown({ type: 'doc', content }, serializeOptions), parseOptions);

describe('扩展块保存兼容', () => {
  it('旧提示块没有额外元数据', () => {
    expect(
      docToMarkdown({
        type: 'doc',
        content: [
          { type: 'callout', attrs: { tone: 'note', kind: 'note' }, content: [paragraph('原有内容')] },
        ],
      }),
    ).toBe('> [!note]\n> 原有内容\n');
  });
  it('提示块外观与语义独立，保留子内容', () => {
    /** 自定义外观但仍为warning语义。 */
    const node: DocNode = {
      type: 'callout',
      attrs: {
        tone: 'warning',
        kind: 'warning',
        background: '#EDF5FF',
        border: 'thin',
        icon: 'lightbulb',
        showTitle: false,
      },
      content: [paragraph('注意')],
    };
    expect(roundTrip([node]).content![0]).toEqual(node);
  });
  it('分栏比例和栏背景可以嵌套往返', () => {
    /** 不等宽分栏中包含有样式的栏。 */
    const node: DocNode = {
      type: 'columns',
      attrs: { widths: [60, 40], gap: 'wide' },
      content: [
        { type: 'column', attrs: { background: 'blue', border: 'left' }, content: [paragraph('甲')] },
        { type: 'column', content: [paragraph('乙')] },
      ],
    };
    expect(roundTrip([node]).content![0]).toEqual(node);
  });
  it('图册保留图片顺序、图注和附件ID', () => {
    /** 图册使用普通image子节点，旧附件遍历无需猜测。 */
    const node: DocNode = {
      type: 'gallery',
      attrs: { layout: 'carousel', columns: 2, caption: '旅行' },
      content: [
        { type: 'image', attrs: { fileId: 'a.png', alt: '甲', caption: '清晨', width: 80, align: 'left' } },
        { type: 'image', attrs: { fileId: 'b.png', alt: '乙' } },
      ],
    };
    /** 保存后的结构会省略缺省属性，但图像内容不可丢失。 */
    const restored = roundTrip([node]);
    expect(restored.content![0]?.type).toBe('gallery');
    expect(restored.content![0]?.content?.map((image) => image.attrs?.fileId)).toEqual(['a.png', 'b.png']);
    expect(restored.content![0]?.content?.[0]?.attrs).toMatchObject(node.content![0]!.attrs!);
    expect(fileIdsInDoc(restored)).toEqual(['a.png', 'b.png']);
  });
  it('引用卡片重新解析页面目标', () => {
    expect(
      roundTrip([
        {
          type: 'pageCard',
          content: [{ type: 'pageLink', attrs: { id: 'old-page', label: '旅行计划', anchor: '路线' } }],
        },
      ]).content![0],
    ).toMatchObject({
      type: 'pageCard',
      content: [{ type: 'pageLink', attrs: { id: 'new-page', anchor: '路线' } }],
    });
  });
  it('书签封面参与备份与附件重新映射', () => {
    /** 网页卡片的封面不能被附件清理当作未使用。 */
    const node: DocNode = {
      type: 'bookmark',
      attrs: { href: 'https://example.com', title: '资料', description: '摘要', coverFileId: 'cover.png' },
    };
    /** 封面在导出后从路径恢复。 */
    const restored = roundTrip([node]);
    expect(restored.content![0]).toEqual(node);
    expect(fileIdsInDoc(restored)).toEqual(['cover.png']);
    expect(remapFileIds(restored, new Map([['cover.png', 'new.png']])).content![0]?.attrs?.coverFileId).toBe(
      'new.png',
    );
  });
  it('空图册仍然保留，损坏标记不会吞掉正文', () => {
    expect(roundTrip([{ type: 'gallery', content: [] }]).content![0]).toEqual({
      type: 'gallery',
      content: [],
    });
    expect(
      docToMarkdown(markdownToDoc('<!-- morrow:block {"type":"gallery","attrs":{}} -->\n\n不能丢失')),
    ).toContain('不能丢失');
  });
  it('拒绝危险颜色和非法比例', () => {
    expect(normalizeBackground('url(javascript:alert(1))')).toBeNull();
    expect(normalizeWidths([99, 1])).toBeNull();
    expect(normalizeWidths([2, 1])).toEqual([66.67, 33.33]);
  });
});

describe('外部编辑元数据正文', () => {
  it('页面卡片标记内的第二个链接与书签修改后的地址都保留', () => {
    /** 两个有效链接不能因第一个链接成功恢复而丢掉第二个。 */
    const links =
      '<!-- morrow:block {"type":"pageCard","attrs":{}} -->\n\n[[甲]]\n\n[[乙]]\n\n<!-- /morrow:block -->';
    expect(docToMarkdown(markdownToDoc(links))).toContain('[[乙]]');
    /** 书签标题未变时，外部修改的URL也不能被旧元数据覆盖。 */
    const bookmark =
      '<!-- morrow:block {"type":"bookmark","attrs":{"href":"https://old.example","title":"资料"}} -->\n\n[资料](https://new.example)\n\n<!-- /morrow:block -->';
    expect(docToMarkdown(markdownToDoc(bookmark))).toContain('(https://new.example)');
  });

  it.each(['callout', 'gallery', 'pageCard', 'bookmark'])('%s 标记内新增正文不会被恢复过程吞掉', (type) => {
    /** 每种元数据都带有正常的原始可读正文。 */
    const bodies: Record<string, string> = {
      callout: '> [!note]\n> 原提示',
      gallery: '![图片](attachments/a.png)',
      pageCard: '[[旅行计划]]',
      bookmark: '[资料](https://example.com)',
    };
    /** 扩展属性与额外段落共同构成外部编辑后的文件。 */
    const attrs = type === 'bookmark' ? { href: 'https://example.com', title: '资料' } : { border: 'thin' };
    const source = `<!-- morrow:block ${JSON.stringify({ type, attrs })} -->\n\n${bodies[type]}\n\n外部添加的重要正文\n\n<!-- /morrow:block -->`;
    const restored = markdownToDoc(source, parseOptions);
    const saved = docToMarkdown(restored, serializeOptions);
    expect(saved).toContain('外部添加的重要正文');
    expect(docToMarkdown(markdownToDoc(saved, parseOptions), serializeOptions)).toContain(
      '外部添加的重要正文',
    );
  });
});

/** 发布文件必须保留所有媒体和可读资料，且不能输出危险链接。 */
describe('扩展块静态发布', () => {
  it('发布图册全部图片、图注和本地卡片，屏蔽危险地址', () => {
    /** 用完全隔离的内存笔记库覆盖发布边界。 */
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'gallery',
          attrs: { layout: 'carousel', caption: '全部图片' },
          content: [
            { type: 'image', attrs: { fileId: 'a.png', caption: '第一张' } },
            { type: 'image', attrs: { fileId: 'b.png', caption: '第二张' } },
          ],
        },
        { type: 'pageCard', content: [{ type: 'pageLink', attrs: { id: 'p', target: '发布示例' } }] },
        { type: 'bookmark', attrs: { href: 'javascript:alert(1)', title: '<危险标题>' } },
      ],
    };
    /** 内存状态使用不可变页面和文档映射。 */
    const state = {
      ...emptyWorkspace(),
      pages: { p: newPageMeta({ id: 'p', parentId: null, title: '发布示例' }) },
      docs: { p: doc },
    };
    /** 静态站点不依赖轮播脚本，所有附件都必须输出。 */
    const site = buildSite(state, { rootId: 'p', title: '测试' });
    /** 主页面用来检查文本和HTML转义。 */
    const html = site.files.find((file) => file.path === 'index.html')!.content;
    expect([...site.assets.keys()]).toEqual(['a.png', 'b.png']);
    expect(html).toContain('第一张');
    expect(html).toContain('第二张');
    expect(html).toContain('全部图片');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<危险标题>');
  });
  it('拒绝包含账号凭据的网页卡片地址', () => {
    expect(normalizeBookmarkHref('https://name:password@example.com')).toBeNull();
    expect(normalizeBookmarkHref('https://example.com')).toBe('https://example.com');
  });
});
