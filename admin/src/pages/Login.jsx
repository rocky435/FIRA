import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, TriangleAlert } from 'lucide-react';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import adminApi from '../api/adminApi';
import logo from '../assets/logo.png';

/**
 * Same rule the server applies (middleware/auth.js requireAuth('admin')): an
 * account is an admin if `roles` includes 'admin' or the legacy `role` is
 * 'admin'. Checking only `role` refused admins whose access is in `roles`.
 */
function isAdminAccount(user) {
    if (!user) return false;
    const roles = Array.isArray(user.roles) ? user.roles : [];
    return user.role === 'admin' || roles.includes('admin');
}

export default function Login({ onLogin }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const navigate = useNavigate();

    /**
     * Authenticate against the real API.
     *
     * The server issues a JWT and every admin request carries it; the role
     * check happens server-side where it cannot be bypassed by editing
     * client code.
     */
    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setIsLoading(true);

        try {
            const { user, token } = await adminApi.login(email, password);

            // Authorisation is enforced server-side; this check only avoids
            // dropping a non-admin into a dashboard where every call would 403.
            if (!isAdminAccount(user)) {
                // login() already stored the token; a non-admin should not keep it.
                adminApi.logout();
                setError('This account does not have admin access.');
                setIsLoading(false);
                return;
            }

            onLogin({ user, token });
            navigate('/');
        } catch (err) {
            setError(err?.message || 'Invalid email or password');
            setIsLoading(false);
        }
    };

    return (
        <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-12">
            {/* One soft brand glow, static - no animated light show. */}
            <div
                className="pointer-events-none absolute left-1/2 top-0 h-[420px] w-[720px] max-w-full -translate-x-1/2 rounded-full bg-violet-600/10 blur-3xl"
                aria-hidden="true"
            />

            <main className="relative w-full max-w-sm">
                <div className="mb-8 text-center">
                    <img src={logo} alt="FIRA" className="mx-auto mb-5 h-12 w-auto" />
                    <h1 className="text-2xl font-semibold tracking-tight text-white">Sign in to FIRA Admin</h1>
                    <p className="mt-1.5 text-sm text-gray-400">Manage venues, events, people and payouts</p>
                </div>

                <div className="rounded-2xl border border-line bg-surface p-6 shadow-2xl sm:p-7">
                    {error && (
                        <div role="alert" className="mb-5 flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/10 px-3.5 py-3 text-sm text-red-300">
                            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>{error}</span>
                        </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-4">
                        <Input
                            label="Email"
                            type="email"
                            autoComplete="username"
                            placeholder="you@letsfira.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                            autoFocus
                            leftIcon={<Mail className="h-4 w-4" aria-hidden="true" />}
                        />

                        <Input
                            label="Password"
                            type={showPassword ? 'text' : 'password'}
                            autoComplete="current-password"
                            placeholder="Your password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            leftIcon={<Lock className="h-4 w-4" aria-hidden="true" />}
                            rightIcon={
                                <button
                                    type="button"
                                    onClick={() => setShowPassword(!showPassword)}
                                    className="cursor-pointer rounded p-0.5 text-gray-400 transition-colors hover:text-white"
                                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                                    aria-pressed={showPassword}
                                >
                                    {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                                </button>
                            }
                        />

                        <Button type="submit" variant="primary" size="lg" className="w-full" isLoading={isLoading}>
                            Sign in
                        </Button>
                    </form>

                    {import.meta.env.VITE_DEV_MODE === 'true' && (
                        <div className="mt-6 border-t border-line pt-5 text-center">
                            <p className="mb-1 text-[10px] uppercase tracking-widest text-yellow-500/70">⚠ Development only</p>
                            <p className="text-xs text-gray-300">Dev credentials: admin@gmail.com / admin123</p>
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
}
