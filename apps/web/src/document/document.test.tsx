// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// Change markers on the rendered article.
import { renderMarkdown } from "@rendered-review/markdown-domain";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { renderWithRouter } from "../test-utils";
import { changedLines } from "./docs";
import { RenderedDocument } from "./document";

afterEach(cleanup);

const LINK = { host: "github.com", owner: "o", repo: "r", sha: "abc", path: "incident.mdx" };

// Laid out like the reported incident review: the children are indented, one per line.
const NEW = `import { Timeline, Event } from "./Timeline";

Intro.

<Timeline>
  <Event time="09:12">First endpoint fails.</Event>
  <Event time="11:40">Latency alert fires.</Event>
</Timeline>

{14} minutes.
`;

// Children separated by blank lines, so each is its own block.
const MDX = `import { Timeline, Event } from "./Timeline";

Intro.

<Timeline>

<Event time="09:12">First endpoint fails.</Event>

<Event time="11:40">Latency alert fires.</Event>

</Timeline>

{14} minutes.
`;

async function mount(base: string, head: string) {
  const rendered = renderMarkdown(head, { format: "mdx" });
  const { container } = await renderWithRouter(() => (
    <RenderedDocument rendered={rendered} changes={changedLines(base, head)} link={LINK} blobOid="blob" />
  ));
  return container.querySelector("article")!;
}

/** The change kind on the element whose own text is exactly `text`, or on its nearest marked ancestor. */
const markOn = (text: string) => screen.getByText(text).closest("[data-rr-change]")?.getAttribute("data-rr-change");

describe("MDX change markers", () => {
  test("every MDX block of a new file is marked added, including the component's tags", async () => {
    const article = await mount("", NEW);
    expect(markOn('import { Timeline, Event } from "./Timeline";')).toBe("added");
    expect(markOn("<Timeline>")).toBe("added");
    expect(markOn("</Timeline>")).toBe("added");
    expect(markOn('<Event time="11:40">Latency alert fires.</Event>')).toBe("added");
    expect(markOn("{14}")).toBe("added");
    // A new file has nothing modified.
    expect(article.querySelectorAll("[data-rr-change]:not([data-rr-change='added'])")).toHaveLength(0);
  });

  test("editing one child marks only that child's block", async () => {
    const article = await mount(MDX.replace("Latency", "Delivery latency"), MDX);
    expect(markOn('<Event time="11:40">Latency alert fires.</Event>')).toBe("modified");
    expect([...article.querySelectorAll("[data-rr-change]")].map((el) => el.textContent)).toEqual([
      'MDX<Event time="11:40">Latency alert fires.</Event>',
    ]);
  });
});
