import {
  BookOpen,
  CalendarDays,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  FileText,
  FileUp,
  FolderOpen,
  FolderPlus,
  Hash,
  Home,
  LayoutDashboard,
  LayoutTemplate,
  Lock,
  MoreHorizontal,
  Network,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  Sparkles,
  Star,
  Table2,
  Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { dateKey } from '../../core/daily';
import { groupJournalPages } from '../../core/journalGroups';
import { inlineDateCalendarDate } from '../../core/inlineDate';
import { displayTitle } from '../i18n/labels';
import type { PageId, PageMeta, WorkspaceState } from '../../core/model';
import { collectTasks } from '../../core/tasks';
import {
  ancestorsOf,
  childrenOf,
  effectiveParent,
  isDescendantOf,
  livePages,
  trashedPages,
} from '../../core/tree';
import { collectTags } from '../../core/tags';
import { formatShortcut, runAction } from '../actions';
import { dateLocale, t, useTranslation } from '../i18n';
import { desktop } from '../platform/desktop';
import { vaultName } from '../platform/vault';
import { chooseVaultFolder, createVault, switchVault } from '../vaults';
import { getSession } from '../workspace';
import { createPage, expandPage, importMarkdown, movePage, openToday, trashPage } from '../operations';
import { getPreferences, setPreferences, usePreferences } from '../platform/preferences';
import { navigate, openPage, useActiveRoute } from '../router';
import { openDialog, setUi, useUi } from '../ui';
import { run, useWorkspace } from '../workspace';
import { Menu } from './Menu';
import { pageMenuEntries } from './pageMenu';
import { Emoji } from './Emoji';
import { Logo } from './primitives';
import { PAGE_DRAG_TYPE } from '../editor/PageLink';

type DropZone = 'before' | 'inside' | 'after';

export function pageIcon(page: PageMeta): LucideIcon {
  if (page.kind === 'journal') return BookOpen;
  if (page.kind === 'database') return Table2;
  if (page.kind === 'canvas') return LayoutDashboard;
  if (page.kind === 'templates') return LayoutTemplate;
  if (page.dailyDate) return CalendarDays;
  return FileText;
}

export function PageIcon({ page }: { page: PageMeta }) {
  if (page.encrypted) return <Lock size={15} strokeWidth={1.75} className="icon-kind-locked" />;
  if (page.icon) return <Emoji emoji={page.icon} />;
  // each kind of page has its own colour when colourful pages are on
  const kind = page.dailyDate ? 'daily' : page.kind;
  const props = { size: 15, strokeWidth: 1.75, className: `icon-kind-${kind}` };
  if (page.kind === 'journal') return <BookOpen {...props} />;
  if (page.kind === 'database') return <Table2 {...props} />;
  if (page.kind === 'canvas') return <LayoutDashboard {...props} />;
  if (page.kind === 'templates') return <LayoutTemplate {...props} />;
  if (page.dailyDate) return <CalendarDays {...props} />;
  return <FileText {...props} />;
}

// the four kinds of page a person can make from the sidebar or a page's menu
export function newPageEntries(parentId: PageId | null) {
  return [
    { label: t('sidebar.page'), icon: FileText, onSelect: () => createPage({ parentId }) },
    {
      label: t('sidebar.database'),
      icon: Table2,
      onSelect: () => createPage({ parentId, kind: 'database' }),
    },
    {
      label: t('sidebar.canvas'),
      icon: LayoutDashboard,
      onSelect: () => createPage({ parentId, kind: 'canvas' }),
    },
    {
      label: t('sidebar.fromTemplate'),
      icon: LayoutTemplate,
      onSelect: () => openDialog({ kind: 'template', parentId }),
    },
  ];
}

function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
  hint,
  count,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
  hint?: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      className={`nav-item${active ? ' is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <Icon size={16} strokeWidth={1.75} />
      <span className="nav-label">{label}</span>
      {count !== undefined && count > 0 && <span className="nav-count">{count}</span>}
      {hint && <kbd className="nav-hint">{hint}</kbd>}
    </button>
  );
}

export function Sidebar() {
  const { t } = useTranslation();
  const state = useWorkspace();
  const route = useActiveRoute();
  const prefs = usePreferences();
  const activeId = route.name === 'page' ? route.id : null;
  const live = useMemo(() => livePages(state.pages), [state.pages]);
  const favorites = useMemo(
    () => live.filter((page) => page.favorite).sort((a, b) => displayTitle(a).localeCompare(displayTitle(b))),
    [live],
  );
  const trashCount = useMemo(() => trashedPages(state.pages).length, [state.pages]);
  const openTasks = useMemo(() => collectTasks(state).filter((task) => !task.checked).length, [state]);
  const tagCount = useMemo(() => collectTags(state).length, [state]);
  const [newMenu, setNewMenu] = useState<HTMLElement | null>(null);
  const [vaultMenu, setVaultMenu] = useState<{
    anchor: HTMLElement;
    recent: Array<{ path: string; name: string; exists: boolean }>;
  } | null>(null);
  const location = getSession().location;
  const todayKey = dateKey(new Date());
  const isToday = activeId !== null && state.pages[activeId]?.dailyDate === todayKey;
  const resizing = useRef(false);

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    resizing.current = true;
    const startX = event.clientX;
    const startWidth = getPreferences().sidebarWidth;
    const onMove = (move: PointerEvent) => {
      setPreferences({ sidebarWidth: Math.min(420, Math.max(208, startWidth + move.clientX - startX)) });
    };
    const onUp = () => {
      resizing.current = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const go = (fn: () => void) => () => {
    fn();
    setUi({ mobileSidebar: false });
  };

  return (
    <aside
      className="sidebar"
      aria-label={t('sidebar.sidebar')}
      style={{ '--sidebar-width': `${prefs.sidebarWidth}px` } as React.CSSProperties}
    >
      <div className="sidebar-header">
        {location && desktop?.vault ? (
          <button
            type="button"
            className="brand"
            aria-label={t('sidebar.switchVaultAria', { name: vaultName(location) })}
            title={location}
            onClick={(event) => {
              const anchor = event.currentTarget;
              void desktop?.vault?.state().then((vaults) => setVaultMenu({ anchor, recent: vaults.recent }));
            }}
          >
            <Logo size={20} />
            <span className="brand-name">{vaultName(location)}</span>
            <ChevronDown size={13} className="brand-chevron" />
          </button>
        ) : (
          <button
            type="button"
            className="brand"
            onClick={go(() => navigate({ name: 'home' }))}
            aria-label={t('sidebar.morrowHome')}
          >
            <Logo size={20} />
            <span className="brand-name">Morrow</span>
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label={t('sidebar.collapseSidebar')}
          title={`${t('sidebar.collapseSidebar')} (${formatShortcut('Mod+\\')})`}
          onClick={() => runAction('view.sidebar')}
        >
          <PanelLeftClose size={16} strokeWidth={1.75} />
        </button>
      </div>

      <nav className="sidebar-nav" aria-label={t('sidebar.main')}>
        <NavItem
          icon={Search}
          label={t('common.search')}
          hint={formatShortcut('Mod+K')}
          onClick={() => setUi({ palette: true, mobileSidebar: false })}
        />
        <NavItem
          icon={CalendarDays}
          label={t('sidebar.today')}
          active={isToday}
          onClick={go(() => openToday())}
        />
        <NavItem
          icon={Home}
          label={t('settings.general.startPages.home')}
          active={route.name === 'home'}
          onClick={go(() => navigate({ name: 'home' }))}
        />
        <NavItem
          icon={CheckSquare}
          label={t('sidebar.tasks')}
          active={route.name === 'tasks'}
          count={openTasks}
          onClick={go(() => navigate({ name: 'tasks' }))}
        />
        <NavItem
          icon={Hash}
          label={t('sidebar.tags')}
          active={route.name === 'tags' || route.name === 'tag'}
          count={tagCount}
          onClick={go(() => navigate({ name: 'tags' }))}
        />
        <NavItem
          icon={Network}
          label={t('sidebar.graph')}
          active={route.name === 'graph'}
          onClick={go(() => navigate({ name: 'graph', focus: null }))}
        />
        {prefs.assistant && desktop?.assistant && (
          <NavItem
            icon={Sparkles}
            label={t('settings.sections.assistant')}
            active={prefs.assistantOpen}
            onClick={() => setPreferences({ assistantOpen: !prefs.assistantOpen })}
          />
        )}
      </nav>

      <div className="sidebar-scroll">
        {favorites.length > 0 && (
          <section className="sidebar-section" aria-label={t('sidebar.favorites')}>
            <h2 className="sidebar-heading">{t('sidebar.favorites')}</h2>
            <ul className="flat-list">
              {favorites.map((page) => {
                return (
                  <li key={page.id}>
                    <button
                      type="button"
                      className={`tree-row flat${activeId === page.id ? ' is-active' : ''}`}
                      onClick={go(() => openPage(page.id))}
                    >
                      <span className="tree-icon">
                        <PageIcon page={page} />
                      </span>
                      <span className="tree-title">{displayTitle(page)}</span>
                      <Star size={12} className="favorite-mark" aria-label={t('sidebar.favorites')} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="sidebar-section" aria-label={t('sidebar.pagesHeading')}>
          <div className="sidebar-heading-row">
            <h2 className="sidebar-heading">{t('sidebar.pagesHeading')}</h2>
            <button
              type="button"
              className="icon-button small"
              aria-label={t('sidebar.newPageAria')}
              aria-haspopup="menu"
              title={t('sidebar.newPageTitle', { shortcut: formatShortcut('Alt+N') })}
              onClick={(event) => setNewMenu(event.currentTarget)}
            >
              <Plus size={15} strokeWidth={1.75} />
            </button>
          </div>
          {live.length === 0 ? (
            <div className="sidebar-empty">
              <p>{t('sidebar.noPages')}</p>
              <button type="button" className="link-button" onClick={() => createPage()}>
                {t('sidebar.createFirstPage')}
              </button>
            </div>
          ) : (
            <PageTree state={state} activeId={activeId} expanded={prefs.expanded} />
          )}
        </section>
      </div>

      <div className="sidebar-footer">
        <NavItem icon={FileUp} label={t('sidebar.import')} onClick={() => void importMarkdown()} />
        <NavItem
          icon={Trash2}
          label={t('sidebar.trash')}
          active={route.name === 'trash'}
          count={trashCount}
          onClick={go(() => navigate({ name: 'trash' }))}
        />
        <NavItem
          icon={Settings}
          label={t('settings.title')}
          onClick={() => openDialog({ kind: 'settings' })}
        />
      </div>
      {newMenu && (
        <Menu
          anchor={newMenu}
          label={t('common.add')}
          entries={newPageEntries(null)}
          onClose={() => setNewMenu(null)}
        />
      )}
      {vaultMenu && (
        <Menu
          anchor={vaultMenu.anchor}
          label={t('sidebar.vaultsMenu')}
          onClose={() => setVaultMenu(null)}
          entries={[
            { heading: t('sidebar.vaultsHeading') },
            ...vaultMenu.recent
              .filter((item) => item.exists)
              .map((item) => ({
                label: item.name,
                checked: item.path === location,
                onSelect: () => {
                  if (item.path !== location) void switchVault(item.path);
                },
              })),
            { separator: true },
            {
              label: t('sidebar.openAnotherFolder'),
              icon: FolderOpen,
              onSelect: () => void chooseVaultFolder(),
            },
            { label: t('sidebar.createNewVault'), icon: FolderPlus, onSelect: () => void createVault() },
            {
              label: t('sidebar.showVaultFolder'),
              icon: FolderOpen,
              onSelect: () => void desktop?.vault?.reveal(''),
            },
            { separator: true },
            {
              label: t('settings.general.startPages.home'),
              icon: Home,
              onSelect: () => navigate({ name: 'home' }),
            },
          ]}
        />
      )}
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('sidebar.resizeSidebar')}
        onPointerDown={startResize}
      />
    </aside>
  );
}

interface TreeProps {
  state: WorkspaceState;
  activeId: PageId | null;
  expanded: string[];
}

const SUBPAGES_SHOWN = 50;

function PageTree({ state, activeId, expanded }: TreeProps) {
  const ui = useUi();
  const [drop, setDrop] = useState<{ id: PageId; zone: DropZone } | null>(null);
  const [menu, setMenu] = useState<{ id: PageId; anchor: HTMLElement } | null>(null);
  /** 当前活动页面下用户主动折叠的虚拟分组；切换页面后重新揭示活动路径。 */
  const [closedGroups, setClosedGroups] = useState<{ active: PageId | null; keys: string[] }>({
    active: activeId,
    keys: [],
  });
  // 活动页变化时丢弃上一次的临时折叠，返回旧笔记也必须重新揭示其路径。
  if (closedGroups.active !== activeId) setClosedGroups({ active: activeId, keys: [] });
  const dragging = useRef<PageId | null>(null);
  const treeRef = useRef<HTMLUListElement>(null);
  // how many subpages each folder shows, a journal of years opens with its latest days and the rest on request
  const [limits, setLimits] = useState<Record<string, number>>({});

  // 打开历史日期后将选中项滚入目录可视区，不改变正文滚动位置。
  useEffect(() => {
    treeRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  const ancestorIds = useMemo(
    () => new Set(activeId ? ancestorsOf(state.pages, activeId).map((page) => page.id) : []),
    [activeId, state.pages],
  );
  const expandedSet = useMemo(() => {
    const set = new Set(expanded);
    // the open page is always revealed
    if (activeId) for (const ancestor of ancestorsOf(state.pages, activeId)) set.add(ancestor.id);
    return set;
  }, [expanded, activeId, state.pages]);

  const toggle = (id: PageId) => {
    const current = getPreferences().expanded;
    if (expandedSet.has(id)) {
      setPreferences({ expanded: current.filter((item) => item !== id) });
      if (activeId && ancestorsOf(state.pages, activeId).some((page) => page.id === id)) openPage(id);
    } else setPreferences({ expanded: [...current, id] });
  };

  const onDrop = (target: PageMeta, zone: DropZone) => {
    const id = dragging.current;
    dragging.current = null;
    setDrop(null);
    if (!id || id === target.id) return;
    if (zone === 'inside') {
      if (movePage(id, target.id)) expandPage(target.id);
      return;
    }
    const parentId = effectiveParent(state.pages, target);
    const siblings = childrenOf(state.pages, parentId).filter((page) => page.id !== id);
    const index = siblings.findIndex((page) => page.id === target.id) + (zone === 'after' ? 1 : 0);
    movePage(id, parentId, index);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const rows = Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []);
    const current = document.activeElement as HTMLElement | null;
    const index = rows.indexOf(current as HTMLElement);
    if (index === -1) return;
    /** 年月是虚拟树节点，仅支持展开与键盘导航，不执行页面删除或重命名。 */
    const groupId = current?.dataset.groupId;
    if (groupId) {
      const open = current!.getAttribute('aria-expanded') === 'true';
      const toggleGroup = () => current!.click();
      const parentKey = current!.dataset.treeParent;
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          rows[index + 1]?.focus();
          break;
        case 'ArrowUp':
          event.preventDefault();
          rows[index - 1]?.focus();
          break;
        case 'ArrowRight':
          event.preventDefault();
          if (!open) toggleGroup();
          else rows[index + 1]?.focus();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          if (open) toggleGroup();
          else
            rows
              .find((row) => row.dataset.groupId === parentKey || row.dataset.pageId === parentKey)
              ?.focus();
          break;
        case 'Enter':
        case ' ':
          event.preventDefault();
          toggleGroup();
          break;
        case 'Home':
          event.preventDefault();
          rows[0]?.focus();
          break;
        case 'End':
          event.preventDefault();
          rows[rows.length - 1]?.focus();
          break;
      }
      return;
    }
    const id = current!.dataset.pageId!;
    const page = state.pages[id];
    if (!page) return;
    const hasChildren = childrenOf(state.pages, id).length > 0;
    const focus = (row: HTMLElement | undefined) => row?.focus();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focus(rows[index + 1]);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focus(rows[index - 1]);
        break;
      case 'ArrowRight':
        event.preventDefault();
        if (hasChildren && !expandedSet.has(id)) toggle(id);
        else if (hasChildren) focus(rows[index + 1]);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (hasChildren && expandedSet.has(id)) toggle(id);
        else if (current?.dataset.treeParent)
          focus(rows.find((row) => row.dataset.groupId === current.dataset.treeParent));
        else if (page.parentId) focus(rows.find((row) => row.dataset.pageId === page.parentId));
        break;
      case 'Enter':
        event.preventDefault();
        openPage(id);
        setUi({ mobileSidebar: false });
        break;
      case 'F2':
        event.preventDefault();
        setUi({ renaming: id });
        break;
      case 'Delete':
        event.preventDefault();
        trashPage(id);
        break;
      case 'ContextMenu':
        event.preventDefault();
        setMenu({ id, anchor: current! });
        break;
      case 'F10':
        if (!event.shiftKey) break;
        event.preventDefault();
        setMenu({ id, anchor: current! });
        break;
    }
  };

  const renderLevel = (
    parentId: PageId | null,
    depth: number,
    supplied?: PageMeta[],
    treeParent?: string,
  ): React.ReactNode => {
    const all = supplied ?? childrenOf(state.pages, parentId);
    if (all.length === 0) return null;
    if (!supplied && parentId && state.pages[parentId]?.kind === 'journal') {
      /** 按真实日期分组，不修改parentId、order或页面路径。 */
      const grouped = groupJournalPages(all);
      /** 活动页也可能是每日笔记下面的普通子页面。 */
      const activePath = new Set(
        activeId ? [activeId, ...ancestorsOf(state.pages, activeId).map((page) => page.id)] : [],
      );
      /** 有活动日期时仅默认揭示对应年月，否则展开最新年月。 */
      const activeMonth = grouped.years
        .flatMap((year) => year.months)
        .find((month) => month.pages.some((page) => activePath.has(page.id)));
      /** 没有活动日期时默认展开最新月份。 */
      const defaultMonth = activeMonth ?? grouped.years[0]?.months[0];
      /** 虚拟节点的键与真实页面ID分离，展开偏好仍使用已有设置。 */
      const keyOf = (key: string) => `journal:${parentId}:${key}`;
      /** 分组没有页面菜单、拖放或重命名操作。 */
      const groupRow = (
        key: string,
        label: string,
        count: number,
        level: number,
        parent: string,
        children: () => React.ReactNode,
      ) => {
        /** 页面ID以外的稳定分组键。 */
        const id = keyOf(key);
        /** 最新或活动日期所属月份作为默认展开范围。 */
        const autoOpen = defaultMonth?.key.startsWith(key) ?? false;
        /** 当前活动页下的明确折叠操作优先于自动揭示。 */
        const manuallyClosed = closedGroups.active === activeId && closedGroups.keys.includes(id);
        /** 合并持久化偏好和当前活动路径。 */
        const open =
          !manuallyClosed &&
          (activeMonth?.key.startsWith(key) ||
            (!expandedSet.has(`${id}:closed`) && (expandedSet.has(id) || autoOpen)));
        /** 展开和折叠只更新界面偏好。 */
        const toggleGroup = () => {
          /** 同一分组只保留一种偏好标记。 */
          const saved = getPreferences().expanded.filter((item) => item !== id && item !== `${id}:closed`);
          setPreferences({ expanded: [...saved, open ? `${id}:closed` : id] });
          setClosedGroups((previous) => ({
            active: activeId,
            keys: open
              ? [...(previous.active === activeId ? previous.keys : []), id]
              : (previous.active === activeId ? previous.keys : []).filter((item) => item !== id),
          }));
        };
        return (
          <li key={id} role="none">
            <div
              role="treeitem"
              aria-label={label}
              aria-level={level + 1}
              aria-expanded={!!open}
              tabIndex={manuallyClosed && activeMonth?.key.startsWith(key) ? 0 : -1}
              data-group-id={id}
              data-tree-parent={parent}
              className="tree-row journal-group-row"
              style={{ '--depth': level } as React.CSSProperties}
              onClick={toggleGroup}
            >
              <span className="tree-toggle" aria-hidden="true">
                <ChevronRight size={14} strokeWidth={2} className={open ? 'is-open' : ''} />
              </span>
              <span className="tree-icon">
                <CalendarDays size={15} strokeWidth={1.75} />
              </span>
              <span className="tree-title">{label}</span>
              <span className="nav-count" aria-hidden="true">
                {count}
              </span>
            </div>
            {open && (
              <ul role="group" className="tree-group">
                {children()}
              </ul>
            )}
          </li>
        );
      };
      return (
        <>
          {grouped.years.map((year) =>
            groupRow(
              year.key,
              inlineDateCalendarDate(`${year.key}-01-01`)!.toLocaleDateString(dateLocale(), {
                year: 'numeric',
                timeZone: 'UTC',
              }),
              year.count,
              depth,
              parentId,
              () =>
                year.months.map((month) =>
                  groupRow(
                    month.key,
                    inlineDateCalendarDate(`${month.key}-01`)!.toLocaleDateString(dateLocale(), {
                      month: 'long',
                      timeZone: 'UTC',
                    }),
                    month.pages.length,
                    depth + 1,
                    keyOf(year.key),
                    () => renderLevel(parentId, depth + 2, month.pages, keyOf(month.key)),
                  ),
                ),
            ),
          )}
          {renderLevel(parentId, depth, grouped.other)}
        </>
      );
    }
    const key = parentId ?? '';
    let limit = limits[key] ?? SUBPAGES_SHOWN;
    // the open page and the folders on its way always show
    const needed = all.findIndex(
      (page) => page.id === activeId || (expandedSet.has(page.id) && ancestorIds.has(page.id)),
    );
    if (needed >= limit) limit = needed + 1;
    const children = all.length > limit ? all.slice(0, limit) : all;
    const rest = all.length - children.length;
    const rows = children.map((page) => {
      const hasChildren = childrenOf(state.pages, page.id).length > 0;
      const isOpen = expandedSet.has(page.id);
      return (
        <li key={page.id} role="none">
          <TreeRow
            page={page}
            treeParent={treeParent}
            depth={depth}
            hasChildren={hasChildren}
            isOpen={isOpen}
            active={page.id === activeId}
            tabbable={
              activeId ? page.id === activeId : depth === 0 && page === children[0] && parentId === null
            }
            renaming={ui.renaming === page.id}
            dropZone={drop?.id === page.id ? drop.zone : null}
            menuOpen={menu?.id === page.id}
            onToggle={toggle}
            onMenu={(anchor) => setMenu({ id: page.id, anchor })}
            onDragStart={() => (dragging.current = page.id)}
            onDragOverZone={(zone) => {
              const id = dragging.current;
              if (!id || id === page.id || isDescendantOf(state.pages, page.id, id)) {
                setDrop(null);
                return false;
              }
              if (drop?.id !== page.id || drop.zone !== zone) setDrop({ id: page.id, zone });
              return true;
            }}
            onDragLeave={() => setDrop((current) => (current?.id === page.id ? null : current))}
            onDrop={(zone) => onDrop(page, zone)}
          />
          {hasChildren && isOpen && (
            <ul role="group" className="tree-group">
              {renderLevel(page.id, depth + 1)}
            </ul>
          )}
        </li>
      );
    });
    if (rest > 0)
      rows.push(
        <li key="more" role="none">
          <button
            type="button"
            className="tree-row tree-more"
            style={{ '--depth': depth } as React.CSSProperties}
            onClick={() => setLimits((current) => ({ ...current, [key]: limit + SUBPAGES_SHOWN * 4 }))}
          >
            {t('common.showMore', { count: Math.min(rest, SUBPAGES_SHOWN * 4) })}
          </button>
        </li>,
      );
    return rows;
  };

  return (
    <>
      <ul
        className="page-tree"
        role="tree"
        aria-label={t('sidebar.pagesHeading')}
        ref={treeRef}
        onKeyDown={onKeyDown}
        onDragEnd={() => setDrop(null)}
      >
        {renderLevel(null, 0)}
      </ul>
      {menu && (
        <Menu
          anchor={menu.anchor}
          label={t('pageMenu.pageOptions')}
          entries={pageMenuEntries(menu.id, () => setUi({ renaming: menu.id }))}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

/** 默认日期标题在年月层级内只显示日和星期，用户自定义标题保持原样。 */
function compactDailyTitle(page: PageMeta): string {
  /** 只格式化经过校验的真实日期。 */
  const date = page.dailyDate ? inlineDateCalendarDate(page.dailyDate) : null;
  if (!date) return displayTitle(page);
  /** 识别既有语言生成的默认标题，避免缩短用户自定义名称。 */
  const defaultNames = [undefined, 'zh-CN', 'en-US', 'en-GB', 'es', 'pt'].map((locale) =>
    date.toLocaleDateString(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
      timeZone: 'UTC',
    }),
  );
  return page.title === page.dailyDate || defaultNames.includes(page.title)
    ? `${date.toLocaleDateString(dateLocale(), { day: 'numeric', timeZone: 'UTC' })} ${date.toLocaleDateString(dateLocale(), { weekday: 'short', timeZone: 'UTC' })}`
    : displayTitle(page);
}

interface RowProps {
  /** 日期叶子节点的虚拟月份父级，仅用于键盘返回。 */
  treeParent?: string;
  page: PageMeta;
  depth: number;
  hasChildren: boolean;
  isOpen: boolean;
  active: boolean;
  tabbable: boolean;
  renaming: boolean;
  dropZone: DropZone | null;
  menuOpen: boolean;
  onToggle: (id: PageId) => void;
  onMenu: (anchor: HTMLElement) => void;
  onDragStart: () => void;
  onDragOverZone: (zone: DropZone) => boolean;
  onDragLeave: () => void;
  onDrop: (zone: DropZone) => void;
}

const TreeRow = memo(function TreeRow(props: RowProps) {
  const { page, depth, hasChildren, isOpen, active, tabbable, renaming, dropZone, menuOpen } = props;

  const zoneFor = (event: React.DragEvent): DropZone => {
    const rect = event.currentTarget.getBoundingClientRect();
    const y = (event.clientY - rect.top) / rect.height;
    return y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside';
  };

  return (
    <div
      role="treeitem"
      aria-label={displayTitle(page)}
      tabIndex={tabbable ? 0 : -1}
      aria-level={depth + 1}
      aria-selected={active}
      aria-expanded={hasChildren ? isOpen : undefined}
      data-page-id={page.id}
      data-tree-parent={props.treeParent}
      className={`tree-row${active ? ' is-active' : ''}${menuOpen ? ' is-menu-open' : ''}${dropZone ? ` drop-${dropZone}` : ''}`}
      style={{ '--depth': depth } as React.CSSProperties}
      draggable={!renaming}
      onClick={() => {
        if (renaming) return;
        openPage(page.id);
        setUi({ mobileSidebar: false });
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        setUi({ renaming: page.id });
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onMenu(event.currentTarget as HTMLElement);
      }}
      onDragStart={(event) => {
        event.dataTransfer.setData(PAGE_DRAG_TYPE, page.id);
        event.dataTransfer.setData('text/plain', displayTitle(page));
        event.dataTransfer.effectAllowed = 'move';
        props.onDragStart();
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(PAGE_DRAG_TYPE)) return;
        if (props.onDragOverZone(zoneFor(event))) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }
      }}
      onDragLeave={props.onDragLeave}
      onDrop={(event) => {
        event.preventDefault();
        props.onDrop(zoneFor(event));
      }}
    >
      <button
        type="button"
        tabIndex={-1}
        className={`tree-toggle${hasChildren ? '' : ' is-empty'}`}
        aria-label={isOpen ? t('common.collapse') : t('common.expand')}
        onClick={(event) => {
          event.stopPropagation();
          if (hasChildren) props.onToggle(page.id);
        }}
      >
        <ChevronRight size={14} strokeWidth={2} className={isOpen ? 'is-open' : ''} />
      </button>
      <span className="tree-icon">
        <PageIcon page={page} />
      </span>
      {renaming ? (
        <RenameInput page={page} />
      ) : (
        <span className="tree-title" title={displayTitle(page)}>
          {props.treeParent ? compactDailyTitle(page) : displayTitle(page)}
        </span>
      )}
      {!renaming && (
        <span className="tree-actions">
          <button
            type="button"
            tabIndex={-1}
            className="icon-button tiny"
            aria-label={t('sidebar.pageOptions', { title: displayTitle(page) })}
            title={t('sidebar.pageOptions', { title: displayTitle(page) })}
            onClick={(event) => {
              event.stopPropagation();
              props.onMenu(event.currentTarget);
            }}
          >
            <MoreHorizontal size={14} />
          </button>
          <button
            type="button"
            tabIndex={-1}
            className="icon-button tiny"
            aria-label={t('sidebar.addSubpageTo', { title: displayTitle(page) })}
            title={t('sidebar.addSubpageTo', { title: displayTitle(page) })}
            onClick={(event) => {
              event.stopPropagation();
              createPage({ parentId: page.id });
            }}
          >
            <Plus size={14} />
          </button>
        </span>
      )}
    </div>
  );
});

function RenameInput({ page }: { page: PageMeta }) {
  const [value, setValue] = useState(page.title);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && value !== page.title)
      run({ type: 'page.rename', id: page.id, title: value, now: Date.now() });
    setUi({ renaming: null });
    document.querySelector<HTMLElement>(`[role="treeitem"][data-page-id="${page.id}"]`)?.focus();
  };
  return (
    <input
      className="tree-rename"
      aria-label={t('page.titleAria')}
      value={value}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') finish(true);
        if (event.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}
