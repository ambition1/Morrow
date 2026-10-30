/**
 * 功能：将每日笔记的直接子页面按年、月虚拟分组，不改变页面父子关系或存储路径。
 * 作者：xuanli
 * 创建时间：2026-10-30 22:57:43
 */
import type { PageMeta } from './model';
import { inlineDateValue } from './inlineDate';

/** 同一个月份中的笔记按日期倒序显示。 */
export interface JournalMonth {
  /** ISO年月键。 */
  key: string;
  /** 数字月份，范围1到12。 */
  month: number;
  /** 保留原始页面对象和ID。 */
  pages: PageMeta[];
}
/** 年份包含已存在的月份，不创建空月份。 */
export interface JournalYear {
  /** 四位年份键。 */
  key: string;
  /** 实际有笔记的月份。 */
  months: JournalMonth[];
  /** 年份内笔记总数。 */
  count: number;
}

/** 无效日期和普通子页面留在原层级，不能因为分组而消失。 */
export function groupJournalPages(pages: readonly PageMeta[]): { years: JournalYear[]; other: PageMeta[] } {
  /** 月份索引不写回用户页面。 */
  const months = new Map<string, JournalMonth>();
  /** 未参与分组的原始页面。 */
  const other: PageMeta[] = [];
  for (const page of pages) {
    /** 只接受真实的日历日期，避免跨月归类错误。 */
    const value = inlineDateValue(page.dailyDate);
    if (!value || value.time) {
      other.push(page);
      continue;
    }
    /** ISO日期可以直接按字符串分组与排序。 */
    const key = value.date.slice(0, 7);
    if (!months.has(key)) months.set(key, { key, month: Number(key.slice(5)), pages: [] });
    months.get(key)!.pages.push(page);
  }
  /** 年份索引按倒序组装，月内不沿用手工order打乱日期顺序。 */
  const years = new Map<string, JournalYear>();
  for (const month of [...months.values()].sort((a, b) => b.key.localeCompare(a.key))) {
    month.pages.sort((a, b) => b.dailyDate!.localeCompare(a.dailyDate!) || a.id.localeCompare(b.id));
    /** 年份键保持四位格式。 */
    const year = month.key.slice(0, 4);
    if (!years.has(year)) years.set(year, { key: year, months: [], count: 0 });
    years.get(year)!.months.push(month);
    years.get(year)!.count += month.pages.length;
  }
  return { years: [...years.values()], other };
}
