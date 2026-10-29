/**
 * 功能：校验文档内日期与可选时刻，保留无时区的日历语义。
 * 作者：xuanli
 * 创建时间：2026-10-30 00:37:21
 */

/** 日期标签只保存本地日历日期和可选24小时时刻，不转换为UTC。 */
export interface InlineDateValue {
  /** ISO日历日期。 */
  date: string;
  /** 可选时刻，关闭时为null。 */
  time: string | null;
}

/** 严格校验真实日期，避免2月30日被自动滚动到3月。 */
export function inlineDateValue(value: unknown): InlineDateValue | null {
  if (typeof value !== 'string') return null;
  /** 仅接受日期或精确到分钟的日期时刻。 */
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d))?$/.exec(value);
  if (!match || Number(match[1]) < 1) return null;
  /** UTC日历校验不受夏令时或当地被跳过的日期影响。 */
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  )
    return null;
  return { date: value.slice(0, 10), time: match[4] ? `${match[4]}:${match[5]}` : null };
}

/** 为保存、搜索和静态发布提供不依赖界面语言的可读文本。 */
export function inlineDateText(date: unknown, time?: unknown): string {
  /** 时刻为空时不输出多余空白。 */
  const value = inlineDateValue(`${date ?? ''}${time ? `T${time}` : ''}`);
  return value ? `${value.date}${value.time ? ` ${value.time}` : ''}` : String(date ?? '');
}

/** 使用UTC日历载体进行显示与月历计算，不把它当作用户选择的瞬时时间。 */
export function inlineDateCalendarDate(key: string): Date | null {
  /** 拒绝无效日历日期，而不是自动滚动到下个月。 */
  const value = inlineDateValue(key);
  if (!value) return null;
  /** 使用setUTCFullYear绕开Date构造器对两位年份的1900偏移。 */
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(
    Number(value.date.slice(0, 4)),
    Number(value.date.slice(5, 7)) - 1,
    Number(value.date.slice(8, 10)),
  );
  return date;
}
