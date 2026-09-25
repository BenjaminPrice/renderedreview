// SPDX-License-Identifier: AGPL-3.0-only
// Hero video: loads only at 900px and wider, as the MP4 matching the theme; a Pause/Play button
// (WCAG 2.2.2); with reduced motion it never starts by itself (poster plus a large Play).
// Playback starts through `autoplay` once the new source can play, not with play() right after
// load(), which raced the load and sometimes left the video stopped.

export function startHeroVideo() {
  const video = document.getElementById("hero-video") as HTMLVideoElement | null;
  const button = document.getElementById("hero-video-btn");
  if (!video || !button) return;
  const label = button.querySelector(".vlabel")!;
  const root = document.documentElement;
  const wide = matchMedia("(min-width: 900px)");
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const osDark = matchMedia("(prefers-color-scheme: dark)");
  let started = false;
  let userPaused = false;
  let loaded = "";

  const sync = () => {
    button.classList.toggle("paused", video.paused);
    button.classList.toggle("big", video.paused && !started);
    label.textContent = video.paused ? "Play video" : "Pause video";
  };
  const dark = () => (root.dataset.theme ? root.dataset.theme === "dark" : osDark.matches);

  const load = () => {
    if (!wide.matches) {
      if (!video.paused) video.pause();
      return;
    }
    const name = `/video/hero${dark() ? "-dark" : ""}`;
    if (loaded === name) return;
    const time = video.currentTime;
    if (started) video.addEventListener("loadedmetadata", () => (video.currentTime = time), { once: true });
    video.poster = `${name}-poster.png`;
    video.preload = "auto";
    video.autoplay = !userPaused && !still.matches;
    video.src = `${name}.mp4`;
    loaded = name;
    sync();
  };

  video.addEventListener("play", () => {
    started = true;
    sync();
  });
  video.addEventListener("pause", sync);
  button.addEventListener("click", () => {
    if (video.paused) {
      userPaused = false;
      video.play().catch(() => {});
    } else {
      userPaused = true;
      video.autoplay = false;
      video.pause();
    }
  });
  document.addEventListener("rr-theme", load);
  osDark.addEventListener("change", load);
  wide.addEventListener("change", load);
  load();
  sync();
}
