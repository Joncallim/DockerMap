import { useLayoutEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/**
 * Gives keyboard users a predictable destination after client-side navigation.
 * The main landmark is always available immediately; an asynchronous route
 * heading is promoted only while focus still remains on that fallback.
 */
export default function RouteFocusManager() {
  const location = useLocation();
  const previousLocation = useRef<string | null>(null);

  useLayoutEffect(() => {
    const nextLocation = location.pathname;
    if (previousLocation.current === null) {
      previousLocation.current = nextLocation;
      return;
    }
    if (previousLocation.current === nextLocation) return;
    previousLocation.current = nextLocation;

    const main = document.getElementById("main-content");
    const content = document.querySelector<HTMLElement>(".content");
    if (!main) return;
    content?.scrollTo({ top: 0, behavior: "auto" });
    main.focus({ preventScroll: true });

    const focusLoadedHeading = () => {
      if (document.activeElement !== main) return true;
      const heading = main.querySelector<HTMLElement>("h1");
      if (!heading) return false;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      return true;
    };

    if (focusLoadedHeading()) return;
    // Keep observing until the heading appears, the user moves focus away
    // (focusLoadedHeading reports done in both cases), or the location effect
    // cleans up on the next navigation. NO arbitrary timeout: a slow route
    // body must still be promoted however late its h1 mounts.
    const observer = new MutationObserver(() => {
      if (focusLoadedHeading()) observer.disconnect();
    });
    observer.observe(main, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [location.pathname]);

  return null;
}
