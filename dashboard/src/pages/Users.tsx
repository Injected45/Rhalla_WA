import { useState, useEffect, useMemo } from 'react';
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
  Loader2,
  X,
  UserCog,
  AlertTriangle,
  CalendarClock,
  KeyRound,
  Pencil,
  Ban,
  Infinity as InfinityIcon,
} from 'lucide-react';
import type { SubscriptionPlan, User, UserRoleName } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  useUsersQuery,
  useCreateUserMutation,
  useUpdateUserMutation,
  useResetUserPasswordMutation,
  useAssignSubscriptionMutation,
  useCancelSubscriptionMutation,
  useDeactivateUserMutation,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import './Users.css';

const roleNames: UserRoleName[] = ['admin', 'operator', 'viewer'];
const planNames: SubscriptionPlan[] = ['trial', 'week', 'month', 'year', 'manual'];

/** Mirrors PLAN_DURATION_DAYS on the server; null = caller decides. */
const planDays: Record<SubscriptionPlan, number | null> = {
  trial: 3,
  week: 7,
  month: 30,
  year: 365,
  manual: null,
};

const MIN_PASSWORD_LENGTH = 8;

type ModalKind = 'create' | 'edit' | 'subscription' | 'password' | 'disable';

interface CreateForm {
  email: string;
  password: string;
  fullName: string;
  role: UserRoleName;
  maxSessions: number;
  plan: SubscriptionPlan;
  days: string;
  note: string;
}

const emptyCreateForm: CreateForm = {
  email: '',
  password: '',
  fullName: '',
  role: 'operator',
  maxSessions: 1,
  plan: 'trial',
  days: '',
  note: '',
};

function useWindowSize() {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const handleResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  return width;
}

const columnHelper = createColumnHelper<User>();

