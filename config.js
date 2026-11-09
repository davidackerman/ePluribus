// Deployment settings.
//
// SHORT_LINK_STORE: base URL of a store for short share links (see share.js and README),
// e.g. "https://links.example.org". Empty: no short links - share links then carry the
// whole recipe (a few thousand characters). On localhost the page also looks for the
// development store from tests/short_link_store.py.
export const SHORT_LINK_STORE = "";

// GOATCOUNTER: the GoatCounter site code (the "xyz" in xyz.goatcounter.com) to count visits
// and button presses anonymously (see stats.js). Empty: no counting at all. The
// "davidackerman" site is shared by several projects: pages are told apart by path
// (/ePluribus/...), and this project's events are named "epluribus/...".
export const GOATCOUNTER = "davidackerman";
