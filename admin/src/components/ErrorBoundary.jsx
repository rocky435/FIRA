import { Component } from 'react';
import { Link } from 'react-router-dom';
import { TriangleAlert, RotateCcw } from 'lucide-react';
import { Button } from './ui/Button';

/**
 * Reusable error boundary for the admin panel.
 * Catches render errors in children while keeping the rest of the UI functional.
 *
 * Props:
 *  - fallbackMessage (string): custom message shown on error
 *  - showDashboardLink (boolean): whether to show "Go to Dashboard" link (default: true)
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // ponytail: log only — no external reporting wired yet
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const message = this.props.fallbackMessage || 'Something went wrong loading this page.';
    const showDashboardLink = this.props.showDashboardLink !== false;

    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center px-6 text-center" role="alert" aria-live="assertive">
        <span className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/10 text-red-400">
          <TriangleAlert className="h-7 w-7" aria-hidden="true" />
        </span>

        <p className="mb-2 text-lg font-medium text-white">{message}</p>
        <p className="mb-8 max-w-md text-sm text-gray-400">
          {this.state.error?.message || 'An unexpected error occurred.'}
        </p>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button onClick={this.handleRetry} leftIcon={<RotateCcw className="h-4 w-4" aria-hidden="true" />}>Try again</Button>
          {showDashboardLink && (
            <Link
              to="/"
              className="inline-flex h-10 items-center rounded-xl border border-line-strong bg-surface-raised px-4 text-sm font-medium text-white transition-colors hover:bg-white/[0.08]"
            >
              Go to Dashboard
            </Link>
          )}
        </div>
      </div>
    );
  }
}
