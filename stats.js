// stats.js - anonymous counts with GoatCounter (no cookies, no personal data).
//
// Off unless GOATCOUNTER is set in config.js. GoatCounter's script sends only the page's
// path - never the part after "#", where share links keep their recipes - and it ignores
// localhost. Events are just names ("picture-made", "link-shared", ...): no photo, no link,
// no recipe ever goes with them.
import { GOATCOUNTER } from "./config.js?v=0d109597";

const queue = [];
let ready = false;
const enabled = /^[a-z0-9-]+$/.test(GOATCOUNTER || "");

/** Loads GoatCounter (which counts the page view); returns whether counting is on. */
export function startStats() {
  if (!enabled) return false;
  const s = document.createElement("script");
  s.async = true;
  s.src = "https://gc.zgo.at/count.js";
  s.dataset.goatcounter = `https://${GOATCOUNTER}.goatcounter.com/count`;
  s.onload = () => { ready = true; queue.splice(0).forEach(send); };
  document.head.append(s);
  return true;
}

// events are namespaced, since the GoatCounter site may be shared with other projects
function send(name) {
  window.goatcounter?.count?.({ path: `epluribus/${name}`, title: `ePluribus: ${name.replace(/-/g, " ")}`, event: true });
}

/** Counts one event by name, e.g. track("picture-made"). */
export function track(name) {
  if (!enabled) return;
  if (ready) send(name); else queue.push(name);
}
