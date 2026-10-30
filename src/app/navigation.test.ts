/**
 * 功能：验证单工作区导航与分栏位置，防止移除标签页后出现导航回归。
 * 作者：xuanli
 * 时间：2026-10-30 23:21:00
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Navigation from './navigation';

/** 模拟浏览器地址与事件，不访问真实笔记库。 */
let browser: EventTarget & { location: { hash: string } };
/** 测试内存存储。 */
let storage: Map<string, string>;
/** 当前测试加载的导航模块。 */
let navigation: typeof Navigation;
/** 清理监听器。 */
let stop: () => void;
/** 模拟浏览器完成一次地址变化。 */
function settleHash(): void {
  browser.dispatchEvent(new Event('hashchange'));
}

beforeEach(async () => {
  vi.resetModules();
  storage = new Map();
  browser = Object.assign(new EventTarget(), { location: { hash: '#/' } });
  vi.stubGlobal('window', browser);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal('history', {
    replaceState: (_data: unknown, _unused: string, hash: string) => {
      browser.location.hash = hash;
    },
  });
  vi.stubGlobal('HashChangeEvent', Event);
  navigation = await import('./navigation');
});
afterEach(() => {
  stop?.();
  vi.unstubAllGlobals();
});

describe('单工作区导航', () => {
  it('忽略旧多标签记录，以当前 URL 创建唯一工作区', () => {
    storage.set('morrow.tabs', JSON.stringify({ tabs: [{ id: 'old', hash: '#/tasks' }], active: 'old' }));
    browser.location.hash = '#/page/current';
    stop = navigation.startNavigation();
    expect(navigation.getNavigation()).toEqual({
      main: { hash: '#/page/current', side: null },
      pane: 'main',
    });
  });
  it('导航只保存当前位置，不累计前后历史', () => {
    stop = navigation.startNavigation();
    navigation.showInMain('#/tasks');
    settleHash();
    navigation.showInMain('#/tags');
    settleHash();
    expect(navigation.getNavigation().main).toEqual({ hash: '#/tags', side: null });
  });
  it('替换地址同步主区域，分栏独立浏览且可交换和关闭', () => {
    stop = navigation.startNavigation();
    navigation.showInMain('#/page/main', true);
    expect(navigation.getNavigation().main.hash).toBe('#/page/main');
    navigation.openSide('#/page/side');
    navigation.showInSide('#/tasks');
    expect(navigation.activeHash()).toBe('#/tasks');
    expect(browser.location.hash).toBe('#/page/main');
    navigation.swapSides();
    settleHash();
    expect(browser.location.hash).toBe('#/tasks');
    expect(navigation.getNavigation().main.side?.hash).toBe('#/page/main');
    navigation.closeSide();
    expect(navigation.targetPane()).toBe('main');
    expect(navigation.getNavigation().main.side).toBeNull();
  });
  it('刷新恢复导航位置及分栏，不恢复多标签列表', async () => {
    stop = navigation.startNavigation();
    navigation.showInMain('#/tasks');
    settleHash();
    navigation.openSide('#/page/side');
    stop();
    vi.resetModules();
    navigation = await import('./navigation');
    stop = navigation.startNavigation();
    expect(navigation.getNavigation().main.hash).toBe('#/tasks');
    expect(navigation.activeHash()).toBe('#/page/side');
    expect(navigation.getNavigation()).not.toHaveProperty('tabs');
  });
  it('上次位置启动偏好不依赖浏览历史', () => {
    storage.set(
      'morrow.navigation',
      JSON.stringify({ main: { hash: '#/page/last', back: ['#/old'], side: null }, pane: 'main' }),
    );
    stop = navigation.startNavigation();
    navigation.restoreLastLocation();
    expect(browser.location.hash).toBe('#/page/last');
    expect(navigation.getNavigation().main).toEqual({ hash: '#/page/last', side: null });
  });
});
