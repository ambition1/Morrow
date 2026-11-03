/**
 * 功能：管理附件预览的来源、显示方式与生命周期，独立于笔记文档。
 * 作者：xuanli
 * 创建时间：2026-11-03 12:06:09
 */
import { useSyncExternalStore } from 'react';
import { canPreview } from './formats';
export { canPreview } from './formats';

/** 三种显示方式不改变附件或正文内容。 */
export type PreviewMode = 'side' | 'inline' | 'window';
/** 附件来源及所属节点，供删除和离开页面时清理。 */
export interface PreviewSource {
  /** 附件存储标识。 */
  id: string;
  /** 原文件名用于格式路由。 */
  name: string;
  /** 正文节点提供的内嵌容器，白板可省略。 */
  host?: HTMLElement;
  /** 关闭后恢复焦点的入口。 */
  trigger?: HTMLElement;
}
/** 当前唯一活动预览。 */
export interface PreviewRequest extends PreviewSource {
  /** 当前布局模式。 */
  mode: PreviewMode;
}
/** 当前请求不持久化，避免保存过期 DOM 引用。 */
let request: PreviewRequest | null = null;
/** 默认侧边，用户切换后在本次运行内沿用。 */
let preferredMode: PreviewMode = 'side';
/** 外部订阅者在请求变化时更新界面。 */
const listeners = new Set<() => void>();
/** 获取稳定快照，便于节点和测试核对归属。 */
export function getPreview(): PreviewRequest | null {
  return request;
}
/** 发布新快照。 */
function publish(next: PreviewRequest | null): void {
  request = next;
  for (const listener of listeners) listener();
}
/** 打开附件；没有正文容器时不能使用内嵌模式。 */
export function openPreview(source: PreviewSource): void {
  if (!canPreview(source.name)) return;
  publish({ ...source, mode: preferredMode === 'inline' && !source.host ? 'side' : preferredMode });
}
/** 切换显示方式，保留当前附件身份。 */
export function setPreviewMode(mode: PreviewMode): void {
  if (!request || (mode === 'inline' && !request.host?.isConnected)) return;
  preferredMode = mode;
  publish({ ...request, mode });
}
/** 关闭时可指定所属容器，避免旧节点关闭新文件。 */
export function closePreview(host?: HTMLElement): void {
  if (host && request?.host !== host) return;
  /** 焦点来源先保存，再释放请求持有的节点。 */
  const trigger = request?.trigger;
  publish(null);
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
}
/** React 使用统一订阅，正文节点无需创建独立根节点。 */
export function usePreview(): PreviewRequest | null {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, getPreview);
}
