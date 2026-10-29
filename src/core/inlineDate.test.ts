/**
 * 功能：验证文档内日期时刻的严格校验、Markdown兼容及无跳转发布。
 * 作者：xuanli
 * 创建时间：2026-10-30 00:39:20
 */
import { describe, expect, it } from 'vitest';
import { inlineDateText, inlineDateValue, inlineDateCalendarDate } from './inlineDate';
import { markdownToDoc } from './markdown/parse';
import { docToMarkdown } from './markdown/serialize';
import { docToPlainText } from './doc';
import { buildSite } from './site';
import { emptyWorkspace, newPageMeta } from './model';
import type { DocNode } from './model';

describe('文档内日期与时刻', () => {
  it('保留公元1至99年的年份，不偏移到1900年代', () => {
    expect(inlineDateCalendarDate('0001-01-01')?.getUTCFullYear()).toBe(1);
    expect(inlineDateCalendarDate('0099-12-31')?.getUTCFullYear()).toBe(99);
    expect(inlineDateCalendarDate('2026-02-30')).toBeNull();
  });
  it('严格校验真实日期和24小时时刻，不做时区转换', () => {
    expect(inlineDateValue('2011-12-30')).toEqual({ date: '2011-12-30', time: null });
    expect(inlineDateValue('2028-02-29T00:00')).toEqual({ date: '2028-02-29', time: '00:00' });
    expect(inlineDateValue('2026-10-30T23:59')).toEqual({ date: '2026-10-30', time: '23:59' });
    for (const value of [
      '2026-02-29',
      '2026-13-01',
      '2026-00-01',
      '2026-10-30T24:00',
      '2026-10-30T09:60',
      '2026-10-30Z',
      '0000-01-01',
    ])
      expect(inlineDateValue(value)).toBeNull();
  });
  it.each([null, '09:30', '00:00'])('日期时刻%s原样往返，不解析为每日笔记链接', (time) => {
    /** 行内标签两侧保留普通文字及格式。 */
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '会议 ' },
            { type: 'inlineDate', attrs: { date: '2026-10-30', time } },
            { type: 'text', text: ' 完成' },
          ],
        },
      ],
    };
    /** 保存后的HTML仍有可读日期，且不依赖页面解析结果。 */
    const markdown = docToMarkdown(doc);
    expect(markdown).not.toContain('[[');
    expect(markdownToDoc(markdown, { resolvePage: () => 'existing-daily-note' })).toEqual(doc);
    expect(docToPlainText(doc)).toContain(inlineDateText('2026-10-30', time));
  });
  it('旧每日笔记链接仍按旧类型解析', () => {
    expect(markdownToDoc('[[2026-10-30]]').content![0]!.content![0]!.type).toBe('dateMention');
  });
  it('非法time标签不吞掉后续正文', () => {
    /** 不合法日期保持可读原文，避免自动修正用户数据。 */
    const source = '<time data-inline-date="" datetime="2026-02-30">错误日期</time> 后续正文';
    expect(docToPlainText(markdownToDoc(source))).toContain('后续正文');
    expect(markdownToDoc(source).content![0]!.content!.some((node) => node.type === 'inlineDate')).toBe(
      false,
    );
  });
  it('静态发布包含日期时刻但不创建日期页面链接', () => {
    /** 发布只使用隔离的内存库。 */
    const state = {
      ...emptyWorkspace(),
      pages: { p: newPageMeta({ id: 'p', parentId: null, title: '会议' }) },
      docs: {
        p: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'inlineDate', attrs: { date: '2026-10-30', time: '09:30' } }],
            },
          ],
        },
      },
    };
    /** 发布主内容不能把日期变为a标签。 */
    const html = buildSite(state, { rootId: 'p', title: '测试' }).files.find(
      (file) => file.path === 'index.html',
    )!.content;
    expect(html).toContain('<time datetime="2026-10-30T09:30">2026-10-30 09:30</time>');
  });
});
