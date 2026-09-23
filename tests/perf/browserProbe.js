/*
 * Test-only browser instrumentation for the time-to-answer benchmark (#335).
 *
 * Loaded by the capture harness with `page.addInitScript({ path })`, so it runs
 * before any product code. It records timestamps only: when the real stream
 * notifies the browser of a new model revision, and when the product commits
 * model-derived DOM.
 *
 * It is plain JavaScript on purpose. A TS-authored init script is serialised
 * through esbuild's `keepNames` helper (__name), which does not exist in the
 * page realm and aborts the script — see #335.
 *
 * Nothing here is part of the production bundle and nothing is uploaded.
 */
(() => {
  const bench = {
    notifyAt: 0,
    notifyRevision: "",
    streamUrl: "",
    opens: 0,
    errors: 0,
    events: 0,
    lastData: "",
    installed: false,
    initError: "",
    observerError: "",
    commits: []
  };
  window.__dockermapBench = bench;

  try {
    const Original = window.EventSource;
    if (typeof Original !== "function") {
      bench.initError = "EventSource is not constructible in this realm";
    } else {
      // The product's stream is the real EventSource; this subclass only
      // timestamps what the product already receives.
      const BenchEventSource = function (url, init) {
        const source = new Original(url, init);
        bench.streamUrl = String(url);
        const record = (event) => {
          bench.events += 1;
          if (!bench.lastData) bench.lastData = String((event && event.data) || "").slice(0, 160);
          let revision = "";
          try {
            revision = (JSON.parse((event && event.data) || "{}").modelRevision) || "";
          } catch (error) {
            revision = "";
          }
          if (revision) {
            bench.notifyAt = performance.now();
            bench.notifyRevision = revision;
          }
        };
        source.addEventListener("open", () => {
          bench.opens += 1;
        });
        source.addEventListener("error", () => {
          bench.errors += 1;
        });
        // The product names its event "snapshot"; "message" is kept so the probe
        // still observes the notification if that ever changes.
        source.addEventListener("snapshot", record);
        source.addEventListener("message", record);
        return source;
      };
      BenchEventSource.prototype = Original.prototype;
      Object.defineProperty(BenchEventSource, "name", { value: "EventSource" });
      Object.defineProperty(window, "EventSource", {
        configurable: true,
        writable: true,
        value: BenchEventSource
      });
      bench.installed = window.EventSource === BenchEventSource;
    }
  } catch (error) {
    bench.initError = String(error);
  }

  try {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const node = record.target;
        const element = node instanceof Element ? node : node.parentElement;
        const inHome = Boolean(element && element.closest("main .story, main .stack"));
        // A commit only counts as model content reaching the DOM if it alters
        // rendered text. Attribute-only or node-shuffling churn does not.
        let textChanged = record.type === "characterData";
        if (!textChanged) {
          const list = (record.addedNodes || []).length
            ? record.addedNodes
            : record.removedNodes || [];
          for (const added of list) {
            const text = added.textContent || "";
            if (text.trim() !== "") {
              textChanged = true;
              break;
            }
          }
        }
        bench.commits.push({ at: performance.now(), inHome, textChanged });
        if (bench.commits.length > 5000) bench.commits.splice(0, 2500);
      }
    });
    const start = () => {
      try {
        observer.observe(document.documentElement || document, {
          childList: true,
          subtree: true,
          characterData: true
        });
      } catch (error) {
        bench.observerError = String(error);
      }
    };
    if (document.documentElement) start();
    else document.addEventListener("readystatechange", start, { once: true });
  } catch (error) {
    bench.observerError = String(error);
  }

  /*
   * Measurement helpers. The harness calls these by NAME through a raw string
   * expression (`page.evaluate("async (input) => window.__dockermapBenchHelpers...")`),
   * because a TS-authored function is re-emitted with esbuild's `__name` helper
   * that does not exist in the page realm.
   */
  window.__dockermapBenchHelpers = {
    async measureModelAcceptance(previous, limit, needHome) {
      const deadline = performance.now() + limit;
      const isNew = () => Boolean(bench.notifyRevision) && bench.notifyRevision !== previous;
      while (performance.now() < deadline && !isNew()) {
        await new Promise((done) => requestAnimationFrame(done));
      }
      if (!isNew()) {
        throw new Error(
          "no new notification observed (opens=" +
            bench.opens +
            " errors=" +
            bench.errors +
            " events=" +
            bench.events +
            " installed=" +
            bench.installed +
            " esType=" +
            typeof window.EventSource +
            " initError=" +
            bench.initError +
            " observerError=" +
            bench.observerError +
            ")"
        );
      }
      const notifyAt = bench.notifyAt;
      let firstText = 0;
      let firstHomeText = 0;
      while (performance.now() < deadline && (!firstText || (needHome && !firstHomeText))) {
        for (const commit of bench.commits) {
          if (commit.at < notifyAt || !commit.textChanged) continue;
          if (!firstText) firstText = commit.at;
          if (commit.inHome && !firstHomeText) firstHomeText = commit.at;
        }
        if (firstText && (!needHome || firstHomeText)) break;
        await new Promise((done) => requestAnimationFrame(done));
      }
      if (!firstText) {
        throw new Error("no text-changing DOM commit was observed after the notification");
      }
      if (needHome && !firstHomeText) {
        throw new Error("Home content region never repainted with changed text after the notification");
      }
      return {
        notificationToCoherentModelMs: firstText - notifyAt,
        coherentModelToUsefulRenderMs: needHome ? firstHomeText - notifyAt : null
      };
    },

    async commandQuery(limit, preferredToken) {
      const started = performance.now();
      const deadline = performance.now() + limit;
      const palette = () => document.querySelector('[aria-label="Command palette"]');
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
      while (performance.now() < deadline && !palette()) {
        await new Promise((done) => requestAnimationFrame(done));
      }
      const dialog = palette();
      if (!dialog) throw new Error("command palette did not open");
      const input = dialog.querySelector("input");
      if (!input) throw new Error("command palette has no query input");
      const listText = () => {
        const items = dialog.querySelectorAll("li");
        return Array.from(items)
          .map((item) => item.textContent || "")
          .join("|");
      };
      // Snapshot the UNFILTERED list: the palette renders every command on open,
      // so "some item exists" would pass even with filtering completely broken.
      const unfiltered = listText();
      const tokens = unfiltered.match(/[A-Za-z0-9][A-Za-z0-9_.:-]{3,}/g) || [];
      // A query with a known expected result: prefer the fixture-derived token
      // the harness passes in; otherwise take a digit-bearing token from the
      // rendered list itself. Either way the filtered list must still contain it.
      const token =
        preferredToken && tokens.includes(preferredToken)
          ? preferredToken
          : tokens.filter((value) => /\d/.test(value)).sort((left, right) => right.length - left.length)[0] ||
            tokens[0];
      if (!token) throw new Error("no queryable token exists in the unfiltered command list");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, token);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      while (performance.now() < deadline) {
        const current = listText();
        if (current !== unfiltered && current.includes(token)) {
          return performance.now() - started;
        }
        await new Promise((done) => requestAnimationFrame(done));
      }
      throw new Error("query " + token + " never produced a filtered list containing it");
    },

    navigationDuration() {
      const entry = performance.getEntriesByType("navigation")[0];
      return entry ? entry.duration : 0;
    },

    homeReady() {
      const metrics = Array.from(document.querySelectorAll(".metric"));
      const services = metrics.find(
        (metric) => metric.querySelector(".metric-label") && metric.querySelector(".metric-label").textContent === "Services"
      );
      return Boolean(services && (services.querySelector(".metric-value").textContent || "").trim() !== "");
    },

    currentRevision() {
      return bench.notifyRevision || "";
    }
  };
})();
