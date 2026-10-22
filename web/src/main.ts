import { createApp } from "vue";
import "./style.css";
import App from "./App.vue";
import { openSession } from "@/stores/chat";
import { installExternalLinks } from "@/lib/platform";

// Expose openSession globally for Playwright gates
(window as any).openSession = openSession;

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

installExternalLinks();
createApp(App).mount("#app");
