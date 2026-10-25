/**
 * 功能：安全应用界面和正文的本机字体配置。
 * 作者：xuanli
 * 创建时间：2026-10-25 23:32:10
 */
import type { Preferences } from './preferences';

/** 系统字体回退栈，兼顾中文和不同操作系统。 */
export const SYSTEM_FONT =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

/** 将单个字体名转换为安全的 CSS 字符串，并提供系统回退。 */
export function fontFamily(name: string): string {
  /** 清除控制字符并限制字体名长度。 */
  const clean = Array.from(name)
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .trim()
    .slice(0, 200);
  return clean ? `${JSON.stringify(clean)}, ${SYSTEM_FONT}` : SYSTEM_FONT;
}

/** 应用字体变量；清空配置时恢复样式表中的默认字体。 */
export function applyFonts(prefs: Pick<Preferences, 'uiFont' | 'writingFont'>): void {
  /** 根元素样式用于让所有页面同步更新。 */
  const style = document.documentElement.style;
  style.setProperty('--font-ui', fontFamily(prefs.uiFont));
  document.documentElement.dataset.customWritingFont = String(Boolean(prefs.writingFont.trim()));
  if (prefs.writingFont.trim()) style.setProperty('--font-writing-custom', fontFamily(prefs.writingFont));
  else style.removeProperty('--font-writing-custom');
}
