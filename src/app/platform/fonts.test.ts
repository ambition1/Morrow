/**
 * 功能：验证系统字体回退及恶意字体名不能注入 CSS。
 * 作者：xuanli
 * 创建时间：2026-10-25 23:45:11
 */
import { describe, expect, it } from 'vitest';
import { fontFamily, SYSTEM_FONT } from './fonts';

describe('字体配置', () => {
  it('空名称使用系统字体，中文名称保留并提供回退', () => {
    expect(fontFamily('')).toBe(SYSTEM_FONT);
    expect(fontFamily('  微软雅黑  ')).toBe(`"微软雅黑", ${SYSTEM_FONT}`);
    expect(fontFamily('\n\t')).toBe(SYSTEM_FONT);
  });
  it('引号和分号保留在单个转义后的字体字符串内', () => {
    /** 包含 CSS 注入片段的字体名，只能作为字体字符串使用。 */
    const name = 'font"; color:red; /*';
    expect(fontFamily(name)).toBe(`${JSON.stringify(name)}, ${SYSTEM_FONT}`);
    expect(fontFamily('x'.repeat(300))).toBe(`${JSON.stringify('x'.repeat(200))}, ${SYSTEM_FONT}`);
  });
});
