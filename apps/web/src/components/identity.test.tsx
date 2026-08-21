import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  UNAVAILABLE_CONTAINER,
  UNAVAILABLE_IMAGE,
  UNAVAILABLE_NETWORK,
  UNAVAILABLE_VOLUME
} from "../lib/identity";
import { IdentityRef } from "./identity";

function render(name: string, fallback: string, to?: string, className?: string) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <IdentityRef name={name} fallback={fallback} to={to} className={className} />
    </MemoryRouter>
  );
}

const FALLBACKS: Array<[string, string]> = [
  ["container relationship", UNAVAILABLE_CONTAINER],
  ["network relationship", UNAVAILABLE_NETWORK],
  ["volume relationship", UNAVAILABLE_VOLUME],
  ["image relationship", UNAVAILABLE_IMAGE]
];

describe("IdentityRef empty-identity fallbacks", () => {
  it.each(FALLBACKS)(
    "renders the %s placeholder verbatim and never a link for an empty string",
    (_kind, fallback) => {
      const html = render("", fallback, "/services/somewhere");
      expect(html).toContain(fallback);
      expect(html).not.toContain("<a");
      expect(html).toContain("<span>");
    }
  );

  it("renders a link for a non-empty identity when a route is known", () => {
    const html = render("web", UNAVAILABLE_CONTAINER, "/services/web", "svc-name");
    expect(html).toContain('<a class="svc-name" href="/services/web"');
    expect(html).toContain(">web</a>");
    expect(html).not.toContain("Unavailable container name");
  });

  it("renders plain text without a link for a non-empty identity with no route", () => {
    const html = render("ghost", UNAVAILABLE_CONTAINER);
    expect(html).toBe("<span>ghost</span>");
  });
});
