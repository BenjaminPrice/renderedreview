// SPDX-License-Identifier: AGPL-3.0-only
import type { Element, Nodes } from "hast";
import { toHtml } from "hast-util-to-html";
import { describe, expect, test } from "vitest";
import { renderMarkdown } from "./render.js";
import type { DocumentLocation, ResourceOptions } from "./resources.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const location: DocumentLocation = {
  host: "github.com",
  owner: "acme",
  repo: "specs",
  commitOid: SHA,
  path: "docs/rfd/0042.md",
};
const RAW = `https://raw.githubusercontent.com/acme/specs/${SHA}`;
const BLOB = `https://github.com/acme/specs/blob/${SHA}`;

function elements(markdown: string, tagName: string, options: ResourceOptions = { location }): Element[] {
  const found: Element[] = [];
  const visit = (node: Nodes) => {
    if (node.type === "element" && node.tagName === tagName) found.push(node);
    if ("children" in node) node.children.forEach(visit);
  };
  visit(renderMarkdown(markdown, options).tree);
  return found;
}
const src = (markdown: string, options?: ResourceOptions) => elements(markdown, "img", options)[0]?.properties.src;
const href = (markdown: string, options?: ResourceOptions) => elements(markdown, "a", options)[0]?.properties.href;

describe("repository images resolve to the document's commit", () => {
  test.each([
    ["diagram.png", `${RAW}/docs/rfd/diagram.png`],
    ["<./img/a b.png>", `${RAW}/docs/rfd/img/a%20b.png`],
    ["../../logo.svg", `${RAW}/logo.svg`],
    ["/assets/logo.svg", `${RAW}/assets/logo.svg`],
    ["img/x.png?raw=true#frag", `${RAW}/docs/rfd/img/x.png`],
  ])("%s", (path, expected) => {
    expect(src(`![alt](${path})`)).toBe(expected);
  });

  test("raw HTML images and picture sources resolve too", () => {
    expect(src('<img src="img\\x.png">')).toBe(`${RAW}/docs/rfd/img/x.png`);
    const md =
      '<picture><source media="(prefers-color-scheme: dark)" srcset="dark.png 2x"><img src="light.png"></picture>';
    expect(elements(md, "source")[0]!.properties.srcSet).toBe(`${RAW}/docs/rfd/dark.png 2x`);
    expect(src(md)).toBe(`${RAW}/docs/rfd/light.png`);
  });

  test("Enterprise Server hosts use the web host's raw route", () => {
    expect(src("![a](a.png)", { location: { ...location, host: "ghe.example.com" } })).toBe(
      `https://ghe.example.com/acme/specs/raw/${SHA}/docs/rfd/a.png`,
    );
  });

  test("a resolver may route images elsewhere but cannot inject unsafe URLs", () => {
    expect(src("![a](a.png)", { location, resolveImage: (p) => `/proxy/${p}` })).toBe("/proxy/docs/rfd/a.png");
    expect(src("![a](a.png)", { location, resolveImage: () => undefined })).toBe(`${RAW}/docs/rfd/a.png`);
    for (const bad of ["javascript:alert(1)", "//evil.example/x", "/\\evil.example/x", "data:image/png,x"]) {
      expect(src("![a](a.png)", { location, resolveImage: () => bad })).toBe(`${RAW}/docs/rfd/a.png`);
    }
  });

  test("without a location, relative images are dropped", () => {
    expect(src("![a](a.png)", {})).toBeUndefined();
  });
});

describe("repository links resolve to the document's commit", () => {
  test.each([
    ["other.md", `${BLOB}/docs/rfd/other.md`],
    ["../adr/0001.md#context", `${BLOB}/docs/adr/0001.md#context`],
    ["/README.md?plain=1", `${BLOB}/README.md?plain=1`],
    ["./", `https://github.com/acme/specs/tree/${SHA}/docs/rfd/`],
    ["..", `https://github.com/acme/specs/tree/${SHA}/docs/`],
    ["/", `https://github.com/acme/specs/tree/${SHA}/`],
  ])("%s", (path, expected) => {
    expect(href(`[x](${path})`)).toBe(expected);
  });

  test("a resolver can send Markdown files to an in-app route", () => {
    const resolveLink = (path: string, suffix: string) => (path.endsWith(".md") ? `/doc/${path}${suffix}` : undefined);
    expect(href("[x](../adr/1.md#a)", { location, resolveLink })).toBe("/doc/docs/adr/1.md#a");
    expect(href("[x](data.csv)", { location, resolveLink })).toBe(`${BLOB}/docs/rfd/data.csv`);
    expect(href("[x](a.md)", { location, resolveLink: () => "javascript:alert(1)" })).toBe(`${BLOB}/docs/rfd/a.md`);
  });

  test("absolute links are left alone", () => {
    expect(href("[x](https://example.com/a?b#c)")).toBe("https://example.com/a?b#c");
    expect(href("[x](mailto:a@example.com)")).toBe("mailto:a@example.com");
  });
});

