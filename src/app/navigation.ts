/**
 * 功能：单工作区及可选分栏的浏览历史、定位和焦点管理。
 * 作者：xuanli
 * 时间：2026-10-30 23:19:54
 */
import { createContext, useContext, useSyncExternalStore } from 'react';

/** 导航区域标识。 */
export type PaneId = 'main' | 'side';
/** 单个区域的当前位置与前后历史。 */
export interface PaneHistory {
  /** 当前地址。 */
  hash: string;
  /** 后退地址。 */
  back: string[];
  /** 前进地址。 */
  forward: string[];
}
/** 主区域及其可选分栏。 */
interface MainPane extends PaneHistory {
  /** 分栏历史，未打开时为空。 */
  side: PaneHistory | null;
}
/** 唯一工作区的导航状态。 */
interface NavigationState {
  /** 主区域。 */
  main: MainPane;
  /** 当前接收导航的区域。 */
  pane: PaneId;
}
/** 独立导航存储，不恢复旧多标签列表。 */
const KEY = 'morrow.navigation';
/** 每侧最多保留的浏览记录数。 */
const MAX_HISTORY = 50;
/** 订阅导航变化的回调。 */
const listeners = new Set<() => void>();
/** 过滤持久化历史中的非法值。 */
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(-MAX_HISTORY)
    : [];
/** 读取单侧有效导航历史。 */
function readPane(raw: unknown): PaneHistory | null {
  /** 待校验的持久化记录。 */
  const value = raw as Partial<PaneHistory> | null;
  if (typeof value?.hash !== 'string') return null;
  return { hash: value.hash, back: strings(value.back), forward: strings(value.forward) };
}
/** 以当前 URL 为准恢复工作区，不触碰笔记数据。 */
function load(): NavigationState {
  /** 当前浏览器地址。 */
  const here = window.location.hash || '#/';
  try {
    /** 已保存的工作区。 */
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<NavigationState> | null;
    /** 主区域历史。 */
    const saved = readPane(raw?.main);
    if (saved) {
      /** 可选分栏历史。 */
      const side = readPane(raw?.main?.side);
      if (saved.hash !== here) saved.back = [...saved.back, saved.hash].slice(-MAX_HISTORY);
      return { main: { ...saved, hash: here, side }, pane: raw?.pane === 'side' && side ? 'side' : 'main' };
    }
  } catch {
    // 导航记录不可用时从当前地址重新开始。
  }
  return { main: { hash: here, back: [], forward: [], side: null }, pane: 'main' };
}
/** 内存导航快照。 */
let state: NavigationState | null = null;
/** 懒加载当前快照。 */
const current = (): NavigationState => (state ??= load());
/** 保存并通知导航变化。 */
function set(next: NavigationState): void {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 存储不可用不会阻止浏览。
  }
  for (const listener of listeners) listener();
}
/** 更新唯一主区域及当前焦点区域。 */
function updateMain(change: (main: MainPane) => MainPane, extra: Partial<NavigationState> = {}): void {
  /** 更新前快照。 */
  const now = current();
  set({ ...now, ...extra, main: change(now.main) });
}
/** 历史跳转即将到达的 URL，避免再次添加浏览记录。 */
let arriving: string | null = null;

/** 更新浏览器地址并标记历史跳转。 */
function go(hash: string): void {
  if (window.location.hash === hash || (hash === '#/' && !window.location.hash)) return;
  arriving = hash;
  window.location.hash = hash;
}

/** 生成一次浏览或替换后的区域历史。 */
function visit(pane: PaneHistory, hash: string, replace: boolean): PaneHistory {
  if (pane.hash === hash) return pane;
  if (replace) return { ...pane, hash };
  return { hash, back: [...pane.back, pane.hash].slice(-MAX_HISTORY), forward: [] };
}

/** 监听地址变化、鼠标历史键和 Alt 点击分栏。 */
export function startNavigation(): () => void {
  current();
  /** 同步浏览器地址变化。 */
  const onHash = () => {
    /** 目标地址。 */
    const hash = window.location.hash || '#/';
    /** 当前主区域快照。 */
    const mainPane = current().main;
    /** 是否由已有历史跳转触发。 */
    const expected = arriving === hash;
    arriving = null;
    if (mainPane.hash === hash) return;
    updateMain((item) => (expected ? { ...item, hash } : { ...item, ...visit(item, hash, false) }));
  };
  /** 处理鼠标历史键与分栏手势。 */
  const onClick = (event: MouseEvent) => {
    if (event.type === 'auxclick' && (event.button === 3 || event.button === 4)) {
      event.preventDefault();
      /** 事件目标所属区域。 */
      const pane = paneAt(event.target);
      if (event.button === 3) goBack(pane);
      else goForward(pane);
      return;
    }
    /** 是否请求在分栏中打开页面。 */
    const toSide =
      event.type === 'click' && event.button === 0 && event.altKey && !event.ctrlKey && !event.metaKey;
    if (!toSide) return;
    /** 具有页面标识的点击元素。 */
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-page-id]');
    /** 目标笔记标识。 */
    const id = target?.dataset.pageId;
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    /** 目标地址。 */
    const hash = `#/page/${encodeURIComponent(id)}`;
    openSide(hash);
  };
  window.addEventListener('hashchange', onHash);
  window.addEventListener('click', onClick, true);
  window.addEventListener('auxclick', onClick, true);
  return () => {
    window.removeEventListener('hashchange', onHash);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('auxclick', onClick, true);
  };
}

