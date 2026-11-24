// names the core layer keeps in english, translated where they are shown
import { VIEW_LABELS } from '../../core/database';
import type {
  OptionColor,
  OPTION_COLORS,
  FilterOp,
  PageMeta,
  PropType,
  ViewDef,
  ViewType,
} from '../../core/model';
import { t } from './index';
import type { TranslationKey } from './types';

const PROP: Record<PropType, TranslationKey> = {
  text: 'database.typeText',
  number: 'database.typeNumber',
  select: 'database.typeSelect',
  multiSelect: 'database.typeMultiSelect',
  date: 'database.typeDate',
  checkbox: 'database.typeCheckbox',
  url: 'database.typeUrl',
  relation: 'database.typeRelation',
  formula: 'database.typeFormula',
};

const VIEW: Record<ViewType, TranslationKey> = {
  table: 'database.viewTable',
  board: 'database.viewBoard',
  calendar: 'database.viewCalendar',
  list: 'database.viewList',
  gallery: 'database.viewGallery',
};

const FILTER: Record<FilterOp, TranslationKey> = {
  contains: 'database.filterContains',
  notContains: 'database.filterNotContains',
  is: 'database.filterIs',
  isNot: 'database.filterIsNot',
  empty: 'database.filterEmpty',
  notEmpty: 'database.filterNotEmpty',
  gt: 'database.filterGt',
  lt: 'database.filterLt',
  checked: 'database.filterChecked',
  unchecked: 'database.filterUnchecked',
};

const COLOR: Record<(typeof OPTION_COLORS)[number], TranslationKey> = {
  gray: 'colors.gray',
  brown: 'colors.brown',
  orange: 'colors.orange',
  yellow: 'colors.yellow',
  green: 'colors.green',
  blue: 'colors.blue',
  purple: 'colors.purple',
  pink: 'colors.pink',
  red: 'colors.red',
  slate: 'colors.slate',
  amber: 'colors.amber',
  lime: 'colors.lime',
  teal: 'colors.teal',
  cyan: 'colors.cyan',
  indigo: 'colors.indigo',
  violet: 'colors.violet',
  rose: 'colors.rose',
  burgundy: 'colors.burgundy',
};

export const propLabel = (type: PropType): string => t(PROP[type]);
export const viewLabel = (type: ViewType): string => t(VIEW[type]);
export const filterLabel = (op: FilterOp): string => t(FILTER[op]);
// 预设色显示本地化名称，自定义色显示可复制的 HEX 值。
export const colorLabel = (color: OptionColor): string =>
  color.startsWith('#') ? color : t(COLOR[color as keyof typeof COLOR]);

// a view still called by its english default shows that name translated, a name someone typed stays as typed
export function viewName(view: Pick<ViewDef, 'name' | 'type'>): string {
  return !view.name || view.name === VIEW_LABELS[view.type] ? viewLabel(view.type) : view.name;
}

/** 在界面中显示页面标题，空标题使用当前语言。 */
export function displayTitle(page: Pick<PageMeta, 'title'> | undefined): string {
  return page?.title.trim() || t('page.untitled');
}
