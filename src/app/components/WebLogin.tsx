/**
 * 功能：提供远程多账号登录界面，凭证仅提交给同源服务端。
 * 作者：xuanli
 * 创建时间：2026-10-25 23:38:56
 */
import { useState } from 'react';
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
  return (
    <div className="boot">
      <Logo size={36} />
      <h1>{t('web.loginTitle')}</h1>
      <p className="boot-text">{t('web.loginHelp')}</p>
      <form
        className="web-login"
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
              setError(reason instanceof Error ? localizeError(reason.message) : t('web.requestFailed'));
            })
            .finally(() => setBusy(false));
        }}
      >
        <label>
          {t('web.username')}
          <input
            className="input"
            autoComplete="username"
            required
            maxLength={48}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label>
          {t('web.password')}
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button className="button primary" type="submit" disabled={busy}>
          {t(busy ? 'web.loggingIn' : 'web.login')}
        </button>
      </form>
    </div>
  );
}
