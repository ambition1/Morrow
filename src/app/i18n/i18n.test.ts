import { describe, expect, it } from 'vitest';
import { en } from './locales/en';
import { es } from './locales/es';
import { zhCN } from './locales/zh-CN';
import { pt } from './locales/pt';
import { localizeError } from './errors';
import { t } from './index';

function collectKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...collectKeys(v as Record<string, unknown>, full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

describe('i18n locales', () => {
  it('has matching keys between en, es and pt dictionaries', () => {
    const enKeys = collectKeys(en).sort();
    const esKeys = collectKeys(es).sort();
    const ptKeys = collectKeys(pt).sort();
    expect(esKeys).toEqual(enKeys);
    expect(ptKeys).toEqual(enKeys);
    expect(collectKeys(zhCN).sort()).toEqual(enKeys);
  });

  it('interpolates parameters correctly', () => {
    const result = t('home.dayStreak', { count: 7 }, 'en');
    expect(result).toBe('7 day streak');

    const resultEs = t('home.dayStreak', { count: 7 }, 'es');
    expect(resultEs).toBe('Racha de 7 días');

    const resultPt = t('home.dayStreak', { count: 7 }, 'pt');
    expect(resultPt).toBe('Sequência de 7 dias');
  });

  it('translates common keys into spanish', () => {
    expect(t('common.cancel', undefined, 'en')).toBe('Cancel');
    expect(t('common.cancel', undefined, 'es')).toBe('Cancelar');
    expect(t('sidebar.today', undefined, 'es')).toBe('Hoy');
    expect(t('settings.general.title', undefined, 'es')).toBe('General');
  });

  it('translates common keys into portuguese', () => {
    expect(t('common.cancel', undefined, 'pt')).toBe('Cancelar');
    expect(t('common.save', undefined, 'pt')).toBe('Salvar');
    expect(t('sidebar.today', undefined, 'pt')).toBe('Hoje');
    expect(t('settings.title', undefined, 'pt')).toBe('Configurações');
    expect(t('settings.sections.appearance', undefined, 'pt')).toBe('Aparência');
  });
});

// 中文词典必须覆盖所有键，并保持插值参数完整。
describe('简体中文完整性', () => {
  it('在界面翻译密码与存储错误，同时保留其他语言的诊断', () => {
    expect(localizeError('That password is not right.', 'zh-CN')).toBe('密码不正确。');
    expect(localizeError('That password is not right.', 'en')).toBe('That password is not right.');
  });
  it('翻译设置、提示、菜单并保持插值参数一致', () => {
    expect(t('settings.title', undefined, 'zh-CN')).toBe('设置');
    expect(t('home.dayStreak', { count: 7 }, 'zh-CN')).toBe('连续 7 天');
    expect(t('slash.items.task.title', undefined, 'zh-CN')).toBe('任务清单');
    // 每一个键都验证参数，不允许翻译时误删占位符。
    for (const key of collectKeys(en)) {
      const params = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      const read = (dictionary: unknown): string =>
        key
          .split('.')
          .reduce((value, part) => (value as Record<string, unknown>)[part], dictionary) as string;
      expect(params(read(zhCN)), key).toEqual(params(read(en)));
      // 专有名词、版本号和搜索关键词可以保留英文，其他文案必须包含中文。
      if (
        !key.endsWith('.keywords') &&
        ![
          'settings.about.version',
          'settings.about.gitHubButton',
          'editor.suggestion.toAction',
          'review.cardProgress',
        ].includes(key) &&
        read(zhCN)
      )
        expect(read(zhCN), key).toMatch(/[\u4e00-\u9fff]/);
    }
  });
});
