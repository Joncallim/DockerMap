/** A listener is ready once it answers HTTP; a truthful 503 is not a model. */
export async function httpListenerReady(url, timeoutMs = 1_000) {
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);
try {
await fetch(url, { signal: controller.signal });
return true;
} catch {
return false;
} finally {
clearTimeout(timer);
}
}
