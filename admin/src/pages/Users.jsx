import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Ban, RotateCcw, Trash2, BadgeCheck, MailCheck, MailX, Users as UsersIcon } from 'lucide-react';
import adminApi from '../api/adminApi';
import { useListParams } from '../lib/useListParams';
import { useRemote } from '../lib/useRemote';
import { useBulkSelection } from '../lib/useBulkSelection';
import { useBulkRunner } from '../lib/useBulkRunner';
import { humanize } from '../lib/statusStyles';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { FilterTabs } from '../components/ui/FilterTabs';
import { SearchInput } from '../components/ui/SearchInput';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Table, THead, Th, TBody, Td } from '../components/ui/Table';
import { IconButton, RowCheckbox } from '../components/ui/IconButton';
import { Pagination } from '../components/ui/Pagination';
import { EmptyState, ErrorState, TableSkeleton } from '../components/ui/States';
import { useConfirm } from '../components/ui/confirmContext';
import { useToast } from '../components/ui/toastContext';
import BulkActionBar from '../components/BulkActionBar';

const ITEMS_PER_PAGE = 10;
const STATUSES = ['all', 'active', 'blocked'];

// Prefer the `roles` array (source of truth); fall back to legacy `role`.
// Surface adminRole (super_admin/admin/moderator) as its own badge when set.
function userRoleLabels(user) {
    const labels = Array.isArray(user.roles) && user.roles.length ? [...user.roles] : (user.role ? [user.role] : []);
    if (user.adminRole && !labels.includes(user.adminRole)) labels.push(user.adminRole);
    return labels.length ? labels : ['user'];
}

// The User model has no `status` field - block state lives on `isBlocked`.
const userStatus = (user) => (user.isBlocked ? 'blocked' : 'active');

