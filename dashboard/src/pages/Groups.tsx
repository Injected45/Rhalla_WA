import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Users, Search, RefreshCw, Shield, Crown } from 'lucide-react';
import { groupApi, type GroupSummary, type GroupInfo } from '../services/api';
import { useSessionsQuery } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { PageHeader } from '../components/PageHeader';
import './Groups.css';

export function Groups() {
  const { t } = useTranslation();
  useDocumentTitle(t('groups.title'));

  const { data: allSessions = [] } = useSessionsQuery();
  const sessions = allSessions.filter(s => s.status === 'ready');
  const [session, setSession] = useState('');

  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  const [groupId, setGroupId] = useState('');
  const [details, setDetails] = useState<GroupInfo | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (sessions.length > 0 && !session) setSession(sessions[0].id);
  }, [sessions, session]);

  const loadGroups = useCallback(async () => {
    if (!session) return;
    setLoadingList(true);
    setError('');
    try {
      setGroups(await groupApi.list(session));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setGroups([]);
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

      {/* Get group by ID */}
      <div className="groups-card">
        <h2>{t('groups.byId.title')}</h2>
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

            <h3>{t('groups.detail.participants')}</h3>
            <div className="participants-table">
              <div className="table-row header">
                <span>{t('groups.detail.number')}</span>
                <span>{t('groups.detail.pName')}</span>
                <span>{t('groups.detail.role')}</span>
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
          <button className="btn-secondary" onClick={() => void loadGroups()} disabled={!session}>
            {loadingList ? <Loader2 className="animate-spin" size={18} /> : <RefreshCw size={18} />}
            {t('groups.all.button')}
          </button>
        </div>

        <div className="groups-table">
          <div className="table-row header">
            <span>{t('groups.all.name')}</span>
            <span>{t('groups.all.id')}</span>
            <span>{t('groups.all.members')}</span>
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
    </div>
  );
}

export default Groups;
