import { error as logError } from "@tauri-apps/plugin-log";
import { Component, type ErrorInfo, type ReactNode } from "react";
import ErrorComponent from "@/components/ErrorComponent";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Scopes a render/lifecycle/effect crash to the subtree it wraps instead of
 * letting it blank the whole window. Used around the board tab so a bad tree,
 * a failed persist, or a broken panel shows the recoverable error screen while
 * the tab strip and the rest of the app stay usable.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logError(`${error.stack ?? error.message}\n${info.componentStack ?? ""}`);
  }

  render() {
    if (this.state.error) {
      return <ErrorComponent error={this.state.error} />;
    }
    return this.props.children;
  }
}
