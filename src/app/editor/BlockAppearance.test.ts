/**
 * 功能：验证自定义背景的文字对比选择及受限样式输出，防止文档外观注入。
 * 作者：xuanli
 * 创建时间：2026-10-30 00:10:35
 */
import { describe, expect, it } from 'vitest';
import { blockAppearanceCss, readableBlockText } from './BlockAppearance';

describe('内容块外观', () => {
  it('对深色和浅色自定义背景选择可读的正文色', () => {
    expect(readableBlockText('#000000')).toBe('#FFFFFF');
    expect(readableBlockText('#FFFFFF')).toBe('#171717');
    expect(readableBlockText('#EDF5FF')).toBe('#171717');
    expect(readableBlockText('#134D99')).toBe('#FFFFFF');
  });

  it('主题色只映射现有CSS令牌，缺省不改变旧块外观', () => {
    expect(blockAppearanceCss({})).toBe('');
    expect(blockAppearanceCss({ background: 'blue' })).toContain('var(--c-blue)');
    expect(blockAppearanceCss({ background: 'transparent' })).toContain('--block-background:transparent');
  });

  it('拒绝颜色输入中的样式和URL注入', () => {
    expect(blockAppearanceCss({ background: 'red; background:url(https://example.com)' })).toBe('');
    expect(blockAppearanceCss({ background: 'url(javascript:alert(1))' })).toBe('');
    expect(blockAppearanceCss({ background: '#abc' })).toBe('');
    expect(blockAppearanceCss({ background: '#edf5ff' })).toContain('--block-background:#EDF5FF');
  });
});
