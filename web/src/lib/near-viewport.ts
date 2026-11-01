import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";

/**
 * True once the element comes within `margin` of its scroll container, and then stays true.
 * Transcript media above the opening scroll position then loads when the user scrolls toward it,
 * not during the first paint. The transcript log is the observer root, so the margin really preloads.
 */
export function useNearViewport(target: Ref<HTMLElement | null | undefined>, margin = "1200px") {
  const near = ref(typeof IntersectionObserver === "undefined");
  let observer: IntersectionObserver | undefined;
  onMounted(() => {
    const el = target.value;
    if (near.value || !el) { near.value = true; return; }
    observer = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      near.value = true;
      observer?.disconnect(); observer = undefined;
    }, { root: el.closest("#log"), rootMargin: margin });
    observer.observe(el);
  });
  onBeforeUnmount(() => { observer?.disconnect(); observer = undefined; });
  return near;
}
