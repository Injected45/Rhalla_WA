import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Users, Search, RefreshCw, CheckCircle2, XCircle } from 'lucide-react';
import { contactApi, type Contact } from '../services/api';
import { useSessionsQuery } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { PageHeader } from '../components/PageHeader';
import './Contacts.css';

export function Contacts() {
  const { t } = useTranslation();
  useDocumentTitle(t('contacts.title'));

  const { data: allSessions = [] } = useSessionsQuery();
  const sessions = allSessions.filter(s => s.status === 'ready');
  const [session, setSession] = useState('');

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');

  const [checkNum, setCheckNum] = useState('');
  const [checkResult, setCheckResult] = useState<{ number: string; exists: boolean } | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (sessions.length > 0 && !session) setSession(sessions[0].id);
  }, [sessions, session]);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError('');
    try {
      const list = await contactApi.list(session);
      // Keep real WhatsApp users (have a number), drop groups/broadcast entries
      setContacts(list.filter(c => c.number && !c.id.endsWith('@g.us')));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setContacts([]);
    } finally {
      setLoading(false);
    }
  }, [session]);

  const runCheck = useCallback(async () => {
    const num = checkNum.replace(/[^0-9]/g, '');
    if (!session || !num) return;
    setChecking(true);
    setCheckResult(null);
    setError('');
    try {
      const res = await contactApi.check(session, num);
      setCheckResult({ number: res.number, exists: res.exists });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, [session, checkNum]);

  const q = query.trim().toLowerCase();
  const shown = q
    ? contacts.filter(
        c =>
          c.number.toLowerCase().includes(q) ||
          (c.name || '').toLowerCase().includes(q) ||
          (c.pushName || '').toLowerCase().includes(q),
      )
    : contacts;

  return (
    <div className="contacts-page">
      <PageHeader title={t('contacts.title')} subtitle={t('contacts.subtitle')} />

      <div className="filters-bar">
        <div className="filter-group">
          <select value={session} onChange={e => setSession(e.target.value)}>
            {sessions.length === 0 && <option value="">{t('contacts.noSessions')}</option>}
            {sessions.map(s => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.phone || '—'})
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="contacts-error">{error}</div>}

      {/* Check a number on WhatsApp */}
      <div className="contacts-card">
        <h2>{t('contacts.check.title')}</h2>
        <p className="contacts-hint">{t('contacts.check.hint')}</p>
        <div className="contacts-search-row">
          <input
            type="text"
            placeholder="201234567890"
            value={checkNum}
            onChange={e => setCheckNum(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && void runCheck()}
          />
          <button className="btn-primary" onClick={() => void runCheck()} disabled={!session || !checkNum.trim()}>
            {checking ? <Loader2 className="animate-spin" size={18} /> : <Search size={18} />}
            {t('contacts.check.button')}
          </button>
        </div>
        {checkResult && (
          <div className={`check-result ${checkResult.exists ? 'ok' : 'no'}`}>
            {checkResult.exists ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
            {checkResult.exists
              ? t('contacts.check.exists', { number: checkResult.number })
              : t('contacts.check.notExists', { number: checkResult.number })}
          </div>
        )}
      </div>

      {/* All contacts */}
      <div className="contacts-card">
        <div className="contacts-card-header">
          <h2>{t('contacts.all.title')}</h2>
          <button className="btn-secondary" onClick={() => void load()} disabled={!session}>
            {loading ? <Loader2 className="animate-spin" size={18} /> : <RefreshCw size={18} />}
            {t('contacts.all.button')}
          </button>
        </div>

        {contacts.length > 0 && (
          <div className="contacts-search-input">
            <Search size={16} />
            <input
              type="text"
              placeholder={t('contacts.all.search')}
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
            <span className="count">{shown.length}</span>
          </div>
        )}

        <div className="contacts-table">
          <div className="table-row header">
            <span>{t('contacts.all.number')}</span>
            <span>{t('contacts.all.name')}</span>
            <span>{t('contacts.all.pushName')}</span>
            <span>{t('contacts.all.saved')}</span>
          </div>
          {shown.length === 0 ? (
            <div className="empty-table-state">
              <Users size={48} strokeWidth={1} />
              <p>{t('contacts.all.empty')}</p>
            </div>
          ) : (
            shown.slice(0, 500).map(c => (
              <div key={c.id} className="table-row">
                <span className="mono">{c.number}</span>
                <span>{c.name || '—'}</span>
                <span>{c.pushName || '—'}</span>
                <span>{c.isMyContact ? t('contacts.all.yes') : '—'}</span>
              </div>
            ))
          )}
        </div>
        {shown.length > 500 && <p className="contacts-hint">{t('contacts.all.truncated', { count: shown.length })}</p>}
      </div>
    </div>
  );
}

export default Contacts;
