/**
 * 功能：验证中文和中英混排的字词统计。
 * 作者：xuanli
 * 创建时间：2026-10-25 23:48:29
 */
import { expect, it } from 'vitest';
import { countWords } from './doc';

it('中文逐字统计，英文按词统计，纯标点不计入', () => {
  expect(countWords('你好，世界！')).toBe(4);
  expect(countWords('中文 Morrow notes 2026')).toBe(5);
  expect(countWords('Hello world')).toBe(2);
  expect(countWords('，。！？')).toBe(0);
});