/** 根据事件目标确定导航区域。 */
function paneAt(target: EventTarget | null): PaneId {
  /** 最近的区域容器。 */
  const element = target instanceof Element ? target.closest<HTMLElement>('[data-pane]') : null;
  return element?.dataset.pane === 'side' ? 'side' : element ? 'main' : current().pane;
}

/** 读取当前接收导航的区域。 */
export function targetPane(): PaneId {
  /** 当前导航快照。 */
  const now = current();
  return now.pane === 'side' && now.main.side ? 'side' : 'main';
}

/** 读取当前活动区域的地址。 */
export function activeHash(): string {
  /** 当前主区域快照。 */
  const mainPane = current().main;
  return targetPane() === 'side' ? mainPane.side!.hash : window.location.hash || '#/';
}

/** 切换接收导航的区域。 */
export function setActivePane(pane: PaneId): void {
  /** 当前导航快照。 */
  const now = current();
  /** 校验后的目标区域。 */
  const next = pane === 'side' && now.main.side ? 'side' : 'main';
  if (now.pane !== next) set({ ...now, pane: next });
}

/** 打开主区域地址，支持替换当前记录。 */
export function showInMain(hash: string, replace = false): void {
  if (window.location.hash === hash) return;
  if (!replace) {
    window.location.hash = hash;
    return;
  }
  updateMain((item) => ({ ...item, hash }));
  history.replaceState(null, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** 打开分栏地址，保持主区域不变。 */
export function showInSide(hash: string, replace = false): void {
  /** 当前主区域快照。 */
  const mainPane = current().main;
  if (!mainPane.side) return;
  updateMain((item) => ({ ...item, side: visit(item.side!, hash, replace) }));
}

/** 打开分栏并将导航焦点移到分栏。 */
export function openSide(hash = activeHash()): void {
  updateMain((item) => ({ ...item, side: { hash, back: [], forward: [] } }), { pane: 'side' });
}

/** 关闭分栏并回到主区域。 */
export function closeSide(): void {
  if (!current().main.side) return;
  updateMain((item) => ({ ...item, side: null }), { pane: 'main' });
}

/** 交换两侧内容及各自浏览历史。 */
export function swapSides(): void {
  /** 当前主区域快照。 */
  const mainPane = current().main;
  if (!mainPane.side) return;
  /** 待交换的主区域历史。 */
  const main: PaneHistory = { hash: mainPane.hash, back: mainPane.back, forward: mainPane.forward };
  /** 待交换的分栏历史。 */
  const side = mainPane.side;
  updateMain((item) => ({ ...item, ...side, side: main }));
  go(side.hash);
}

/** 获取指定区域的历史。 */
function paneOf(mainPane: MainPane, pane: PaneId): PaneHistory | null {
  return pane === 'side' ? mainPane.side : mainPane;
}

/** 检查指定区域能否前进或后退。 */
export function canGo(mainPane: MainPane, pane: PaneId, direction: 'back' | 'forward'): boolean {
  return (paneOf(mainPane, pane)?.[direction].length ?? 0) > 0;
}

/** 执行指定方向的历史跳转。 */
function step(pane: PaneId, direction: 'back' | 'forward'): void {
  /** 当前主区域快照。 */
  const mainPane = current().main;
  /** 当前区域的浏览历史。 */
  const history = paneOf(mainPane, pane);
  if (!history || history[direction].length === 0) return;
  /** 待访问方向的历史副本。 */
  const list = [...history[direction]];
  /** 目标地址。 */
  const hash = list.pop()!;
  /** 另一方向补入当前位置后的历史。 */
  const left = [...(direction === 'back' ? history.forward : history.back), history.hash].slice(-MAX_HISTORY);
  /** 跳转后的完整区域历史。 */
  const moved: PaneHistory =
    direction === 'back' ? { hash, back: list, forward: left } : { hash, back: left, forward: list };
  if (pane === 'side') {
    updateMain((item) => ({ ...item, side: moved }), { pane: 'side' });
    return;
  }
  updateMain((item) => ({ ...item, ...moved }), { pane: 'main' });
  go(hash);
}

/** 后退到上一次浏览位置。 */
export function goBack(pane: PaneId = targetPane()): void {
  step(pane, 'back');
}

/** 前进到下一次浏览位置。 */
export function goForward(pane: PaneId = targetPane()): void {
  step(pane, 'forward');
}

/** 订阅单工作区导航快照。 */
export function useNavigation(): NavigationState {
  return useSyncExternalStore(subscribeNavigation, current);
}
/** 注册导航变化回调。 */
export function subscribeNavigation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** 读取导航状态。 */
export function getNavigation(): NavigationState {
  return current();
}
/** 当前渲染区域的上下文。 */
export const PaneContext = createContext<PaneId>('main');
/** 读取组件所属区域。 */
export function usePane(): PaneId {
  return useContext(PaneContext);
}
