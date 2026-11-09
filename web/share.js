// share.js - short share links that a server can't read.
//
// The recipe is encrypted in the browser (AES-GCM, a fresh random key per picture). The
// store keeps only the ciphertext, under a random id. The key travels in the link's
// #fragment, which browsers never send to any server, so whoever runs the store can't
// rebuild the picture. Link form: #s=<id>.<key>
//
// Store contract (see README): POST {store}/s with the bytes -> {"id": "..."};
//                               GET {store}/s/{id} -> the bytes.
import { SHORT_LINK_STORE } from "./config.js";

const DEV_STORE = "http://127.0.0.1:8799"; // tests/short_link_store.py

/** The store to use, or "" for none (then links carry the whole recipe). */
export async function findStore() {
  if (SHORT_LINK_STORE) return SHORT_LINK_STORE;
  if (!["localhost", "127.0.0.1"].includes(location.hostname)) return "";
  try {
    const r = await fetch(`${DEV_STORE}/health`, { signal: AbortSignal.timeout(800) });
    return r.ok ? DEV_STORE : "";
  } catch {
    return "";
  }
}

export async function storeRecipe(store, recipe) {
  const key = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(recipe)));
  const body = new Uint8Array(iv.length + ct.length);
  body.set(iv);
  body.set(ct, iv.length);
  const r = await fetch(`${store}/s`, { method: "POST", body, headers: { "Content-Type": "application/octet-stream" } });
  if (!r.ok) throw new Error(`the link store answered ${r.status}`);
  const { id } = await r.json();
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(id)) throw new Error("the link store sent a bad id");
  return `${id}.${b64url(key)}`;
}

export async function loadRecipe(store, token) {
  const m = /^([A-Za-z0-9_-]{4,32})\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!m) throw new Error("malformed short link");
  const r = await fetch(`${store}/s/${m[1]}`);
  if (!r.ok) throw new Error(r.status === 404 ? "this link has expired or never existed" : `the link store answered ${r.status}`);
  const body = new Uint8Array(await r.arrayBuffer());
  const k = await crypto.subtle.importKey("raw", unb64url(m[2]), "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: body.slice(0, 12) }, k, body.slice(12));
  return new TextDecoder().decode(pt);
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function unb64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
