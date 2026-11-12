import { useState, useEffect, lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import AdminDashboardLayout from './components/AdminDashboardLayout';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider } from './components/ui/Toast';
import { ConfirmProvider } from './components/ui/ConfirmDialog';
import { PageSkeleton } from './components/ui/States';
import adminApi, { ADMIN_TOKEN_KEY } from './api/adminApi';
import './index.css';

// ponytail: lazy-load all pages — each page's code stays out of the initial chunk
// Retry wrapper handles chunk load failures (e.g. new deploy while user has stale tab)
function lazyWithRetry(importFn) {
  return lazy(() => retryImport(importFn));
}

function retryImport(importFn, retries = 2, delay = 500) {
  return importFn().catch((err) => {
    if (retries <= 0) throw err;
    return new Promise((resolve) => setTimeout(resolve, delay)).then(() =>
      retryImport(importFn, retries - 1, delay)
    );
  });
}

const Dashboard = lazyWithRetry(() => import('./pages/Dashboard'));
const Venues = lazyWithRetry(() => import('./pages/Venues'));
const VenueDetail = lazyWithRetry(() => import('./pages/VenueDetail'));
const VenueOwners = lazyWithRetry(() => import('./pages/VenueOwners'));
const Events = lazyWithRetry(() => import('./pages/Events'));
const EventDetail = lazyWithRetry(() => import('./pages/EventDetail'));
const Brands = lazyWithRetry(() => import('./pages/Brands'));
const BrandDetail = lazyWithRetry(() => import('./pages/BrandDetail'));
const Users = lazyWithRetry(() => import('./pages/Users'));
const UserDetail = lazyWithRetry(() => import('./pages/UserDetail'));
const AuditTrail = lazyWithRetry(() => import('./pages/AuditTrail'));
const DiscountCodes = lazyWithRetry(() => import('./pages/DiscountCodes'));
const Refunds = lazyWithRetry(() => import('./pages/Refunds'));
const IdChecks = lazyWithRetry(() => import('./pages/IdChecks'));
const Bookings = lazyWithRetry(() => import('./pages/Bookings'));
const Payouts = lazyWithRetry(() => import('./pages/Payouts'));
const Login = lazyWithRetry(() => import('./pages/Login'));

// Loading fallback while a page's code downloads: the page's rough shape, so
// the layout does not jump when it arrives.
function PageLoader() {
  return <PageSkeleton />;
}

const AUTH_KEY = 'fira_admin_auth';

/**
 * Whether a session can be restored from this browser.
 *
 * The session is the JWT itself - previously this was a self-declared
 * `{authenticated: true}` flag with a client-chosen expiry, which anyone
 * could write into localStorage by hand to "log in". The real gate is
 * server-side; this only decides which screen to show.
 */
function restoreSession() {
  try {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);
    const storedAuth = localStorage.getItem(AUTH_KEY);
    if (token && storedAuth) {
      JSON.parse(storedAuth);
      return true;
    }
  } catch {
    // Unreadable stored session - fall through and clear it.
  }
  // One without the other (or a corrupt one) is a half-session, e.g. left over
  // from the old hardcoded login - clear both so the user gets a clean sign-in.
  try {
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // Storage blocked: nothing to clear.
  }
  return false;
}

function App() {
  // Read once, on the first render, rather than in an effect after it: no blank
  // frame, and no setState inside an effect.
  const [isAuthenticated, setIsAuthenticated] = useState(restoreSession);

  // Keep the admin session alive. The server token is 7-day with no refresh
  // token, so a long-lived tab used to get logged out at the cliff. Slide it
  // forward once on mount and daily thereafter; a failed refresh is a no-op.
  useEffect(() => {
    if (!isAuthenticated) return;
    adminApi.refresh().catch(() => {});
    const id = setInterval(() => adminApi.refresh().catch(() => {}), 24 * 60 * 60 * 1000);
    return () => clearInterval(id);
  }, [isAuthenticated]);

  const handleLogin = ({ user }) => {
    // adminApi.login already stored the token.
    localStorage.setItem(AUTH_KEY, JSON.stringify({
      name: user?.name,
      email: user?.email,
      role: user?.role,
      adminRole: user?.adminRole || null,
      loginTime: new Date().toISOString(),
    }));
    setIsAuthenticated(true);
  };

  const handleLogout = () => {
    adminApi.logout();
    localStorage.removeItem(AUTH_KEY);
    setIsAuthenticated(false);
  };

  if (!isAuthenticated) {
    return (
      <ToastProvider>
        <Router>
          <Suspense fallback={<div className="min-h-screen bg-background" />}>
            <Routes>
              <Route path="*" element={<Login onLogin={handleLogin} />} />
            </Routes>
          </Suspense>
        </Router>
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <ConfirmProvider>
        <Router>
          <AdminDashboardLayout onLogout={handleLogout}>
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/" element={<ErrorBoundary fallbackMessage="Failed to load Dashboard."><Dashboard /></ErrorBoundary>} />
                <Route path="/venues" element={<ErrorBoundary fallbackMessage="Failed to load Venues."><Venues /></ErrorBoundary>} />
                <Route path="/venue-owners" element={<ErrorBoundary fallbackMessage="Failed to load Venue Owners."><VenueOwners /></ErrorBoundary>} />
                <Route path="/venues/:id" element={<ErrorBoundary fallbackMessage="Failed to load Venue details."><VenueDetail /></ErrorBoundary>} />
                <Route path="/events" element={<ErrorBoundary fallbackMessage="Failed to load Events."><Events /></ErrorBoundary>} />
                <Route path="/events/:id" element={<ErrorBoundary fallbackMessage="Failed to load Event details."><EventDetail /></ErrorBoundary>} />
                <Route path="/brands" element={<ErrorBoundary fallbackMessage="Failed to load Brands."><Brands /></ErrorBoundary>} />
                <Route path="/brands/:id" element={<ErrorBoundary fallbackMessage="Failed to load Brand details."><BrandDetail /></ErrorBoundary>} />
                <Route path="/users" element={<ErrorBoundary fallbackMessage="Failed to load Users."><Users /></ErrorBoundary>} />
                <Route path="/users/:id" element={<ErrorBoundary fallbackMessage="Failed to load User details."><UserDetail /></ErrorBoundary>} />
                <Route path="/audit-trail" element={<ErrorBoundary fallbackMessage="Failed to load Audit Trail."><AuditTrail /></ErrorBoundary>} />
                <Route path="/discount-codes" element={<ErrorBoundary fallbackMessage="Failed to load Discount Codes."><DiscountCodes /></ErrorBoundary>} />
                <Route path="/refunds" element={<ErrorBoundary fallbackMessage="Failed to load Refunds."><Refunds /></ErrorBoundary>} />
                <Route path="/id-checks" element={<ErrorBoundary fallbackMessage="Failed to load ID Checks."><IdChecks /></ErrorBoundary>} />
                <Route path="/bookings" element={<ErrorBoundary fallbackMessage="Failed to load Venue Bookings."><Bookings /></ErrorBoundary>} />
                <Route path="/payouts" element={<ErrorBoundary fallbackMessage="Failed to load Payouts."><Payouts /></ErrorBoundary>} />
                <Route path="*" element={<Navigate to="/" />} />
              </Routes>
            </Suspense>
          </AdminDashboardLayout>
        </Router>
      </ConfirmProvider>
    </ToastProvider>
  );
}

export default App;
