// SPDX-License-Identifier: AGPL-3.0-only
// The built site: pages, links, prices, SEO, CSP-safe markup, no-JS fallback and accessibility.
import axe from "axe-core";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { annualPrice, formatUsd, plans } from "../src/pricing";
import { fileFor, page, pages, read } from "./dist";

const SITE = "https://renderedreview.com";
const APP = "https://renderedreview.dev";

describe("pages", () => {
  it("builds the home, pricing and 404 pages plus robots, sitemap and favicon", () => {
    expect(pages()).toEqual(expect.arrayContaining(["/", "/pricing/", "/404.html"]));
    for (const file of ["/robots.txt", "/sitemap.xml", "/favicon.svg", "/_headers"]) expect(fileFor(file)).toBeTruthy();
  });

  it("lists every public page in the sitemap, on renderedreview.com, and robots points at it", () => {
    const sitemap = read("/sitemap.xml");
    const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    const indexable = pages().filter((p) => !page(p).querySelector('meta[name="robots"][content~="noindex"]'));
    const expected = indexable.map((p) => SITE + p);
    expect(indexable).not.toContain("/404.html");
    expect(listed.sort()).toEqual(expected.sort());
    expect(read("/robots.txt")).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });
});

describe("links", () => {
  it("resolve every internal link and fragment to a built page and element", () => {
    const broken: string[] = [];
    for (const path of pages()) {
      const doc = page(path);
      for (const el of doc.querySelectorAll<HTMLElement>("[href], [src], [data-src]")) {
        const raw = el.getAttribute("href") ?? el.getAttribute("src") ?? el.getAttribute("data-src")!;
        const url = new URL(raw, `${SITE}${path}`);
        if (url.origin !== SITE) continue;
        const target = url.pathname === new URL(`${SITE}${path}`).pathname ? doc : undefined;
        if (!fileFor(url.pathname)) {
          broken.push(`${path}: ${raw}`);
          continue;
        }
        if (url.hash && url.pathname.match(/\/$|\.html$/)) {
          const into = target ?? page(url.pathname);
          if (!into.getElementById(decodeURIComponent(url.hash.slice(1)))) broken.push(`${path}: ${raw} (no anchor)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("send the app calls to action to renderedreview.dev", () => {
    const home = page("/");
    const cta = [...home.querySelectorAll("a")].filter((a) =>
      /^(Open a pull request|Sign in)/.test(a.textContent!.trim()),
    );
    expect(cta.length).toBeGreaterThanOrEqual(3);
    for (const a of cta) expect(a.getAttribute("href")).toBe(APP);
  });

  it("open every cross-origin link in a new tab without a referrer or opener", () => {
    for (const path of pages()) {
      for (const a of page(path).querySelectorAll("a[href]")) {
        const url = new URL(a.getAttribute("href")!, `${SITE}${path}`);
        if (url.origin === SITE) {
          expect(a.getAttribute("target"), `${path} ${url}`).toBeNull();
        } else {
          expect(a.getAttribute("target"), `${path} ${url}`).toBe("_blank");
          expect(a.getAttribute("rel")?.split(" ").sort(), `${path} ${url}`).toEqual(["noopener", "noreferrer"]);
        }
      }
    }
  });
});

describe("pricing", () => {
  it.each(["/", "/pricing/"])("shows each plan's monthly and annual price from the plan data on %s", (path) => {
    const cards = [...page(path).querySelectorAll("[data-plan]")];
    expect(cards.map((c) => c.getAttribute("data-plan"))).toEqual(plans.map((p) => p.name));
    for (const [i, plan] of plans.entries()) {
      const card = cards[i]!;
      const text = (sel: string) => card.querySelector(sel)?.textContent?.replace(/\s+/g, " ").trim();
      expect(card.querySelector("h2, h3")?.textContent).toBe(plan.name);
      if (plan.monthly === 0) {
        expect(text(".price")).toBe("Free");
      } else {
        expect(text(".price.monthly")).toBe(`${formatUsd(plan.monthly)} / month`);
        expect(text(".price.annual")).toBe(`${formatUsd(annualPrice(plan))} / year`);
      }
      if (plan.overage) expect(text(".over")).toBe(`Additional active contributors: $${plan.overage}/month each`);
      else expect(card.querySelector(".over")).toBeNull();
    }
  });

  it("shows Enterprise as Contact us, with no published price", () => {
    const band = page("/pricing/").querySelector("[data-plan-enterprise]")!;
    expect(band.querySelector(".price")?.textContent).toBe("Contact us");
    expect(band.querySelector("a.btn")?.textContent).toBe("Contact us");
    expect(band.textContent).not.toMatch(/\$/);
  });

  it("switches monthly and annual with native radio buttons, so it needs no script", () => {
    const doc = page("/pricing/");
    const radios = [...doc.querySelectorAll<HTMLInputElement>('fieldset.billing input[type="radio"]')];
    expect(radios.map((r) => doc.querySelector(`label[for="${r.id}"]`)?.textContent)).toEqual([
      "Monthly",
      "Annual · 1 month free",
    ]);
    expect(radios[0]!.checked).toBe(true);
  });
});

describe("head", () => {
  it.each(pages())("gives %s a title, description, canonical URL and Open Graph tags", (path) => {
    const doc = page(path);
    const meta = (sel: string) => doc.querySelector(sel)?.getAttribute("content");
    expect(doc.title).toMatch(/Rendered Review/);
    expect(meta('meta[name="description"]')?.length).toBeGreaterThan(40);
    expect(doc.documentElement.lang).toBe("en");
    if (path !== "/404.html") {
      expect(doc.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(SITE + path);
      expect(meta('meta[property="og:url"]')).toBe(SITE + path);
    }
    expect(meta('meta[property="og:title"]')).toBeTruthy();
    expect(meta('meta[property="og:image"]')).toMatch(new RegExp(`^${SITE}/`));
    expect(doc.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe("/favicon.svg");
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
  });
});

describe("content security policy", () => {
  it("serves a strict policy that allows only same-origin scripts and styles", () => {
    const headers = read("/_headers");
    const csp = headers.match(/Content-Security-Policy: (.+)/)?.[1];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it.each(pages())("keeps %s free of inline scripts, styles and event handlers", (path) => {
    const doc = page(path);
    for (const s of doc.querySelectorAll("script")) expect(s.getAttribute("src"), s.outerHTML).toBeTruthy();
    expect(doc.querySelectorAll("style")).toHaveLength(0);
    for (const el of doc.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) {
        expect(attr === "style" || attr.startsWith("on"), `${path}: ${el.tagName} ${attr}`).toBe(false);
      }
    }
  });
});

describe("hero video", () => {
  it("fetches nothing until a script adds the sources at 900px and wider", () => {
    const video = page("/").querySelector("video")!;
    expect(video.getAttribute("src")).toBeNull();
    expect(video.getAttribute("poster")).toBeNull();
    expect(video.getAttribute("preload")).toBe("none");
    expect(video.querySelectorAll("source")).toHaveLength(0);
  });

  it("is described for screen readers and has a pause control", () => {
    const doc = page("/");
    const video = doc.querySelector("video")!;
    expect(doc.getElementById(video.getAttribute("aria-describedby")!)?.textContent).toMatch(/18-second loop/);
    expect(doc.querySelector(`button[aria-controls="${video.id}"]`)?.textContent).toMatch(/Pause video/);
  });

  it("shows the static preview without JavaScript: the video is only shown once a script marks the page", () => {
    const doc = page("/");
    expect(doc.documentElement.classList.contains("js")).toBe(false);
    expect(doc.querySelector(".static-preview [role=img]")?.getAttribute("aria-label")).toMatch(/Illustration/);
  });
});

describe("accessibility", () => {
  it.each(pages())("has landmarks and a skip link on %s", (path) => {
    const doc = page(path);
    const skip = doc.querySelector("body a")!;
    expect(skip.textContent).toBe("Skip to content");
    expect(doc.getElementById(skip.getAttribute("href")!.slice(1))?.tagName).toBe("MAIN");
    expect(doc.querySelectorAll("header, footer, main, nav")).not.toHaveLength(0);
  });

  it.each(pages())("has no axe violations on %s", async (path) => {
    const dom = new JSDOM(read(path), { url: `${SITE}${path}`, runScripts: "outside-only" });
    dom.window.eval(axe.source);
    const run = (dom.window as unknown as { axe: typeof axe }).axe.run(dom.window.document, {
      // jsdom has no layout or colours; contrast was checked in the approved design.
      rules: { "color-contrast": { enabled: false } },
    });
    const { violations } = await run;
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
  });
});
