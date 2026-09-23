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
        bench.commits.push({ at: performance.now(), inHome });
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
    async measureModelAcceptance(previous, limit) {
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
      let firstCommit = 0;
      let firstHomeCommit = 0;
      while (performance.now() < deadline && (!firstCommit || !firstHomeCommit)) {
        for (const commit of bench.commits) {
          if (commit.at < notifyAt) continue;
          if (!firstCommit) firstCommit = commit.at;
          if (commit.inHome && !firstHomeCommit) firstHomeCommit = commit.at;
        }
        if (firstCommit && firstHomeCommit) break;
        await new Promise((done) => requestAnimationFrame(done));
      }
      if (!firstCommit) throw new Error("coherent model was never committed to the DOM");
      return {
        notificationToCoherentModelMs: firstCommit - notifyAt,
        // Where Home's visible content does not repaint (a provider-only
        // change), the first root commit stands in and the interpretation says so.
        coherentModelToUsefulRenderMs: (firstHomeCommit || firstCommit) - notifyAt
      };
    },

    async commandQuery(limit) {
      const started = performance.now();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
      const deadline = performance.now() + limit;
      const palette = () => document.querySelector('[aria-label="Command palette"]');
      while (performance.now() < deadline && !palette()) {
        await new Promise((done) => requestAnimationFrame(done));
      }
      const input = palette() && palette().querySelector("input");
      if (!input) throw new Error("command palette did not open");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "8080");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      while (performance.now() < deadline) {
        if (document.querySelectorAll('[aria-label="Command palette"] li').length > 0) {
          return performance.now() - started;
        }
        await new Promise((done) => requestAnimationFrame(done));
      }
      throw new Error("command palette produced no results for the representative query");
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