describe("paths escaping the repository lose their URL", () => {
  test.each([
    "../../../etc/passwd",
    "/../x.png",
    "a/../../../../x.png",
    "%2e%2e/%2e%2e/%2e%2e/x.png",
    "a%2F..%2F..%2Fx.png",
    "..\\..\\..\\x.png",
    "%E0%A4%A.png",
  ])("%s", (path) => {
    expect(src(`![a](${path})`)).toBeUndefined();
    expect(href(`[a](${path})`)).toBeUndefined();
  });
});

describe("protocol attacks stay neutralised after resolution", () => {
  test.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "&#106;avascript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
  ])("%s", (url) => {
    const html = toHtml(
      renderMarkdown(`[a](${url}) <a href="${url}">b</a> ![c](${url}) <img src="${url}">`, { location }).tree,
    );
    expect(html).not.toMatch(/javascript|vbscript|data:/i);
  });
});

describe("external images are not loaded automatically", () => {
  test("replaced by a link to the image naming its host", () => {
    const [link] = elements("![build status](https://tracker.example/pixel.png)", "a");
    expect(elements("![build status](https://tracker.example/pixel.png)", "img")).toEqual([]);
    expect(link!.properties).toMatchObject({
      href: "https://tracker.example/pixel.png",
      target: "_blank",
      rel: ["noopener", "noreferrer"],
    });
    expect(link!.properties.dataRrExternalImage).toBe("https://tracker.example/pixel.png");
    expect(toHtml(link!)).toContain("build status (external image from tracker.example)");
  });

  test("inside a link, the placeholder is text so links do not nest", () => {
    const md = "[![ci](https://img.shields.io/badge/ci-passing-green)](https://ci.example)";
    expect(elements(md, "a")).toHaveLength(1);
    expect(elements(md, "span")[0]!.properties.dataRrExternalImage).toBe(
      "https://img.shields.io/badge/ci-passing-green",
    );
  });

  test.each([
    "http://raw.githubusercontent.com/a.png",
    "//tracker.example/a.png",
    "https://githubusercontent.com.evil.example/a.png",
  ])("%s is external", (url) => {
    expect(src(`<img src="${url}">`)).toBeUndefined();
  });

  test("GitHub-hosted images load directly", () => {
    for (const url of [
      "https://github.com/user-attachments/assets/1234",
      "https://user-images.githubusercontent.com/1/2.png",
      "https://raw.githubusercontent.com/acme/specs/main/a.png",
    ]) {
      expect(src(`![a](${url})`)).toBe(url);
    }
    const ghes = { location: { ...location, host: "ghe.example.com" } };
    expect(src("![a](https://media.ghe.example.com/x.png)", ghes)).toBe("https://media.ghe.example.com/x.png");
    expect(src("![a](https://raw.githubusercontent.com/x.png)", ghes)).toBeUndefined();
  });

  test("an untrusted picture source is removed", () => {
    const md = '<picture><source srcset="https://tracker.example/a.png"><img src="a.png"></picture>';
    expect(elements(md, "source")[0]!.properties.srcSet).toBeUndefined();
  });
});

describe("anchors use GitHub's user-content- ids", () => {
  test("headings get GitHub slugs and fragment links point at them", () => {
    const md = "# Hello, World!\n\n## Hello, World!\n\n[a](#hello-world-1)";
    expect(elements(md, "h1")[0]!.properties.id).toBe("user-content-hello-world");
    expect(elements(md, "h2")[0]!.properties.id).toBe("user-content-hello-world-1");
    expect(href(md)).toBe("#user-content-hello-world-1");
  });

  test("footnotes and named anchors still match their prefixed ids", () => {
    const md = 'x[^1] <a name="top"></a>[up](#top)\n\n[^1]: note';
    const links = elements(md, "a").map((a) => a.properties.href ?? a.properties.name);
    expect(links).toContain("#user-content-fn-1");
    expect(links).toContain("user-content-top");
    expect(links).toContain("#user-content-top");
  });

  test("already-prefixed fragments are kept", () => {
    expect(href("[a](#user-content-x)")).toBe("#user-content-x");
  });
});
