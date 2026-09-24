// SPDX-License-Identifier: AGPL-3.0-only
import { useLocation, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import type { ReviewerState } from "@rendered-review/review-domain";
import {
  type KeyboardEvent,
  type LiHTMLAttributes,
  type MouseEvent,
  useDeferredValue,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { Icon } from "../ui/AppShell";
import { ExternalLink } from "../ui/ExternalLink";
import { type DocEntry, STATUS_LETTER } from "./docs";
import type { PrState } from "./Overview";
import { initials } from "../review/ThreadCard";

const ROUTE = "/$host/$owner/$repo/pull/$number";
const STATUS_LABEL = {
  added: "Added",
  modified: "Modified",
  renamed: "Renamed",
  deleted: "Deleted",
  unchanged: "Unchanged",
};

export interface SidebarProps {
  mode: "changed" | "all";
  changed: DocEntry[];
  /** Markdown at head; undefined while the tree loads. */
  all?: DocEntry[];
  /** The head tree listing was cut short by GitHub. */
  truncated?: boolean;
  allError?: boolean;
  selected?: string;
  /** Changed files that are not Markdown; they are reviewed on GitHub. */
  otherCount: number;
  filesUrl: string;
  /** Count of threads not known to be resolved, per document path. */
  unresolved?: ReadonlyMap<string, number>;
  /** Whether thread resolution is known; anonymous reads cannot see it, so counts include resolved threads. */
  resolutionKnown?: boolean;
  /** The pull request block above the documents; it opens the Overview. */
  pr: PrBlockProps;
}

export interface PrBlockProps {
  number: number;
  state: PrState;
  /** The Overview is shown. */
  selected: boolean;
  /** Timeline items; undefined while loading. */
  comments?: number;
  reviewers?: ReviewerState[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Client-side navigation for plain clicks on a plain anchor; modified clicks keep the browser's behaviour. */
function useAnchorNavigation() {
  const router = useRouter();
  return (event: MouseEvent, link: HTMLAnchorElement | null) => {
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void router.navigate({ href: link.getAttribute("href")! });
  };
}

function PrBlock({ number, state, selected, comments, reviewers = [] }: PrBlockProps) {
  const router = useRouter();
  const search = useSearch({ from: ROUTE });
  const pathname = useLocation({ select: (l) => l.pathname });
  const go = useAnchorNavigation();
  const href =
    pathname + router.options.stringifySearch({ ...search, view: "overview", doc: undefined, thread: undefined });
  const approvals = reviewers.filter((r) => r.state === "APPROVED").length;
  const changes = reviewers.filter((r) => r.state === "CHANGES_REQUESTED").length;
  const verdicts = [approvals && plural(approvals, "approval"), changes && plural(changes, "change request")].filter(
    Boolean,
  );
  return (
    <div className="rr-sidebar-pr">
      <a
        href={href}
        className="rr-pr-entry"
        aria-current={selected ? "page" : undefined}
        onClick={(event) => go(event, event.currentTarget)}
      >
        <Icon name="pr" className={`rr-pr-icon rr-pr-${state}`} />
        <span className="rr-pr-entry-text">
          <span className="rr-pr-entry-title">Pull request #{number}</span>
          <span className="rr-pr-entry-sub">
            Overview{comments !== undefined && ` · ${plural(comments, "comment")}`}
          </span>
          {verdicts.length > 0 && <span className="rr-pr-entry-sub">{verdicts.join(" · ")}</span>}
          {reviewers.length > 0 && (
            <span
              className="rr-pr-avatars"
              role="img"
              aria-label={`Reviewers: ${reviewers.map((r) => r.author.login).join(", ")}`}
            >
              {reviewers.map((r) => (
                <span key={r.author.login} className="rr-avatar" title={r.author.login}>
                  {initials(r.author.login)}
                </span>
              ))}
            </span>
          )}
        </span>
      </a>
    </div>
  );
}

export function Sidebar(props: SidebarProps) {
  const navigate = useNavigate({ from: ROUTE });
  const setMode = (files: "changed" | "all") => navigate({ search: (s) => ({ ...s, files }) });
  const list = props.mode === "changed" ? props.changed : props.all;

  return (
    <>
      <PrBlock {...props.pr} />
      <div className="rr-side-label">Documents</div>
      <div className="rr-sidebar-head">
        <div className="rr-seg rr-seg-fill" role="group" aria-label="Document scope">
          <button type="button" aria-pressed={props.mode === "changed"} onClick={() => setMode("changed")}>
            Changed docs <span className="rr-count">{props.changed.length}</span>
          </button>
          <button type="button" aria-pressed={props.mode === "all"} onClick={() => setMode("all")}>
            All docs {props.all && <span className="rr-count">{props.all.length}</span>}
          </button>
        </div>
      </div>

      {!list ? (
        <p className="rr-sidebar-note">{props.allError ? "Could not load the document list." : "Loading documents…"}</p>
      ) : list.length === 0 ? (
        <p className="rr-sidebar-note">
          {props.mode === "changed" ? "No Markdown changed in this pull request." : "No Markdown in this repository."}
        </p>
      ) : props.mode === "changed" ? (
        // Keyed by mode: replacing the whole list is one DOM removal instead of thousands.
        <FileList key={props.mode} {...props} list={list} />
      ) : (
        <AllDocs {...props} list={list} />
      )}
      {props.mode === "all" && props.truncated && (
        <p className="rr-sidebar-note">GitHub truncated the file tree, so some documents may be missing.</p>
      )}

      {props.otherCount > 0 && (
        <p className="rr-sidebar-foot">
          {props.otherCount} other {props.otherCount === 1 ? "file" : "files"} changed ·{" "}
          <ExternalLink href={props.filesUrl}>view on GitHub</ExternalLink>
        </p>
      )}
    </>
  );
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

// Arrow keys move between files; Tab leaves the list (roving tabindex).
const LIST_KEYS: Record<string, (i: number, n: number) => number> = {
  ArrowDown: (i, n) => Math.min(i + 1, n - 1),
  ArrowUp: (i) => Math.max(i - 1, 0),
  Home: () => 0,
  End: (_, n) => n - 1,
};

function onListKey(event: KeyboardEvent<HTMLUListElement>) {
  const move = LIST_KEYS[event.key];
  if (!move) return;
  const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>("a.rr-file")];
  const i = links.indexOf(document.activeElement as HTMLAnchorElement);
  event.preventDefault();
  links[move(i, links.length)]?.focus();
}

/** Links to documents. Plain anchors, not <Link>: each Link subscribes to router state. */
function useDocHref() {
  const router = useRouter();
  const search = useSearch({ from: ROUTE });
  const pathname = useLocation({ select: (l) => l.pathname });
  return (path: string) =>
    pathname + router.options.stringifySearch({ ...search, doc: path, view: undefined, thread: undefined });
}

const clickedFile = (event: MouseEvent) => (event.target as Element).closest<HTMLAnchorElement>("a.rr-file");

/** The changed documents: few enough to render every entry. */
function FileList(props: SidebarProps & { list: DocEntry[] }) {
  const href = useDocHref();
  const go = useAnchorNavigation();
  const focusable = props.list.some((d) => d.path === props.selected) ? props.selected : props.list[0]?.path;
  return (
    <ul
      className="rr-filelist"
      aria-label="Changed documents"
      onKeyDown={onListKey}
      onClick={(event) => go(event, clickedFile(event))}
    >
      {props.list.map((doc) => (
        <FileItem key={doc.path} doc={doc} href={href(doc.path)} tabbable={doc.path === focusable} {...props} />
      ))}
    </ul>
  );
}

/** Every head document, filtered by a case-insensitive path substring. */
function AllDocs(props: SidebarProps & { list: DocEntry[] }) {
  const [query, setQuery] = useState("");
  // Deferred rather than debounced: typing stays responsive while the filter catches up.
  const filter = useDeferredValue(query.trim().toLowerCase());
  const list = useMemo(
    () => (filter ? props.list.filter((d) => d.path.toLowerCase().includes(filter)) : props.list),
    [props.list, filter],
  );
  return (
    <>
      <div className="rr-sidebar-filter">
        <input
          type="search"
          aria-label="Filter documents"
          placeholder="Filter by path"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <p className="rr-sidebar-note rr-filter-count" role="status">
        {filter && plural(list.length, "document")}
      </p>
      <VirtualFileList key={filter} {...props} list={list} />
    </>
  );
}

/** Row height of the virtualized list; `.rr-filelist-virtual > li` in styles.css matches it. */
const ROW_H = 34;
/** Rows rendered beyond each edge of the viewport. */
const OVERSCAN = 10;

/**
 * Only the rows in view (plus overscan, plus the tabbable row) are in the DOM, so very large
 * repositories stay fast. Rows carry their position and the list size for screen readers.
 */
function VirtualFileList(props: SidebarProps & { list: DocEntry[] }) {
  const { list } = props;
  const href = useDocHref();
  const go = useAnchorNavigation();
  const scroller = useRef<HTMLDivElement>(null);
  const selectedIndex = list.findIndex((d) => d.path === props.selected);
  const [active, setActive] = useState(Math.max(selectedIndex, 0));
  const [view, setView] = useState({ top: 0, height: 0 });
  const measure = () => {
    const el = scroller.current;
    if (el) setView({ top: el.scrollTop, height: el.clientHeight });
  };
  useLayoutEffect(() => {
    const el = scroller.current!;
    // Open with the selected document in view.
    if (selectedIndex > 0) el.scrollTop = selectedIndex * ROW_H - el.clientHeight / 2;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []); // Mount only: later selections are made in this list, already in view.

  const first = Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN);
  const last = Math.min(list.length, Math.ceil((view.top + view.height) / ROW_H) + OVERSCAN);
  const shown = Array.from({ length: last - first }, (_, i) => first + i);
  if (active < list.length && (active < first || active >= last)) shown.push(active);

  const onKeyDown = (event: KeyboardEvent) => {
    const move = LIST_KEYS[event.key];
    const el = scroller.current!;
    if (!move || !list.length) return;
    event.preventDefault();
    const next = move(active, list.length);
    const top = next * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    // Render the target row now so it can take focus.
    flushSync(() => {
      setActive(next);
      measure();
    });
    el.querySelector<HTMLElement>(`[aria-posinset="${next + 1}"] > a`)?.focus();
  };

  return (
    <div className="rr-filescroll" ref={scroller} onScroll={measure}>
      <ul
        className="rr-filelist rr-filelist-virtual"
        aria-label="All documents"
        style={{ height: list.length * ROW_H }}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          const link = clickedFile(event);
          const row = link?.parentElement?.getAttribute("aria-posinset");
          if (row) setActive(Number(row) - 1);
          go(event, link);
        }}
      >
        {shown.map((i) => (
          <FileItem
            key={list[i]!.path}
            doc={list[i]!}
            href={href(list[i]!.path)}
            tabbable={i === active}
            li={{ "aria-setsize": list.length, "aria-posinset": i + 1, style: { top: i * ROW_H } }}
            {...props}
          />
        ))}
      </ul>
    </div>
  );
}

function FileItem({
  doc,
  href,
  tabbable,
  li,
  selected,
  unresolved,
  resolutionKnown,
}: { doc: DocEntry; href: string; tabbable: boolean; li?: LiHTMLAttributes<HTMLLIElement> } & SidebarProps) {
  const dir = dirOf(doc.path);
  const count = unresolved?.get(doc.path);
  const status = STATUS_LABEL[doc.status];
  return (
    <li {...li}>
      <a
        href={href}
        className={`rr-file${doc.status === "deleted" ? " rr-file-deleted" : ""}`}
        aria-current={doc.path === selected ? "page" : undefined}
        tabIndex={tabbable ? 0 : -1}
        title={doc.path}
        aria-label={[
          doc.path,
          status.toLowerCase(),
          doc.previousPath && `from ${doc.previousPath}`,
          doc.status === "deleted" && "historical, base revision",
          count && `${count} ${resolutionKnown ? "unresolved " : ""}${count === 1 ? "comment" : "comments"}`,
        ]
          .filter(Boolean)
          .join(", ")}
      >
        <span className={`rr-status rr-status-${doc.status}`} title={status} aria-hidden="true">
          {STATUS_LETTER[doc.status]}
        </span>
        <span className="rr-file-name">
          <span className="rr-file-path">
            {/* Long directories truncate from the start so the tail and file name stay visible. */}
            {dir && (
              <span className="rr-file-dir">
                <bdi>{dir}</bdi>
              </span>
            )}
            <span className="rr-file-base">{doc.path.slice(dir.length)}</span>
          </span>
          {doc.previousPath && <span className="rr-file-sub">from {doc.previousPath}</span>}
          {doc.status === "deleted" && <span className="rr-file-sub">historical · base revision</span>}
        </span>
        {count ? (
          <span className="rr-file-comments" aria-hidden="true">
            <Icon name="comment" />
            {count}
          </span>
        ) : null}
      </a>
    </li>
  );
}
