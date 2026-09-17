import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import type { LoginResult, UserRoleName } from '../services/api';
import './Login.css';

interface LoginProps {
  onLogin: (apiKey: string, role?: UserRoleName) => void;
}

export function Login({ onLogin }: LoginProps) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  /**
   * The API rejects a login for three different reasons and its messages are
   * English-only, so map the known ones onto translated strings and fall back
   * to whatever the server said.
   */
  const translateLoginError = (message?: string): string => {
    if (!message) return t('login.invalidCredentials');
    const lower = message.toLowerCase();
    if (lower.includes('subscription')) return t('login.subscriptionExpired');
    if (lower.includes('disabled')) return t('login.accountDisabled');
    if (lower.includes('invalid email or password')) return t('login.invalidCredentials');
    return message;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setError(t('login.emailRequired'));
      return;
    }
    if (!password.trim()) {
      setError(t('login.passwordRequired'));
      return;
    }
    setIsLoading(true);
    setError('');

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      if (response.ok) {
        const data = (await response.json()) as Partial<LoginResult>;
        if (data?.apiKey) {
          onLogin(data.apiKey, data.role);
        } else {
          setError(t('login.invalidCredentials'));
        }
      } else {
        const errorData = (await response.json().catch(() => ({}))) as { message?: string };
        setError(translateLoginError(errorData.message));
      }
    } catch {
      setError(t('login.connectionError'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo">
          <img src="/rhalla-logo.svg" alt="Rhalla Wa" className="logo-icon" />
          <span className="version-info">
            {t('login.version', {
              version: __APP_VERSION__,
              date: new Date(__BUILD_TIME__).toLocaleDateString(),
            })}
          </span>
        </div>
        <form onSubmit={handleSubmit} className="login-form">
          <div className="input-group">
            <label htmlFor="email">{t('login.email')}</label>
            <div className="input-wrapper">
              <input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder={t('login.emailPlaceholder')}
                className={error ? 'error' : ''}
              />
            </div>
          </div>

          <div className="input-group">
            <label htmlFor="password">{t('login.password')}</label>
            <div className="input-wrapper">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={t('login.passwordPlaceholder')}
                className={error ? 'error' : ''}
              />
              <button type="button" className="toggle-visibility" onClick={() => setShowPassword(!showPassword)}>
                {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
            {error && <span className="error-message">{error}</span>}
          </div>

          <button type="submit" className="connect-btn" disabled={isLoading}>
            {isLoading ? t('login.connecting') : t('login.connect')}
          </button>
        </form>
      </div>

      <footer className="login-footer">
        <span>{t('login.footer')}</span>
      </footer>
    </div>
  );
}
