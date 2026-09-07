import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EmptyState, ErrorState, Loading } from "./components/primitives";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function cssBlock(selector: string) {
  const start = styles.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing CSS rule for ${selector}`);
  const end = styles.indexOf("}", start);
  if (end < 0) throw new Error(`Unclosed CSS rule for ${selector}`);
  return styles.slice(start, end + 1);
}

describe("shared empty, error, and loading primitives", () => {
  it("leaves an ordinary empty state quiet while keeping its icon decorative", () => {
    const html = renderToStaticMarkup(<EmptyState icon="search" title="No matching services" body="Clear a filter to see every service." />);

    expect(html).not.toContain('role="alert"');
    expect(html).toContain('class="empty-icon" aria-hidden="true"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("No matching services");
  });

  it("announces an error and keeps its alert icon decorative", () => {
    const html = renderToStaticMarkup(<ErrorState title="Runtime unavailable" body="Try again when the host is reachable." />);

    expect(html).toContain('class="empty empty-error" role="alert"');
    expect(html).toContain('class="empty-icon" aria-hidden="true"');
    expect(html).toContain("Runtime unavailable");
    expect(html).toContain("Try again when the host is reachable.");
  });

  it("uses one polite, atomic status announcement for loading", () => {
    const html = renderToStaticMarkup(<Loading label="Reading runtime topology…" />);

    expect(html).toContain('class="loading" role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain('class="loading-spinner" aria-hidden="true"');
    expect(html).toContain("Reading runtime topology…");
  });

  it("uses public Hearth roles for shared status spacing, type, and loading color", () => {
    expect(cssBlock(".empty")).toContain("gap: var(--s2)");
    expect(cssBlock(".empty")).toContain("padding: var(--s6) var(--s4)");
    expect(cssBlock(".empty")).toContain("font-size: var(--hearth-type-sm)");
    expect(cssBlock(".loading")).toContain("gap: var(--s3)");
    expect(cssBlock(".loading")).toContain("padding: var(--s6)");
    expect(cssBlock(".loading")).toContain("font-size: var(--hearth-type-sm)");
    expect(cssBlock(".loading-spinner")).toContain("border-top-color: var(--hearth-azure)");
    expect(cssBlock(".empty-error .empty-icon")).toContain("color: var(--s-offline)");
  });
});
