import { UserPlus, TrendingUp, TrendingDown } from 'lucide-react';
import adminApi from '../api/adminApi';
import { useRemote } from '../lib/useRemote';
import { cn } from '../lib/cn';
import { Card } from './ui/Card';
import { BarChart } from './ui/BarChart';
import { Skeleton } from './ui/States';

const num = (n) => Number(n || 0).toLocaleString('en-IN');
const monthName = (key) => new Date(`${key}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short' });
const countAxis = (n) => (n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const loadSignups = () => adminApi.getSignups();

/**
 * Top of the Users page: how many people use FIRA, how many joined this month
 * against last month, and a year of sign-ups. A failure here only hides the
 * card; the user list below still works.
 */
export default function SignupsCard() {
    const { data, loading, error } = useRemote(loadSignups);
    if (error) return null;
    if (loading || !data) return <Skeleton className="mb-6 h-56 rounded-2xl" />;

    const months = data.months || [];
    const thisMonth = months[months.length - 1]?.newUsers || 0;
    const lastMonth = months[months.length - 2]?.newUsers || 0;
    const yearTotal = months.reduce((sum, m) => sum + m.newUsers, 0);
    const change = lastMonth ? Math.round(((thisMonth - lastMonth) / lastMonth) * 100) : null;
    const Trend = change != null && change < 0 ? TrendingDown : TrendingUp;

    return (
        <Card className="mb-6">
            <div className="grid gap-6 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:items-end">
                <div className="space-y-5">
                    <div>
                        <p className="text-xs text-gray-400">People on FIRA</p>
                        <p className="text-brand-grad text-4xl font-semibold tabular-nums">{num(data.total)}</p>
                    </div>
                    <dl className="grid grid-cols-2 gap-3">
                        <div className="rounded-xl border border-line bg-surface-raised p-3">
                            <dt className="flex items-center gap-1.5 text-xs text-gray-400"><UserPlus className="h-3.5 w-3.5" aria-hidden="true" />This month</dt>
                            <dd className="mt-1 text-lg font-semibold tabular-nums text-white">{num(thisMonth)}</dd>
                            {change != null && (
                                <dd className={cn('mt-0.5 flex items-center gap-1 text-xs tabular-nums', change < 0 ? 'text-red-300' : 'text-green-300')}>
                                    <Trend className="h-3 w-3" aria-hidden="true" />
                                    {change > 0 ? '+' : ''}{change}% <span className="text-gray-500">vs {num(lastMonth)}</span>
                                </dd>
                            )}
                        </div>
                        <div className="rounded-xl border border-line bg-surface-raised p-3">
                            <dt className="text-xs text-gray-400">Last 12 months</dt>
                            <dd className="mt-1 text-lg font-semibold tabular-nums text-white">{num(yearTotal)}</dd>
                            <dd className="mt-0.5 text-xs text-gray-500">joined</dd>
                        </div>
                    </dl>
                </div>
                <div>
                    <h2 className="mb-3 text-sm font-medium text-white">Sign-ups per month</h2>
                    <BarChart
                        label="Sign-ups per month, last 12 months"
                        data={months.map((m) => ({ label: monthName(m.month), value: m.newUsers }))}
                        format={num}
                        axisFormat={countAxis}
                        wholeNumbers
                        height={150}
                    />
                </div>
            </div>
        </Card>
    );
}
