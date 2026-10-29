/**
 * 功能：为编辑器提示块、分栏与折叠内容提供受限的外观属性和安全主题样式。
 * 作者：xuanli
 * 创建时间：2026-10-30 00:05:47
 */
import type { Editor } from '@tiptap/core';
import { normalizeBackground, normalizeBorder } from '../../core/blockAppearance';

/** 为自定义背景选择具有更高对比度的黑白正文色。 */
export function readableBlockText(hex: string): string {
  /** 把颜色通道转换为线性亮度。 */
  const channels = [1, 3, 5].map((start) => {
    /** 当前通道的归一化值。 */
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  /** WCAG相对亮度用于选择安全的文字色。 */
  const luminance = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  return luminance > 0.179 ? '#171717' : '#FFFFFF';
}

/** 只从已经规范化的颜色生成CSS变量，禁止任意样式进入文档。 */
export function blockAppearanceCss(attrs: Record<string, unknown>): string {
  /** 当前受支持的背景值。 */
  const background = normalizeBackground(attrs.background);
  if (!background) return '';
  if (background === 'transparent')
    return '--block-background:transparent;--block-text:var(--text);--block-line:var(--border-strong)';
  if (background.startsWith('#')) {
    /** 自定义颜色的安全正文颜色。 */
    const text = readableBlockText(background);
    return `--block-background:${background};--block-text:${text};--block-line:${text}`;
  }
  return `--block-background:var(--c-${background});--block-text:var(--c-${background}-text);--block-line:var(--c-${background}-text)`;
}

/** 提供统一的HTML属性，复制粘贴时保留受支持的外观。 */
export function blockAppearanceAttributes() {
  return {
    background: {
      default: null,
      parseHTML: (element: HTMLElement) => normalizeBackground(element.getAttribute('data-block-background')),
      renderHTML: (attrs: Record<string, unknown>) => {
        /** 背景只允许主题名、透明或完整HEX。 */
        const background = normalizeBackground(attrs.background);
        return background ? { 'data-block-background': background, style: blockAppearanceCss(attrs) } : {};
      },
    },
    border: {
      default: null,
      parseHTML: (element: HTMLElement) => normalizeBorder(element.getAttribute('data-block-border')),
      renderHTML: (attrs: Record<string, unknown>) => {
        /** 边框只接受有限枚举。 */
        const border = normalizeBorder(attrs.border);
        return border ? { 'data-block-border': border } : {};
      },
    },
  };
}

/** 更新原生节点视图的安全外观，而不触碰内容区域。 */
export function applyBlockAppearance(element: HTMLElement, attrs: Record<string, unknown>): void {
  /** 当前规范化的背景。 */
  const background = normalizeBackground(attrs.background);
  /** 当前规范化的边框。 */
  const border = normalizeBorder(attrs.border);
  if (background) element.dataset.blockBackground = background;
  else delete element.dataset.blockBackground;
  if (border) element.dataset.blockBorder = border;
  else delete element.dataset.blockBorder;
  element.style.removeProperty('--block-background');
  element.style.removeProperty('--block-text');
  element.style.removeProperty('--block-line');
  if (background) element.style.cssText += `;${blockAppearanceCss(attrs)}`;
}

/** 复用原有块菜单回调，使图标点击与拖动手柄进入同一设置入口。 */
export function openBlockAppearance(editor: Editor, pos: number, element: HTMLElement): void {
  /** 已注册的块菜单扩展。 */
  const handle = editor.extensionManager.extensions.find((extension) => extension.name === 'blockHandle');
  handle?.options.onMenu?.({ pos, rect: element.getBoundingClientRect() });
}
