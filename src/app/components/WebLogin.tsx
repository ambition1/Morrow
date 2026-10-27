/**
 * 功能：提供远程多账号登录界面，凭证仅提交给同源服务端。
 * 作者：xuanli
 * 创建时间：2026-10-25 23:38:56
 */
import { useState } from 'react';
import { ArrowRight, Eye, EyeOff, FileText, LayoutGrid, LoaderCircle, Waypoints } from 'lucide-react';
import { localizeError } from '../i18n/errors';
import { useTranslation } from '../i18n';
import { webRequest } from '../platform/webVault';
import { Logo } from './primitives';

/** 登录成功后重新加载账号的服务器笔记库。 */
export function WebLogin() {
  /** 根据界面设置显示登录文案。 */
  const { t } = useTranslation();
  /** 管理员创建的账号名。 */
  const [username, setUsername] = useState('');
  /** 密码仅保留在本组件内存中。 */
  const [password, setPassword] = useState('');
  /** 请求期间防止重复提交。 */
  const [busy, setBusy] = useState(false);
  /** 登录失败时的可见错误提示。 */
  const [error, setError] = useState('');
  /** 密码默认隐藏，仅由当前用户主动切换可见性。 */
  const [showPassword, setShowPassword] = useState(false);
  /** 大写锁定提示不作为认证错误，避免误将正确输入标为无效。 */
  const [capsLock, setCapsLock] = useState(false);
  return (
    <div className="web-login-screen">
      <aside className="web-login-sidebar" aria-label="Morrow">
        <div className="web-login-brand">
          <Logo size={28} />
          <span>Morrow</span>
        </div>
        <div className="web-login-intro">
          <h2>{t('web.welcomeHeading')}</h2>
          <p>{t('web.welcomeBody')}</p>
          <div className="web-login-horizon" aria-hidden="true">
            <svg viewBox="0 0 520 260" fill="none" focusable="false">
              <path
                className="horizon-guide"
                d="M36 200H484M100 200A160 160 0 0 1 420 200M140 200A120 120 0 0 1 380 200"
              />
              <path className="horizon-rise" d="M100 200A160 160 0 0 1 420 200" />
              <path className="horizon-ground" d="M200 222H320M232 238H288" />
              <circle className="horizon-halo" cx="373" cy="87" r="12" />
              <circle className="horizon-point" cx="373" cy="87" r="4" />
            </svg>
          </div>
          <ul className="web-login-features">
            <li>
              <FileText size={17} aria-hidden="true" />
              <span>{t('web.featureNotes')}</span>
            </li>
            <li>
              <LayoutGrid size={17} aria-hidden="true" />
              <span>{t('web.featureWork')}</span>
            </li>
            <li>
              <Waypoints size={17} aria-hidden="true" />
              <span>{t('web.featureIdeas')}</span>
            </li>
          </ul>
        </div>
        <p className="web-login-sidebar-note">{t('web.welcomeFooter')}</p>
      </aside>
      <main className="web-login-main">
        <div className="web-login-content">
          <header className="web-login-heading">
            <p className="web-login-kicker">{t('web.workspaceLabel')}</p>
            <h1>{t('web.loginTitle')}</h1>
            <p>{t('web.loginHelp')}</p>
          </header>
          <form
            className="web-login"
            aria-label={t('web.loginTitle')}
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              setError('');
              void webRequest('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
              })
                .then(() => window.location.reload())
                .catch((reason: unknown) => {
                  setPassword('');
                  setShowPassword(false);
                  setError(reason instanceof Error ? localizeError(reason.message) : t('web.requestFailed'));
                })
                .finally(() => setBusy(false));
            }}
          >
            <label className="field">
              <span>{t('web.username')}</span>
              <input
                className="text-input"
                name="username"
                autoComplete="username"
                disabled={busy}
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'web-login-error' : undefined}
                required
                maxLength={48}
                placeholder={t('web.usernamePlaceholder')}
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setError('');
                }}
              />
            </label>
            <div className="field">
              <label htmlFor="web-login-password">{t('web.password')}</label>
              <div className="web-login-password">
                <input
                  id="web-login-password"
                  className="text-input"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  disabled={busy}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? 'web-login-error' : undefined}
                  required
                  maxLength={256}
                  placeholder={t('web.passwordPlaceholder')}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setError('');
                  }}
                  onKeyDown={(event) => setCapsLock(event.getModifierState('CapsLock'))}
                  onKeyUp={(event) => setCapsLock(event.getModifierState('CapsLock'))}
                  onBlur={() => setCapsLock(false)}
                />
                <button
                  type="button"
                  className="icon-button small"
                  aria-label={t(showPassword ? 'web.hidePassword' : 'web.showPassword')}
                  aria-pressed={showPassword}
                  disabled={busy}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? (
                    <EyeOff size={16} aria-hidden="true" />
                  ) : (
                    <Eye size={16} aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>
            <div className="web-login-feedback">
              {error ? (
                <p id="web-login-error" className="field-error" role="alert">
                  {error}
                </p>
              ) : (
                <p role={capsLock ? 'status' : undefined}>
                  {t(capsLock ? 'web.capsLock' : 'web.accountHint')}
                </p>
              )}
            </div>
            <button className="button primary" type="submit" disabled={busy}>
              {busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
              {t(busy ? 'web.loggingIn' : 'web.login')}
              {!busy && <ArrowRight size={15} aria-hidden="true" />}
            </button>
          </form>
          <p className="web-login-device-note">{t('web.deviceHint')}</p>
        </div>
      </main>
    </div>
  );
}
