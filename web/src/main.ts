import { createApp } from "vue";
import "./style.css";
import "./assets/virtualization.css";
import "./assets/mobile.css";
import App from "./App.vue";
import { openSession } from "@/stores/chat";
import { installExternalLinks } from "@/lib/platform";

// Expose openSession globally for Playwright gates
(window as any).openSession = openSession;

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready).then(registration => {
    const warm = () => {
      const start = () => (navigator.serviceWorker.controller ?? registration.active)?.postMessage({ type: "luna:cache-optional" });
      if ("requestIdleCallback" in window) window.requestIdleCallback(start);
      else setTimeout(start, 0);
    };
    const afterLoad = () => {
      if (document.readyState === "complete") warm();
      else window.addEventListener("load", warm, { once: true });
    };
    afterLoad();
    window.addEventListener("online", afterLoad);
    navigator.serviceWorker.addEventListener("controllerchange", afterLoad);
  }).catch(() => {});
}

// Show focus rings only after keyboard navigation (Tab), never after mouse or touch.
window.addEventListener("keydown", e => { if (e.key === "Tab") document.body.classList.add("kbd-nav"); }, true);
window.addEventListener("pointerdown", () => document.body.classList.remove("kbd-nav"), true);

installExternalLinks();
createApp(App).mount("#app");
