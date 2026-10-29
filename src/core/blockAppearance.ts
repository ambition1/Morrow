/**
 * 功能：规范文档扩展块的可选外观属性，保持旧文档默认值和不可信输入安全。
 * 作者：xuanli
 * 创建时间：2026-10-30 00:03:54
 */
import { COLORS } from './model';

/** 内容块边框的受支持样式。 */
export type BlockBorder = 'none' | 'thin' | 'left';
/** 内容块间距的受支持密度。 */
export type BlockGap = 'compact' | 'normal' | 'wide';

/** 只接受既有主题色、透明色或完整十六进制颜色。 */
export function normalizeBackground(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  /** 去除输入外围空格，主题色名称统一小写。 */
  const color = value.trim().toLowerCase();
  if (color === 'transparent' || (COLORS as readonly string[]).includes(color)) return color;
  return /^#[0-9a-f]{6}$/.test(color) ? color.toUpperCase() : null;
}

/** 拒绝不支持的边框，缺省继续使用原有块样式。 */
export function normalizeBorder(value: unknown): BlockBorder | null {
  return value === 'none' || value === 'thin' || value === 'left' ? value : null;
}

/** 分栏比例只能由二至四个有限正数组成，避免生成非法布局。 */
export function normalizeWidths(value: unknown, count?: number): number[] | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4 || (count && value.length !== count))
    return null;
  if (value.some((part) => typeof part !== 'number' || !Number.isFinite(part) || part <= 0)) return null;
  /** 比例按统一总量规范化，限制任何一栏小于整体的十分之一。 */
  const total = value.reduce((sum: number, part: number) => sum + part, 0);
  if (!Number.isFinite(total) || value.some((part: number) => part / total < 0.1)) return null;
  return value.map((part: number) => Math.round((part / total) * 10000) / 100);
}

/** 限定链接卡片只使用普通网页地址，禁止脚本协议。 */
export function normalizeBookmarkHref(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4000) return null;
  try {
    /** URL解析结果用于检查协议，不改变用户原有地址大小写。 */
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}

/** 按节点类型挑选可持久化的扩展属性，默认值不产生额外元数据。 */
export function normalizeBlockAttrs(
  type: string,
  attrs: Record<string, unknown> = {},
): Record<string, unknown> {
  /** 返回对象只包含明确允许的键，避免原型或CSS注入。 */
  const result: Record<string, unknown> = {};
  if (['callout', 'column', 'details'].includes(type)) {
    /** 背景色和边框与语义类型分离。 */
    const background = normalizeBackground(attrs.background);
    /** 合法边框值沿用有限枚举。 */
    const border = normalizeBorder(attrs.border);
    if (background) result.background = background;
    if (border) result.border = border;
  }
  if (type === 'callout') {
    if (typeof attrs.icon === 'string' && attrs.icon.length > 0 && attrs.icon.length <= 16)
      result.icon = attrs.icon;
    if (typeof attrs.showTitle === 'boolean') result.showTitle = attrs.showTitle;
  }
  if (type === 'columns') {
    /** 分栏宽度在实际视图中再次按栏数验证。 */
    const widths = normalizeWidths(attrs.widths);
    if (widths) result.widths = widths;
  }
  if (['columns', 'gallery'].includes(type) && ['compact', 'wide'].includes(String(attrs.gap)))
    result.gap = attrs.gap;
  if (type === 'orderedList' && attrs.presentation === 'steps') result.presentation = 'steps';
  if (type === 'image') {
    if (typeof attrs.caption === 'string' && attrs.caption) result.caption = attrs.caption.slice(0, 2000);
    if (typeof attrs.width === 'number' && Number.isFinite(attrs.width))
      result.width = Math.min(100, Math.max(10, attrs.width));
    if (attrs.align === 'left' || attrs.align === 'right') result.align = attrs.align;
  }
  if (type === 'gallery') {
    if (attrs.layout === 'masonry' || attrs.layout === 'carousel') result.layout = attrs.layout;
    if (attrs.columns === 2 || attrs.columns === 4) result.columns = attrs.columns;
    if (attrs.originalRatio === true) result.originalRatio = true;
    if (typeof attrs.caption === 'string' && attrs.caption) result.caption = attrs.caption.slice(0, 2000);
  }
  if (type === 'bookmark') {
    /** 非法地址仍保留标题和说明，显示层负责不可用状态。 */
    const href = normalizeBookmarkHref(attrs.href);
    if (href) result.href = href;
    for (const key of ['title', 'description'] as const)
      if (typeof attrs[key] === 'string') result[key] = attrs[key].slice(0, key === 'title' ? 500 : 4000);
    if (typeof attrs.coverFileId === 'string' && attrs.coverFileId) result.coverFileId = attrs.coverFileId;
  }
  return result;
}
