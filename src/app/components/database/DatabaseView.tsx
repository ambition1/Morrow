import {
  ArrowDownUp,
  Type,
  Hash,
  CheckSquare,
  Link2,
  ListFilter,
  CircleDot,
  FunctionSquare,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Eye,
  EyeOff,
  Filter,
  GalleryVerticalEnd,
  LayoutList,
  Maximize2,
  Ellipsis,
  FileText,
  Plus,
  Settings2,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { dateKey } from '../../../core/daily';
import {
  filterOpsFor,
  groupRows,
  valueForGroup,
  propType,
  rowsOf,
  TITLE_PROP,
  BODY_COLUMN,
  VIEW_LABELS,
  visibleRows,
  newView,
  valueOf,
} from '../../../core/database';
import { VIEW_TYPES } from '../../../core/model';
import { displayTitle } from '../../i18n/labels';
import { unclaimedKeys } from '../../../core/properties';
import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from '../../../core/migrations';
import type {
  DocNode,
  DatabaseDef,
  FilterOp,
  PageId,
  PageMeta,
  PropDef,
  PropValue,
  ViewDef,
  ViewType,
} from '../../../core/model';
import { fileUrl } from '../../platform/attachments';
import { newId } from '../../platform/files';
import { openPage } from '../../router';
import { trashPage } from '../../operations';
import { DateInput } from '../CalendarDatePicker';
import { BodyCell } from './BodyCell';
import { run, useWorkspace } from '../../workspace';
import { Menu } from '../Menu';
import { Select } from '../Select';
import { optionColorAppearance } from '../optionColors';
import { Popover } from '../Popover';
import { Emoji } from '../Emoji';
import { PageIcon } from '../Sidebar';
import { addColumnsFromPages, createRow, setValue, updateDatabase, updateView } from './data';
import { Chip, DraftInput, NewProperty, PropertyDisplay, PropertyInput } from './PropertyValue';
import { PropertySettings } from './PropertySettings';
import { dateLocale, t, tp } from '../../i18n';
import { filterLabel, propLabel, viewLabel, viewName } from '../../i18n/labels';

const VIEW_ICONS: Record<ViewType, LucideIcon> = {
  table: Table2,
  board: Columns3,
  calendar: Calendar,
  list: LayoutList,
  gallery: GalleryVerticalEnd,
};

const viewKey = (id: PageId) => `morrow.view.${id}`;

function readViewChoice(id: PageId): string | null {
  try {
    return localStorage.getItem(viewKey(id));
  } catch {
    return null;
  }
}

export function DatabaseView({ page, editable }: { page: PageMeta; editable: boolean }) {
  const state = useWorkspace();
  const database = useMemo(() => page.database ?? { properties: [], views: [] }, [page.database]);
  const [viewId, setViewId] = useState<string | null>(() => readViewChoice(page.id));
  const view = database.views.find((candidate) => candidate.id === viewId) ?? database.views[0] ?? null;
  const allRows = useMemo(() => rowsOf(state, page.id), [state, page.id]);
  const rows = useMemo(
    () => (view ? visibleRows(allRows, view, database) : allRows),
    [allRows, view, database],
  );
  const [tabMenu, setTabMenu] = useState<{ view: ViewDef; anchor: HTMLElement } | null>(null);
  const [addMenu, setAddMenu] = useState<HTMLElement | null>(null);

  const choose = (id: string) => {
    setViewId(id);
    try {
      localStorage.setItem(viewKey(page.id), id);
    } catch {
      // the choice is only remembered for convenience
    }
  };

  // a database always has at least one view
  useEffect(() => {
    if (editable && database.views.length === 0)
      updateDatabase(page.id, (current) => ({ ...current, views: [newView('table', current, newId)] }));
  }, [editable, database.views.length, page.id]);

  if (!view) return null;
  const visible = database.properties.filter((prop) => !view.hidden.includes(prop.id));

  return (
    <section className="database database-v2" aria-label={t('sidebar.database')}>
      <div className="db-bar">
        <div className="db-tabs" role="tablist" aria-label={t('database.views')}>
          {database.views.map((candidate) => {
            const Icon = VIEW_ICONS[candidate.type];
            return (
              <button
                key={candidate.id}
                type="button"
                role="tab"
                aria-selected={candidate.id === view.id}
                className={`db-tab${candidate.id === view.id ? ' is-active' : ''}`}
                onClick={() => choose(candidate.id)}
                onContextMenu={(event) => {
                  if (!editable) return;
                  event.preventDefault();
                  setTabMenu({ view: candidate, anchor: event.currentTarget });
                }}
                onDoubleClick={(event) =>
                  editable && setTabMenu({ view: candidate, anchor: event.currentTarget })
                }
              >
                <Icon size={14} /> {viewName(candidate)}
              </button>
            );
          })}
          {editable && (
            <button
              type="button"
              className="icon-button small"
              aria-label={t('database.addAView')}
              onClick={(event) => setAddMenu(event.currentTarget)}
            >
              <Plus size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="db-action-bar">
        <Toolbar dbId={page.id} database={database} view={view} rows={allRows} editable={editable} />
        {editable && (
          <button
            type="button"
            className="button primary db-create-record"
            onClick={() => newRowAndOpen(page.id, {})}
          >
            <Plus size={15} /> {t('database.newRecord')}
          </button>
        )}
      </div>
      {editable && <ColumnSuggestion dbId={page.id} database={database} rows={allRows} />}

      {view.type === 'table' && (
        <TableView
          dbId={page.id}
          database={database}
          view={view}
          rows={rows}
          props={visible}
          editable={editable}
        />
      )}
      {view.type === 'board' && (
        <BoardView
          dbId={page.id}
          database={database}
          view={view}
          rows={rows}
          props={visible}
          editable={editable}
        />
      )}
      {view.type === 'calendar' && (
        <CalendarView dbId={page.id} database={database} view={view} rows={rows} editable={editable} />
      )}
      {view.type === 'list' && <ListView rows={rows} props={visible} database={database} />}
      {view.type === 'gallery' && <GalleryView rows={rows} props={visible} database={database} />}
      {view.type !== 'table' && editable && (
        <button type="button" className="db-new-row" onClick={() => newRowAndOpen(page.id, {})}>
          <Plus size={14} /> {t('database.new')}
        </button>
      )}
      <p className="db-count muted small">
        {rows.length === allRows.length
          ? tp('database.rows', rows.length)
          : t('database.rowsOf', { count: rows.length, total: allRows.length })}
      </p>

      {addMenu && (
        <Menu
          anchor={addMenu}
          label={t('database.addAView')}
          onClose={() => setAddMenu(null)}
          entries={VIEW_TYPES.map((type) => ({
            label: viewLabel(type),
            icon: VIEW_ICONS[type],
            onSelect: () => {
              const created = newView(type, database, newId);
              if (updateDatabase(page.id, (current) => ({ ...current, views: [...current.views, created] })))
                choose(created.id);
            },
          }))}
        />
      )}
      {tabMenu && (
        <ViewSettings
          dbId={page.id}
          database={database}
          view={tabMenu.view}
          anchor={tabMenu.anchor}
          onClose={() => setTabMenu(null)}
        />
      )}
    </section>
  );
}

function newRowAndOpen(dbId: PageId, values: Record<string, PropValue>): void {
  const id = createRow(dbId, values);
  if (id) openPage(id);
}

function ViewSettings({
  dbId,
  database,
  view,
  anchor,
  onClose,
}: {
  dbId: PageId;
  database: DatabaseDef;
  view: ViewDef;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  return (
    <Popover anchor={anchor} onClose={onClose} label={t('database.viewSettings')}>
      <label className="field">
        <span>{t('database.name')}</span>
        <DraftInput
          type="text"
          label={t('database.viewName')}
          className="text-input small"
          value={view.name}
          editable
          onCommit={(name) =>
            updateView(dbId, view.id, (current) => ({
              ...current,
              name: name.trim() || VIEW_LABELS[current.type],
            }))
          }
        />
      </label>
      <div className="field">
        <span>{t('slash.sections.layout')}</span>
        <Select<ViewType>
          label={t('slash.sections.layout')}
          value={view.type}
          options={VIEW_TYPES.map((type) => ({ value: type, label: viewLabel(type) }))}
          onChange={(value) =>
            updateView(dbId, view.id, (current) => {
              const type = value;
              const fresh = newView(type, database, () => current.id);
              return {
                ...current,
                type,
                groupBy: current.groupBy ?? fresh.groupBy,
                dateProp: current.dateProp ?? fresh.dateProp,
              };
            })
          }
        />
      </div>
      <div className="popover-actions">
        <button
          type="button"
          className="button small"
          onClick={() => {
            updateDatabase(dbId, (current) => ({
              ...current,
              views: [...current.views, { ...view, id: newId(), name: `${view.name} copy` }],
            }));
            onClose();
          }}
        >
          {t('pageMenu.duplicate')}
        </button>
        <button
          type="button"
          className="button small danger"
          disabled={database.views.length <= 1}
          onClick={() => {
            updateDatabase(dbId, (current) => ({
              ...current,
              views: current.views.filter((candidate) => candidate.id !== view.id),
            }));
            onClose();
          }}
        >
          <Trash2 size={13} /> {t('database.deleteView')}
        </button>
      </div>
    </Popover>
  );
}

type ToolPanel = 'filter' | 'sort' | 'properties' | 'layout';

// the frontmatter keys rows already have but no column shows yet, such as the properties of notes that
// came from obsidian, offered once until they are added or dismissed
function ColumnSuggestion({
  dbId,
  database,
  rows,
}: {
  dbId: PageId;
  database: DatabaseDef;
  rows: PageMeta[];
}) {
  const keys = useMemo(() => unclaimedKeys(database, rows), [database, rows]);
  const storageKey = `morrow.columns-dismissed.${dbId}`;
  const [dismissed, setDismissed] = useState<string>(() => {
    try {
      return localStorage.getItem(storageKey) ?? '';
    } catch {
      return '';
    }
  });
  const signature = keys.join('\n');
  if (keys.length === 0 || dismissed === signature) return null;
  const names = keys.slice(0, 4).join(', ');
  const shown = keys.length > 4 ? t('database.andMore', { names, count: keys.length - 4 }) : names;
  return (
    <div className="db-suggest" role="note">
      <Columns3 size={14} />
      <span>{tp('database.suggestColumns', keys.length, { names: shown })}</span>
      <button type="button" className="button small" onClick={() => addColumnsFromPages(dbId, keys)}>
        {t('database.addAsColumns')}
      </button>
      <button
        type="button"
        className="icon-button tiny"
        aria-label={t('common.dismiss')}
        onClick={() => {
          setDismissed(signature);
          try {
            localStorage.setItem(storageKey, signature);
          } catch {
            // only a convenience
          }
        }}
      >
        <X size={13} />
      </button>
    </div>
  );
}

function Toolbar({
  dbId,
  database,
  view,
  rows,
  editable,
}: {
  dbId: PageId;
  database: DatabaseDef;
  view: ViewDef;
  rows: PageMeta[];
  editable: boolean;
}) {
  const unclaimed = useMemo(() => unclaimedKeys(database, rows), [database, rows]);
  const [panel, setPanel] = useState<{ kind: ToolPanel; anchor: HTMLElement } | null>(null);
  const open = (kind: ToolPanel) => (event: React.MouseEvent<HTMLElement>) =>
    setPanel({ kind, anchor: event.currentTarget });
  const names = [{ id: TITLE_PROP, name: t('database.name'), type: 'text' as const }, ...database.properties];
  return (
    <div className="db-tools">
      <button
        type="button"
        className={`text-tool${view.filters.length ? ' is-active' : ''}`}
        onClick={open('filter')}
        disabled={!editable}
      >
        <Filter size={13} /> {t('database.filter')}
        {view.filters.length ? ` ${view.filters.length}` : ''}
      </button>
      <button
        type="button"
        className={`text-tool${view.sorts.length ? ' is-active' : ''}`}
        onClick={open('sort')}
        disabled={!editable}
      >
        <ArrowDownUp size={13} /> {t('database.sort')}
        {view.sorts.length ? ` ${view.sorts.length}` : ''}
      </button>
      {(view.type === 'table' || view.type === 'board' || view.type === 'calendar') && (
        <button type="button" className="text-tool" onClick={open('layout')} disabled={!editable}>
          <Settings2 size={13} /> {view.type !== 'calendar' ? t('database.group') : t('database.date')}
        </button>
      )}
      <button type="button" className="text-tool" onClick={open('properties')}>
        <Eye size={13} /> {t('database.properties')}
      </button>
      {panel?.kind === 'filter' && (
        <Popover
          anchor={panel.anchor}
          onClose={() => setPanel(null)}
          label={t('database.filters')}
          className="db-panel db-filter-panel"
        >
          {view.filters.length === 0 && <p className="muted small">{t('database.noFilters')}</p>}
          {view.filters.map((rule) => {
            const type = propType(database, rule.prop) ?? 'text';
            const prop = database.properties.find((candidate) => candidate.id === rule.prop);
            const ops = filterOpsFor(type === 'title' ? 'text' : type);
            const needsValue = !['empty', 'notEmpty', 'checked', 'unchecked'].includes(rule.op);
            const change = (patch: Partial<typeof rule>) =>
              updateView(dbId, view.id, (current) => ({
                ...current,
                filters: current.filters.map((item) => (item.id === rule.id ? { ...item, ...patch } : item)),
              }));
            return (
              <div key={rule.id} className="db-rule">
                <Select
                  label={t('database.property')}
                  value={rule.prop}
                  options={names.map((item) => ({ value: item.id, label: item.name }))}
                  onChange={(value) => {
                    const nextType = propType(database, value) ?? 'text';
                    change({
                      prop: value,
                      op: filterOpsFor(nextType === 'title' ? 'text' : nextType)[0]!,
                      value: null,
                    });
                  }}
                />
                <Select<FilterOp>
                  label={t('database.condition')}
                  value={rule.op}
                  options={ops.map((op) => ({ value: op, label: filterLabel(op) }))}
                  onChange={(value) => change({ op: value as FilterOp })}
                />
                {needsValue &&
                  (prop && (prop.type === 'select' || prop.type === 'multiSelect') ? (
                    <Select
                      label={t('database.value')}
                      value={String(rule.value ?? '')}
                      options={[
                        { value: '', label: t('database.choose') },
                        ...prop.options.map((option) => ({
                          value: option.id,
                          label: option.name,
                          color: option.color,
                        })),
                      ]}
                      onChange={(value) => change({ value: value || null })}
                    />
                  ) : type === 'date' ? (
                    <DateInput
                      label={t('database.value')}
                      value={typeof rule.value === 'string' ? rule.value : null}
                      onChange={(value) => change({ value })}
                    />
                  ) : (
                    <input
                      className="text-input small"
                      aria-label={t('database.value')}
                      type={prop?.type === 'number' ? 'number' : 'text'}
                      value={rule.value === null ? '' : String(rule.value)}
                      onChange={(event) =>
                        change({
                          value:
                            prop?.type === 'number' && event.target.value
                              ? Number(event.target.value)
                              : event.target.value,
                        })
                      }
                    />
                  ))}
                <button
                  type="button"
                  className="icon-button tiny"
                  aria-label={t('database.removeFilter')}
                  onClick={() =>
                    updateView(dbId, view.id, (current) => ({
                      ...current,
                      filters: current.filters.filter((item) => item.id !== rule.id),
                    }))
                  }
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="link-button"
            onClick={() =>
              updateView(dbId, view.id, (current) => ({
                ...current,
                filters: [...current.filters, { id: newId(), prop: TITLE_PROP, op: 'contains', value: '' }],
              }))
            }
          >
            <Plus size={13} /> {t('database.addAFilter')}
          </button>
        </Popover>
      )}
      {panel?.kind === 'sort' && (
        <Popover
          anchor={panel.anchor}
          onClose={() => setPanel(null)}
          label={t('database.sorting')}
          className="db-panel"
        >
          {view.sorts.length === 0 && <p className="muted small">{t('database.noSorts')}</p>}
          {view.sorts.map((sort, index) => (
            <div key={`${sort.prop}-${index}`} className="db-rule">
              <Select
                label={t('database.sortBy')}
                value={sort.prop}
                options={[
                  ...names,
                  { id: 'created', name: t('database.created') },
                  { id: 'updated', name: t('database.edited') },
                ].map((item) => ({ value: item.id, label: item.name }))}
                onChange={(value) =>
                  updateView(dbId, view.id, (current) => ({
                    ...current,
                    sorts: current.sorts.map((item, i) => (i === index ? { ...item, prop: value } : item)),
                  }))
                }
              />
              <Select<'asc' | 'desc'>
                label={t('database.direction')}
                value={sort.dir}
                options={[
                  { value: 'asc', label: t('database.ascending') },
                  { value: 'desc', label: t('database.descending') },
                ]}
                onChange={(value) =>
                  updateView(dbId, view.id, (current) => ({
                    ...current,
                    sorts: current.sorts.map((item, i) =>
                      i === index ? { ...item, dir: value === 'desc' ? 'desc' : 'asc' } : item,
                    ),
                  }))
                }
              />
              <button
                type="button"
                className="icon-button tiny"
                aria-label={t('database.removeSort')}
                onClick={() =>
                  updateView(dbId, view.id, (current) => ({
                    ...current,
                    sorts: current.sorts.filter((_item, i) => i !== index),
                  }))
                }
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="link-button"
            onClick={() =>
              updateView(dbId, view.id, (current) => ({
                ...current,
                sorts: [...current.sorts, { prop: TITLE_PROP, dir: 'asc' }],
              }))
            }
          >
            <Plus size={13} /> {t('database.addASort')}
          </button>
        </Popover>
      )}
      {panel?.kind === 'layout' && (
        <Popover
          anchor={panel.anchor}
          onClose={() => setPanel(null)}
          label={t('slash.sections.layout')}
          className="db-panel"
        >
          {/* 复用属性设置的选择组件，统一浮层、选中标记与键盘交互。 */}
          <div className="field">
            <span>{view.type !== 'calendar' ? t('database.group') : t('database.placeRowsBy')}</span>
            <Select
              label={view.type !== 'calendar' ? t('database.group') : t('database.placeRowsBy')}
              value={(view.type !== 'calendar' ? view.groupBy : view.dateProp) ?? ''}
              disabled={!editable}
              options={[
                { value: '', label: t('database.none') },
                ...database.properties
                  .filter((prop) =>
                    view.type !== 'calendar'
                      ? ['select', 'multiSelect', 'checkbox'].includes(prop.type)
                      : prop.type === 'date',
                  )
                  .map((prop) => ({ value: prop.id, label: prop.name })),
              ]}
              onChange={(value) =>
                updateView(dbId, view.id, (current) =>
                  current.type !== 'calendar'
                    ? { ...current, groupBy: value || null }
                    : { ...current, dateProp: value || null },
                )
              }
            />
          </div>
          {view.type === 'table' && (
            <div className="field">
              <span>{t('database.direction')}</span>
              <Select<'asc' | 'desc'>
                label={t('database.direction')}
                value={view.groupDirection ?? 'asc'}
                disabled={!editable}
                options={[
                  { value: 'asc', label: t('database.ascending') },
                  { value: 'desc', label: t('database.descending') },
                ]}
                onChange={(groupDirection) =>
                  updateView(dbId, view.id, (current) => ({ ...current, groupDirection }))
                }
              />
            </div>
          )}
        </Popover>
      )}
      {panel?.kind === 'properties' && (
        <Popover
          anchor={panel.anchor}
          onClose={() => setPanel(null)}
          label={t('database.properties')}
          className="db-panel"
        >
          <ul className="db-prop-list">
            {view.type === 'table' && (
              <li>
                <span className="db-prop-name">{t('database.bodyColumn')}</span>
                <button
                  type="button"
                  className="icon-button tiny"
                  aria-label={t(view.showBody ? 'database.hideProp' : 'database.showProp', {
                    name: t('database.bodyColumn'),
                  })}
                  disabled={!editable}
                  onClick={() =>
                    updateView(dbId, view.id, (current) => ({
                      ...current,
                      showBody: !current.showBody,
                    }))
                  }
                >
                  {view.showBody ? <Eye size={13} /> : <EyeOff size={13} />}
                </button>
              </li>
            )}
            {database.properties.map((prop) => {
              const hidden = view.hidden.includes(prop.id);
              return (
                <li key={prop.id}>
                  <span className="db-prop-name">{prop.name}</span>
                  <span className="muted small">{propLabel(prop.type)}</span>
                  <button
                    type="button"
                    className="icon-button tiny"
                    aria-label={
                      hidden
                        ? t('database.showProp', { name: prop.name })
                        : t('database.hideProp', { name: prop.name })
                    }
                    disabled={!editable}
                    onClick={() =>
                      updateView(dbId, view.id, (current) => ({
                        ...current,
                        hidden: hidden
                          ? current.hidden.filter((id) => id !== prop.id)
                          : [...current.hidden, prop.id],
                      }))
                    }
                  >
                    {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </li>
              );
            })}
          </ul>
          {editable && <NewProperty dbId={dbId} database={database} />}
          {editable && unclaimed.length > 0 && (
            <>
              <p className="db-panel-heading">{t('database.inYourPages')}</p>
              <ul className="db-prop-list">
                {unclaimed.map((key) => (
                  <li key={key}>
                    <span className="db-prop-name">{key}</span>
                    <button
                      type="button"
                      className="icon-button tiny"
                      aria-label={t('database.addColumnAria', { key })}
                      title={t('database.addAsAColumn')}
                      onClick={() => addColumnsFromPages(dbId, [key])}
                    >
                      <Plus size={13} />
                    </button>
                  </li>
                ))}
              </ul>
              {unclaimed.length > 1 && (
                <button
                  type="button"
                  className="button small"
                  onClick={() => addColumnsFromPages(dbId, unclaimed)}
                >
                  {t('database.addAllAsColumns')}
                </button>
              )}
            </>
          )}
        </Popover>
      )}
    </div>
  );
}

// rename a property, change its type or options, or delete it
interface ViewProps {
  dbId: PageId;
  database: DatabaseDef;
  view: ViewDef;
  rows: PageMeta[];
  props: PropDef[];
  editable: boolean;
}

function RowTitle({ row, editable, autoFocus }: { row: PageMeta; editable: boolean; autoFocus?: boolean }) {
  // 每行独立操作菜单，触屏和键盘均可找到回收站入口。
  const [actions, setActions] = useState<HTMLButtonElement | null>(null);
  // 菜单名称包含当前行标题，便于区分多条记录。
  const actionLabel = t('database.recordActions', { title: displayTitle(row) });
  return (
    <div className="db-title" title={displayTitle(row)}>
      <span className="tree-icon">
        <PageIcon page={row} />
      </span>
      <DraftInput
        type="text"
        label={t('database.name')}
        className="db-title-input"
        value={row.title}
        placeholder={t('page.untitled')}
        editable={editable}
        autoFocus={autoFocus}
        onCommit={(title) => run({ type: 'page.rename', id: row.id, title, now: Date.now() })}
      />
      <button
        type="button"
        className="icon-button tiny db-open"
        aria-label={t('database.openTitle', { title: displayTitle(row) })}
        title={t('common.open')}
        onClick={() => openPage(row.id)}
      >
        <Maximize2 size={13} />
      </button>
      {editable && (
        <button
          type="button"
          className="icon-button tiny db-row-actions"
          aria-label={actionLabel}
          aria-haspopup="menu"
          aria-expanded={Boolean(actions)}
          onClick={(event) => setActions(event.currentTarget)}
        >
          <Ellipsis size={14} />
        </button>
      )}
      {actions && (
        <Menu
          anchor={actions}
          label={actionLabel}
          onClose={() => setActions(null)}
          entries={[
            {
              label: t('database.deleteRecord'),
              icon: Trash2,
              danger: true,
              onSelect: () => trashPage(row.id),
            },
          ]}
        />
      )}
    </div>
  );
}

const TITLE_WIDTH = 260;
const COLUMN_WIDTH = 180;

// drag a column's right edge to size it, a double click goes back to the usual width
function ColumnResizer({
  width,
  onResize,
  onDone,
  onReset,
}: {
  width: number;
  onResize: (width: number) => void;
  onDone: (width: number) => void;
  onReset: () => void;
}) {
  return (
    <span
      className="db-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('database.dragToResize')}
      onDoubleClick={onReset}
      onPointerDown={(event) => {
        event.preventDefault();
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        const start = event.clientX;
        // 使用实际渲染宽度，窄屏名称列被限宽后仍能正常缩放。
        const startWidth = handle.closest('th')?.getBoundingClientRect().width ?? width;
        let next = width;
        const move = (moved: PointerEvent) => {
          next = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, startWidth + moved.clientX - start));
          onResize(next);
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          onDone(next);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      }}
    />
  );
}

// 根据属性类型显示表头图标，沿用现有 Lucide 图标体系。
function PropertyTypeIcon({ prop }: { prop: PropDef }) {
  // 属性类型对应的图标，不改变列的功能或数据。
  const Icon =
    prop.type === 'number'
      ? Hash
      : prop.type === 'date'
        ? Calendar
        : prop.type === 'checkbox'
          ? CheckSquare
          : prop.type === 'url' || prop.type === 'relation'
            ? Link2
            : prop.type === 'select'
              ? CircleDot
              : prop.type === 'multiSelect'
                ? ListFilter
                : prop.type === 'formula'
                  ? FunctionSquare
                  : Type;
  return <Icon size={14} aria-hidden="true" />;
}

function TableView({ dbId, database, view, rows, props, editable }: ViewProps) {
  // 正文列和自定义属性复用表头的打开状态。
  const [header, setHeader] = useState<{ prop: PropDef | null; anchor: HTMLElement } | null>(null);
  const [adding, setAdding] = useState<HTMLElement | null>(null);
  const [focusNew, setFocusNew] = useState<string | null>(null);
  // the width being dragged, saved to the view once the drag ends
  const [dragging, setDragging] = useState<{ key: string; width: number } | null>(null);
  const widthOf = (key: string) =>
    dragging?.key === key
      ? dragging.width
      : (view.widths?.[key] ?? (key === TITLE_PROP ? TITLE_WIDTH : COLUMN_WIDTH));
  const saveWidth = (key: string, width: number | null) => {
    setDragging(null);
    updateView(dbId, view.id, (current) => {
      const widths = { ...current.widths };
      if (width === null) delete widths[key];
      else widths[key] = width;
      return { ...current, widths };
    });
  };
  const resizer = (key: string) =>
    editable && (
      <ColumnResizer
        width={widthOf(key)}
        onResize={(width) => setDragging({ key, width })}
        onDone={(width) => saveWidth(key, width)}
        onReset={() => saveWidth(key, null)}
      />
    );
  // 只读视图的折叠交互仅保存在当前组件。
  const [readonlyCollapsed, setReadonlyCollapsed] = useState<string[]>([]);
  // 名称列始终固定在序号右侧，其他列沿用用户顺序。
  const columns = [
    TITLE_PROP,
    ...[...props.map((prop) => prop.id), ...(view.showBody ? [BODY_COLUMN] : [])].sort((a, b) => {
      // 未配置的列保持原有相对顺序。
      const order = view.columnOrder ?? [];
      return (
        (order.includes(a) ? order.indexOf(a) : order.length) -
        (order.includes(b) ? order.indexOf(b) : order.length)
      );
    }),
  ];
  // 分组沿用看板的选项顺序和多选语义，空值组仅在有记录时显示。
  const groups = view.groupBy
    ? groupRows(rows, view.groupBy, database).filter((group) => group.key !== null || group.rows.length > 0)
    : [{ key: null, label: '', color: 'gray' as const, rows }];
  if (view.groupDirection === 'desc') groups.reverse();
  // 按完整列序移动，隐藏列的位置也保留在视图设置内。
  const moveColumn = (source: string, target: string) => {
    if (
      !editable ||
      source === target ||
      source === TITLE_PROP ||
      target === TITLE_PROP ||
      !columns.includes(source) ||
      !columns.includes(target)
    )
      return;
    updateView(dbId, view.id, (current) => {
      // 去除失效属性并为新属性补齐位置。
      const available = [...database.properties.map((prop) => prop.id), BODY_COLUMN];
      // 根据已保存的列序还原完整序列。
      const order = [...new Set([...(current.columnOrder ?? []), ...available])].filter((id) =>
        available.includes(id),
      );
      // 使用移除前的目标位置，左右移动均可到达相邻列。
      const targetIndex = order.indexOf(target);
      order.splice(order.indexOf(source), 1);
      order.splice(targetIndex, 0, source);
      return { ...current, columnOrder: order };
    });
  };
  // 名称列按表格容器限宽，窄分栏仍能看到部分横向滚动内容。
  const otherWidth = 44 + columns.slice(1).reduce((sum, key) => sum + widthOf(key), 0) + (editable ? 36 : 0);
  return (
    <div
      className={`db-table-wrap${view.groupBy ? ' is-grouped' : ''}`}
      style={{ '--db-saved-title-width': `${widthOf(TITLE_PROP)}px` } as CSSProperties}
    >
      <table
        className={`db-table${editable ? ' is-filled' : ''}`}
        style={{ width: `calc(${otherWidth}px + var(--db-title-width))` }}
      >
        <colgroup>
          <col style={{ width: 44 }} />
          {columns.map((key) => (
            <col key={key} style={{ width: key === TITLE_PROP ? 'var(--db-title-width)' : widthOf(key) }} />
          ))}
          {editable && <col />}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="db-row-number" aria-label={t('database.rowNumber')}>
              #
            </th>
            {columns.map((key, index) => {
              // 当前表头对应的属性，名称列使用内置图标与标签。
              const prop = props.find((item) => item.id === key);
              return (
                <th
                  key={key}
                  scope="col"
                  className={key === TITLE_PROP ? 'db-col-title' : undefined}
                  draggable={editable && key !== TITLE_PROP}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('application/x-morrow-column', key);
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(event) => {
                    if (
                      editable &&
                      key !== TITLE_PROP &&
                      event.dataTransfer.types.includes('application/x-morrow-column')
                    )
                      event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    moveColumn(event.dataTransfer.getData('application/x-morrow-column'), key);
                  }}
                >
                  {key === TITLE_PROP ? (
                    <span className="db-header">
                      <Type size={14} /> {t('database.name')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="db-header"
                      disabled={!editable}
                      onKeyDown={(event) => {
                        if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
                        event.preventDefault();
                        // Alt 加方向键为键盘用户提供同等列移动能力。
                        const target = columns[index + (event.key === 'ArrowLeft' ? -1 : 1)];
                        if (target) moveColumn(key, target);
                      }}
                      onClick={(event) => setHeader({ prop: prop ?? null, anchor: event.currentTarget })}
                    >
                      {prop ? <PropertyTypeIcon prop={prop} /> : <FileText size={14} />}{' '}
                      {prop?.name ?? t('database.bodyColumn')}
                    </button>
                  )}
                  {resizer(key)}
                </th>
              );
            })}
            {editable && (
              <th className="db-col-add">
                <button
                  type="button"
                  className="icon-button tiny"
                  aria-label={t('page.addAProperty')}
                  onClick={(event) => setAdding(event.currentTarget)}
                >
                  <Plus size={13} />
                </button>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            // JSON 编码避免空值与真实选项键冲突。
            const key = JSON.stringify(group.key);
            // 折叠状态按视图保存，刷新后保持。
            const collapsed = (editable ? (view.collapsedGroups ?? []) : readonlyCollapsed).includes(key);
            return (
              <Fragment key={key}>
                {/* 空白分隔行仅用于视觉区分，不参与记录计数。 */}
                {view.groupBy && (
                  <tr className="db-group-gap" aria-hidden="true">
                    <td colSpan={columns.length + 1 + Number(editable)} />
                  </tr>
                )}
                {view.groupBy && (
                  <tr className="db-group-row">
                    <td colSpan={columns.length + 1 + Number(editable)}>
                      <button
                        type="button"
                        className="db-group-toggle"
                        aria-expanded={!collapsed}
                        onClick={() =>
                          editable
                            ? updateView(dbId, view.id, (current) => ({
                                ...current,
                                collapsedGroups: collapsed
                                  ? (current.collapsedGroups ?? []).filter((item) => item !== key)
                                  : [...(current.collapsedGroups ?? []), key],
                              }))
                            : setReadonlyCollapsed((current) =>
                                collapsed ? current.filter((item) => item !== key) : [...current, key],
                              )
                        }
                      >
                        <ChevronRight
                          size={14}
                          style={{ transform: collapsed ? undefined : 'rotate(90deg)' }}
                        />
                        <Chip
                          option={{
                            name:
                              group.key === null
                                ? t('database.emptyValue')
                                : database.properties.find((prop) => prop.id === view.groupBy)?.type ===
                                    'checkbox'
                                  ? t(
                                      group.key === 'true'
                                        ? 'database.filterChecked'
                                        : 'database.filterUnchecked',
                                    )
                                  : group.label,
                            color: group.color,
                          }}
                        />
                        <span className="muted small">{tp('database.rows', group.rows.length)}</span>
                      </button>
                    </td>
                  </tr>
                )}
                {(!view.groupBy || !collapsed) &&
                  group.rows.map((row, index) => (
                    <tr key={row.id}>
                      <td className="db-row-number">{index + 1}</td>
                      {columns.map((column) => {
                        // 按表头顺序渲染单元格，避免拖动后值与标题错位。
                        const prop = props.find((item) => item.id === column);
                        return (
                          <td key={column} className={column === TITLE_PROP ? 'db-col-title' : undefined}>
                            {prop ? (
                              <PropertyInput
                                dbId={dbId}
                                prop={prop}
                                row={row}
                                editable={editable}
                                tableCell
                              />
                            ) : column === BODY_COLUMN ? (
                              <BodyCell row={row} editable={editable} />
                            ) : (
                              <RowTitle row={row} editable={editable} autoFocus={focusNew === row.id} />
                            )}
                          </td>
                        );
                      })}
                      {editable && <td />}
                    </tr>
                  ))}
                {view.groupBy && !collapsed && editable && (
                  <tr className="db-group-create">
                    <td colSpan={columns.length + 1 + Number(editable)}>
                      <button
                        type="button"
                        className="db-new-row"
                        aria-label={`${t('database.new')} · ${group.label}`}
                        onClick={() => {
                          // 读取真实分组属性，避免新记录落入未分组区域。
                          const prop = database.properties.find((item) => item.id === view.groupBy);
                          if (!prop) return;
                          // 创建后保持表格内编辑并聚焦名称。
                          const id = createRow(dbId, { [prop.id]: valueForGroup(prop, group.key) });
                          if (id) setFocusNew(id);
                        }}
                      >
                        <Plus size={14} /> {t('database.new')}
                      </button>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {editable && !view.groupBy && (
        <button
          type="button"
          className="db-new-row"
          onClick={() => {
            const id = createRow(dbId);
            if (id) setFocusNew(id);
          }}
        >
          <Plus size={14} /> {t('database.new')}
        </button>
      )}
      {header?.prop && (
        <PropertySettings
          dbId={dbId}
          database={database}
          prop={header.prop}
          view={view}
          anchor={header.anchor}
          onClose={() => setHeader(null)}
        />
      )}
      {header && !header.prop && (
        <Menu
          anchor={header.anchor}
          label={t('database.bodyColumn')}
          onClose={() => setHeader(null)}
          entries={[
            {
              label: t('database.hide'),
              icon: EyeOff,
              onSelect: () => updateView(dbId, view.id, (current) => ({ ...current, showBody: false })),
            },
          ]}
        />
      )}
      {adding && (
        <Popover
          anchor={adding}
          onClose={() => setAdding(null)}
          label={t('database.newProperty')}
          className="db-panel"
        >
          {!view.showBody && (
            <button
              type="button"
              className="button small db-add-body"
              onClick={() => {
                updateView(dbId, view.id, (current) => ({ ...current, showBody: true }));
                adding.focus({ preventScroll: true });
                setAdding(null);
              }}
            >
              <FileText size={13} /> {t('database.addBodyColumn')}
            </button>
          )}
          <NewProperty dbId={dbId} database={database} onDone={() => setAdding(null)} />
        </Popover>
      )}
    </div>
  );
}

function Card({
  row,
  props,
  database,
  cover,
}: {
  row: PageMeta;
  props: PropDef[];
  database: DatabaseDef;
  cover?: boolean;
}) {
  const state = useWorkspace();
  const [image, setImage] = useState<string | null>(null);
  const firstImage = useMemo(() => {
    if (!cover) return null;
    const doc = state.docs[row.id];
    const node = doc?.content?.find(
      (child) => child.type === 'image' && typeof child.attrs?.fileId === 'string',
    );
    return node ? String(node.attrs!.fileId) : null;
  }, [cover, state.docs, row.id]);
  const progress = useMemo(() => taskProgress(state.docs[row.id]), [state.docs, row.id]);
  useEffect(() => {
    let live = true;
    if (firstImage) void fileUrl(firstImage).then((url) => live && setImage(url));
    return () => {
      live = false;
    };
  }, [firstImage]);
  return (
    <button type="button" className="db-card" onClick={() => openPage(row.id)}>
      {cover && (
        <span className="db-cover">
          {image ? <img src={image} alt="" /> : <span className="db-cover-empty" />}
        </span>
      )}
      <span className="db-card-title">
        {row.icon && <Emoji emoji={row.icon} className="db-card-icon" />}
        {displayTitle(row)}
      </span>
      <span className="db-card-props">
        {props.map((prop) => (
          <PropertyDisplay key={prop.id} prop={prop} value={valueOf(row, prop.id, database)} />
        ))}
      </span>
      {progress.total > 0 && (
        <span
          className="db-progress"
          title={t('database.tasksDone', { done: progress.done, total: progress.total })}
        >
          <span className="db-progress-bar">
            <span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
          </span>
          <span className="db-progress-label">
            {progress.done}/{progress.total}
          </span>
        </span>
      )}
    </button>
  );
}

// how many of the checklist items in a page are ticked
function taskProgress(doc: DocNode | undefined): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const visit = (node: DocNode) => {
    if (node.type === 'taskItem') {
      total++;
      if (node.attrs?.checked === true) done++;
    }
    for (const child of node.content ?? []) visit(child);
  };
  if (doc) visit(doc);
  return { done, total };
}

const DRAG = 'application/x-morrow-row';

function BoardView({ dbId, database, view, rows, props, editable }: ViewProps) {
  const prop = database.properties.find((candidate) => candidate.id === view.groupBy);
  // an empty column for rows without a value only adds noise
  const groups = groupRows(rows, view.groupBy, database).filter(
    (group) => group.key !== null || group.rows.length > 0,
  );
  const [over, setOver] = useState<string | null>(null);
  if (!prop) return <p className="muted db-hint">{t('database.boardHint')}</p>;
  const shown = props.filter((item) => item.id !== prop.id);
  const valueFor = (key: string | null): PropValue => {
    if (prop.type === 'checkbox') return key === 'true';
    if (key === null) return null;
    return prop.type === 'multiSelect' ? [key] : key;
  };
  return (
    <div className="db-board">
      {groups.map((group) => {
        const key = group.key ?? '__none';
        return (
          <section
            key={key}
            {...optionColorAppearance(group.color, `db-column${over === key ? ' is-over' : ''}`, false)}
            aria-label={group.label}
            onDragOver={(event) => {
              if (!editable || !event.dataTransfer.types.includes(DRAG)) return;
              event.preventDefault();
              setOver(key);
            }}
            onDragLeave={() => setOver((current) => (current === key ? null : current))}
            onDrop={(event) => {
              setOver(null);
              const id = event.dataTransfer.getData(DRAG);
              if (id) setValue(id, prop.id, valueFor(group.key));
            }}
          >
            <header className="db-column-head">
              <span className="db-column-dot" aria-hidden="true" />
              <Chip option={{ name: group.label, color: group.color }} />
              <span className="muted small">{group.rows.length}</span>
            </header>
            {group.rows.map((row) => (
              <div
                key={row.id}
                draggable={editable}
                onDragStart={(event) => {
                  event.dataTransfer.setData(DRAG, row.id);
                  event.dataTransfer.effectAllowed = 'move';
                }}
              >
                <Card row={row} props={shown} database={database} />
              </div>
            ))}
            {editable && (
              <button
                type="button"
                className="db-new-row"
                onClick={() => newRowAndOpen(dbId, { [prop.id]: valueFor(group.key) })}
              >
                <Plus size={13} /> {t('database.new')}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

function CalendarView({ dbId, database, view, rows, editable }: Omit<ViewProps, 'props'>) {
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [over, setOver] = useState<string | null>(null);
  const prop = database.properties.find((candidate) => candidate.id === view.dateProp);
  if (!prop) return <p className="muted db-hint">{t('database.calendarHint')}</p>;
  // weeks start on monday
  const start = new Date(month);
  start.setDate(1 - ((month.getDay() + 6) % 7));
  const days = Array.from(
    { length: 42 },
    (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
  );
  const byDay = new Map<string, PageMeta[]>();
  for (const row of rows) {
    const value = row.properties[prop.id];
    if (typeof value === 'string') byDay.set(value, [...(byDay.get(value) ?? []), row]);
  }
  const today = dateKey(new Date());
  const shift = (delta: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1));
  return (
    <div className="db-calendar">
      <header className="db-calendar-head">
        <h3>{month.toLocaleDateString(dateLocale(), { month: 'long', year: 'numeric' })}</h3>
        <button
          type="button"
          className="icon-button small"
          aria-label={t('database.previousMonth')}
          onClick={() => shift(-1)}
        >
          <ChevronLeft size={15} />
        </button>
        <button
          type="button"
          className="button small"
          onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
        >
          {t('sidebar.today')}
        </button>
        <button
          type="button"
          className="icon-button small"
          aria-label={t('database.nextMonth')}
          onClick={() => shift(1)}
        >
          <ChevronRight size={15} />
        </button>
      </header>
      <div className="db-calendar-grid" role="grid">
        {days.slice(0, 7).map((day) => (
          <div key={day.toISOString()} className="db-weekday" role="columnheader">
            {day.toLocaleDateString(dateLocale(), { weekday: 'short' })}
          </div>
        ))}
        {days.map((day) => {
          const key = dateKey(day);
          const inMonth = day.getMonth() === month.getMonth();
          return (
            <div
              key={key}
              role="gridcell"
              className={`db-day${inMonth ? '' : ' is-outside'}${key === today ? ' is-today' : ''}${over === key ? ' is-over' : ''}`}
              onDragOver={(event) => {
                if (!editable || !event.dataTransfer.types.includes(DRAG)) return;
                event.preventDefault();
                setOver(key);
              }}
              onDragLeave={() => setOver((current) => (current === key ? null : current))}
              onDrop={(event) => {
                setOver(null);
                const id = event.dataTransfer.getData(DRAG);
                if (id) setValue(id, prop.id, key);
              }}
            >
              <span className="db-day-number">{day.getDate()}</span>
              {(byDay.get(key) ?? []).map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="db-event"
                  draggable={editable}
                  onDragStart={(event) => event.dataTransfer.setData(DRAG, row.id)}
                  onClick={() => openPage(row.id)}
                >
                  {displayTitle(row)}
                </button>
              ))}
              {editable && (
                <button
                  type="button"
                  className="db-day-add"
                  aria-label={t('database.newRowOn', { date: day.toLocaleDateString(dateLocale()) })}
                  onClick={() => newRowAndOpen(dbId, { [prop.id]: key })}
                >
                  <Plus size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ListView({ rows, props, database }: { rows: PageMeta[]; props: PropDef[]; database: DatabaseDef }) {
  return (
    <ul className="link-list db-list">
      {rows.map((row) => (
        <li key={row.id}>
          <button type="button" className="link-row" onClick={() => openPage(row.id)}>
            <span className="tree-icon">
              <PageIcon page={row} />
            </span>
            <span className="link-row-title">{displayTitle(row)}</span>
            <span className="db-card-props">
              {props.map((prop) => (
                <PropertyDisplay key={prop.id} prop={prop} value={valueOf(row, prop.id, database)} />
              ))}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function GalleryView({
  rows,
  props,
  database,
}: {
  rows: PageMeta[];
  props: PropDef[];
  database: DatabaseDef;
}) {
  return (
    <div className="db-gallery">
      {rows.map((row) => (
        <Card key={row.id} row={row} props={props} database={database} cover />
      ))}
    </div>
  );
}
