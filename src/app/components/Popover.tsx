import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import type { Placement } from '@floating-ui/dom';
import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

// a floating panel anchored to an element, closed by escape or a click outside
export function Popover({
  anchor,
  onClose,
  children,
  placement = 'bottom-start',
  label,
  className,
  fitViewport = false,
}: {
  anchor: HTMLElement | DOMRect;
  onClose: () => void;
  children: ReactNode;
  placement?: Placement;
  label: string;
  className?: string;
  /** 日期等较高浮层允许沿两个方向避让，保证短屏不会裁切顶部。 */
  fitViewport?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const reference = anchor instanceof HTMLElement ? anchor : { getBoundingClientRect: () => anchor };
    // focus waits until the panel is placed and shown, a hidden element can not take it
    let focused = false;
    const place = () =>
      void computePosition(reference, element, {
        placement,
        strategy: 'fixed',
        middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8, crossAxis: fitViewport })],
      }).then(({ x, y }) => {
        element.style.left = `${x}px`;
        element.style.top = `${y}px`;
        element.style.visibility = 'visible';
        if (focused) return;
        focused = true;
        (
          element.querySelector<HTMLElement>('[data-autofocus]') ??
          element.querySelector<HTMLElement>('input, select, button')
        )?.focus();
      });
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [anchor, placement, fitViewport]);

  useEffect(() => {
    const trigger = anchor instanceof HTMLElement ? anchor : null;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || trigger?.contains(target)) return;
      // menus opened from inside the popover live in their own layer
      if ((target as HTMLElement).closest?.('.floating-layer')) return;
      closeRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeRef.current();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      className={`popover floating-layer panel-popover${className ? ` ${className}` : ''}`}
      role="dialog"
      aria-label={label}
      style={{ visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.querySelector('main') ?? document.body,
  );
}
