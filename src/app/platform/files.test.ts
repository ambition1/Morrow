/**
 * 功能：验证安全上下文与局域网 HTTP 环境的标识生成和草稿所有者隔离。
 * 作者：xuanli
 * 创建时间：2026-11-07 16:53:26
 */
import { afterEach, expect, it, vi } from 'vitest';
import { newId } from './files';
import { createDraftOwner } from '../../storage/webDrafts';

/** 每项测试结束后恢复浏览器全局能力。 */
afterEach(() => vi.unstubAllGlobals());

/** 原生 UUID 可用时保持标准 UUID。 */
it('使用安全上下文提供的 UUID', () => {
  expect(newId()).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
});

/** HTTP 缺少 randomUUID 时仍能创建互相隔离的草稿与历史标识。 */
it('局域网 HTTP 缺少 randomUUID 时仍可生成独立标识', () => {
  vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
  /** 同一毫秒内批量生成标识，验证草稿不会因固定时间共享所有者。 */
  const identities = Array.from({ length: 100 }, () => createDraftOwner());
  expect(new Set(identities).size).toBe(100);
  expect(newId()).toBeTruthy();
});
