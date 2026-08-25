/**
 * **View** — which page of the app is showing, kept in the URL.
 *
 * The app is one document with several pages drawn into it: the model page, and now the electronics
 * editor. They cannot be separate documents — every editor is fed live from the store, and a real page
 * load would sever that — so "another page" means a route rather than a navigation.
 *
 * **Hash, not `pushState`.** `main.ts` is built to no-op under `file://`, where `fetch` is blocked and
 * there is no server to rewrite paths; `pushState` would need that rewrite and would 404 on a refresh.
 * A hash costs nothing, works from a file, and the Back button drives it for free.
 *
 * Deliberately not a router. There is no matching, no parameters and no nesting, because nothing in this
 * app has asked for any of it — a page is a name, and a name is a hash. It lives in its own file rather
 * than inside the electronics editor so that the next page to want one does not have to reach into it.
 */

/** The route name for the app's own front page — the model, the viewer, the convert panel. */
export const HOME = "";

/** Whether this environment has a URL to keep the route in at all (a test DOM does not). */
function addressable(): boolean {
  return typeof location !== "undefined" && typeof location.hash === "string";
}

/** The page named by the current URL: `#/electronics` is `"electronics"`, everything else is {@link HOME}. */
export function currentRoute(): string {
  if (!addressable()) return HOME;
  const raw = location.hash.replace(/^#\/?/, "").trim();
  return raw;
}

/**
 * Go to a page.
 *
 * Writing the hash is the whole navigation: the browser fires `hashchange`, every listener registered
 * through {@link onRouteChange} hears it, and the Back button now has an entry to return to. Where there
 * is no URL — the test DOM — this is a no-op and the caller shows the page itself, which is why callers
 * must not rely on the event coming back to them.
 */
export function goToRoute(name: string): void {
  if (!addressable()) return;
  const next = name === HOME ? "#/" : `#/${name}`;
  if (location.hash !== next) location.hash = next;
}

/** Register a listener for page changes. Fires on `hashchange`, never on registration. */
export function onRouteChange(handler: (route: string) => void): void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  window.addEventListener("hashchange", () => handler(currentRoute()));
}
