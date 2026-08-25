/**
 * Top-level error boundary (spec §34: never crash to a white screen).
 *
 * A React render error should not cost the user their library. This catches it,
 * shows what happened, and offers the two things that actually help: reload, or
 * open Settings to inspect and repair storage.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertOctagon } from 'lucide-react';
import { createLogger, describeError } from '@core/logger';

const log = createLogger('boundary');

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error('unhandled render error', { message: error.message, stack: info.componentStack });
    this.setState({ info: info.componentStack ?? null });
  }

  override render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center bg-bg p-6 text-text">
        <div className="w-full max-w-lg rounded-panel border border-line bg-surface p-6">
          <h1 className="flex items-center gap-2 text-base font-semibold">
            <AlertOctagon className="h-5 w-5 text-danger" />
            Something went wrong
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            MusiX hit an unexpected error while drawing this screen. Your library is stored
            separately and is not affected.
          </p>

          <pre className="mx-scroll mt-4 max-h-40 overflow-auto rounded-lg border border-line bg-bg p-3 text-2xs text-muted">
            {describeError(error)}
            {info ? `\n${info.trim()}` : ''}
          </pre>

          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="h-10 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover"
            >
              Reload MusiX
            </button>
            <button
              type="button"
              onClick={() => {
                window.location.href = '/settings';
              }}
              className="h-10 rounded-xl border border-line bg-surface px-4 text-sm font-medium hover:bg-surface-hover"
            >
              Open settings
            </button>
          </div>
        </div>
      </div>
    );
  }
}
