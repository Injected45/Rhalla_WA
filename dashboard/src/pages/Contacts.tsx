import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Users, Search, RefreshCw, CheckCircle2, XCircle, Tag, Plus, X, Code2 } from 'lucide-react';
import { contactApi, labelApi, type Contact, type Label } from '../services/api';
import { useSessionsQuery } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { ApiCodeDialog, type ApiRequestDescriptor } from '../components/ApiCodeDialog';
import './Contacts.css';

export function Contacts() {
  const { t } = useTranslation();
  useDocumentTitle(t('contacts.title'));
  const toast = useToast();

  const { data: allSessions = [] } = useSessionsQuery();
  const sessions = allSessions.filter(s => s.status === 'ready');
  const [session, setSession] = useState('');

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');

  const [checkNum, setCheckNum] = useState('');
  const [checkResult, setCheckResult] = useState<{
    number: string;
    exists: boolean;
    whatsappId: string | null;
    profilePicUrl: string | null;
    profilePicLoading: boolean;
  } | null>(null);
  const [checking, setChecking] = useState(false);

  // Phase 4: labels (WhatsApp Business)
  const [labels, setLabels] = useState<Label[]>([]);
  const [labelsLoaded, setLabelsLoaded] = useState(false);
  const [loadingLabels, setLoadingLabels] = useState(false);
  const [labelChatId, setLabelChatId] = useState('');
  const [chatLabels, setChatLabels] = useState<Label[] | null>(null);
  const [loadingChatLabels, setLoadingChatLabels] = useState(false);
  const [addLabelId, setAddLabelId] = useState('');
  const [labelBusy, setLabelBusy] = useState(false);

  const [apiDialog, setApiDialog] = useState<ApiRequestDescriptor | null>(null);
  const sid = session || 'SESSION_ID';

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
      // Show the true/false result first so the user isn't waiting on the picture fetch
      setCheckResult({
        number: res.number,
        exists: res.exists,
        whatsappId: res.whatsappId,
        profilePicUrl: null,
        profilePicLoading: res.exists && !!res.whatsappId,
      });
      if (res.exists && res.whatsappId) {
        // Best-effort — profile pictures are private for many users; on error/null
        // we just fall back to the initials avatar the CSS renders.
        contactApi
          .getProfilePicture(session, res.whatsappId)
          .then(({ url }) => {
            setCheckResult(prev =>
              prev && prev.number === res.number
                ? { ...prev, profilePicUrl: url, profilePicLoading: false }
                : prev,
            );
          })
          .catch(() => {
            setCheckResult(prev =>
              prev && prev.number === res.number
                ? { ...prev, profilePicUrl: null, profilePicLoading: false }
                : prev,
            );
          });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, [session, checkNum]);

  const loadLabels = useCallback(async () => {
    if (!session) return;
    setLoadingLabels(true);
    setError('');
    try {
      setLabels(await labelApi.list(session));
      setLabelsLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingLabels(false);
    }
  }, [session]);

  const loadChatLabels = useCallback(async () => {
    const chatId = labelChatId.trim();
    if (!session || !chatId) return;
    setLoadingChatLabels(true);
    setError('');
    setChatLabels(null);
    try {
      setChatLabels(await labelApi.chatLabels(session, chatId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingChatLabels(false);
    }
  }, [session, labelChatId]);

  const addLabel = async () => {
    if (!session || !addLabelId || !labelChatId.trim()) return;
    setLabelBusy(true);
    try {
      await labelApi.addToChat(session, labelChatId.trim(), addLabelId);
      toast.success(t('contacts.labels.toasts.added'));
      setAddLabelId('');
      await loadChatLabels();
    } catch (e) {
      toast.error(t('contacts.labels.toasts.failed'), e instanceof Error ? e.message : undefined);
    } finally {
      setLabelBusy(false);
    }
  };

  const removeLabel = async (labelId: string) => {
    if (!session || !labelChatId.trim()) return;
    setLabelBusy(true);
    try {
      await labelApi.removeFromChat(session, labelChatId.trim(), labelId);
      toast.success(t('contacts.labels.toasts.removed'));
      await loadChatLabels();
    } catch (e) {
      toast.error(t('contacts.labels.toasts.failed'), e instanceof Error ? e.message : undefined);
    } finally {
      setLabelBusy(false);
    }
  };

  const assignableLabels = labels.filter(l => !(chatLabels || []).some(cl => cl.id === l.id));

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
        <div className="card-title-row">
          <h2>{t('contacts.check.title')}</h2>
          <button
            className="dev-api-btn"
            title={t('apiCode.dev')}
            onClick={() =>
              setApiDialog({
                method: 'GET',
                path: `/sessions/${sid}/contacts/check/${encodeURIComponent(checkNum.replace(/[^0-9]/g, '') || ':number')}`,
                title: t('contacts.check.title'),
              })
            }
          >
            <Code2 size={16} />
          </button>
        </div>
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
          <div className={`check-result-row ${checkResult.exists ? 'ok' : 'no'}`}>
            <div className="check-avatar">
              {checkResult.profilePicLoading ? (
                <Loader2 className="animate-spin" size={24} />
              ) : checkResult.profilePicUrl ? (
                <img src={checkResult.profilePicUrl} alt="" onError={e => (e.currentTarget.style.display = 'none')} />
              ) : (
                <span className="check-avatar-fallback">
                  {checkResult.exists ? checkResult.number.slice(-2) : '?'}
                </span>
              )}
            </div>
            <div className="check-result-body">
              <div className="check-result-status">
                {checkResult.exists ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                <span>
                  {checkResult.exists
                    ? t('contacts.check.exists', { number: checkResult.number })
                    : t('contacts.check.notExists', { number: checkResult.number })}
                </span>
              </div>
              <div className="check-result-detail">
                <span className="check-result-label">{t('contacts.check.resultLabel')}</span>
                <code className={`check-bool ${checkResult.exists ? 'ok' : 'no'}`}>
                  {String(checkResult.exists)}
                </code>
                {checkResult.whatsappId && (
                  <span className="check-wid">{checkResult.whatsappId}</span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Labels (WhatsApp Business) */}
      <div className="contacts-card">
        <div className="contacts-card-header">
          <h2>{t('contacts.labels.title')}</h2>
          <div className="card-header-actions">
            <button
              className="dev-api-btn"
              title={t('apiCode.dev')}
              onClick={() => setApiDialog({ method: 'GET', path: `/sessions/${sid}/labels`, title: t('contacts.labels.title') })}
            >
              <Code2 size={16} />
            </button>
            <button className="btn-secondary" onClick={() => void loadLabels()} disabled={!session}>
              {loadingLabels ? <Loader2 className="animate-spin" size={18} /> : <Tag size={18} />}
              {t('contacts.labels.loadButton')}
            </button>
          </div>
        </div>
        <p className="contacts-hint">{t('contacts.labels.hint')}</p>

        {labelsLoaded &&
          (labels.length === 0 ? (
            <p className="contacts-hint">{t('contacts.labels.none')}</p>
          ) : (
            <div className="label-list">
              {labels.map(l => (
                <span key={l.id} className="label-chip" style={{ borderColor: l.hexColor, color: l.hexColor }}>
                  <Tag size={12} />
                  {l.name}
                </span>
              ))}
            </div>
          ))}

        <div className="label-chat-manager">
          <div className="contacts-search-row">
            <input
              type="text"
              placeholder="120363xxxx@g.us / 62812xxxx@c.us"
              value={labelChatId}
              onChange={e => setLabelChatId(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && void loadChatLabels()}
            />
            <button
              className="btn-primary"
              onClick={() => void loadChatLabels()}
              disabled={!session || !labelChatId.trim()}
            >
              {loadingChatLabels ? <Loader2 className="animate-spin" size={18} /> : <Search size={18} />}
              {t('contacts.labels.viewButton')}
            </button>
          </div>

          {chatLabels && (
            <div className="chat-labels-box">
              <label className="label-section-label">{t('contacts.labels.chatLabels')}</label>
              {chatLabels.length === 0 ? (
                <p className="contacts-hint">{t('contacts.labels.noChatLabels')}</p>
              ) : (
                <div className="label-list">
                  {chatLabels.map(l => (
                    <span key={l.id} className="label-chip" style={{ borderColor: l.hexColor, color: l.hexColor }}>
                      <Tag size={12} />
                      {l.name}
                      <button
                        className="label-remove"
                        title={t('contacts.labels.remove')}
                        onClick={() => void removeLabel(l.id)}
                        disabled={labelBusy}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {labels.length > 0 && (
                <div className="label-add-row">
                  <select value={addLabelId} onChange={e => setAddLabelId(e.target.value)}>
                    <option value="">{t('contacts.labels.selectLabel')}</option>
                    {assignableLabels.map(l => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                  <button className="btn-primary" onClick={() => void addLabel()} disabled={!addLabelId || labelBusy}>
                    <Plus size={16} />
                    {t('contacts.labels.addButton')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* All contacts */}
      <div className="contacts-card">
        <div className="contacts-card-header">
          <h2>{t('contacts.all.title')}</h2>
          <div className="card-header-actions">
            <button
              className="dev-api-btn"
              title={t('apiCode.dev')}
              onClick={() => setApiDialog({ method: 'GET', path: `/sessions/${sid}/contacts`, title: t('contacts.all.title') })}
            >
              <Code2 size={16} />
            </button>
            <button className="btn-secondary" onClick={() => void load()} disabled={!session}>
              {loading ? <Loader2 className="animate-spin" size={18} /> : <RefreshCw size={18} />}
              {t('contacts.all.button')}
            </button>
          </div>
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

      <ApiCodeDialog request={apiDialog} onClose={() => setApiDialog(null)} />
    </div>
  );
}

export default Contacts;