const formatDate = (value) => {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

export default function Users() {
    const navigate = useNavigate();
    const confirm = useConfirm();
    const toast = useToast();
    const { params, set } = useListParams({ status: 'all', q: '', page: 1 });
    const status = STATUSES.includes(params.status) ? params.status : 'all';

    const loadUsers = useCallback(() => {
        const query = { page: params.page, limit: ITEMS_PER_PAGE };
        if (status !== 'all') query.status = status;
        if (params.q) query.search = params.q;
        return adminApi.getUsers(query);
    }, [params.page, params.q, status]);
    const { data, loading, refreshing, error, reload: fetchUsers } = useRemote(loadUsers);
    const users = data?.users || [];
    const totalPages = data?.totalPages || 1;
    const total = data?.total || 0;

    const bulk = useBulkSelection();
    const pageIds = users.map((u) => u._id);

    const label = (user) => user.name || user.email || 'this user';

    const setBlocked = async (user, block) => {
        const ok = await confirm(block
            ? { title: `Block ${label(user)}?`, message: 'They will lose access to their account until unblocked.', confirmLabel: 'Block user', tone: 'danger' }
            : { title: `Unblock ${label(user)}?`, message: 'They will regain full access to their account.', confirmLabel: 'Unblock user' });
        if (!ok) return;
        try {
            await (block ? adminApi.blockUser(user._id) : adminApi.unblockUser(user._id));
            toast.success(`${label(user)} is ${block ? 'blocked' : 'unblocked'}`);
            fetchUsers();
        } catch (err) {
            toast.error(err?.message || `Could not ${block ? 'block' : 'unblock'} ${label(user)}`);
        }
    };

    // Irreversible: removes the account plus every event, venue, booking, ticket
    // and post it owns. The admin types the account's email to confirm, so a
    // reflex click cannot do it.
    const handleDelete = async (user) => {
        const ok = await confirm({
            title: `Permanently delete ${label(user)}?`,
            message: 'This also removes their events, venues, bookings, tickets and posts. This cannot be undone.',
            confirmLabel: 'Delete permanently',
            tone: 'danger',
            requireText: user.email || 'DELETE',
        });
        if (!ok) return;
        try {
            await adminApi.deleteUser(user._id);
            toast.success(`${label(user)} was deleted`);
            fetchUsers();
        } catch (err) {
            toast.error(err?.message || 'Failed to delete user');
        }
    };

    // One call per selected user, one at a time; stops at the first failure so a
    // broken call is not fired at every row blind.
    const { busy: bulkBusy, run } = useBulkRunner({ bulk, reload: fetchUsers, noun: ['user', 'users'] });
    const DELETE_MESSAGE = 'This also removes their events, venues, bookings, tickets and posts. This cannot be undone.';
    const bulkActions = [
        { label: 'Block', variant: 'danger', onClick: () => run({ verb: 'Block', past: 'Blocked', fn: (id) => adminApi.blockUser(id), danger: true }) },
        { label: 'Unblock', onClick: () => run({ verb: 'Unblock', past: 'Unblocked', fn: (id) => adminApi.unblockUser(id) }) },
        { label: 'Delete', variant: 'danger', onClick: () => run({ verb: 'Delete', past: 'Deleted', fn: (id) => adminApi.deleteUser(id), danger: true, message: DELETE_MESSAGE, requireText: 'DELETE' }) },
    ];

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <PageHeader title="Users" description="Manage user accounts" count={loading ? null : total} />

            <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <FilterTabs label="Account status" options={STATUSES} value={status} onChange={(v) => set({ status: v })} />
                <SearchInput value={params.q} onSearch={(q) => set({ q })} placeholder="Search name or email" label="Search users" />
            </div>

            <BulkActionBar count={bulk.count} actions={bulkActions} onClear={bulk.clear} busy={bulkBusy} />

            <Card
                padded={false}
                aria-busy={loading || refreshing || undefined}
                className={`overflow-hidden transition-opacity ${refreshing ? 'opacity-60' : ''}`}
            >
                {error ? (
                    <ErrorState title="Couldn't load users" message={error} onRetry={fetchUsers} />
                ) : loading ? (
                    <TableSkeleton rows={6} columns={6} />
                ) : users.length === 0 ? (
                    <EmptyState
                        icon={UsersIcon}
                        title={params.q || status !== 'all' ? 'No users match these filters' : 'No users yet'}
                        message={params.q ? `Nothing found for "${params.q}".` : undefined}
                    />
                ) : (
                    <Table label="Users">
                        <THead>
                            <Th className="w-10">
                                <RowCheckbox checked={bulk.isPageAllSelected(pageIds)} onChange={() => bulk.togglePage(pageIds)} label="Select all on this page" />
                            </Th>
                            <Th>User</Th>
                            <Th>Roles</Th>
                            <Th>Verified</Th>
                            <Th>Email</Th>
                            <Th>Joined</Th>
                            <Th>Status</Th>
                            <Th className="text-right">Actions</Th>
                        </THead>
                        <TBody>
                            {users.map((user) => {
                                const blocked = userStatus(user) === 'blocked';
                                const badge = user.verificationBadge && user.verificationBadge !== 'none' ? user.verificationBadge : null;
                                return (
                                    <tr
                                        key={user._id}
                                        onClick={() => navigate(`/users/${user._id}`)}
                                        className={`cursor-pointer ${bulk.isSelected(user._id) ? 'bg-violet-500/[0.06]' : ''}`}
                                    >
                                        <Td onClick={(e) => e.stopPropagation()}>
                                            <RowCheckbox checked={bulk.isSelected(user._id)} onChange={() => bulk.toggle(user._id)} label={`Select ${label(user)}`} />
                                        </Td>
                                        <Td>
                                            <div className="flex items-center gap-3">
                                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-sm font-medium text-white">
                                                    {(user.name?.charAt(0) || 'U').toUpperCase()}
                                                </span>
                                                <div className="min-w-0">
                                                    <p className="flex items-center gap-1 font-medium text-white">
                                                        {user.name || '—'}
                                                        {user.isVerified && <BadgeCheck className="h-4 w-4 text-violet-300" aria-label="Verified" />}
                                                    </p>
                                                    <p className="text-xs text-gray-400">{user.email || 'No email'}</p>
                                                </div>
                                            </div>
                                        </Td>
                                        <Td>
                                            <div className="flex gap-1">
                                                {userRoleLabels(user).map((r) => <StatusBadge key={r} value={r} />)}
                                            </div>
                                        </Td>
                                        <Td>
                                            {user.isVerified ? (
                                                <StatusBadge tone="accent" icon={BadgeCheck}>{badge ? humanize(badge) : 'Verified'}</StatusBadge>
                                            ) : (
                                                <span className="text-gray-500">—</span>
                                            )}
                                        </Td>
                                        <Td>
                                            {user.emailVerified ? (
                                                <span className="inline-flex items-center gap-1 text-xs text-green-400"><MailCheck className="h-4 w-4" aria-hidden="true" />Verified</span>
                                            ) : (
                                                <span className="inline-flex items-center gap-1 text-xs text-amber-300"><MailX className="h-4 w-4" aria-hidden="true" />Unverified</span>
                                            )}
                                        </Td>
                                        <Td>{formatDate(user.createdAt)}</Td>
                                        <Td><StatusBadge value={userStatus(user)} /></Td>
                                        <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                                            <div className="flex items-center justify-end gap-1">
                                                {blocked ? (
                                                    <IconButton label={`Unblock ${label(user)}`} tone="success" icon={RotateCcw} onClick={() => setBlocked(user, false)} />
                                                ) : (
                                                    <IconButton label={`Block ${label(user)}`} tone="danger" icon={Ban} onClick={() => setBlocked(user, true)} />
                                                )}
                                                <IconButton label={`Delete ${label(user)}`} tone="danger" icon={Trash2} onClick={() => handleDelete(user)} />
                                            </div>
                                        </Td>
                                    </tr>
                                );
                            })}
                        </TBody>
                    </Table>
                )}

                {!loading && !error && (
                    <Pagination currentPage={params.page} totalPages={totalPages} onChange={(page) => set({ page })} />
                )}
            </Card>
        </div>
    );
}
