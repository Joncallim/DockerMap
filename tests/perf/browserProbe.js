/*
 * Test-only browser instrumentation for the time-to-answer benchmark (#335).
 *
 * Loaded by the capture harness with `page.addInitScript({ path })`, so it runs
 * before any product code. It records timestamps only:
 *
 *   - when the real stream notifies the browser of a new model revision;
 *   - when the application ACCEPTS a coherent model (read from the
 *     benchmark-only acceptance sink the real application seam writes to — this
 *     is application state, never a DOM mutation);
 *   - when the product commits model-derived DOM text, together with the
 *     accepted revision the document was stamped with at that commit.
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
    notifyLog: [],
    streamUrl: "",
    opens: 0,
    errors: 0,
    events: 0,
    lastData: "",
    installed: false,
    initError: "",
    observerError: "",
    commits: [],
    arm: null
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
          // Timestamp every NEW notified revision: a publication can advance more
          // than once per sample (provider state and inventory can both move), so
          // the notification a later acceptance belongs to must be recoverable
          // rather than assumed to be the latest one.
          if (revision && revision !== bench.notifyRevision) {
            bench.notifyAt = performance.now();
            bench.notifyRevision = revision;
            bench.notifyLog.push({ at: bench.notifyAt, revision });
            if (bench.notifyLog.length > 256) bench.notifyLog.splice(0, 128);
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

  const readMetric = (label) => {
    const metrics = Array.from(document.querySelectorAll("main .story .metric"));
    for (const metric of metrics) {
      const name = metric.querySelector(".metric-label");
      if (name && (name.textContent || "").trim() === label) {
        const value = metric.querySelector(".metric-value");
        return value ? (value.textContent || "").trim() : "";
      }
    }
    return null;
  };

  const acceptedRevision = () => {
    const root = document.documentElement;
    return (root && root.dataset && root.dataset.dockermapAcceptedRevision) || "";
  };

  try {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const node = record.target;
        const element = node instanceof Element ? node : node.parentElement;
        // The Home content regions. `main .story` is the metrics band; `main
        // .stack` is Home's right column (attention list, map preview, feed).
        const inStory = Boolean(element && element.closest("main .story"));
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
        const commit = { at: performance.now(), inHome, inStory, textChanged, revision: "" };
        if (textChanged && inHome) {
          // Stamped by the application in the same commit that rendered the
          // accepted model, and the live metric band value at that commit.
          commit.revision = acceptedRevision();
          commit.storyValue = readMetric("Offline");
          commit.servicesValue = readMetric("Services");
        }
        bench.commits.push(commit);
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

  const frame = () => new Promise((done) => requestAnimationFrame(done));
  const acceptanceSink = () => window.__dockermapBenchAcceptanceSink || [];
  const diagnostic = () =>
    "opens=" +
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
    " accepted=" +
    acceptanceSink().length;

  /*
   * Measurement helpers. The harness calls these by NAME through a raw string
   * expression (`page.evaluate("window.__dockermapBenchHelpers...")`), because a
   * TS-authored function is re-emitted with esbuild's `__name` helper that does
   * not exist in the page realm.
   */
  window.__dockermapBenchHelpers = {
    /*
     * Arm the stage-6/7 measurement BEFORE the harness triggers a publication
     * change, then await it afterwards. Arming records the pre-change Home
     * metric value, so "the DOM changed" is measured rather than assumed.
     */
    armModelAcceptance(input) {
      const arm = {
        previousSeq: Number(input.previousSeq) || 0,
        limit: Number(input.limit) || 60000,
        metricLabel: String(input.metricLabel || "Offline"),
        expectedMetricValue: String(input.expectedMetricValue || ""),
        beforeMetricValue: readMetric(String(input.metricLabel || "Offline")),
        startedAt: performance.now(),
        armed: true,
        result: null,
        error: null
      };
      arm.task = (async () => {
        const deadline = arm.startedAt + arm.limit;
        // Wait for the NEXT accepted coherent model, identified by its monotonic
        // sequence number. Matching on "revision differs from the last one seen"
        // would select a stale event whenever a publication lands between arming
        // and the trigger.
        let event = null;
        while (performance.now() < deadline && !event) {
          event = acceptanceSink().find((entry) => entry.revision && entry.seq > arm.previousSeq) || null;
          if (!event) await frame();
        }
        if (!event) throw new Error("no accepted coherent model was observed (" + diagnostic() + ")");
        const acceptedAt = event.at;
        const revision = event.revision;
        // Stage 6 starts at the notification of THAT revision, which is not
        // necessarily the latest notification the page has seen.
        const notified = bench.notifyLog.filter((entry) => entry.revision === revision).pop();
        if (!notified) {
          throw new Error(
            "the accepted revision " +
              revision +
              " was never notified to this browser (" +
              diagnostic() +
              "; latest=" +
              bench.notifyRevision +
              ")"
          );
        }
        const notifyAt = notified.at;

        // Stage 7: the expected Home content for the newly accepted model, in a
        // commit that carries that revision's stamp and is strictly later than
        // acceptance, followed by exactly one bounded frame.
        let commit = null;
        while (performance.now() < deadline && !commit) {
          for (const candidate of bench.commits) {
            if (candidate.at <= acceptedAt) continue;
            if (!candidate.textChanged || !candidate.inStory) continue;
            if (candidate.revision !== revision) continue;
            if (candidate.storyValue !== arm.expectedMetricValue) continue;
            commit = candidate;
            break;
          }
          if (!commit) await frame();
        }
        if (!commit) {
          throw new Error(
            "the Home content for the accepted revision " +
              revision +
              " never rendered (expected " +
              arm.metricLabel +
              "=" +
              arm.expectedMetricValue +
              ", story=" +
              JSON.stringify(bench.commits.filter((entry) => entry.inStory).slice(-4)) +
              ")"
          );
        }
        const renderCommitAt = commit.at;
        await frame();
        const presentedAt = performance.now();
        return {
          notificationToCoherentModelMs: acceptedAt - notifyAt,
          coherentModelToUsefulRenderMs: presentedAt - acceptedAt,
          acceptedRevision: revision,
          acceptedSequence: event.seq,
          notifiedRevision: revision,
          latestNotifiedRevision: bench.notifyRevision,
          renderCommitMs: renderCommitAt - acceptedAt,
          presentationFrameMs: presentedAt - renderCommitAt,
          metricLabel: arm.metricLabel,
          beforeMetricValue: arm.beforeMetricValue,
          afterMetricValue: readMetric(arm.metricLabel),
          expectedMetricValue: arm.expectedMetricValue,
          metricChanged: arm.beforeMetricValue !== arm.expectedMetricValue
        };
      })();
      arm.task.catch((error) => {
        arm.error = String(error && error.message ? error.message : error);
      });
      bench.arm = arm;
      return true;
    },

    armed() {
      return Boolean(bench.arm && bench.arm.armed);
    },

    async awaitModelAcceptance() {
      const arm = bench.arm;
      if (!arm || !arm.task) throw new Error("model acceptance was not armed");
      try {
        arm.result = await arm.task;
      } catch (error) {
        throw new Error(arm.error || String(error && error.message ? error.message : error));
      } finally {
        arm.armed = false;
      }
      return arm.result;
    },

    async commandQuery(limit, preferredToken) {
      const started = performance.now();
      const deadline = performance.now() + limit;
      const palette = () => document.querySelector('[aria-label="Command palette"]');
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
      while (performance.now() < deadline && !palette()) {
        await frame();
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
      const unfilteredCount = dialog.querySelectorAll("li").length;
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
        // Success requires the filtered list to have actually narrowed — not just
        // changed. The palette prepends an "Ask Copilot" item on any query, so a
        // reorder-only or no-op filter would still change the joined text and
        // still contain the token. The count must strictly drop.
        if (current !== unfiltered && current.includes(token) && dialog.querySelectorAll("li").length < unfilteredCount) {
          return performance.now() - started;
        }
        await frame();
      }
      throw new Error("query " + token + " never produced a filtered list containing it");
    },

    navigationDuration() {
      const entry = performance.getEntriesByType("navigation")[0];
      return entry ? entry.duration : 0;
    },

    homeReady() {
      const value = readMetric("Services");
      return value !== null && value !== "";
    },

    currentRevision() {
      return bench.notifyRevision || "";
    },

    currentAcceptedRevision() {
      const entries = acceptanceSink().filter((entry) => entry.revision);
      return entries.length ? entries[entries.length - 1].revision : "";
    },

    currentAcceptedSeq() {
      const entries = acceptanceSink().filter((entry) => entry.revision);
      return entries.length ? entries[entries.length - 1].seq : 0;
    },

    acceptedEventCount() {
      return acceptanceSink().length;
    }
  };
})();
