// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// The hero video loader: what it asks the browser to fetch and play, by width, motion preference and theme.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHeroVideo } from "./hero-video";

let media: Record<string, boolean>;
let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;

function setup(query: { wide?: boolean; still?: boolean; dark?: boolean } = {}) {
  media = {
    "(min-width: 900px)": query.wide ?? true,
    "(prefers-reduced-motion: reduce)": query.still ?? false,
    "(prefers-color-scheme: dark)": query.dark ?? false,
  };
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: media[q] ?? false, addEventListener: () => {} }));
  document.body.innerHTML = `
    <video id="hero-video" muted loop playsinline preload="none"></video>
    <button id="hero-video-btn" type="button"><span class="vlabel">Pause video</span></button>`;
  const video = document.querySelector("video")!;
  // jsdom has no media playback: record calls, and mirror play/pause into `paused`.
  let paused = true;
  Object.defineProperty(video, "paused", { get: () => paused });
  play = vi.fn(async () => {
    paused = false;
    video.dispatchEvent(new Event("play"));
  });
  pause = vi.fn(() => {
    paused = true;
    video.dispatchEvent(new Event("pause"));
  });
  video.play = play as unknown as HTMLVideoElement["play"];
  video.pause = pause as unknown as HTMLVideoElement["pause"];
  video.load = vi.fn();
  startHeroVideo();
  return { video, button: document.getElementById("hero-video-btn")! };
}

beforeEach(() => {
  delete document.documentElement.dataset.theme;
});
afterEach(() => vi.unstubAllGlobals());

describe("startHeroVideo", () => {
  it("fetches nothing below 900px", () => {
    const { video } = setup({ wide: false });
    expect(video.getAttribute("src")).toBeNull();
    expect(video.getAttribute("poster")).toBeNull();
    expect(video.preload).toBe("none");
  });

  it("loads the MP4 and poster and autoplays at 900px and wider", () => {
    const { video } = setup();
    expect(video.getAttribute("src")).toBe("/video/hero.mp4");
    expect(video.getAttribute("poster")).toBe("/video/hero-poster.png");
    expect(video.preload).toBe("auto");
    expect(video.autoplay).toBe(true);
    expect(play).not.toHaveBeenCalled();
  });

  it("never starts by itself with reduced motion: poster and a Play button", () => {
    const { video, button } = setup({ still: true });
    expect(video.getAttribute("src")).toBe("/video/hero.mp4");
    expect(video.autoplay).toBe(false);
    expect(button.textContent).toBe("Play video");
  });

  it("picks the dark rendition in dark mode and swaps it on a theme change", () => {
    const { video } = setup({ dark: true });
    expect(video.getAttribute("src")).toBe("/video/hero-dark.mp4");
    document.documentElement.dataset.theme = "light";
    document.dispatchEvent(new Event("rr-theme"));
    expect(video.getAttribute("src")).toBe("/video/hero.mp4");
    expect(video.getAttribute("poster")).toBe("/video/hero-poster.png");
  });

  it("pauses and plays from the button, and a pause survives a theme change", async () => {
    const { video, button } = setup();
    await video.play();
    expect(button.textContent).toBe("Pause video");
    button.click();
    expect(pause).toHaveBeenCalled();
    expect(video.autoplay).toBe(false);
    expect(button.textContent).toBe("Play video");
    document.documentElement.dataset.theme = "dark";
    document.dispatchEvent(new Event("rr-theme"));
    expect(video.autoplay).toBe(false);
    button.click();
    expect(play).toHaveBeenCalledTimes(2);
  });
});
