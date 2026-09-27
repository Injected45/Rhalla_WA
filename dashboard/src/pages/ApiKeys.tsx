import { useState, useEffect, useMemo, useCallback } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
  type VisibilityState,
} from '@tanstack/react-table';
import {
  Plus,
  Copy,
  RefreshCw,
  RotateCw,
  Trash2,
  Eye,
  EyeOff,
  Loader2,
  X,
  Check,
  KeyRound,
  AlertTriangle,
} from 'lucide-react';
import type { ApiKey } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole, type UserRole } from '../hooks/useRole';
import {
  useApiKeysQuery,
  useCreateApiKeyMutation,
  useDeleteApiKeyMutation,
  useRevokeApiKeyMutation,
  useRegenerateApiKeyMutation,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import './ApiKeys.css';

const allRoleNames = ['admin', 'operator', 'viewer'] as const;

/**
 * A key can never grant more than its issuer holds — the server enforces the
 * same cap — so the picker only offers roles at or below the caller's own.
 */
function grantableRoles(role: UserRole | null): readonly string[] {
  if (role === 'admin') return allRoleNames;
  if (role === 'operator') return ['operator', 'viewer'];
  return ['viewer'];
}

function useWindowSize() {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const handleResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  return width;
}

const columnHelper = createColumnHelper<ApiKey>();

export function ApiKeys() {
  const { t } = useTranslation();
  useDocumentTitle(t('apiKeys.title'));
  const { role } = useRole();
  // The key this browser is signed in with. Revoking it would lock the user
  // out of the dashboard, so its destructive actions are replaced by a badge.
  const storedKey = localStorage.getItem('openwa_api_key') || '';

  const { data: apiKeys = [], isLoading: loading } = useApiKeysQuery();
  const createMutation = useCreateApiKeyMutation();
  const deleteMutation = useDeleteApiKeyMutation();
  const revokeMutation = useRevokeApiKeyMutation();
  const regenerateMutation = useRegenerateApiKeyMutation();
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());
  const [showModal, setShowModal] = useState(false);
  const [newKey, setNewKey] = useState({ name: '', role: 'operator' });
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [wasRotated, setWasRotated] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ type: 'delete' | 'revoke'; id: string; name: string } | null>(
    null,
  );

  const windowWidth = useWindowSize();
  const isMobile = windowWidth < 768;
  const isSmall = windowWidth < 640;
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  useEffect(() => {
    setColumnVisibility({ key: !isSmall, lastUsed: !isMobile });
  }, [isMobile, isSmall]);

  const handleCreate = async () => {
    if (!newKey.name) return;
    try {
      const created = await createMutation.mutateAsync({ name: newKey.name, role: newKey.role });
      setWasRotated(false);
      setCreatedKey(created.apiKey || null);
      setNewKey({ name: '', role: 'operator' });
    } catch (err) {
      console.error('Failed to create:', err);
    }
  };

  // The stored key is only a hash, so a lost secret can never be read back —
  // rotating it is the only way to recover access. Shown once, like creation.
  const handleRegenerate = useCallback(
    async (id: string) => {
      try {
        const rotated = await regenerateMutation.mutateAsync(id);
        setWasRotated(true);
        setCreatedKey(rotated.apiKey || null);
        setShowModal(true);
      } catch (err) {
        console.error('Failed to regenerate:', err);
      }
    },
    [regenerateMutation],
  );

  const handleRevoke = async (id: string) => {
    try {
      await revokeMutation.mutateAsync(id);
    } catch (err) {
      console.error('Failed to revoke:', err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteMutation.mutateAsync(id);
    } catch (err) {
      console.error('Failed to delete:', err);
    }
  };

  const confirmAndExecute = () => {
    if (!confirmAction) return;
    if (confirmAction.type === 'delete') handleDelete(confirmAction.id);
    else handleRevoke(confirmAction.id);
    setConfirmAction(null);
  };

  const toggleKeyVisibility = (id: string) => {
    setVisibleKeys(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const columns = useMemo(
    () => [
      columnHelper.accessor('name', {
        header: () => t('apiKeys.columns.name'),
        cell: info => <span className="name-cell">{info.getValue()}</span>,
      }),
      columnHelper.accessor('keyPrefix', {
        id: 'key',
        header: () => t('apiKeys.columns.key'),
        cell: info => {
          const apiKey = info.row.original;
          return (
            <span className="key-cell">
              <code>{visibleKeys.has(apiKey.id) ? apiKey.keyPrefix + '...' : apiKey.keyPrefix + '****'}</code>
              <button className="icon-btn-sm" onClick={() => toggleKeyVisibility(apiKey.id)}>
                {visibleKeys.has(apiKey.id) ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </span>
          );
        },
      }),
      columnHelper.accessor('role', {
        header: () => t('apiKeys.columns.role'),
        cell: info => <span className="permission-badge">{info.getValue()}</span>,
      }),
      columnHelper.accessor('isActive', {
        header: () => t('apiKeys.columns.status'),
        cell: info => (
          <span className={`status-badge ${info.getValue() ? 'active' : 'inactive'}`}>
            {info.getValue() ? t('apiKeys.statuses.active') : t('apiKeys.statuses.revoked')}
          </span>
        ),
      }),
      columnHelper.accessor('lastUsedAt', {
        id: 'lastUsed',
        header: () => t('apiKeys.columns.lastUsed'),
        cell: info => (
          <span className="last-used">
            {info.getValue() ? new Date(info.getValue()!).toLocaleDateString() : t('common.never')}
          </span>
        ),
      }),
      columnHelper.display({
        id: 'actions',
        header: () => t('apiKeys.columns.actions'),
        cell: info => {
          const apiKey = info.row.original;
          return (
            <span className="actions-cell">
              {apiKey.keyPrefix.length > 0 && storedKey.startsWith(apiKey.keyPrefix) ? (
                // Revoking or deleting this row would lock the user out of the
                // dashboard, so offer a label instead of the two traps.
                <span className="permission-badge">{t('apiKeys.currentSession')}</span>
              ) : (
                <>
                  {/* The stored secret is only a hash, so it cannot be copied
                      back — rotation is how a lost key is recovered. */}
                  <button
                    className="icon-btn"
                    onClick={() => void handleRegenerate(apiKey.id)}
                    title={t('apiKeys.actions.regenerate')}
                  >
                    <RotateCw size={16} />
                  </button>
                  {apiKey.isActive && (
                    <button
                      className="icon-btn"
                      onClick={() => setConfirmAction({ type: 'revoke', id: apiKey.id, name: apiKey.name })}
                      title={t('apiKeys.actions.revoke')}
                    >
                      <RefreshCw size={16} />
                    </button>
                  )}
                  <button
                    className="icon-btn danger"
                    onClick={() => setConfirmAction({ type: 'delete', id: apiKey.id, name: apiKey.name })}
                    title={t('apiKeys.actions.delete')}
                  >
                    <Trash2 size={16} />
                  </button>
                </>
              )}
            </span>
          );
        },
      }),
    ],
    [visibleKeys, storedKey, handleRegenerate, t],
  );

  const table = useReactTable({
    data: apiKeys,
    columns,
    state: { columnVisibility },
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
  });

  if (loading) {
    return (
      <div
        className="api-keys-page"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="api-keys-page">
      <PageHeader
        title={t('apiKeys.title')}
        subtitle={t('apiKeys.subtitle')}
        actions={
          // Issuing a key needs operator rights; a viewer can only look.
          role === 'viewer' ? undefined : (
            <button className="btn-primary" onClick={() => setShowModal(true)}>
              <Plus size={18} />
              {t('apiKeys.createBtn')}
            </button>
          )
        }
      />

      {showModal && (
        <div
          className="modal-overlay"
          onClick={() => {
            setShowModal(false);
            setCreatedKey(null);
          }}
        >
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>
                {createdKey
                  ? t(wasRotated ? 'apiKeys.regeneratedTitle' : 'apiKeys.createdTitle')
                  : t('apiKeys.modalTitle')}
              </h2>
              <button
                className="btn-icon"
                onClick={() => {
                  setShowModal(false);
                  setCreatedKey(null);
                }}
              >
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              {createdKey ? (
                <div>
                  <p style={{ marginBottom: '1rem', color: 'var(--text-muted)' }}>
                    {t(wasRotated ? 'apiKeys.regeneratedHint' : 'apiKeys.createdHint')}
                  </p>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <code
                      style={{
                        flex: 1,
                        padding: '0.75rem',
                        background: 'var(--bg-secondary)',
                        borderRadius: '6px',
                        wordBreak: 'break-all',
                      }}
                    >
                      {createdKey}
                    </code>
                    <button className="btn-primary" onClick={() => copyToClipboard(createdKey, 'modal')}>
                      {copied === 'modal' ? <Check size={16} /> : <Copy size={16} />}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <label>{t('common.name')}</label>
                  <input
                    type="text"
                    placeholder={t('apiKeys.namePlaceholder')}
                    value={newKey.name}
                    onChange={e => setNewKey({ ...newKey, name: e.target.value })}
                  />
                  <label>{t('common.role')}</label>
                  <select value={newKey.role} onChange={e => setNewKey({ ...newKey, role: e.target.value })}>
                    {grantableRoles(role).map(r => (
                      <option key={r} value={r}>
                        {t(`apiKeys.roles.${r}`)}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
            {!createdKey && (
              <div className="modal-footer">
                <button className="btn-secondary" onClick={() => setShowModal(false)}>
                  {t('common.cancel')}
                </button>
                <button className="btn-primary" onClick={handleCreate}>
                  {t('common.create')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="api-keys-content">
        <div className="keys-table-container">
          {apiKeys.length === 0 ? (
            <div className="empty-table-state">
              <KeyRound size={48} strokeWidth={1} />
              <h3>{t('apiKeys.empty.title')}</h3>
              <p>{t('apiKeys.empty.description')}</p>
            </div>
          ) : (
            <table className="keys-table">
              <thead>
                {table.getHeaderGroups().map(headerGroup => (
                  <tr key={headerGroup.id} className="table-row header">
                    {headerGroup.headers.map(header => (
                      <th key={header.id}>
                        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map(row => (
                  <tr key={row.id} className="table-row">
                    {row.getVisibleCells().map(cell => (
                      <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="permissions-reference">
          <h3>{t('apiKeys.rolesTitle')}</h3>
          <div className="permissions-list">
            {allRoleNames.map(r => (
              <div key={r} className="perm-item">
                <code>{r}</code>
                <span>{t(`apiKeys.roleDescriptions.${r}`)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {confirmAction && (
        <div className="modal-overlay" onClick={() => setConfirmAction(null)}>
          <div className="modal confirm-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>
                {confirmAction.type === 'delete' ? t('apiKeys.confirm.deleteTitle') : t('apiKeys.confirm.revokeTitle')}
              </h2>
              <button className="btn-icon" onClick={() => setConfirmAction(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <div className="confirm-icon-wrapper">
                <AlertTriangle size={48} className="confirm-warning-icon" />
              </div>
              <p className="confirm-message">
                <Trans
                  i18nKey={
                    confirmAction.type === 'delete' ? 'apiKeys.confirm.deleteMessage' : 'apiKeys.confirm.revokeMessage'
                  }
                  values={{ name: confirmAction.name }}
                  components={{ strong: <strong /> }}
                />
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setConfirmAction(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={confirmAndExecute}>
                {confirmAction.type === 'delete' ? t('apiKeys.confirm.delete') : t('apiKeys.confirm.revoke')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
