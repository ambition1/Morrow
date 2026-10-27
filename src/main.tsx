import '@fontsource-variable/inter/index.css';
import '@fontsource-variable/source-serif-4/index.css';
import '@fontsource-variable/source-serif-4/wght-italic.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import './app/styles/tokens.css';
import './app/styles/app.css';
import './app/styles/editor.css';
import './app/styles/features.css';
import './app/styles/color.css';
import './app/styles/blocks.css';
import './app/styles/shell.css';
import './app/styles/collections.css';
import './app/styles/workspace-views.css';
import './app/styles/dialogs-settings.css';
import 'katex/dist/katex.min.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { chineseSampleCommands } from './core/sample.zh-CN';
import { sampleCommands } from './core/sample';
import { startRecurring } from './app/recurring';
import { WorkspaceSession } from './storage/session';
import { webRequest, webVaultBridge } from './app/platform/webVault';
import { WebLogin } from './app/components/WebLogin';
import { applyFonts } from './app/platform/fonts';
import { localizeError } from './app/i18n/errors';
import { t, tp } from './app/i18n';
import { VaultRepository } from './storage/vaultRepository';
import { App } from './app/App';
import { Logo } from './app/components/primitives';
import { VaultChooser } from './app/components/VaultChooser';
import { commitEditors } from './app/editor/commits';
import { COPY_LEGACY_KEY, copyLegacyInto, legacyPageCount } from './app/legacy';
import { desktop } from './app/platform/desktop';
import { newId } from './app/platform/files';
import { desktopVaultBridge } from './app/platform/vault';
import { resolvedTheme, getPreferences } from './app/platform/preferences';
import { toast } from './app/ui';
import { setSession } from './app/workspace';

type BootState =
  | { kind: 'loading' }
  | { kind: 'login' }
  | { kind: 'error'; message: string }
  | { kind: 'choose'; legacy: number }
  | { kind: 'ready' };

// 首次绘制前应用语言和字体，避免界面闪烁。
document.documentElement.lang = getPreferences().locale;
desktop?.setLocale?.(getPreferences().locale);
applyFonts(getPreferences());
// the theme is applied before react renders so there is no flash
document.documentElement.dataset.theme = resolvedTheme(getPreferences().theme);
document.documentElement.dataset.accent = getPreferences().accent;
document.documentElement.dataset.colorful = getPreferences().colorful ? 'true' : 'false';
// the desktop window has no title bar, styles use this to make room for the native buttons
if (desktop) document.documentElement.dataset.desktop = desktop.platform;

async function openWorkspace(): Promise<BootState> {
  // morrow is a desktop app, pages are files in a folder the person chooses
  // 浏览器必须先通过服务器认证，账号由会话确定。
  // 当前账号用于将所有文件请求绑定到本标签页打开的工作区。
  let username = '';
  if (!desktop) {
    try {
      const response = await webRequest('/api/session');
      username = ((await response.json()) as { username: string }).username;
      sessionStorage.setItem('morrow.webUser', username);
    } catch (error) {
      if ((error as { status?: number }).status === 401) return { kind: 'login' };
      throw error;
    }
  }
  const vault = desktop?.vault ? await desktop.vault.open() : null;
  if (desktop?.vault && (!vault?.ok || !vault.root))
    return { kind: 'choose', legacy: await legacyPageCount().catch(() => 0) };
  const repository =
    desktop?.vault && vault?.root
      ? new VaultRepository(desktopVaultBridge(desktop.vault, vault.root), newId)
      : new VaultRepository(webVaultBridge(username), newId);
  const opened = await WorkspaceSession.open(repository);
  if (!opened.ok) return { kind: 'error', message: opened.error };
  const session = opened.value;
  session.beforeExternal = commitEditors;
  const copyLegacy = sessionStorage.getItem(COPY_LEGACY_KEY) === '1';
  sessionStorage.removeItem(COPY_LEGACY_KEY);
  if (copyLegacy) {
    const copied = await copyLegacyInto(session);
    if (copied.ok && copied.value > 0)
      toast(tp('settings.vault.copyLegacySuccess', copied.value), { durationMs: 12_000 });
    else if (!copied.ok)
      toast(t('toasts.importFailed', { error: copied.error }), { tone: 'error', durationMs: 12_000 });
  } else if (session.firstRun && !sessionStorage.getItem('morrow.syncAfterOpen')) {
    // a folder about to be filled from another computer never gets the welcome guide
    const seeded = session.executeAll(
      (getPreferences().locale === 'zh-CN' ? chineseSampleCommands : sampleCommands)(newId, Date.now()),
    );
    if (seeded.ok) await session.flush();
  }
  await session.markInitialized();
  setSession(session);
  startRecurring();
  if (session.problems.length > 0) {
    console.warn('Morrow could not read some stored records:', session.problems);
    toast(t('boot.unreadable', { count: session.problems.length }), {
      tone: 'error',
      durationMs: 12_000,
    });
  }
  return { kind: 'ready' };
}

const fail = (error: unknown): BootState => ({ kind: 'error', message: String(error) });

// booting runs once even when strict mode mounts twice
let booting: Promise<BootState> | null = null;
function bootOnce(): Promise<BootState> {
  booting ??= openWorkspace().catch(fail);
  return booting;
}

function Boot() {
  const [state, setState] = useState<BootState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void bootOnce().then((next) => !cancelled && setState(next));
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'login') return <WebLogin />;
  if (state.kind === 'ready') return <App />;
  if (state.kind === 'choose') return <VaultChooser legacy={state.legacy} />;
  return (
    <div className="boot">
      <Logo size={36} />
      {state.kind === 'loading' && <p className="boot-text">{t('boot.opening')}</p>}
      {state.kind === 'error' && (
        <>
          <h1>{t('boot.failed')}</h1>
          <p className="boot-text">{localizeError(state.message)}</p>
          <p className="boot-text muted">{t('boot.unchanged')}</p>
          <div className="button-row">
            <button type="button" className="button primary" onClick={() => window.location.reload()}>
              {t('boot.retry')}
            </button>
            {desktop?.vault && (
              <button
                type="button"
                className="button"
                onClick={() => setState({ kind: 'choose', legacy: 0 })}
              >
                {t('sidebar.openAnotherFolder')}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
