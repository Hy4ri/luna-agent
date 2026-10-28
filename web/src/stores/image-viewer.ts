import { reactive } from "vue";

// Single lightbox state. Any component can call openImage(); App.vue mounts the viewer once.
export const imageViewer = reactive({ src: "", alt: "" });

export function openImage(src: string, alt = "") {
  if (src) Object.assign(imageViewer, { src, alt });
}

export function closeImage() {
  imageViewer.src = "";
}
