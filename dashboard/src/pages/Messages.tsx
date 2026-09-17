import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RefreshCw,
  Loader2,
  MessageSquare,
  ArrowDownLeft,
  ArrowUpRight,
  Paperclip,
  CornerUpLeft,
  Forward,
  SmilePlus,
  Trash2,
  X,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { messageApi, type MessageRecord, type MessageReaction } from '../services/api';
import { useSessionsQuery } from '../hooks/queries';
import { useWebSocket } from '../hooks/useWebSocket';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import './Messages.css';

type DirectionFilter = 'all' | 'incoming' | 'outgoing';
type ActionType = 'reply' | 'forward' | 'delete';
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const KNOWN_STATUSES = ['sent', 'delivered', 'read'];
const PAGE_SIZE = 50;

export function Messages() {
  const { t } = useTranslation();
  useDocumentTitle(t('messages.title'));

  const toast = useToast();
  const { data: sessions = [] } = useSessionsQuery();
  const [session, setSession] = useState('');
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<DirectionFilter>('all');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  // Phase 1 message actions
  const [actionModal, setActionModal] = useState<{ type: ActionType; msg: MessageRecord } | null>(null);
  const [replyText, setReplyText] = useState('');
  const [forwardTarget, setForwardTarget] = useState('');
  const [deleteForEveryone, setDeleteForEveryone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reactFor, setReactFor] = useState<string | null>(null);
  const [reactions, setReactions] = useState<Record<string, MessageReaction[]>>({});
  const [loadingReactions, setLoadingReactions] = useState(false);

  // Default to the first session once sessions load
  useEffect(() => {
    if (sessions.length > 0 && !session) setSession(sessions[0].id);
  }, [sessions, session]);

  // Reset to the first page whenever the selected session changes
  useEffect(() => {
    setPage(1);
  }, [session]);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const res = await messageApi.history(session, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
      setMessages(res.messages);
      setTotal(res.total);
    } catch {
      setMessages([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [session, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live updates: prepend messages as they arrive for the selected session.
  // Only mutate the list while viewing the first (newest) page so pagination stays consistent.
  useWebSocket({
    onMessage: evt => {
      if (evt.sessionId !== session || page !== 1) return;
      const m = evt.message as {
        id?: string;
        chatId?: string;
        from?: string;
        to?: string;
        body?: string;
        type?: string;
        fromMe?: boolean;
        timestamp?: number;
        media?: { mimetype?: string; filename?: string; url?: string };
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
        metadata: m.media ? { media: m.media } : undefined,
      };
      setMessages(prev => {
        if (record.waMessageId && prev.some(p => p.waMessageId === record.waMessageId)) return prev;
        setTotal(tprev => tprev + 1);
        return [record, ...prev].slice(0, PAGE_SIZE);
      });
    },
  });

  const shown = messages.filter(m => filter === 'all' || m.direction === filter);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const formatTime = (m: MessageRecord) =>
    new Date(m.timestamp ? m.timestamp * 1000 : m.createdAt).toLocaleString();
  const numberOf = (jid: string) => (jid || '').replace(/@.*/, '') || '—';

  const renderBody = (m: MessageRecord) => {
    const media = m.metadata?.media;
    if (media?.url) {
      const isImage = (media.mimetype || '').startsWith('image/');
      return (
        <a className="media-link" href={media.url} target="_blank" rel="noreferrer" title={media.filename || media.url}>
          {isImage ? (
            <img className="media-thumb" src={media.url} alt={media.filename || 'media'} loading="lazy" />
          ) : (
            <>
              <Paperclip size={14} />
              {media.filename || t('messages.viewMedia')}
            </>
          )}
        </a>
      );
    }
    return m.body || '—';
  };

  // The backend message actions key off the real WhatsApp message id; the DB row
  // id (uuid) will never match in the engine, so actions require waMessageId.
  const waId = (m: MessageRecord) => m.waMessageId ?? '';
  const actionable = (m: MessageRecord) => !!m.waMessageId;
  const statusLabel = (s: string) => (KNOWN_STATUSES.includes(s) ? t(`messages.status.${s}`) : s);
  const chatOptions = Array.from(new Set(messages.map(m => m.chatId).filter(Boolean)));

  const openModal = (type: ActionType, msg: MessageRecord) => {
    setActionModal({ type, msg });
    setReplyText('');
    setForwardTarget('');
    setDeleteForEveryone(false);
  };

  const handleSubmit = async () => {
    if (!actionModal || !session) return;
    const { type, msg } = actionModal;
    setSubmitting(true);
    try {
      if (type === 'reply') {
        await messageApi.reply(session, msg.chatId, waId(msg), replyText);
        toast.success(t('messages.toasts.replySent'));
      } else if (type === 'forward') {
        await messageApi.forward(session, msg.chatId, forwardTarget, waId(msg));
        toast.success(t('messages.toasts.forwarded'));
      } else {
        await messageApi.deleteMessage(session, msg.chatId, waId(msg), deleteForEveryone);
        toast.success(t('messages.toasts.deleted'));
      }
      setActionModal(null);
      void load();
    } catch (err) {
      toast.error(t('messages.toasts.actionFailed'), err instanceof Error ? err.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  const fetchReactions = async (msg: MessageRecord) => {
    if (!session || !msg.waMessageId) return;
    setLoadingReactions(true);
    try {
      const r = await messageApi.getReactions(session, msg.chatId, msg.waMessageId);
      setReactions(prev => ({ ...prev, [msg.id]: r }));
    } catch {
      setReactions(prev => ({ ...prev, [msg.id]: [] }));
    } finally {
      setLoadingReactions(false);
    }
  };

  const toggleReactPopover = (msg: MessageRecord) => {
    if (reactFor === msg.id) {
      setReactFor(null);
      return;
    }
    setReactFor(msg.id);
    void fetchReactions(msg);
  };

  const doReact = async (msg: MessageRecord, emoji: string) => {
    if (!session || !msg.waMessageId) return;
    try {
      await messageApi.react(session, msg.chatId, msg.waMessageId, emoji);
      toast.success(emoji ? t('messages.toasts.reacted') : t('messages.toasts.reactionRemoved'));
      await fetchReactions(msg);
    } catch (err) {
      toast.error(t('messages.toasts.actionFailed'), err instanceof Error ? err.message : undefined);
    }
  };

  const submitDisabled =
    submitting ||
    (actionModal?.type === 'reply' && !replyText.trim()) ||
    (actionModal?.type === 'forward' && !forwardTarget);

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
            <span>{t('messages.columns.actions')}</span>
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
                <span className="direction-cell">
                  <span className={`direction-badge ${m.direction}`}>
                    {m.direction === 'incoming' ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}
                    {t(`messages.direction.${m.direction}`)}
                  </span>
                  {m.status && <span className={`msg-status ${m.status}`}>{statusLabel(m.status)}</span>}
                </span>
                <span className="jid">{numberOf(m.from)}</span>
                <span className="jid">{numberOf(m.to)}</span>
                <span>
                  <span className="type-badge">{m.type}</span>
                </span>
                <span className="body" title={m.body}>
                  {renderBody(m)}
                </span>
                <span className="msg-actions">
                  {reactions[m.id] && reactions[m.id].length > 0 && (
                    <div className="msg-reactions-inline">
                      {reactions[m.id].map(r => (
                        <button
                          key={r.emoji}
                          className="reaction-chip"
                          title={t('messages.actions.removeReaction')}
                          onClick={() => void doReact(m, '')}
                        >
                          {r.emoji}
                          {r.senders.length > 1 ? ` ${r.senders.length}` : ''}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="msg-action-buttons">
                  <button
                    className="msg-action-btn"
                    title={actionable(m) ? t('messages.actions.reply') : t('messages.actions.unavailable')}
                    onClick={() => openModal('reply', m)}
                    disabled={!actionable(m)}
                  >
                    <CornerUpLeft size={15} />
                  </button>
                  <button
                    className="msg-action-btn"
                    title={actionable(m) ? t('messages.actions.forward') : t('messages.actions.unavailable')}
                    onClick={() => openModal('forward', m)}
                    disabled={!actionable(m)}
                  >
                    <Forward size={15} />
                  </button>
                  <div className="react-wrap">
                    <button
                      className="msg-action-btn"
                      title={actionable(m) ? t('messages.actions.react') : t('messages.actions.unavailable')}
                      onClick={() => toggleReactPopover(m)}
                      disabled={!actionable(m)}
                    >
                      <SmilePlus size={15} />
                    </button>
                    {reactFor === m.id && (
                      <div className="react-popover">
                        <div className="react-emoji-row">
                          {REACTIONS.map(emoji => (
                            <button key={emoji} className="react-emoji" onClick={() => void doReact(m, emoji)}>
                              {emoji}
                            </button>
                          ))}
                        </div>
                        <div className="react-current">
                          {loadingReactions ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : reactions[m.id] && reactions[m.id].length > 0 ? (
                            <>
                              <span className="react-current-list">
                                {reactions[m.id].map(r => (
                                  <span key={r.emoji} className="react-current-emoji">
                                    {r.emoji}
                                    {r.senders.length > 1 ? ` ${r.senders.length}` : ''}
                                  </span>
                                ))}
                              </span>
                              <button className="react-remove-btn" onClick={() => void doReact(m, '')}>
                                <X size={12} />
                                {t('messages.actions.removeReaction')}
                              </button>
                            </>
                          ) : (
                            <span className="react-none">{t('messages.actions.noReactions')}</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <button
                    className="msg-action-btn danger"
                    title={actionable(m) ? t('messages.actions.delete') : t('messages.actions.unavailable')}
                    onClick={() => openModal('delete', m)}
                    disabled={!actionable(m)}
                  >
                    <Trash2 size={15} />
                  </button>
                  </div>
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {total > 0 && (
        <div className="messages-pagination">
          <button
            className="btn-secondary"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
          >
            <ChevronLeft size={16} />
            {t('messages.pagination.prev')}
          </button>
          <span className="pagination-info">{t('messages.pagination.pageOf', { page, total: totalPages })}</span>
          <button
            className="btn-secondary"
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || loading}
          >
            {t('messages.pagination.next')}
            <ChevronRight size={16} />
          </button>
          <span className="pagination-total">{t('messages.pagination.total', { count: total })}</span>
        </div>
      )}

      {actionModal && (
        <div className="modal-overlay" onClick={() => !submitting && setActionModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t(`messages.actions.${actionModal.type}`)}</h2>
              <button className="btn-icon" onClick={() => setActionModal(null)} disabled={submitting}>
                <X size={20} />
              </button>
            </div>

            <div className="modal-body">
              {actionModal.type === 'reply' && (
                <div className="form-group">
                  <label>{t('messages.modal.replyLabel')}</label>
                  <textarea
                    rows={3}
                    value={replyText}
                    onChange={e => setReplyText(e.target.value)}
                    placeholder={t('messages.modal.replyPlaceholder')}
                  />
                </div>
              )}

              {actionModal.type === 'forward' && (
                <div className="form-group">
                  <label>{t('messages.modal.forwardLabel')}</label>
                  <select value={forwardTarget} onChange={e => setForwardTarget(e.target.value)}>
                    <option value="">{t('messages.modal.forwardPlaceholder')}</option>
                    {chatOptions
                      .filter(c => c !== actionModal.msg.chatId)
                      .map(c => (
                        <option key={c} value={c}>
                          {numberOf(c)}
                        </option>
                      ))}
                  </select>
                </div>
              )}

              {actionModal.type === 'delete' && (
                <>
                  <p className="modal-confirm-text">{t('messages.modal.deleteConfirm')}</p>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={deleteForEveryone}
                      onChange={e => setDeleteForEveryone(e.target.checked)}
                    />
                    {t('messages.modal.deleteForEveryone')}
                  </label>
                </>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setActionModal(null)} disabled={submitting}>
                {t('common.cancel')}
              </button>
              <button
                className={actionModal.type === 'delete' ? 'btn-danger' : 'btn-primary'}
                onClick={() => void handleSubmit()}
                disabled={submitDisabled}
              >
                {submitting ? <Loader2 size={16} className="animate-spin" /> : t(`messages.actions.${actionModal.type}`)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Messages;
