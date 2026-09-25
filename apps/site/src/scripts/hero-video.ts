// SPDX-License-Identifier: AGPL-3.0-only
// Hero video: loads only at 900px and wider, in the rendition matching the theme; a Pause/Play
// button (WCAG 2.2.2); with reduced motion it never starts by itself (poster plus a large Play).

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
    const [webm, mp4] = video.querySelectorAll("source");
    video.poster = `${name}-poster.png`;
    webm!.src = `${name}.webm`;
    mp4!.src = `${name}.mp4`;
    video.preload = "metadata";
    video.load();
    loaded = name;
    if (started) video.currentTime = time;
    if (!userPaused && !still.matches) video.play().catch(() => {});
  };

  video.addEventListener("play", () => {
    started = true;
    userPaused = false;
    sync();
  });
  video.addEventListener("pause", sync);
  button.addEventListener("click", () => {
    if (video.paused) void video.play();
    else {
      userPaused = true;
      video.pause();
    }
  });
  document.addEventListener("rr-theme", load);
  osDark.addEventListener("change", load);
  wide.addEventListener("change", load);
  load();
  sync();
}
