import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Radio, RefreshCw, Plus, Trash2, MessageSquare, BadgeCheck, X, Code2 } from 'lucide-react';
import { channelApi, type Channel, type ChannelMessage } from '../services/api';
import { useSessionsQuery } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { ApiCodeDialog, type ApiRequestDescriptor } from '../components/ApiCodeDialog';
import './Channels.css';

export function Channels() {
  const { t } = useTranslation();
  useDocumentTitle(t('channels.title'));
  const toast = useToast();

  const { data: allSessions = [] } = useSessionsQuery();
  const sessions = allSessions.filter(s => s.status === 'ready');
  const [session, setSession] = useState('');

  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [inviteCode, setInviteCode] = useState('');
  const [subscribing, setSubscribing] = useState(false);

  const [messagesFor, setMessagesFor] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);

  const [unsubTarget, setUnsubTarget] = useState<Channel | null>(null);
  const [unsubscribing, setUnsubscribing] = useState(false);

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
      setChannels(await channelApi.list(session));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setChannels([]);
    } finally {
      setLoading(false);
    }
  }, [session]);

  const subscribe = async () => {
    if (!session || !inviteCode.trim()) return;
    setSubscribing(true);
    try {
      await channelApi.subscribe(session, inviteCode.trim());
      toast.success(t('channels.toasts.subscribed'));
      setInviteCode('');
      void load();
    } catch (e) {
      toast.error(t('channels.toasts.failed'), e instanceof Error ? e.message : undefined);
    } finally {
      setSubscribing(false);
    }
  };

  const viewMessages = async (channelId: string) => {
    if (messagesFor === channelId) {
      setMessagesFor(null);
      return;
    }
    setMessagesFor(channelId);
    setMessages([]);
    setLoadingMessages(true);
    try {
      setMessages(await channelApi.messages(session, channelId, 50));
    } catch (e) {
      toast.error(t('channels.toasts.failed'), e instanceof Error ? e.message : undefined);
      setMessagesFor(null);
    } finally {
      setLoadingMessages(false);
    }
  };

  const confirmUnsubscribe = async () => {
    if (!session || !unsubTarget) return;
    setUnsubscribing(true);
    try {
      await channelApi.unsubscribe(session, unsubTarget.id);
      toast.success(t('channels.toasts.unsubscribed'));
      setUnsubTarget(null);
      if (messagesFor === unsubTarget.id) setMessagesFor(null);
      void load();
    } catch (e) {
      toast.error(t('channels.toasts.failed'), e instanceof Error ? e.message : undefined);
    } finally {
      setUnsubscribing(false);
    }
  };

  return (
    <div className="channels-page">
      <PageHeader title={t('channels.title')} subtitle={t('channels.subtitle')} />

      <div className="filters-bar">
        <div className="filter-group">
          <select value={session} onChange={e => setSession(e.target.value)}>
            {sessions.length === 0 && <option value="">{t('channels.noSessions')}</option>}
            {sessions.map(s => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.phone || '—'})
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="page-error">{error}</div>}

      {/* Subscribe */}
      <div className="page-card">
        <div className="card-title-row">
          <h2>{t('channels.subscribe.title')}</h2>
          <button
            className="dev-api-btn"
            title={t('apiCode.dev')}
            onClick={() =>
              setApiDialog({
                method: 'POST',
                path: `/sessions/${sid}/channels/subscribe`,
                body: { inviteCode },
                title: t('channels.subscribe.title'),
              })
            }
          >
            <Code2 size={16} />
          </button>
        </div>
        <p className="page-hint">{t('channels.subscribe.hint')}</p>
        <div className="page-row">
          <input
            type="text"
            placeholder={t('channels.subscribe.placeholder')}
            value={inviteCode}
            onChange={e => setInviteCode(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && void subscribe()}
          />
          <button className="btn-primary" onClick={() => void subscribe()} disabled={!session || !inviteCode.trim() || subscribing}>
            {subscribing ? <Loader2 className="animate-spin" size={18} /> : <Plus size={18} />}
            {t('channels.subscribe.button')}
          </button>
        </div>
      </div>

      {/* Subscribed channels */}
      <div className="page-card">
        <div className="page-card-header">
          <h2>{t('channels.list.title')}</h2>
          <div className="card-header-actions">
            <button
              className="dev-api-btn"
              title={t('apiCode.dev')}
              onClick={() => setApiDialog({ method: 'GET', path: `/sessions/${sid}/channels`, title: t('channels.list.title') })}
            >
              <Code2 size={16} />
            </button>
            <button className="btn-secondary" onClick={() => void load()} disabled={!session}>
              {loading ? <Loader2 className="animate-spin" size={18} /> : <RefreshCw size={18} />}
              {t('channels.list.button')}
            </button>
          </div>
        </div>

        {channels.length === 0 ? (
          <div className="empty-state-box">
            <Radio size={48} strokeWidth={1} />
            <p>{t('channels.list.empty')}</p>
          </div>
        ) : (
          <div className="channel-grid">
            {channels.map(c => (
              <div key={c.id} className="channel-card">
                <div className="channel-card-head">
                  <div className="channel-name">
                    {c.name || '—'}
                    {c.verified && <BadgeCheck size={15} className="verified" />}
                  </div>
                  {c.subscriberCount != null && (
                    <span className="channel-subs">{t('channels.list.subscribers', { count: c.subscriberCount })}</span>
                  )}
                </div>
                {c.description && <p className="channel-desc">{c.description}</p>}
                <div className="channel-actions">
                  <button className="btn-secondary" onClick={() => void viewMessages(c.id)}>
                    <MessageSquare size={15} />
                    {messagesFor === c.id ? t('channels.list.hideMessages') : t('channels.list.viewMessages')}
                  </button>
                  <button className="btn-secondary danger" onClick={() => setUnsubTarget(c)}>
                    <Trash2 size={15} />
                    {t('channels.list.unsubscribe')}
                  </button>
                </div>

                {messagesFor === c.id && (
                  <div className="channel-messages">
                    {loadingMessages ? (
                      <div className="channel-messages-loading">
                        <Loader2 className="animate-spin" size={20} />
                      </div>
                    ) : messages.length === 0 ? (
                      <p className="page-hint">{t('channels.list.noMessages')}</p>
                    ) : (
                      messages.map(m => (
                        <div key={m.id} className="channel-message">
                          <span className="channel-message-time">{new Date(m.timestamp * 1000).toLocaleString()}</span>
                          <span className="channel-message-body">
                            {m.body || (m.hasMedia ? t('channels.list.mediaMessage') : '—')}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {unsubTarget && (
        <div className="modal-overlay" onClick={() => !unsubscribing && setUnsubTarget(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('channels.list.unsubscribe')}</h2>
              <button className="btn-icon" onClick={() => setUnsubTarget(null)} disabled={unsubscribing}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <p>{t('channels.unsubscribeConfirm', { name: unsubTarget.name })}</p>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setUnsubTarget(null)} disabled={unsubscribing}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={() => void confirmUnsubscribe()} disabled={unsubscribing}>
                {unsubscribing ? <Loader2 size={16} className="animate-spin" /> : t('channels.list.unsubscribe')}
              </button>
            </div>
          </div>
        </div>
      )}

      <ApiCodeDialog request={apiDialog} onClose={() => setApiDialog(null)} />
    </div>
  );
}

export default Channels;
