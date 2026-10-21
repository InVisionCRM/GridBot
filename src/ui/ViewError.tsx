/**
 * A screen that fails to draw shows its error here instead of taking the whole app down: without this a render error
 * left a black page, and since the last screen is reopened on every load, it stayed black across restarts.
 */
import { Component, type ReactNode } from 'react';

export class ViewError extends Component<{ children: ReactNode; onHome: () => void }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="banner error" role="alert">
        <span className="grow">This screen hit an error and couldn't be shown: <b>{error.message}</b></span>
        <button type="button" className="btn small-btn" onClick={this.props.onHome}>Back to Home</button>
      </div>
    );
  }
}
