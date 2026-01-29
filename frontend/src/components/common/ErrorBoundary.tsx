/**
 * ErrorBoundary Component
 *
 * Catches JavaScript errors anywhere in the child component tree,
 * logs those errors, and displays a fallback UI.
 */

import type { ErrorInfo, ReactNode } from 'react';
import React, { Component } from 'react';

interface ErrorBoundaryProps {
  /** Child components to wrap */
  children: ReactNode;
  /** Custom fallback component */
  fallback?: ReactNode;
  /** Callback when error is caught */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error Boundary component for catching and handling React errors
 *
 * @example
 * ```tsx
 * <ErrorBoundary fallback={<ErrorPage />}>
 *   <MyComponent />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div style={styles.container}>
          <div style={styles.content}>
            <div style={styles.iconContainer}>
              <svg
                width="64"
                height="64"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={styles.icon}
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <h2 style={styles.title}>Something went wrong</h2>
            <p style={styles.message}>
              We're sorry, but something unexpected happened. Please try again.
            </p>
            {this.state.error && (
              <details style={styles.details}>
                <summary style={styles.summary}>Error details</summary>
                <pre style={styles.errorText}>{this.state.error.message}</pre>
              </details>
            )}
            <div style={styles.actions}>
              <button onClick={this.handleRetry} style={styles.retryButton}>
                Try Again
              </button>
              <button onClick={() => window.location.reload()} style={styles.reloadButton}>
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    minHeight: 'calc(100vh - 80px)',
    paddingTop: '15vh',
    padding: '2rem',
  },
  content: {
    textAlign: 'center',
    maxWidth: '400px',
  },
  iconContainer: {
    marginBottom: '1.5rem',
  },
  icon: {
    color: 'var(--error, #ef4444)',
  },
  title: {
    fontSize: '1.5rem',
    fontWeight: 600,
    color: 'var(--text-primary, #ffffff)',
    marginBottom: '0.75rem',
  },
  message: {
    fontSize: '1rem',
    color: 'var(--text-secondary, #a1a1aa)',
    marginBottom: '1.5rem',
    lineHeight: 1.5,
  },
  details: {
    marginBottom: '1.5rem',
    textAlign: 'left',
  },
  summary: {
    cursor: 'pointer',
    color: 'var(--text-secondary, #a1a1aa)',
    fontSize: '0.875rem',
  },
  errorText: {
    marginTop: '0.5rem',
    padding: '0.75rem',
    backgroundColor: 'var(--bg-secondary, #1a1a1a)',
    borderRadius: '8px',
    fontSize: '0.75rem',
    color: 'var(--text-danger, #ef4444)',
    overflow: 'auto',
    maxHeight: '150px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  actions: {
    display: 'flex',
    gap: '0.75rem',
    justifyContent: 'center',
  },
  retryButton: {
    padding: '0.625rem 1.25rem',
    backgroundColor: 'var(--accent, #3b82f6)',
    color: '#ffffff',
    border: 'none',
    borderRadius: '8px',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'background-color 0.2s',
  },
  reloadButton: {
    padding: '0.625rem 1.25rem',
    backgroundColor: 'transparent',
    color: 'var(--text-secondary, #a1a1aa)',
    border: '1px solid var(--border, #27272a)',
    borderRadius: '8px',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
};

/**
 * Hook-style error boundary wrapper using Error Boundary
 *
 * @example
 * ```tsx
 * const MyPage = withErrorBoundary(MyPageComponent, {
 *   fallback: <CustomErrorUI />
 * });
 * ```
 */
// eslint-disable-next-line react-refresh/only-export-components
export function withErrorBoundary<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  errorBoundaryProps?: Omit<ErrorBoundaryProps, 'children'>
): React.FC<P> {
  const WithErrorBoundary: React.FC<P> = (props) => (
    <ErrorBoundary {...errorBoundaryProps}>
      <WrappedComponent {...props} />
    </ErrorBoundary>
  );

  WithErrorBoundary.displayName = `WithErrorBoundary(${WrappedComponent.displayName || WrappedComponent.name || 'Component'})`;

  return WithErrorBoundary;
}

export default ErrorBoundary;
