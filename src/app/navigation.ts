/**
 * 功能：单工作区及可选分栏的位置恢复、定位和焦点管理。
 * 作者：xuanli
 * 时间：2026-10-30 23:19:54
 */
import { createContext, useContext, useSyncExternalStore } from 'react';

/** 导航区域标识。 */
export type PaneId = 'main' | 'side';
/** 单个区域的当前位置。 */
export interface PaneLocation {
  /** 当前地址。 */
  hash: string;
}
/** 主区域及其可选分栏。 */
interface MainPane extends PaneLocation {
  /** 分栏位置，未打开时为空。 */
  side: PaneLocation | null;
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
/** 订阅导航变化的回调。 */
const listeners = new Set<() => void>();
/** 读取单侧有效导航位置。 */
function readPane(raw: unknown): PaneLocation | null {
  /** 待校验的持久化记录。 */
  const value = raw as Partial<PaneLocation> | null;
  if (typeof value?.hash !== 'string') return null;
  return { hash: value.hash };
}
/** 启动时可恢复的上次主区域地址。 */
let lastLocation: string | null = null;
/** 以当前 URL 为准恢复工作区，不触碰笔记数据。 */
function load(): NavigationState {
  /** 当前浏览器地址。 */
  const here = window.location.hash || '#/';
  try {
    /** 已保存的工作区。 */
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<NavigationState> | null;
    /** 主区域位置。 */
    const saved = readPane(raw?.main);
    if (saved) {
      lastLocation = saved.hash;
      /** 可选分栏位置。 */
      const side = readPane(raw?.main?.side);
      return { main: { ...saved, hash: here, side }, pane: raw?.pane === 'side' && side ? 'side' : 'main' };
    }
  } catch {
    // 导航记录不可用时从当前地址重新开始。
  }
  return { main: { hash: here, side: null }, pane: 'main' };
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
/** 根据启动偏好恢复上次位置，不依赖前后位置。 */
export function restoreLastLocation(): void {
  current();
  if (lastLocation) showInMain(lastLocation, true);
}

/** 监听地址变化和 Alt 点击分栏。 */
export function startNavigation(): () => void {
  current();
  /** 同步浏览器地址变化。 */
  const onHash = () => {
    /** 目标地址。 */
    const hash = window.location.hash || '#/';
    /** 当前主区域快照。 */
    const mainPane = current().main;
    if (mainPane.hash !== hash) updateMain((item) => ({ ...item, hash }));
  };
  /** 处理分栏手势。 */
  const onClick = (event: MouseEvent) => {
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
  return () => {
    window.removeEventListener('hashchange', onHash);
    window.removeEventListener('click', onClick, true);
  };
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
export function showInSide(hash: string): void {
  /** 当前主区域快照。 */
  const mainPane = current().main;
  if (!mainPane.side) return;
  updateMain((item) => ({ ...item, side: { hash } }));
}

/** 打开分栏并将导航焦点移到分栏。 */
export function openSide(hash = activeHash()): void {
  updateMain((item) => ({ ...item, side: { hash } }), { pane: 'side' });
}

/** 关闭分栏并回到主区域。 */
export function closeSide(): void {
  if (!current().main.side) return;
  updateMain((item) => ({ ...item, side: null }), { pane: 'main' });
}

/** 交换两侧内容及各自浏览位置。 */
export function swapSides(): void {
  /** 当前主区域快照。 */
  const mainPane = current().main;
  if (!mainPane.side) return;
  /** 待交换的主区域位置。 */
  const main: PaneLocation = { hash: mainPane.hash };
  /** 待交换的分栏位置。 */
  const side = mainPane.side;
  updateMain((item) => ({ ...item, ...side, side: main }));
  showInMain(side.hash, true);
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
