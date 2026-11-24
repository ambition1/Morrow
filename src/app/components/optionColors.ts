/**
 * 功能：为数据库选项统一生成预设色和自定义色的界面样式。
 * 作者：xuanli
 * 创建时间：2026-11-24 12:20:15
 */
import type { CSSProperties } from 'react';
import type { OptionColor } from '../../core/model';
import { OPTION_HEX_PATTERN } from '../../core/model';
import { readableBlockText } from '../editor/BlockAppearance';

/** 复用标签和看板的颜色变量，为浅色背景提供深色文字。 */
export function optionColorAppearance(color: OptionColor, className: string, withForeground = true) {
  if (!OPTION_HEX_PATTERN.test(color)) return { className: `${className} color-${color}` };
  // 看板容器只需要底色，避免文字色继承到卡片中的其他标签。
  if (!withForeground) return { className, style: { '--solid': color } as CSSProperties };
  // 在黑白两色中选择对比更高的一种，适用于标签文字和选中标记。
  const foreground = readableBlockText(color) === '#FFFFFF' ? '#fff' : '#000';
  return { className, style: { '--solid': color, '--on-solid': foreground } as CSSProperties };
}