export function Users() {
  const { t } = useTranslation();
  useDocumentTitle(t('users.title'));
  const toast = useToast();

  const { data: users = [], isLoading } = useUsersQuery();
  const createMutation = useCreateUserMutation();
  const updateMutation = useUpdateUserMutation();
  const passwordMutation = useResetUserPasswordMutation();
  const subscriptionMutation = useAssignSubscriptionMutation();
  const cancelSubscriptionMutation = useCancelSubscriptionMutation();
  const deactivateMutation = useDeactivateUserMutation();

  const [modal, setModal] = useState<ModalKind | null>(null);
  const [target, setTarget] = useState<User | null>(null);
  const [formError, setFormError] = useState('');

  const [createForm, setCreateForm] = useState<CreateForm>(emptyCreateForm);
  const [editForm, setEditForm] = useState({
    fullName: '',
    role: 'operator' as UserRoleName,
    maxSessions: 1,
    isActive: true,
  });
  const [subscriptionForm, setSubscriptionForm] = useState({
    plan: 'month' as SubscriptionPlan,
    days: '',
    expiresAt: '',
    note: '',
  });
  const [newPassword, setNewPassword] = useState('');

  const windowWidth = useWindowSize();
  const isMobile = windowWidth < 768;
  const isSmall = windowWidth < 640;
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  useEffect(() => {
    setColumnVisibility({ role: !isSmall, lastLogin: !isMobile, status: !isSmall });
  }, [isMobile, isSmall]);

  const closeModal = () => {
    setModal(null);
    setTarget(null);
    setFormError('');
  };

  const errorMessage = (err: unknown): string =>
    err instanceof Error && err.message ? err.message : t('common.errorGeneric');

  const openCreate = () => {
    setCreateForm(emptyCreateForm);
    setFormError('');
    setModal('create');
  };

  const openEdit = (user: User) => {
    setTarget(user);
    setEditForm({
      fullName: user.fullName ?? '',
      role: user.role,
      maxSessions: user.maxSessions,
      isActive: user.isActive,
    });
    setFormError('');
    setModal('edit');
  };

  const openSubscription = (user: User) => {
    setTarget(user);
    setSubscriptionForm({ plan: user.subscription?.plan ?? 'month', days: '', expiresAt: '', note: '' });
    setFormError('');
    setModal('subscription');
  };

  const openPassword = (user: User) => {
    setTarget(user);
    setNewPassword('');
    setFormError('');
    setModal('password');
  };

  const openDisable = (user: User) => {
    setTarget(user);
    setFormError('');
    setModal('disable');
  };

  const handleCreate = async () => {
    if (!createForm.email.trim()) {
      setFormError(t('users.errors.emailRequired'));
      return;
    }
    if (createForm.password.length < MIN_PASSWORD_LENGTH) {
      setFormError(t('users.errors.passwordTooShort', { count: MIN_PASSWORD_LENGTH }));
      return;
    }
    const days = createForm.days.trim() ? Number(createForm.days) : undefined;
    if (days !== undefined && (!Number.isInteger(days) || days < 1)) {
      setFormError(t('users.errors.invalidDays'));
      return;
    }

    try {
      await createMutation.mutateAsync({
        email: createForm.email.trim(),
        password: createForm.password,
        fullName: createForm.fullName.trim() || undefined,
        role: createForm.role,
        maxSessions: createForm.maxSessions,
        plan: createForm.plan,
        days,
        note: createForm.note.trim() || undefined,
      });
      toast.success(t('users.toasts.created', { email: createForm.email.trim() }));
      closeModal();
    } catch (err) {
      setFormError(errorMessage(err));
    }
  };

  const handleEdit = async () => {
    if (!target) return;
    try {
      await updateMutation.mutateAsync({
        id: target.id,
        data: {
          fullName: editForm.fullName.trim(),
          role: editForm.role,
          maxSessions: editForm.maxSessions,
          isActive: editForm.isActive,
        },
      });
      toast.success(t('users.toasts.updated', { email: target.email }));
      closeModal();
    } catch (err) {
      setFormError(errorMessage(err));
    }
  };

  const handleAssignSubscription = async () => {
    if (!target) return;
    const days = subscriptionForm.days.trim() ? Number(subscriptionForm.days) : undefined;
    if (days !== undefined && (!Number.isInteger(days) || days < 1)) {
      setFormError(t('users.errors.invalidDays'));
      return;
    }

    try {
      await subscriptionMutation.mutateAsync({
        id: target.id,
        data: {
          plan: subscriptionForm.plan,
          days,
          // Only a manual plan uses an exact end date; the rest derive it.
          expiresAt:
            subscriptionForm.plan === 'manual' && subscriptionForm.expiresAt && days === undefined
              ? new Date(subscriptionForm.expiresAt).toISOString()
              : undefined,
          note: subscriptionForm.note.trim() || undefined,
        },
      });
      toast.success(t('users.toasts.subscriptionAssigned', { email: target.email }));
      closeModal();
    } catch (err) {
      setFormError(errorMessage(err));
    }
  };

  const handleCancelSubscription = async (user: User) => {
    try {
      await cancelSubscriptionMutation.mutateAsync(user.id);
      toast.success(t('users.toasts.subscriptionCancelled', { email: user.email }));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const handleResetPassword = async () => {
    if (!target) return;
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setFormError(t('users.errors.passwordTooShort', { count: MIN_PASSWORD_LENGTH }));
      return;
    }
    try {
      await passwordMutation.mutateAsync({ id: target.id, password: newPassword });
      toast.success(t('users.toasts.passwordReset', { email: target.email }));
      closeModal();
    } catch (err) {
      setFormError(errorMessage(err));
    }
  };

  const handleDisable = async () => {
    if (!target) return;
    try {
      await deactivateMutation.mutateAsync(target.id);
      toast.success(t('users.toasts.disabled', { email: target.email }));
      closeModal();
    } catch (err) {
      setFormError(errorMessage(err));
    }
  };

  const columns = useMemo(
    () => [
      columnHelper.accessor('email', {
        header: () => t('users.columns.account'),
        cell: info => {
          const user = info.row.original;
          return (
            <span className="account-cell">
              <span className="account-email">{user.email}</span>
              {user.fullName && <span className="account-name">{user.fullName}</span>}
            </span>
          );
        },
      }),
      columnHelper.accessor('role', {
        id: 'role',
        header: () => t('users.columns.role'),
        cell: info => <span className="role-badge">{t(`users.roles.${info.getValue()}`)}</span>,
      }),
      columnHelper.accessor(row => row.subscription?.plan ?? null, {
        id: 'subscription',
        header: () => t('users.columns.subscription'),
        cell: info => {
          const { subscription } = info.row.original;
          if (!subscription) {
            return <span className="sub-badge none">{t('users.subscription.none')}</span>;
          }
          const expired = subscription.isExpired;
          const unlimited = subscription.expiresAt === null;
          return (
            <span className="sub-cell">
              <span className={`sub-badge ${expired ? 'expired' : 'active'}`}>
                {t(`users.plans.${subscription.plan}`)}
              </span>
              <span className="sub-remaining">
                {unlimited ? (
                  <>
                    <InfinityIcon size={13} aria-hidden="true" />
                    {t('users.subscription.unlimited')}
                  </>
                ) : expired ? (
                  t('users.subscription.expiredOn', {
                    date: new Date(subscription.expiresAt!).toLocaleDateString(),
                  })
                ) : (
                  t('users.subscription.daysLeft', { count: subscription.daysRemaining ?? 0 })
                )}
              </span>
            </span>
          );
        },
      }),
      columnHelper.accessor('sessionCount', {
        header: () => t('users.columns.sessions'),
        cell: info => {
          const user = info.row.original;
          const atLimit = user.maxSessions > 0 && user.sessionCount >= user.maxSessions;
          return (
            <span className={`sessions-cell ${atLimit ? 'at-limit' : ''}`}>
              {user.maxSessions === 0
                ? t('users.sessions.unlimitedUsage', { used: user.sessionCount })
                : `${user.sessionCount} / ${user.maxSessions}`}
            </span>
          );
        },
      }),
      columnHelper.accessor('isActive', {
        id: 'status',
        header: () => t('users.columns.status'),
        cell: info => (
          <span className={`status-badge ${info.getValue() ? 'active' : 'inactive'}`}>
            {info.getValue() ? t('users.statuses.active') : t('users.statuses.disabled')}
          </span>
        ),
      }),
      columnHelper.accessor('lastLoginAt', {
        id: 'lastLogin',
        header: () => t('users.columns.lastLogin'),
        cell: info => (
          <span className="last-login">
            {info.getValue() ? new Date(info.getValue()!).toLocaleString() : t('common.never')}
          </span>
        ),
      }),
      columnHelper.display({
        id: 'actions',
        header: () => t('users.columns.actions'),
        cell: info => {
          const user = info.row.original;
          return (
            <span className="actions-cell">
              <button className="icon-btn" onClick={() => openEdit(user)} title={t('users.actions.edit')}>
                <Pencil size={16} />
              </button>
              <button
                className="icon-btn"
                onClick={() => openSubscription(user)}
                title={t('users.actions.subscription')}
              >
                <CalendarClock size={16} />
              </button>
              <button className="icon-btn" onClick={() => openPassword(user)} title={t('users.actions.password')}>
                <KeyRound size={16} />
              </button>
              {user.subscription && !user.subscription.isExpired && (
                <button
                  className="icon-btn"
                  onClick={() => void handleCancelSubscription(user)}
                  title={t('users.actions.cancelSubscription')}
                >
                  <Ban size={16} />
                </button>
              )}
              {user.isActive && (
                <button
                  className="icon-btn danger"
                  onClick={() => openDisable(user)}
                  title={t('users.actions.disable')}
                >
                  <X size={16} />
                </button>
              )}
            </span>
          );
        },
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  const table = useReactTable({
    data: users,
    columns,
    state: { columnVisibility },
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
  });

  const busy =
    createMutation.isPending ||
    updateMutation.isPending ||
    passwordMutation.isPending ||
    subscriptionMutation.isPending ||
    deactivateMutation.isPending;

  if (isLoading) {
    return (
      <div className="users-page users-page--loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  /** Human-readable end date for the plan currently chosen in the modal. */
  const previewEnd = (plan: SubscriptionPlan, daysInput: string, expiresAt: string): string => {
    const days = daysInput.trim() ? Number(daysInput) : planDays[plan];
    if (days !== null && days !== undefined && Number.isInteger(days) && days > 0) {
      return new Date(Date.now() + days * 86_400_000).toLocaleDateString();
    }
    if (plan === 'manual' && expiresAt) {
      return new Date(expiresAt).toLocaleDateString();
    }
    return t('users.subscription.unlimited');
  };

  return (
    <div className="users-page">
      <PageHeader
        title={t('users.title')}
        subtitle={t('users.subtitle')}
        actions={
          <button className="btn-primary" onClick={openCreate}>
            <Plus size={18} />
            {t('users.createBtn')}
          </button>
        }
      />

      <div className="users-content">
        <div className="users-table-container">
          {users.length === 0 ? (
            <div className="empty-table-state">
              <UserCog size={48} strokeWidth={1} />
              <h3>{t('users.empty.title')}</h3>
              <p>{t('users.empty.description')}</p>
            </div>
          ) : (
            <table className="users-table">
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

        <div className="plans-reference">
          <h3>{t('users.plansTitle')}</h3>
          <div className="plans-list">
            {planNames.map(plan => (
              <div key={plan} className="plan-item">
                <code>{t(`users.plans.${plan}`)}</code>
                <span>{t(`users.planDescriptions.${plan}`)}</span>
              </div>
            ))}
          </div>
          <p className="plans-hint">{t('users.sessions.hint')}</p>
        </div>
      </div>

      {/* ── Create ─────────────────────────────────────────────── */}
      {modal === 'create' && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('users.create.title')}</h2>
              <button className="btn-icon" onClick={closeModal}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <label htmlFor="user-email">{t('users.fields.email')}</label>
              <input
                id="user-email"
                type="email"
                autoComplete="off"
                placeholder={t('users.fields.emailPlaceholder')}
                value={createForm.email}
                onChange={e => setCreateForm({ ...createForm, email: e.target.value })}
              />

              <label htmlFor="user-password">{t('users.fields.password')}</label>
              <input
                id="user-password"
                type="password"
                autoComplete="new-password"
                placeholder={t('users.fields.passwordPlaceholder', { count: MIN_PASSWORD_LENGTH })}
                value={createForm.password}
                onChange={e => setCreateForm({ ...createForm, password: e.target.value })}
              />

              <label htmlFor="user-fullname">
                {t('users.fields.fullName')} <span className="field-optional">({t('common.optional')})</span>
              </label>
              <input
                id="user-fullname"
                type="text"
                placeholder={t('users.fields.fullNamePlaceholder')}
                value={createForm.fullName}
                onChange={e => setCreateForm({ ...createForm, fullName: e.target.value })}
              />

              <div className="field-row">
                <div className="field-col">
                  <label htmlFor="user-role">{t('users.fields.role')}</label>
                  <select
                    id="user-role"
                    value={createForm.role}
                    onChange={e => setCreateForm({ ...createForm, role: e.target.value as UserRoleName })}
                  >
                    {roleNames.map(r => (
                      <option key={r} value={r}>
                        {t(`users.roles.${r}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field-col">
                  <label htmlFor="user-max-sessions">{t('users.fields.maxSessions')}</label>
                  <input
                    id="user-max-sessions"
                    type="number"
                    min={0}
                    value={createForm.maxSessions}
                    onChange={e => setCreateForm({ ...createForm, maxSessions: Number(e.target.value) })}
                  />
                  <span className="field-hint">{t('users.fields.maxSessionsHint')}</span>
                </div>
              </div>

              <div className="field-row">
                <div className="field-col">
                  <label htmlFor="user-plan">{t('users.fields.plan')}</label>
                  <select
                    id="user-plan"
                    value={createForm.plan}
                    onChange={e => setCreateForm({ ...createForm, plan: e.target.value as SubscriptionPlan })}
                  >
                    {planNames.map(p => (
                      <option key={p} value={p}>
                        {t(`users.plans.${p}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field-col">
                  <label htmlFor="user-days">
                    {t('users.fields.days')} <span className="field-optional">({t('common.optional')})</span>
                  </label>
                  <input
                    id="user-days"
                    type="number"
                    min={1}
                    placeholder={planDays[createForm.plan]?.toString() ?? t('users.fields.daysUnlimited')}
                    value={createForm.days}
                    onChange={e => setCreateForm({ ...createForm, days: e.target.value })}
                  />
                  <span className="field-hint">{t('users.fields.daysHint')}</span>
                </div>
              </div>

              <label htmlFor="user-note">
                {t('users.fields.note')} <span className="field-optional">({t('common.optional')})</span>
              </label>
              <input
                id="user-note"
                type="text"
                placeholder={t('users.fields.notePlaceholder')}
                value={createForm.note}
                onChange={e => setCreateForm({ ...createForm, note: e.target.value })}
              />

              <p className="modal-preview">
                {t('users.subscription.endsOn', {
                  date: previewEnd(createForm.plan, createForm.days, ''),
                })}
              </p>

              {formError && <span className="form-error">{formError}</span>}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={closeModal}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={() => void handleCreate()} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" size={16} /> : t('common.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit ───────────────────────────────────────────────── */}
      {modal === 'edit' && target && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('users.edit.title', { email: target.email })}</h2>
              <button className="btn-icon" onClick={closeModal}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <label htmlFor="edit-fullname">{t('users.fields.fullName')}</label>
              <input
                id="edit-fullname"
                type="text"
                value={editForm.fullName}
                onChange={e => setEditForm({ ...editForm, fullName: e.target.value })}
              />

              <div className="field-row">
                <div className="field-col">
                  <label htmlFor="edit-role">{t('users.fields.role')}</label>
                  <select
                    id="edit-role"
                    value={editForm.role}
                    onChange={e => setEditForm({ ...editForm, role: e.target.value as UserRoleName })}
                  >
                    {roleNames.map(r => (
                      <option key={r} value={r}>
                        {t(`users.roles.${r}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field-col">
                  <label htmlFor="edit-max-sessions">{t('users.fields.maxSessions')}</label>
                  <input
                    id="edit-max-sessions"
                    type="number"
                    min={0}
                    value={editForm.maxSessions}
                    onChange={e => setEditForm({ ...editForm, maxSessions: Number(e.target.value) })}
                  />
                  <span className="field-hint">{t('users.fields.maxSessionsHint')}</span>
                </div>
              </div>

              <label className="checkbox-row" htmlFor="edit-active">
                <input
                  id="edit-active"
                  type="checkbox"
                  checked={editForm.isActive}
                  onChange={e => setEditForm({ ...editForm, isActive: e.target.checked })}
                />
                <span>{t('users.fields.isActive')}</span>
              </label>

              <p className="modal-preview">{t('users.edit.usage', { used: target.sessionCount })}</p>

              {formError && <span className="form-error">{formError}</span>}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={closeModal}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={() => void handleEdit()} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" size={16} /> : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Subscription ───────────────────────────────────────── */}
      {modal === 'subscription' && target && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('users.subscriptionModal.title', { email: target.email })}</h2>
              <button className="btn-icon" onClick={closeModal}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <div className="plan-picker">
                {planNames.map(plan => (
                  <button
                    key={plan}
                    type="button"
                    className={`plan-option ${subscriptionForm.plan === plan ? 'selected' : ''}`}
                    onClick={() => setSubscriptionForm({ ...subscriptionForm, plan })}
                  >
                    <span className="plan-option-name">{t(`users.plans.${plan}`)}</span>
                    <span className="plan-option-days">
                      {planDays[plan] === null
                        ? t('users.fields.daysUnlimited')
                        : t('users.subscription.daysLeft', { count: planDays[plan]! })}
                    </span>
                  </button>
                ))}
              </div>

              <label htmlFor="sub-days">
                {t('users.fields.days')} <span className="field-optional">({t('common.optional')})</span>
              </label>
              <input
                id="sub-days"
                type="number"
                min={1}
                placeholder={planDays[subscriptionForm.plan]?.toString() ?? t('users.fields.daysUnlimited')}
                value={subscriptionForm.days}
                onChange={e => setSubscriptionForm({ ...subscriptionForm, days: e.target.value })}
              />
              <span className="field-hint">{t('users.fields.daysHint')}</span>

              {subscriptionForm.plan === 'manual' && !subscriptionForm.days.trim() && (
                <>
                  <label htmlFor="sub-expires">
                    {t('users.fields.expiresAt')} <span className="field-optional">({t('common.optional')})</span>
                  </label>
                  <input
                    id="sub-expires"
                    type="date"
                    value={subscriptionForm.expiresAt}
                    onChange={e => setSubscriptionForm({ ...subscriptionForm, expiresAt: e.target.value })}
                  />
                  <span className="field-hint">{t('users.fields.expiresAtHint')}</span>
                </>
              )}

              <label htmlFor="sub-note">
                {t('users.fields.note')} <span className="field-optional">({t('common.optional')})</span>
              </label>
              <input
                id="sub-note"
                type="text"
                placeholder={t('users.fields.notePlaceholder')}
                value={subscriptionForm.note}
                onChange={e => setSubscriptionForm({ ...subscriptionForm, note: e.target.value })}
              />

              <p className="modal-preview">
                {t('users.subscription.endsOn', {
                  date: previewEnd(subscriptionForm.plan, subscriptionForm.days, subscriptionForm.expiresAt),
                })}
              </p>
              <p className="modal-note">{t('users.subscriptionModal.replaceHint')}</p>

              {formError && <span className="form-error">{formError}</span>}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={closeModal}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={() => void handleAssignSubscription()} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" size={16} /> : t('users.subscriptionModal.assign')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Password ───────────────────────────────────────────── */}
      {modal === 'password' && target && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('users.password.title', { email: target.email })}</h2>
              <button className="btn-icon" onClick={closeModal}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <label htmlFor="reset-password">{t('users.fields.newPassword')}</label>
              <input
                id="reset-password"
                type="password"
                autoComplete="new-password"
                placeholder={t('users.fields.passwordPlaceholder', { count: MIN_PASSWORD_LENGTH })}
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
              />
              <p className="modal-note">{t('users.password.hint')}</p>
              {formError && <span className="form-error">{formError}</span>}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={closeModal}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={() => void handleResetPassword()} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" size={16} /> : t('users.password.submit')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Disable ────────────────────────────────────────────── */}
      {modal === 'disable' && target && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal confirm-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('users.disable.title')}</h2>
              <button className="btn-icon" onClick={closeModal}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <div className="confirm-icon-wrapper">
                <AlertTriangle size={48} className="confirm-warning-icon" />
              </div>
              <p className="confirm-message">
                <Trans
                  i18nKey="users.disable.message"
                  values={{ email: target.email }}
                  components={{ strong: <strong /> }}
                />
              </p>
              <p className="modal-note">{t('users.disable.hint')}</p>
              {formError && <span className="form-error">{formError}</span>}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={closeModal}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={() => void handleDisable()} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" size={16} /> : t('users.disable.submit')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
