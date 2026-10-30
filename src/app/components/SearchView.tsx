import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { displayTitle } from '../i18n/labels';
import { searchWorkspace } from '../../core/search';
import { encodeSearchLocation } from '../../core/searchLocation';
import { livePages } from '../../core/tree';
import { Select } from './Select';
import type { SearchFilters, SearchResult } from '../../core/search';
import { navigate, openPage } from '../router';
import { usePane } from '../navigation';
import { useWorkspace } from '../workspace';
import { PageIcon } from './Sidebar';
import { relativeTime } from './primitives';
import { useTranslation } from '../i18n';
import { TopBar } from './TopBar';
import { tr } from '../i18n/rich';

type Order = 'best' | 'recent' | 'title';

const MAX_RESULTS = 200;
const SNIPPETS_PER_PAGE = 3;

function sorted(results: SearchResult[], order: Order): SearchResult[] {
  if (order === 'recent') return [...results].sort((a, b) => b.page.updatedAt - a.page.updatedAt);
  if (order === 'title')
    return [...results].sort((a, b) => displayTitle(a.page).localeCompare(displayTitle(b.page)));
  return results;
}

// every page that matches, with each place it matched, the query lives in the address so tabs keep it
export function SearchView({ query }: { query: string }) {
  const { t } = useTranslation();
  const state = useWorkspace();
  const orders: Array<[Order, string]> = [
    ['best', t('searchView.orders.best')],
    ['recent', t('searchView.orders.recent')],
    ['title', t('searchView.orders.title')],
  ];
  const pane = usePane();
  const [text, setText] = useState(query);
  const [order, setOrder] = useState<Order>('best');
  /** 页面范围与筛选条件不改变笔记库内容。 */
  const [filters, setFilters] = useState<SearchFilters>({});
  /** 日期输入保留本地日历日期，不通过UTC引入一天偏移。 */
  const [after, setAfter] = useState('');
  /** 结束日期含当日的全部时间。 */
  const [before, setBefore] = useState('');
  /** 空查询也可使用筛选查看范围内页面。 */
  const active = Boolean(
    query.trim() || filters.rootId || filters.tag || filters.attachment || after || before,
  );
  /** 搜索命中的指定片段使用当前文档校验和编码。 */
  const openResult = (result: SearchResult, index = 0) => {
    /** 没有正文片段的标题结果正常打开。 */
    const snippet = result.snippets[index];
    /** 文档不存在时保留文字回退。 */
    const doc = state.docs[result.page.id];
    openPage(
      result.page.id,
      snippet && doc ? encodeSearchLocation(doc, snippet.match, snippet.offset) : null,
    );
  };
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // typing updates the address after a pause, without a history entry for every letter
  useEffect(() => {
    if (text === query) return;
    const timer = setTimeout(() => navigate({ name: 'search', query: text }, { replace: true, pane }), 250);
    return () => clearTimeout(timer);
  }, [text, query, pane]);

  const results = useMemo(
    () =>
      sorted(
        searchWorkspace(state, query, MAX_RESULTS, SNIPPETS_PER_PAGE, {
          ...filters,
          ...(after ? { updatedAfter: new Date(`${after}T00:00:00`).getTime() } : {}),
          ...(before ? { updatedBefore: new Date(`${before}T23:59:59.999`).getTime() } : {}),
        }),
        order,
      ),
    [state, query, order, filters, after, before],
  );

  return (
    <div className="view collection-view search-page">
      <TopBar>
        <span className="topbar-title">{t('common.search')}</span>
      </TopBar>
      <div className="page-scroll">
        <div className="collection search-view">
          <header className="collection-header">
            <span className="collection-symbol" aria-hidden="true">
              <Search size={22} strokeWidth={1.5} />
            </span>
            <h1>{t('common.search')}</h1>
            <label className="search-field">
              <Search size={18} strokeWidth={1.75} />
              <input
                ref={inputRef}
                type="search"
                placeholder={t('searchView.placeholder')}
                aria-label={t('searchView.ariaLabel')}
                value={text}
                spellCheck={false}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter')
                    navigate({ name: 'search', query: text }, { replace: true, pane });
                }}
              />
            </label>
            <p className="muted small search-tips">
              {tr('searchView.tips', {
                phrase: <code>{t('searchView.tipPhrase')}</code>,
                exclude: <code>{t('searchView.tipExclude')}</code>,
                tag: <code>{t('searchView.tipTag')}</code>,
              })}
            </p>
            <div className="search-filters">
              <label className="field">
                <span>{t('searchView.filters.scope')}</span>
                <Select
                  value={filters.rootId ?? ''}
                  label={t('searchView.filters.scope')}
                  options={[
                    { value: '', label: t('searchView.filters.all') },
                    ...livePages(state.pages).map((page) => ({ value: page.id, label: displayTitle(page) })),
                  ]}
                  onChange={(rootId) => setFilters({ ...filters, rootId: rootId || null })}
                />
              </label>
              <label className="field">
                <span>{t('searchView.filters.tag')}</span>
                <input
                  className="text-input"
                  value={filters.tag ?? ''}
                  onChange={(event) => setFilters({ ...filters, tag: event.target.value })}
                />
              </label>
              <label className="field">
                <span>{t('searchView.filters.after')}</span>
                <input
                  className="text-input"
                  type="date"
                  value={after}
                  onChange={(event) => setAfter(event.target.value)}
                />
              </label>
              <label className="field">
                <span>{t('searchView.filters.before')}</span>
                <input
                  className="text-input"
                  type="date"
                  value={before}
                  onChange={(event) => setBefore(event.target.value)}
                />
              </label>
              <label className="field">
                <span>{t('searchView.filters.attachment')}</span>
                <Select
                  value={filters.attachment ?? ''}
                  label={t('searchView.filters.attachment')}
                  options={[
                    { value: '', label: t('searchView.filters.all') },
                    { value: 'image', label: t('searchView.filters.image') },
                    { value: 'pdf', label: 'PDF' },
                    { value: 'file', label: t('searchView.filters.file') },
                  ]}
                  onChange={(attachment) =>
                    setFilters({
                      ...filters,
                      attachment: attachment ? (attachment as SearchFilters['attachment']) : undefined,
                    })
                  }
                />
              </label>
              <button
                type="button"
                className="button small"
                onClick={() => {
                  setFilters({});
                  setAfter('');
                  setBefore('');
                }}
              >
                {t('searchView.filters.clear')}
              </button>
            </div>
            <p className="muted small">{t('searchView.filters.help')}</p>
            {active && (
              <div className="search-meta">
                <span className="muted">
                  {results.length === 1
                    ? t('searchView.pageCountSingular', { count: 1 })
                    : t('searchView.pageCountPlural', {
                        count: results.length === MAX_RESULTS ? `${MAX_RESULTS}+` : results.length,
                      })}
                </span>
                <div className="segmented" role="radiogroup" aria-label={t('searchView.orderAria')}>
                  {orders.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={order === value}
                      className={order === value ? 'is-active' : ''}
                      onClick={() => setOrder(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </header>
          {active && results.length === 0 && (
            <div className="empty-state compact">
              <Search size={24} strokeWidth={1.5} />
              <p>{t('searchView.noMatches', { query })}</p>
            </div>
          )}
          {!active && (
            <div className="empty-state compact search-intro">
              <Search size={24} strokeWidth={1.5} aria-hidden="true" />
              <p>{t('searchView.placeholder')}</p>
            </div>
          )}
          <ul className="search-results">
            {results.map((result) => (
              <li key={result.page.id}>
                <div
                  className="search-result"
                  data-page-id={result.page.id}
                  title={t('searchView.resultTooltip')}
                >
                  <span className="search-result-head">
                    <span className="tree-icon">
                      <PageIcon page={result.page} />
                    </span>
                    <button type="button" className="search-result-title" onClick={() => openResult(result)}>
                      {displayTitle(result.page)}
                    </button>
                    {result.path.length > 0 && (
                      <span className="search-result-path">{result.path.join(' / ')}</span>
                    )}
                    <span className="search-result-time">{relativeTime(result.page.updatedAt)}</span>
                  </span>
                  {result.snippets.map((snippet, index) => (
                    <button
                      type="button"
                      key={index}
                      className="search-snippet"
                      onClick={() => openResult(result, index)}
                    >
                      {snippet.before}
                      <mark>{snippet.match}</mark>
                      {snippet.after}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
