import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, CircleDashed, RefreshCw, Send, Trash2, X, Code2 } from 'lucide-react';
import { statusApi, type ContactStatus } from '../services/api';
import { useSessionsQuery } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { ApiCodeDialog, type ApiRequestDescriptor } from '../components/ApiCodeDialog';
import './Status.css';

type StatusType = 'text' | 'image' | 'video';
const statusTypes: StatusType[] = ['text', 'image', 'video'];

export function Status() {
  const { t } = useTranslation();
  useDocumentTitle(t('status.title'));
  const toast = useToast();

  const { data: allSessions = [] } = useSessionsQuery();
  const sessions = allSessions.filter(s => s.status === 'ready');
  const [session, setSession] = useState('');

  const [statuses, setStatuses] = useState<ContactStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Post status
  const [postType, setPostType] = useState<StatusType>('text');
  const [text, setText] = useState('');
  const [backgroundColor, setBackgroundColor] = useState('#25d366');
  const [font, setFont] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [caption, setCaption] = useState('');
  const [posting, setPosting] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<ContactStatus | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [apiDialog, setApiDialog] = useState<ApiRequestDescriptor | null>(null);
  const sid = session || 'SESSION_ID';

  const postRequest = (): ApiRequestDescriptor => {
    const base = `/sessions/${sid}/status`;
    if (postType === 'text') {
      return {
        method: 'POST',
        path: `${base}/send-text`,
        body: { text, backgroundColor, font: font ? Number(font) : undefined },
        title: t('status.post.title'),
      };
    }
    return {
      method: 'POST',
      path: `${base}/send-${postType}`,
      body: { [postType]: mediaUrl, caption },
      title: t('status.post.title'),
    };
  };

  useEffect(() => {
    if (sessions.length > 0 && !session) setSession(sessions[0].id);
  }, [sessions, session]);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError('');
    try {
      const res = await statusApi.list(session);
      setStatuses(res.statuses);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatuses([]);
    } finally {
      setLoading(false);
    }
  }, [session]);

  const post = async () => {
    if (!session) return;
    setPosting(true);
    try {
      if (postType === 'text') {
        await statusApi.sendText(session, text, backgroundColor || undefined, font ? Number(font) : undefined);
      } else if (postType === 'image') {
        await statusApi.sendImage(session, mediaUrl, caption || undefined);
      } else {
        await statusApi.sendVideo(session, mediaUrl, caption || undefined);
      }
      toast.success(t('status.toasts.posted'));
      setText('');
      setMediaUrl('');
      setCaption('');
    } catch (e) {
      toast.error(t('status.toasts.failed'), e instanceof Error ? e.message : undefined);
    } finally {
      setPosting(false);
    }
  };

  const confirmDelete = async () => {
    if (!session || !deleteTarget) return;
    setDeleting(true);
    try {
      await statusApi.remove(session, deleteTarget.id);
      toast.success(t('status.toasts.deleted'));
      setDeleteTarget(null);
      void load();
    } catch (e) {
      toast.error(t('status.toasts.failed'), e instanceof Error ? e.message : undefined);
    } finally {
      setDeleting(false);
    }
  };

  const postDisabled = posting || (postType === 'text' ? !text.trim() : !mediaUrl.trim());

  return (
    <div className="status-page">
      <PageHeader title={t('status.title')} subtitle={t('status.subtitle')} />

      <div className="filters-bar">
        <div className="filter-group">
          <select value={session} onChange={e => setSession(e.target.value)}>
            {sessions.length === 0 && <option value="">{t('status.noSessions')}</option>}
            {sessions.map(s => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.phone || '—'})
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="page-error">{error}</div>}

      {/* Post a status */}
      <div className="page-card">
        <div className="card-title-row">
          <h2>{t('status.post.title')}</h2>
          <button className="dev-api-btn" title={t('apiCode.dev')} onClick={() => setApiDialog(postRequest())}>
            <Code2 size={16} />
          </button>
        </div>
        <p className="page-hint">{t('status.post.hint')}</p>

        <div className="status-type-toggle">
          {statusTypes.map(ty => (
            <button key={ty} className={postType === ty ? 'active' : ''} onClick={() => setPostType(ty)}>
              {t(`status.post.types.${ty}`)}
            </button>
          ))}
        </div>

        {postType === 'text' ? (
          <>
            <div className="form-group">
              <label>{t('status.post.text')}</label>
              <textarea rows={3} value={text} onChange={e => setText(e.target.value)} />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>{t('status.post.backgroundColor')}</label>
                <input type="text" value={backgroundColor} onChange={e => setBackgroundColor(e.target.value)} placeholder="#25d366" />
              </div>
              <div className="form-group">
                <label>
                  {t('status.post.font')} ({t('common.optional')})
                </label>
                <input type="number" value={font} onChange={e => setFont(e.target.value)} placeholder="0" />
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="form-group">
              <label>{t('status.post.mediaUrl')}</label>
              <input type="text" value={mediaUrl} onChange={e => setMediaUrl(e.target.value)} placeholder="https://example.com/file" />
            </div>
            <div className="form-group">
              <label>
                {t('status.post.caption')} ({t('common.optional')})
              </label>
              <input type="text" value={caption} onChange={e => setCaption(e.target.value)} />
            </div>
          </>
        )}

        <button className="btn-primary" onClick={() => void post()} disabled={!session || postDisabled}>
          {posting ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
          {t('status.post.button')}
        </button>
      </div>

      {/* Status updates */}
      <div className="page-card">
        <div className="page-card-header">
          <h2>{t('status.list.title')}</h2>
          <div className="card-header-actions">
            <button
              className="dev-api-btn"
              title={t('apiCode.dev')}
              onClick={() => setApiDialog({ method: 'GET', path: `/sessions/${sid}/status`, title: t('status.list.title') })}
            >
              <Code2 size={16} />
            </button>
            <button className="btn-secondary" onClick={() => void load()} disabled={!session}>
              {loading ? <Loader2 className="animate-spin" size={18} /> : <RefreshCw size={18} />}
              {t('status.list.button')}
            </button>
          </div>
        </div>

        {statuses.length === 0 ? (
          <div className="empty-state-box">
            <CircleDashed size={48} strokeWidth={1} />
            <p>{t('status.list.empty')}</p>
          </div>
        ) : (
          <div className="status-list">
            {statuses.map(s => (
              <div key={s.id} className="status-item">
                <div className="status-meta">
                  <span className="status-contact">{s.contact?.name || s.contact?.pushName || s.contact?.id || '—'}</span>
                  <span className={`status-type-badge ${s.type}`}>{t(`status.post.types.${s.type}`)}</span>
                </div>
                <span className="status-caption">{s.caption || (s.type === 'text' ? '' : t('status.list.media'))}</span>
                <span className="status-time">{s.timestamp ? new Date(s.timestamp).toLocaleString() : '—'}</span>
                <button className="icon-btn danger" title={t('status.list.delete')} onClick={() => setDeleteTarget(s)}>
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {deleteTarget && (
        <div className="modal-overlay" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('status.list.delete')}</h2>
              <button className="btn-icon" onClick={() => setDeleteTarget(null)} disabled={deleting}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <p>{t('status.deleteConfirm')}</p>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setDeleteTarget(null)} disabled={deleting}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={() => void confirmDelete()} disabled={deleting}>
                {deleting ? <Loader2 size={16} className="animate-spin" /> : t('status.list.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      <ApiCodeDialog request={apiDialog} onClose={() => setApiDialog(null)} />
    </div>
  );
}

export default Status;
