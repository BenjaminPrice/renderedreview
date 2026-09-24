// SPDX-License-Identifier: AGPL-3.0-only
import { Link } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  nextTheme,
  readConnectors,
  readRail,
  readTheme,
  saveConnectors,
  saveRail,
  saveTheme,
  type RailMode,
  type Theme,
} from "./prefs";
import { ViewerSlot } from "./Viewer";

const RAIL_ID = "rr-rail";

const ICONS = {
  comment: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z",
  sun: "M8 5a3 3 0 1 1 0 6a3 3 0 1 1 0-6M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1",
  moon: "M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z",
  system: "M2 3h12v8H2zM5.5 14h5M8 11v3",
  x: "M4 4l8 8M12 4l-8 8",
};

export function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg className="rr-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

type Shell = {
  railMode: RailMode;
  /** Shows the rail: a collapsed rail opens as a slide-over. Callers may then focus a thread in it. */
  openRail: () => void;
  connectors: boolean;
  setConnectors: (on: boolean) => void;
  /** Registers work to finish before a pinned rail collapses (connector retraction). */
  setBeforeCollapse: (fn: (() => Promise<void>) | null) => void;
};

const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell must be used inside <AppShell>");
  return shell;
}

export type AppShellProps = {
  /** Top bar, after the wordmark: PR title and meta. */
  title?: ReactNode;
  /** Top bar, right side before the theme toggle: "Open in GitHub", "Review". */
  actions?: ReactNode;
  /** Document sidebar. Omitted: no sidebar (e.g. the home page). */
  sidebar?: ReactNode;
  /** Toolbar content before the Comments button; `toolbarEnd` goes after it. */
  toolbar?: ReactNode;
  toolbarEnd?: ReactNode;
  commentCount?: number;
  /** Rail header content under the title (connector switch, filters). */
  railHeader?: ReactNode;
  /** Comment rail. Omitted: no rail and no Comments button. */
  rail?: ReactNode;
  /** The document column. Its right padding is the margin-marker gutter. */
  children: ReactNode;
};

export function AppShell(props: AppShellProps) {
  // null until mounted: until then the pre-paint script's <html data-rail> drives the layout.
  const [rail, setRail] = useState<RailMode | null>(null);
  const [connectors, setConnectors] = useState(false);
  const commentsButton = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const railTitle = useRef<HTMLHeadingElement>(null);
  const beforeCollapse = useRef<(() => Promise<void>) | null>(null);
  const mode = rail ?? "pinned";

  useEffect(() => {
    setRail(readRail());
    setConnectors(readConnectors());
  }, []);

  useEffect(() => {
    if (rail) document.documentElement.dataset.rail = rail;
  }, [rail]);

  useEffect(() => {
    if (mode !== "slide") return;
    if (!railRef.current?.contains(document.activeElement)) railTitle.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSlideOver();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mode]);

  function closeSlideOver() {
    setRail("collapsed");
    commentsButton.current?.focus();
  }

  // The toolbar Comments button is the only pin control: pinned -> collapsed, otherwise -> pinned.
  function togglePinned() {
    const next = mode === "pinned" ? "collapsed" : "pinned";
    const apply = () => {
      setRail(next);
      saveRail(next);
    };
    if (next === "collapsed" && beforeCollapse.current) void beforeCollapse.current().then(apply);
    else apply();
  }

  const shell: Shell = {
    railMode: mode,
    openRail: () => setRail((current) => (current === "collapsed" ? "slide" : current)),
    connectors,
    setConnectors: (on) => {
      setConnectors(on);
      saveConnectors(on);
    },
    setBeforeCollapse: (fn) => {
      beforeCollapse.current = fn;
    },
  };

  return (
    <ShellContext.Provider value={shell}>
      <div className="rr-app">
        <header className="rr-topbar">
          <Link to="/" className="rr-wordmark" aria-label="Rendered Review home">
            <span className="rr-logo" aria-hidden="true">
              <svg viewBox="0 0 14 14">
                <path d="M3 4h8M3 7h8M3 10h5" />
              </svg>
            </span>
            Rendered Review
          </Link>
          {props.title && (
            <>
              <span className="rr-vsep" aria-hidden="true" />
              <div className="rr-topbar-title">{props.title}</div>
            </>
          )}
          <span className="rr-spacer" />
          {props.actions}
          <ThemeToggle />
          <ViewerSlot />
        </header>

        <div className="rr-body">
          {props.sidebar !== undefined && (
            <nav className="rr-sidebar" aria-label="Documents">
              {props.sidebar}
            </nav>
          )}

          <main className="rr-main">
            <div className="rr-toolbar">
              {props.toolbar}
              <span className="rr-spacer" />
              {props.rail !== undefined && (
                <button
                  ref={commentsButton}
                  type="button"
                  className="rr-btn rr-btn-sm"
                  aria-controls={RAIL_ID}
                  aria-pressed={mode === "pinned"}
                  title="Pin or unpin the comment rail"
                  onClick={togglePinned}
                >
                  <Icon name="comment" />
                  Comments
                  {props.commentCount !== undefined && <span className="rr-count">{props.commentCount}</span>}
                </button>
              )}
              {props.toolbarEnd}
            </div>

            <div className="rr-scroll">
              <div className="rr-canvas">
                <div className="rr-doc">{props.children}</div>
                {props.rail !== undefined && (
                  <aside ref={railRef} className="rr-rail" id={RAIL_ID} aria-labelledby={`${RAIL_ID}-title`}>
                    <div className="rr-rail-head">
                      <h2 ref={railTitle} className="rr-rail-title" id={`${RAIL_ID}-title`} tabIndex={-1}>
                        Comments
                        {props.commentCount !== undefined && <span className="rr-count">{props.commentCount}</span>}
                        <span className="rr-spacer" />
                        {mode === "slide" && (
                          <button
                            type="button"
                            className="rr-btn rr-btn-sm rr-btn-icon rr-btn-ghost"
                            aria-label="Close comments"
                            title="Close (Esc)"
                            onClick={closeSlideOver}
                          >
                            <Icon name="x" />
                          </button>
                        )}
                      </h2>
                      {props.railHeader}
                    </div>
                    {props.rail}
                  </aside>
                )}
              </div>
            </div>
          </main>
        </div>
      </div>
    </ShellContext.Provider>
  );
}

const THEME_LABEL: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };
const THEME_ICON = { system: "system", light: "sun", dark: "moon" } as const;

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => setTheme(readTheme()), []);
  const next = nextTheme(theme);
  const label = `Theme: ${THEME_LABEL[theme]}. Switch to ${THEME_LABEL[next]}`;
  return (
    <button
      type="button"
      className="rr-btn rr-btn-icon rr-btn-ghost"
      aria-label={label}
      title={label}
      onClick={() => {
        saveTheme(next, document.documentElement);
        setTheme(next);
      }}
    >
      <Icon name={THEME_ICON[theme]} />
    </button>
  );
}
