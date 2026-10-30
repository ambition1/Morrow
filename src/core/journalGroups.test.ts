/**
 * 功能：验证每日笔记的年、月分组、倒序排列和异常数据保留。
 * 作者：xuanli
 * 创建时间：2026-10-30 22:57:43
 */
import { describe, expect, it } from 'vitest';
import { newPageMeta } from './model';
import { groupJournalPages } from './journalGroups';

/** 固定笔记样本不依赖设备时区。 */
const page = (id: string, dailyDate: string | null) => newPageMeta({ id, parentId: 'journal', dailyDate });
describe('每日笔记年、月虚拟分组', () => {
  it('跨年、跨月与月内日期均倒序，保留原页面对象及父级', () => {
    /** 输入故意打乱日期和order。 */
    const pages = [
      page('a', '2025-12-31'),
      page('b', '2026-01-02'),
      page('c', '2026-10-03'),
      page('d', '2026-10-01'),
    ];
    const result = groupJournalPages(pages);
    expect(result.years.map((year) => year.key)).toEqual(['2026', '2025']);
    expect(result.years[0]!.months.map((month) => month.key)).toEqual(['2026-10', '2026-01']);
    expect(result.years[0]!.months[0]!.pages).toEqual([pages[2], pages[3]]);
    expect(result.years[0]!.count).toBe(3);
    expect(result.years[0]!.months[0]!.pages[0]).toBe(pages[2]);
    expect(pages.every((item) => item.parentId === 'journal')).toBe(true);
    expect(pages.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('普通子页、非法日期与带时刻的损坏日期字段不丢失', () => {
    /** 只有闰年的2月29日进入二月。 */
    const pages = [
      page('normal', null),
      page('invalid', '2026-02-30'),
      page('time', '2026-10-30T09:00'),
      page('leap', '2028-02-29'),
    ];
    const result = groupJournalPages(pages);
    expect(result.other.map((item) => item.id)).toEqual(['normal', 'invalid', 'time']);
    expect(result.years[0]!.months[0]!.pages[0]!.id).toBe('leap');
  });
  it('空月份不创建占位，超过50篇仍全部归入对应月份', () => {
    /** 大目录分组不能先截断成50条。 */
    const pages = Array.from({ length: 120 }, (_, index) =>
      page(`p${index}`, `${2020 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`),
    );
    const result = groupJournalPages(pages);
    expect(result.years.reduce((sum, year) => sum + year.count, 0)).toBe(120);
    expect(groupJournalPages([])).toEqual({ years: [], other: [] });
  });
});
