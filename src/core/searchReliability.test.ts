/**
 * 功能：验证搜索筛选、重复命中的精确定位与快速记录节点安全性。
 * 作者：xuanli
 * 创建时间：2026-10-30 16:47:34
 */
import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import { appendCapture } from './capture';
import { docToPlainText } from './doc';
import { emptyWorkspace } from './model';
import type { DocNode, WorkspaceState } from './model';
import { searchWorkspace } from './search';
import { decodeSearchLocation, encodeSearchLocation, locateSearchText } from './searchLocation';

/** 创建隔离样本，真实笔记不会参与搜索测试。 */
function sample(): WorkspaceState {
  /** 根笔记含图片，子笔记含PDF，另一根笔记含普通文件。 */
  let state = emptyWorkspace();
  for (const [id, parentId, now, attachment] of [
    ['root', null, 100, { type: 'image', attrs: { fileId: 'image', alt: '照片' } }],
    ['child', 'root', 200, { type: 'fileAttachment', attrs: { fileId: 'pdf', name: '预算.PDF' } }],
    ['other', null, 300, { type: 'fileAttachment', attrs: { fileId: 'txt', name: '清单.txt' } }],
  ] as const) {
    /** 真实命令负责建立合法页面元数据。 */
    const result = applyCommand(state, {
      type: 'page.create',
      id,
      parentId,
      now,
      title: id,
      tags: id === 'child' ? ['家庭/预算'] : [],
      doc: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '共同内容' }] }, attachment],
      },
    });
    if (!result.ok) throw new Error(result.error);
    state = result.value.state;
  }
  return state;
}

/** 多处相同短语前有图注和多层内容，不能只定位第一个同名词。 */
const repeated: DocNode = {
  type: 'doc',
  content: [
    { type: 'image', attrs: { alt: '预算', caption: '预算说明' } },
    { type: 'paragraph', content: [{ type: 'text', text: `预算第一处${'。'.repeat(70)}` }] },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: '预算第二处' }] }] },
  ],
};

describe('搜索可靠性', () => {
  it('范围包含选中页面及后代，且所有筛选同时满足', () => {
    expect(
      searchWorkspace(sample(), '共同', 50, 1, { rootId: 'root' })
        .map((result) => result.page.id)
        .sort(),
    ).toEqual(['child', 'root']);
    expect(
      searchWorkspace(sample(), '', 50, 1, {
        rootId: 'root',
        tag: '家庭',
        updatedAfter: 150,
        updatedBefore: 250,
        attachment: 'pdf',
      }).map((result) => result.page.id),
    ).toEqual(['child']);
    expect(searchWorkspace(sample(), '共同', 50, 1, { rootId: 'child', attachment: 'image' })).toEqual([]);
  });
  it('附件筛选来自节点而非正文中的文件名，时间边界包含当时修改', () => {
    expect(
      searchWorkspace(sample(), '', 50, 1, { attachment: 'image' }).map((result) => result.page.id),
    ).toEqual(['root']);
    expect(
      searchWorkspace(sample(), '', 50, 1, { updatedAfter: 200, updatedBefore: 200 }).map(
        (result) => result.page.id,
      ),
    ).toEqual(['child']);
    expect(searchWorkspace(sample(), '', 50, 1, { attachment: 'pdf', rootId: 'other' })).toEqual([]);
  });
  it('每个重复命中有独立偏移，嵌套第二处可精确定位', () => {
    /** 将合法页面正文替换为重复样本，保持页面记录不变。 */
    const state = sample();
    state.docs = { ...state.docs, child: repeated };
    /** 请求足够多的片段，原有相邻片段合并策略仍然有效。 */
    const result = searchWorkspace(state, '预算', 50, 5).find((item) => item.page.id === 'child')!;
    /** 最后一段位于blockquote内部。 */
    const snippet = result.snippets.at(-1)!;
    const target = decodeSearchLocation(encodeSearchLocation(repeated, snippet.match, snippet.offset))!;
    expect(locateSearchText(repeated, target)).toEqual({ path: [2, 0], offset: 0 });
  });
  it('内容变化拒绝旧偏移，默认属性标准化不改变位置', () => {
    /** 第二处搜索词的原始偏移。 */
    const offset = docToPlainText(repeated).lastIndexOf('预算');
    const target = decodeSearchLocation(encodeSearchLocation(repeated, '预算', offset))!;
    expect(locateSearchText({ ...repeated, attrs: { normalized: true } }, target)).toEqual({
      path: [2, 0],
      offset: 0,
    });
    expect(
      locateSearchText(
        { ...repeated, content: [{ type: 'paragraph', content: [{ type: 'text', text: '改变后的预算' }] }] },
        target,
      ),
    ).toBeNull();
    expect(decodeSearchLocation('morrow-search:{"match":"预算","offset":-1,"fingerprint":"a"}')).toBeNull();
    expect(decodeSearchLocation('普通搜索词')).toBeNull();
  });
});

describe('快速记录组合', () => {
  it('保留原正文，任务与附件复用既有节点且输入不变', () => {
    /** 输入文档用来核对不可变语义。 */
    const source: DocNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '原文' }] }],
    };
    const result = appendCapture(
      source,
      '[ ] 买菜\n\n普通记录',
      [
        { id: 'f1', name: '相片.png', type: 'image/png', size: 2, createdAt: 1 },
        { id: 'f2', name: '资料.pdf', type: 'application/pdf', size: 3, createdAt: 1 },
      ],
      '16:00',
    );
    expect(result.content?.map((node) => node.type)).toEqual([
      'paragraph',
      'taskList',
      'paragraph',
      'image',
      'fileAttachment',
    ]);
    expect(result.content?.[1]?.content?.[0]?.attrs?.checked).toBe(false);
    expect(source.content).toHaveLength(1);
  });
  it('只上传附件不会插入空文字或破坏原有空行', () => {
    /** 新页面的默认空段落只在这里移除。 */
    const result = appendCapture(
      { type: 'doc', content: [{ type: 'paragraph' }] },
      '',
      [{ id: 'f', name: 'a.txt', type: 'text/plain', size: 1, createdAt: 1 }],
      '16:00',
    );
    expect(result.content).toHaveLength(1);
    expect(result.content?.[0]?.type).toBe('fileAttachment');
  });
});
