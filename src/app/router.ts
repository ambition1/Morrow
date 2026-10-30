import { useMemo, useSyncExternalStore } from 'react';
import type { PageId } from '../core/model';
import {
  activeHash,
  getNavigation,
  showInMain,
  showInSide,
  subscribeNavigation,
  targetPane,
} from './navigation';
import type { PaneId } from './navigation';

export type Route =
  | { name: 'home' }
  // anchor is a heading or ^block id to scroll to once the page opens
  | { name: 'page'; id: PageId; find: string | null; anchor?: string | null }
  | { name: 'tasks' }
  | { name: 'trash' }
  | { name: 'tags' }
  | { name: 'tag'; tag: string }
  | { name: 'graph'; focus: PageId | null }
  | { name: 'search'; query: string };

export function parseRoute(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'page' && parts[1]) {
    const params = new URLSearchParams(query);
    const find = params.get('find');
    const anchor = params.get('anchor');
    return { name: 'page', id: decodeURIComponent(parts[1]), find: find || null, anchor: anchor || null };
  }
  if (parts[0] === 'tasks') return { name: 'tasks' };
  if (parts[0] === 'trash') return { name: 'trash' };
  if (parts[0] === 'tags' && parts[1])
    return { name: 'tag', tag: decodeURIComponent(parts.slice(1).join('/')) };
  if (parts[0] === 'tags') return { name: 'tags' };
  if (parts[0] === 'search') return { name: 'search', query: new URLSearchParams(query).get('q') ?? '' };
  if (parts[0] === 'graph') return { name: 'graph', focus: parts[1] ? decodeURIComponent(parts[1]) : null };
  return { name: 'home' };
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case 'page': {
      const params = new URLSearchParams();
      if (route.find) params.set('find', route.find);
      if (route.anchor) params.set('anchor', route.anchor);
      const query = params.toString();
      return `#/page/${encodeURIComponent(route.id)}${query ? `?${query}` : ''}`;
    }
    case 'tasks':
      return '#/tasks';
    case 'trash':
      return '#/trash';
    case 'tags':
      return '#/tags';
    case 'tag':
      return `#/tags/${route.tag.split('/').map(encodeURIComponent).join('/')}`;
    case 'search':
      return route.query ? `#/search?q=${encodeURIComponent(route.query)}` : '#/search';
    case 'graph':
      return route.focus ? `#/graph/${encodeURIComponent(route.focus)}` : '#/graph';
    default:
      return '#/';
  }
}

// 导航到最后使用的区域，或显式指定的区域。
export function navigate(route: Route, options: { replace?: boolean; pane?: PaneId } = {}): void {
  const hash = routeHash(route);
  const pane = options.pane ?? targetPane();
  if (pane === 'side' && getNavigation().main.side) {
    showInSide(hash, options.replace);
    return;
  }
  showInMain(hash, options.replace);
}

export function openPage(id: PageId, find: string | null = null, anchor: string | null = null): void {
  navigate({ name: 'page', id, find, anchor });
}

let cachedHash = '';
let cachedRoute: Route = { name: 'home' };

function snapshot(): Route {
  const hash = window.location.hash;
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedRoute = parseRoute(hash);
  }
  return cachedRoute;
}

export function useRoute(): Route {
  return useSyncExternalStore((listener) => {
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, snapshot);
}

// 返回当前接收导航的区域位置。
export function useActiveRoute(): Route {
  const hash = useSyncExternalStore((listener) => {
    window.addEventListener('hashchange', listener);
    const stop = subscribeNavigation(listener);
    return () => {
      window.removeEventListener('hashchange', listener);
      stop();
    };
  }, activeHash);
  return useMemo(() => parseRoute(hash), [hash]);
}

export function activeRoute(): Route {
  return parseRoute(activeHash());
}
