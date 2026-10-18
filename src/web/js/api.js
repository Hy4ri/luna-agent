// Authenticated fetch helpers. A 401 calls the registered handler (the shell shows login).
export let token = localStorage.getItem("luna.token") || "";
export function setToken(value) { token = value; }
let unauthorized = () => {};
export function onUnauthorized(fn) { unauthorized = fn; }

export const api = async (path, opts = {}) => {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (token) headers.authorization = "Bearer " + token;
  const r = await fetch(path, { ...opts, headers });
  if (r.status === 401) { unauthorized("token rejected"); throw new Error("unauthorized"); }
  return r;
};
export const json = async (path, opts) => { const r = await api(path, opts); if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).error || r.statusText), { status: r.status }); return r.json(); };
export const post = (path, body, method = "POST") => json(path, { method, body: JSON.stringify(body ?? {}) });
