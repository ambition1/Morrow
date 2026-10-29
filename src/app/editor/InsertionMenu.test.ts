/**
 * 功能：验证紧凑插入菜单的最近命令、图标分组和网页地址约束。
 * 作者：xuanli
 * 创建时间：2026-10-30 00:12:47
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { filterBlocks, recentBlockIds, rememberBlock } from './SlashCommand';
import { bookmarkHref } from './ReferenceCards';

/** 为每个用例提供隔离的浏览器偏好存储。 */
function storage(value = '[]') {
  // 本用例保存的原始JSON内容。
  let saved = value;
  vi.stubGlobal('localStorage', {
    getItem: () => saved,
    setItem: (_key: string, next: string) => {
      saved = next;
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('紧凑插入菜单', () => {
  it('损坏偏好降级为空，并将最近执行的命令去重限制四项', () => {
    storage('{broken');
    expect(recentBlockIds()).toEqual([]);
    storage('["image","image",null,"table","gallery","text","file"]');
    expect(recentBlockIds()).toEqual(['image', 'table', 'gallery', 'text']);
    rememberBlock('gallery');
    expect(recentBlockIds()).toEqual(['gallery', 'image', 'table', 'text']);
  });

  it('标题使用单一图标并保留图册和两类引用卡片入口', () => {
    storage('["gallery"]');
    // 扁平顺序与界面的分组显示一致。
    const items = filterBlocks('');
    expect(items[0]).toMatchObject({ id: 'recent:gallery', commandId: 'gallery' });
    for (let level = 1; level <= 6; level++) {
      expect(items.find((item) => item.id === `h${level}`)).toMatchObject({
        compact: 'format',
        glyph: `H${level}`,
      });
    }
    expect(items.some((item) => item.id === 'gallery')).toBe(true);
    expect(items.some((item) => item.id === 'pageCard')).toBe(true);
    expect(items.some((item) => item.id === 'bookmark')).toBe(true);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    expect(filterBlocks('gallery').some((item) => item.id === 'gallery')).toBe(true);
  });
});

describe('网页卡片地址', () => {
  it('保留标准HTTP地址并拒绝脚本和带凭据地址', () => {
    expect(bookmarkHref(' https://example.com/docs ')).toBe('https://example.com/docs');
    expect(bookmarkHref('javascript:alert(1)')).toBeNull();
    expect(bookmarkHref('file:///tmp/private')).toBeNull();
    expect(bookmarkHref('https://user:password@example.com')).toBeNull();
    expect(bookmarkHref('这不是地址')).toBeNull();
  });
});
