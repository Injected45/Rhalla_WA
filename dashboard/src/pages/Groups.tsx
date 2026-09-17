import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Loader2,
  Users,
  Search,
  RefreshCw,
  Shield,
  Crown,
  Plus,
  UserPlus,
  UserMinus,
  Pencil,
  LogOut,
  Link as LinkIcon,
  ArrowUp,
  ArrowDown,
  X,
  Code2,
} from 'lucide-react';
import {
  groupApi,
  messageApi,
  type GroupSummary,
  type GroupInfo,
  type GroupInviteInfo,
} from '../services/api';
import { useSessionsQuery } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { ApiCodeDialog, type ApiRequestDescriptor } from '../components/ApiCodeDialog';
import './Groups.css';

type GroupModal =
  | { type: 'subject' }
  | { type: 'description' }
  | { type: 'invite' }
  | { type: 'leave' }
  | { type: 'removeParticipant'; participantId: string; label: string };

export function Groups() {
  const { t } = useTranslation();
  useDocumentTitle(t('groups.title'));
  const toast = useToast();

  const { data: allSessions = [] } = useSessionsQuery();
  const sessions = allSessions.filter(s => s.status === 'ready');
  const [session, setSession] = useState('');

  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  // When wwjs's getChats() reflects into a WA-Web module that's been renamed
  // upstream (the same class of bug as the media `r: r`), we surface a derived
  // list built from persisted incoming group messages so the page isn't blank.
  // `null` = normal wwjs source. Non-null = the reason we fell back.
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);

  const [groupId, setGroupId] = useState('');
  const [details, setDetails] = useState<GroupInfo | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [error, setError] = useState('');

  // Phase 3: group management
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupParticipants, setNewGroupParticipants] = useState('');
  const [creating, setCreating] = useState(false);
  const [addInput, setAddInput] = useState('');
  const [modal, setModal] = useState<GroupModal | null>(null);
  const [modalInput, setModalInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [inviteInfo, setInviteInfo] = useState<GroupInviteInfo | null>(null);
  const [busyParticipant, setBusyParticipant] = useState<string | null>(null);

  const [apiDialog, setApiDialog] = useState<ApiRequestDescriptor | null>(null);
  const sid = session || 'SESSION_ID';

  useEffect(() => {
    if (sessions.length > 0 && !session) setSession(sessions[0].id);
  }, [sessions, session]);

  const loadGroups = useCallback(async () => {
    if (!session) return;
    setLoadingList(true);
    setError('');
    setFallbackNotice(null);
    try {
      setGroups(await groupApi.list(session));
    } catch (e) {
      const primaryMsg = e instanceof Error ? e.message : String(e);
      // Backend `groupApi.list` throws when wwjs's getChats() hits the WA-Web
      // module-rename bug. Fall back to deriving the full group list from
      // persisted message history — paginate with early-exit so we cover ALL
      // groups the account has ever interacted with, not just the chatty ones
      // that dominate the most recent 1000 rows.
      try {
        const PAGE = 5000; // ~1 MB of JSON per page — plenty of headroom
        const MAX_PAGES = 20; // 100k msg cap as a safety net
        const DRY_PAGES = 2; // stop after this many consecutive pages add no new groups
        const acc = new Map<string, { count: number; lastTs: number }>();
        let offset = 0;
        let dry = 0;
        let total: number | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const { messages, total: t } = await messageApi.history(session, { limit: PAGE, offset });
          if (total === undefined) total = t;
          if (messages.length === 0) break;
          const before = acc.size;
          for (const m of messages) {
            if (!m.chatId || !m.chatId.endsWith('@g.us')) continue;
            const cur = acc.get(m.chatId) || { count: 0, lastTs: 0 };
            cur.count++;
            const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
            if (ts > cur.lastTs) cur.lastTs = ts;
            acc.set(m.chatId, cur);
          }
          const added = acc.size - before;
          dry = added === 0 ? dry + 1 : 0;
          offset += messages.length;
          if (dry >= DRY_PAGES) break; // no new groups appearing → tail is dry
          if (offset >= (total ?? 0)) break; // exhausted the table
          if (messages.length < PAGE) break; // last partial page
        }
        const derived: GroupSummary[] = Array.from(acc.entries())
          .sort((a, b) => b[1].lastTs - a[1].lastTs)
          .map(([id, v]) => ({
            id,
            // Group name isn't stored on message rows — short-form ID is the
            // best identifier we have without WA Web state.
            name: `Group ${id.split('@')[0].slice(-6)}`,
            participantsCount: v.count,
          }));
        setGroups(derived);
        setFallbackNotice(primaryMsg);
      } catch (fbErr) {
        setError(`${primaryMsg} · fallback also failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`);
        setGroups([]);
      }
    } finally {
      setLoadingList(false);
    }
  }, [session]);

  const loadDetails = useCallback(
    async (id: string) => {
      const target = id.trim();
      if (!session || !target) return;
      setLoadingDetails(true);
      setError('');
      setDetails(null);
      try {
        setDetails(await groupApi.get(session, target));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoadingDetails(false);
      }
    },
    [session],
  );

  const numberOf = (jid: string) => (jid || '').replace(/@.*/, '');

  const toJid = (raw: string) => {
    const v = raw.trim();
    if (!v) return '';
    return v.includes('@') ? v : `${v.replace(/[^0-9]/g, '')}@c.us`;
  };
  const parseParticipants = (text: string) =>
    text
      .split(/[\n,]/)
      .map(toJid)
      .filter(Boolean);

  const refreshDetails = () => {
    if (details) void loadDetails(details.id);
  };

  const handleCreate = async () => {
    if (!session || !newGroupName.trim()) return;
    setCreating(true);
    try {
      await groupApi.create(session, newGroupName.trim(), parseParticipants(newGroupParticipants));
      toast.success(t('groups.manage.toasts.created'));
      setNewGroupName('');
      setNewGroupParticipants('');
      void loadGroups();
    } catch (e) {
      toast.error(t('groups.manage.toasts.failed'), e instanceof Error ? e.message : undefined);
    } finally {
      setCreating(false);
    }
  };

  const handleAdd = async () => {
    if (!session || !details || !addInput.trim()) return;
    setSubmitting(true);
    try {
      await groupApi.addParticipants(session, details.id, parseParticipants(addInput));
      toast.success(t('groups.manage.toasts.added'));
      setAddInput('');
      refreshDetails();
    } catch (e) {
      toast.error(t('groups.manage.toasts.failed'), e instanceof Error ? e.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRole = async (participantId: string, action: 'promote' | 'demote') => {
    if (!session || !details) return;
    setBusyParticipant(participantId);
    try {
      if (action === 'promote') await groupApi.promoteParticipants(session, details.id, [participantId]);
      else await groupApi.demoteParticipants(session, details.id, [participantId]);
      toast.success(t(action === 'promote' ? 'groups.manage.toasts.promoted' : 'groups.manage.toasts.demoted'));
      refreshDetails();
    } catch (e) {
      toast.error(t('groups.manage.toasts.failed'), e instanceof Error ? e.message : undefined);
    } finally {
      setBusyParticipant(null);
    }
  };

  const openModal = (m: GroupModal) => {
    setModal(m);
    if (m.type === 'subject') setModalInput(details?.name || '');
    else if (m.type === 'description') setModalInput(details?.description || '');
    else setModalInput('');
  };

  const openInvite = async () => {
    if (!session || !details) return;
    setModal({ type: 'invite' });
    setInviteInfo(null);
    try {
      setInviteInfo(await groupApi.getInviteCode(session, details.id));
    } catch (e) {
      toast.error(t('groups.manage.toasts.failed'), e instanceof Error ? e.message : undefined);
    }
  };

  const handleRevoke = async () => {
    if (!session || !details) return;
    setSubmitting(true);
    try {
      setInviteInfo(await groupApi.revokeInviteCode(session, details.id));
      toast.success(t('groups.manage.toasts.revoked'));
    } catch (e) {
      toast.error(t('groups.manage.toasts.failed'), e instanceof Error ? e.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  const handleModalSubmit = async () => {
    if (!session || !details || !modal) return;
    setSubmitting(true);
    try {
      if (modal.type === 'subject') {
        await groupApi.setSubject(session, details.id, modalInput.trim());
        toast.success(t('groups.manage.toasts.subjectUpdated'));
        refreshDetails();
      } else if (modal.type === 'description') {
        await groupApi.setDescription(session, details.id, modalInput);
        toast.success(t('groups.manage.toasts.descriptionUpdated'));
        refreshDetails();
      } else if (modal.type === 'leave') {
        await groupApi.leave(session, details.id);
        toast.success(t('groups.manage.toasts.left'));
        setDetails(null);
        void loadGroups();
      } else if (modal.type === 'removeParticipant') {
        await groupApi.removeParticipants(session, details.id, [modal.participantId]);
        toast.success(t('groups.manage.toasts.removed'));
        refreshDetails();
      }
      setModal(null);
    } catch (e) {
      toast.error(t('groups.manage.toasts.failed'), e instanceof Error ? e.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  const modalSubmitDisabled = submitting || (modal?.type === 'subject' && !modalInput.trim());

  return (
    <div className="groups-page">
      <PageHeader title={t('groups.title')} subtitle={t('groups.subtitle')} />

      <div className="filters-bar">
        <div className="filter-group">
          <select value={session} onChange={e => setSession(e.target.value)}>
            {sessions.length === 0 && <option value="">{t('groups.noSessions')}</option>}
            {sessions.map(s => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.phone || '—'})
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="groups-error">{error}</div>}

      {/* Create group */}
      <div className="groups-card">
        <div className="card-title-row">
          <h2>{t('groups.manage.create.title')}</h2>
          <button
            className="dev-api-btn"
            title={t('apiCode.dev')}
            onClick={() =>
              setApiDialog({
                method: 'POST',
                path: `/sessions/${sid}/groups`,
                body: { name: newGroupName, participants: parseParticipants(newGroupParticipants) },
                title: t('groups.manage.create.title'),
              })
            }
          >
            <Code2 size={16} />
          </button>
        </div>
        <p className="groups-hint">{t('groups.manage.create.hint')}</p>
        <div className="form-group">
          <label>{t('groups.manage.create.name')}</label>
          <input
            type="text"
            value={newGroupName}
            onChange={e => setNewGroupName(e.target.value)}
            placeholder={t('groups.manage.create.namePlaceholder')}
          />
        </div>
        <div className="form-group">
          <label>{t('groups.manage.create.participants')}</label>
          <textarea
            rows={2}
            value={newGroupParticipants}
            onChange={e => setNewGroupParticipants(e.target.value)}
            placeholder="+62812..., +62813..."
          />
          <span className="groups-hint">{t('groups.manage.create.participantsHint')}</span>
        </div>
        <button
          className="btn-primary"
          onClick={() => void handleCreate()}
          disabled={!session || !newGroupName.trim() || parseParticipants(newGroupParticipants).length === 0 || creating}
        >
          {creating ? <Loader2 className="animate-spin" size={18} /> : <Plus size={18} />}
          {t('groups.manage.create.button')}
        </button>
      </div>

      {/* Get group by ID */}
      <div className="groups-card">
        <div className="card-title-row">
          <h2>{t('groups.byId.title')}</h2>
          <button
            className="dev-api-btn"
            title={t('apiCode.dev')}
            onClick={() =>
              setApiDialog({
                method: 'GET',
                path: `/sessions/${sid}/groups/${encodeURIComponent(groupId.trim() || ':groupId')}`,
                title: t('groups.byId.title'),
              })
            }
          >
            <Code2 size={16} />
          </button>
        </div>
        <p className="groups-hint">{t('groups.byId.hint')}</p>
        <div className="groups-search-row">
          <input
            type="text"
            placeholder="120363xxxxxxxxxx@g.us"
            value={groupId}
            onChange={e => setGroupId(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && void loadDetails(groupId)}
          />
          <button className="btn-primary" onClick={() => void loadDetails(groupId)} disabled={!session || !groupId.trim()}>
            {loadingDetails ? <Loader2 className="animate-spin" size={18} /> : <Search size={18} />}
            {t('groups.byId.button')}
          </button>
        </div>

        {details && (
          <div className="group-details">
            <div className="group-detail-grid">
              <div>
                <label>{t('groups.detail.name')}</label>
                <span>{details.name || '—'}</span>
              </div>
              <div>
                <label>{t('groups.detail.id')}</label>
                <span className="mono">{details.id}</span>
              </div>
              <div>
                <label>{t('groups.detail.owner')}</label>
                <span className="mono">{numberOf(details.owner || '') || '—'}</span>
              </div>
              <div>
                <label>{t('groups.detail.created')}</label>
                <span>{details.createdAt ? new Date(details.createdAt * 1000).toLocaleString() : '—'}</span>
              </div>
              <div>
                <label>{t('groups.detail.participants')}</label>
                <span>{details.participants?.length ?? 0}</span>
              </div>
              <div className="full">
                <label>{t('groups.detail.description')}</label>
                <span>{details.description || '—'}</span>
              </div>
            </div>

            <div className="group-manage-toolbar">
              <button className="btn-secondary" onClick={() => openModal({ type: 'subject' })}>
                <Pencil size={15} />
                {t('groups.manage.editName')}
              </button>
              <button className="btn-secondary" onClick={() => openModal({ type: 'description' })}>
                <Pencil size={15} />
                {t('groups.manage.editDescription')}
              </button>
              <button className="btn-secondary" onClick={() => void openInvite()}>
                <LinkIcon size={15} />
                {t('groups.manage.inviteLink')}
              </button>
              <button className="btn-secondary danger" onClick={() => openModal({ type: 'leave' })}>
                <LogOut size={15} />
                {t('groups.manage.leave')}
              </button>
            </div>

            <div className="group-add-row">
              <input
                type="text"
                value={addInput}
                onChange={e => setAddInput(e.target.value)}
                placeholder={t('groups.manage.addPlaceholder')}
                onKeyDown={e => e.key === 'Enter' && void handleAdd()}
              />
              <button className="btn-primary" onClick={() => void handleAdd()} disabled={!addInput.trim() || submitting}>
                <UserPlus size={16} />
                {t('groups.manage.addParticipants')}
              </button>
            </div>

            <h3>{t('groups.detail.participants')}</h3>
            <div className="participants-table">
              <div className="table-row header">
                <span>{t('groups.detail.number')}</span>
                <span>{t('groups.detail.pName')}</span>
                <span>{t('groups.detail.role')}</span>
                <span>{t('groups.manage.actions')}</span>
              </div>
              {(details.participants || []).map(p => (
                <div key={p.id} className="table-row">
                  <span className="mono">{p.number || numberOf(p.id)}</span>
                  <span>{p.name || '—'}</span>
                  <span>
                    {p.isSuperAdmin ? (
                      <span className="role-badge owner">
                        <Crown size={12} /> {t('groups.role.owner')}
                      </span>
                    ) : p.isAdmin ? (
                      <span className="role-badge admin">
                        <Shield size={12} /> {t('groups.role.admin')}
                      </span>
                    ) : (
                      <span className="role-badge member">{t('groups.role.member')}</span>
                    )}
                  </span>
                  <span className="participant-actions">
                    {busyParticipant === p.id ? (
                      <Loader2 className="animate-spin" size={15} />
                    ) : (
                      !p.isSuperAdmin && (
                        <>
                          {p.isAdmin ? (
                            <button
                              className="icon-btn"
                              title={t('groups.manage.demote')}
                              onClick={() => void handleRole(p.id, 'demote')}
                            >
                              <ArrowDown size={15} />
                            </button>
                          ) : (
                            <button
                              className="icon-btn"
                              title={t('groups.manage.promote')}
                              onClick={() => void handleRole(p.id, 'promote')}
                            >
                              <ArrowUp size={15} />
                            </button>
                          )}
                          <button
                            className="icon-btn danger"
                            title={t('groups.manage.remove')}
                            onClick={() =>
                              openModal({
                                type: 'removeParticipant',
                                participantId: p.id,
                                label: p.number || numberOf(p.id),
                              })
                            }
                          >
                            <UserMinus size={15} />
                          </button>
                        </>
                      )
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* All groups */}
      <div className="groups-card">
        <div className="groups-card-header">
          <h2>{t('groups.all.title')}</h2>
          <div className="card-header-actions">
            <button
              className="dev-api-btn"
              title={t('apiCode.dev')}
              onClick={() => setApiDialog({ method: 'GET', path: `/sessions/${sid}/groups`, title: t('groups.all.title') })}
            >
              <Code2 size={16} />
            </button>
            <button className="btn-secondary" onClick={() => void loadGroups()} disabled={!session}>
              {loadingList ? <Loader2 className="animate-spin" size={18} /> : <RefreshCw size={18} />}
              {t('groups.all.button')}
            </button>
          </div>
        </div>

        {fallbackNotice && (
          <div className="groups-fallback-notice">
            <strong>{t('groups.all.fallbackTitle')}</strong>
            <span>{t('groups.all.fallbackHint')}</span>
          </div>
        )}
        <div className="groups-table">
          <div className="table-row header">
            <span>{t('groups.all.name')}</span>
            <span>{t('groups.all.id')}</span>
            <span>{fallbackNotice ? t('groups.all.messages') : t('groups.all.members')}</span>
            <span></span>
          </div>
          {groups.length === 0 ? (
            <div className="empty-table-state">
              <Users size={48} strokeWidth={1} />
              <p>{t('groups.all.empty')}</p>
            </div>
          ) : (
            groups.map(g => (
              <div key={g.id} className="table-row">
                <span className="group-name">{g.name || '—'}</span>
                <span className="mono">{g.id}</span>
                <span>{g.participantsCount ?? '—'}</span>
                <span>
                  <button
                    className="link-btn"
                    onClick={() => {
                      setGroupId(g.id);
                      void loadDetails(g.id);
                    }}
                  >
                    {t('groups.all.view')}
                  </button>
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {modal && (
        <div className="modal-overlay" onClick={() => !submitting && setModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t(`groups.manage.modal.${modal.type}Title`)}</h2>
              <button className="btn-icon" onClick={() => setModal(null)} disabled={submitting}>
                <X size={20} />
              </button>
            </div>

            <div className="modal-body">
              {modal.type === 'subject' && (
                <div className="form-group">
                  <label>{t('groups.manage.modal.subjectLabel')}</label>
                  <input type="text" value={modalInput} onChange={e => setModalInput(e.target.value)} />
                </div>
              )}

              {modal.type === 'description' && (
                <div className="form-group">
                  <label>{t('groups.manage.modal.descriptionLabel')}</label>
                  <textarea rows={4} value={modalInput} onChange={e => setModalInput(e.target.value)} />
                </div>
              )}

              {modal.type === 'leave' && <p className="modal-confirm-text">{t('groups.manage.modal.leaveConfirm')}</p>}

              {modal.type === 'removeParticipant' && (
                <p className="modal-confirm-text">
                  {t('groups.manage.modal.removeConfirm', { participant: modal.label })}
                </p>
              )}

              {modal.type === 'invite' && (
                <div className="invite-box">
                  {inviteInfo ? (
                    <>
                      <label>{t('groups.manage.modal.inviteLabel')}</label>
                      <input className="mono" type="text" value={inviteInfo.inviteLink} readOnly onFocus={e => e.target.select()} />
                    </>
                  ) : (
                    <div className="invite-loading">
                      <Loader2 className="animate-spin" size={24} />
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setModal(null)} disabled={submitting}>
                {modal.type === 'invite' ? t('common.close') : t('common.cancel')}
              </button>
              {modal.type === 'invite' ? (
                <button className="btn-danger" onClick={() => void handleRevoke()} disabled={submitting || !inviteInfo}>
                  {submitting ? <Loader2 size={16} className="animate-spin" /> : t('groups.manage.modal.revoke')}
                </button>
              ) : (
                <button
                  className={modal.type === 'leave' || modal.type === 'removeParticipant' ? 'btn-danger' : 'btn-primary'}
                  onClick={() => void handleModalSubmit()}
                  disabled={modalSubmitDisabled}
                >
                  {submitting ? <Loader2 size={16} className="animate-spin" /> : t('common.confirm')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <ApiCodeDialog request={apiDialog} onClose={() => setApiDialog(null)} />
    </div>
  );
}

export default Groups;
