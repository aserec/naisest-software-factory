// fetch for the dashboard's own API. A 401 means the session ran out: the proxy answers API calls
// with 401 instead of a redirect, so the page goes to sign-in itself.
export async function api(url: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(url, init);
  if (r.status === 401) {
    window.location.assign("/sign-in");
    throw new Error("Signed out. Sign in again.");
  }
  return r;
}
