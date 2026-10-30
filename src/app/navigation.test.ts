/**
 * 功能：验证单工作区导航与分栏历史，防止移除标签页后出现导航回归。
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
      main: { hash: '#/page/current', back: [], forward: [], side: null },
      pane: 'main',
    });
  });
  it('主区域保留前后历史，后退后新导航清除前进记录', () => {
    stop = navigation.startNavigation();
    navigation.showInMain('#/tasks');
    settleHash();
    navigation.showInMain('#/tags');
    settleHash();
    navigation.goBack();
    settleHash();
    expect(browser.location.hash).toBe('#/tasks');
    expect(navigation.canGo(navigation.getNavigation().main, 'main', 'forward')).toBe(true);
    navigation.goForward();
    settleHash();
    expect(browser.location.hash).toBe('#/tags');
    navigation.goBack();
    settleHash();
    navigation.showInMain('#/graph');
    settleHash();
    expect(navigation.getNavigation().main.forward).toEqual([]);
  });
  it('替换地址不添加历史，分栏独立浏览且可交换和关闭', () => {
    stop = navigation.startNavigation();
    navigation.showInMain('#/page/main', true);
    expect(navigation.getNavigation().main.back).toEqual([]);
    navigation.openSide('#/page/side');
    navigation.showInSide('#/tasks');
    navigation.goBack('side');
    expect(navigation.activeHash()).toBe('#/page/side');
    expect(browser.location.hash).toBe('#/page/main');
    navigation.swapSides();
    settleHash();
    expect(browser.location.hash).toBe('#/page/side');
    expect(navigation.getNavigation().main.side?.hash).toBe('#/page/main');
    navigation.closeSide();
    expect(navigation.targetPane()).toBe('main');
    expect(navigation.getNavigation().main.side).toBeNull();
  });
  it('刷新恢复导航历史及分栏，不恢复多标签列表', async () => {
    stop = navigation.startNavigation();
    navigation.showInMain('#/tasks');
    settleHash();
    navigation.openSide('#/page/side');
    stop();
    vi.resetModules();
    navigation = await import('./navigation');
    stop = navigation.startNavigation();
    expect(navigation.getNavigation().main.back).toEqual(['#/']);
    expect(navigation.activeHash()).toBe('#/page/side');
    expect(navigation.getNavigation()).not.toHaveProperty('tabs');
  });
});
