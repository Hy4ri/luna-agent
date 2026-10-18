// Entry point. Module order does not matter: no module calls into another at top level.
import { showWelcome } from "./transcript.js";
import { openSession } from "./session.js";
import { setDrawer, boot } from "./shell.js";
import "./models.js"; import "./sidebar.js"; import "./composer.js"; import "./extras.js"; import "./panels.js";
window.openSession = openSession; // Playwright gates call it
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) navigator.serviceWorker.register("/sw.js").catch(() => {});
setDrawer(false);
showWelcome();
boot();
