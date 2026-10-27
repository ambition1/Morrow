/**
 * 功能：为浮层玻璃材质提供逐帧合并的指针高光，不影响编辑与拖拽行为。
 * 作者：xuanli
 * 创建时间：2026-10-28 00:19:47
 */
import { useEffect } from 'react';

/** 仅在精细指针且允许动态与透明度效果时更新局部玻璃高光。 */
export function useGlassLight() {
  useEffect(() => {
    /** 高光只作用于独立浮动表面，避免正文整页重绘。 */
    const selector = '.dialog, .popover, .palette, .canvas-toolbar';
    /** 用户偏好在每次输入时读取，设置改变后立即停止动态高光。 */
    const allowed = window.matchMedia('(pointer: fine) and (prefers-reduced-motion: no-preference)');
    /** 不支持透明度媒体查询时也允许效果，明确请求减少透明度时才禁用。 */
    const reducedTransparency = window.matchMedia('(prefers-reduced-transparency: reduce)');
    /** 同一帧只保留最近一次指针坐标。 */
    let pending: { element: HTMLElement; x: number; y: number } | null = null;
    /** 待执行的动画帧编号，用于卸载时取消。 */
    let frame = 0;
    /** 将最近指针位置写入局部 CSS 变量，避开 React 渲染链。 */
    const paint = () => {
      frame = 0;
      if (!pending || !allowed.matches || reducedTransparency.matches || !pending.element.isConnected) return;
      /** 目标表面的位置仅在真正绘制的帧读取。 */
      const bounds = pending.element.getBoundingClientRect();
      pending.element.style.setProperty('--glass-x', `${pending.x - bounds.left}px`);
      pending.element.style.setProperty('--glass-y', `${pending.y - bounds.top}px`);
      pending = null;
    };
    /** 不阻止浏览器原生输入，只记录当前最近的浮层表面。 */
    const move = (event: PointerEvent) => {
      if (!allowed.matches || reducedTransparency.matches || event.pointerType !== 'mouse') return;
      /** 文本节点之外的原生指针目标。 */
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
      if (!target) return;
      pending = { element: target, x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(paint);
    };
    document.addEventListener('pointermove', move, { passive: true });
    return () => {
      document.removeEventListener('pointermove', move);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
}
