import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Loader2, MessageSquare, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { messageApi, type MessageRecord } from '../services/api';
import { useSessionsQuery } from '../hooks/queries';
import { useWebSocket } from '../hooks/useWebSocket';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { PageHeader } from '../components/PageHeader';
import './Messages.css';

type DirectionFilter = 'all' | 'incoming' | 'outgoing';

export function Messages() {
  const { t } = useTranslation();
  useDocumentTitle(t('messages.title'));

  const { data: sessions = [] } = useSessionsQuery();
  const [session, setSession] = useState('');
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<DirectionFilter>('all');

  // Default to the first session once sessions load
  useEffect(() => {
    if (sessions.length > 0 && !session) setSession(sessions[0].id);
  }, [sessions, session]);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const res = await messageApi.history(session, { limit: 100 });
      setMessages(res.messages);
    } catch {
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live updates: prepend messages as they arrive for the selected session
  useWebSocket({
    onMessage: evt => {
      if (evt.sessionId !== session) return;
      const m = evt.message as {
        id?: string;
        chatId?: string;
        from?: string;
        to?: string;
        body?: string;
        type?: string;
        fromMe?: boolean;
        timestamp?: number;
      };
      const record: MessageRecord = {
        id: String(m.id ?? `${Date.now()}-${Math.random()}`),
        sessionId: evt.sessionId,
        waMessageId: m.id,
        chatId: String(m.chatId ?? ''),
        from: String(m.from ?? ''),
        to: String(m.to ?? ''),
        body: String(m.body ?? ''),
        type: String(m.type ?? 'text'),
        direction: m.fromMe ? 'outgoing' : 'incoming',
        status: m.fromMe ? 'sent' : 'delivered',
        timestamp: m.timestamp,
        createdAt: new Date().toISOString(),
      };
      setMessages(prev => {
        if (record.waMessageId && prev.some(p => p.waMessageId === record.waMessageId)) return prev;
        return [record, ...prev].slice(0, 300);
      });
    },
  });

  const shown = messages.filter(m => filter === 'all' || m.direction === filter);
  const formatTime = (m: MessageRecord) =>
    new Date(m.timestamp ? m.timestamp * 1000 : m.createdAt).toLocaleString();
  const numberOf = (jid: string) => (jid || '').replace(/@.*/, '') || '—';

  return (
    <div className="messages-page">
      <PageHeader
        title={t('messages.title')}
        subtitle={t('messages.subtitle')}
        actions={
          <button className="btn-secondary" onClick={() => void load()} disabled={!session}>
            <RefreshCw size={18} />
            {t('messages.refresh')}
          </button>
        }
      />

      <div className="filters-bar">
        <div className="filter-group">
          <select value={session} onChange={e => setSession(e.target.value)}>
            {sessions.length === 0 && <option value="">{t('messages.noSessions')}</option>}
            {sessions.map(s => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.phone || '—'})
              </option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <select value={filter} onChange={e => setFilter(e.target.value as DirectionFilter)}>
            <option value="all">{t('messages.filter.all')}</option>
            <option value="incoming">{t('messages.filter.incoming')}</option>
            <option value="outgoing">{t('messages.filter.outgoing')}</option>
          </select>
        </div>
      </div>

      <div className="messages-table-container">
        <div className="messages-table">
          <div className="table-row header">
            <span>{t('messages.columns.time')}</span>
            <span>{t('messages.columns.direction')}</span>
            <span>{t('messages.columns.from')}</span>
            <span>{t('messages.columns.to')}</span>
            <span>{t('messages.columns.type')}</span>
            <span>{t('messages.columns.body')}</span>
          </div>

          {loading && messages.length === 0 ? (
            <div className="empty-table-state">
              <Loader2 className="animate-spin" size={32} />
            </div>
          ) : shown.length === 0 ? (
            <div className="empty-table-state">
              <MessageSquare size={48} strokeWidth={1} />
              <h3>{t('messages.empty.title')}</h3>
              <p>{t('messages.empty.description')}</p>
            </div>
          ) : (
            shown.map(m => (
              <div key={m.id} className="table-row">
                <span className="timestamp">{formatTime(m)}</span>
                <span>
                  <span className={`direction-badge ${m.direction}`}>
                    {m.direction === 'incoming' ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}
                    {t(`messages.direction.${m.direction}`)}
                  </span>
                </span>
                <span className="jid">{numberOf(m.from)}</span>
                <span className="jid">{numberOf(m.to)}</span>
                <span>
                  <span className="type-badge">{m.type}</span>
                </span>
                <span className="body" title={m.body}>
                  {m.body || '—'}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default Messages;
