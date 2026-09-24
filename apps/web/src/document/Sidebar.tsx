// SPDX-License-Identifier: AGPL-3.0-only
import { useLocation, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import type { KeyboardEvent } from "react";
import { Icon } from "../ui/AppShell";
import { ExternalLink } from "../ui/ExternalLink";
import { type DocEntry, STATUS_LETTER } from "./docs";

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
}

export function Sidebar(props: SidebarProps) {
  const navigate = useNavigate({ from: ROUTE });
  const setMode = (files: "changed" | "all") => navigate({ search: (s) => ({ ...s, files }) });
  const list = props.mode === "changed" ? props.changed : props.all;

  return (
    <>
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
      ) : (
        // Keyed by mode: replacing the whole list is one DOM removal instead of thousands.
        <FileList key={props.mode} {...props} list={list} />
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
function onListKey(event: KeyboardEvent<HTMLUListElement>) {
  const keys: Record<string, (i: number, n: number) => number> = {
    ArrowDown: (i, n) => Math.min(i + 1, n - 1),
    ArrowUp: (i) => Math.max(i - 1, 0),
    Home: () => 0,
    End: (_, n) => n - 1,
  };
  const move = keys[event.key];
  if (!move) return;
  const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>("a.rr-file")];
  const i = links.indexOf(document.activeElement as HTMLAnchorElement);
  event.preventDefault();
  links[move(i, links.length)]?.focus();
}

function FileList(props: SidebarProps & { list: DocEntry[] }) {
  // Plain anchors, not <Link>: each Link subscribes to router state, which is slow for 10k+ entries.
  const router = useRouter();
  const search = useSearch({ from: ROUTE });
  const pathname = useLocation({ select: (l) => l.pathname });
  const focusable = props.list.some((d) => d.path === props.selected) ? props.selected : props.list[0]?.path;
  // ponytail: renders every entry (mdn/content: 15k in ~0.6s); virtualize if larger repositories lag.
  return (
    <ul
      className="rr-filelist"
      onKeyDown={onListKey}
      onClick={(event) => {
        // Client-side navigation for plain clicks; modified clicks keep the browser's behaviour.
        const link = (event.target as Element).closest<HTMLAnchorElement>("a.rr-file");
        if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        void router.navigate({ href: link.getAttribute("href")! });
      }}
    >
      {props.list.map((doc) => (
        <FileItem
          key={doc.path}
          doc={doc}
          href={pathname + router.options.stringifySearch({ ...search, doc: doc.path, thread: undefined })}
          tabbable={doc.path === focusable}
          {...props}
        />
      ))}
    </ul>
  );
}

function FileItem({
  doc,
  href,
  tabbable,
  selected,
  unresolved,
  resolutionKnown,
}: { doc: DocEntry; href: string; tabbable: boolean } & SidebarProps) {
  const dir = dirOf(doc.path);
  const count = unresolved?.get(doc.path);
  const status = STATUS_LABEL[doc.status];
  return (
    <li>
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
