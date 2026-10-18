"use client";

import React from "react";

const STYLES_ID = "dvltr-controls-styles";

// CSS is injected once into the document head
const CSS = `
@layer dvltr {
[data-dvltr-controls] {
  --dvltr-accent: #fff;
  --dvltr-text: #fff;
  --dvltr-bar-bg: linear-gradient(transparent, rgba(0,0,0,0.7));
  --dvltr-menu-bg: rgba(0,0,0,0.85);
  --dvltr-track-height: 4px;
  --dvltr-track-bg: rgba(255,255,255,0.3);
  --dvltr-buffered: rgba(255,255,255,0.5);
  --dvltr-thumb: #fff;
  --dvltr-thumb-width: 3px;
  --dvltr-thumb-height: calc(var(--dvltr-track-height) + 8px);
  --dvltr-thumb-shadow: 0 0 2px rgba(0,0,0,0.3);
  --dvltr-font-size: 13px;
  --dvltr-btn-size: 32px;
  --dvltr-big-play-size: 64px;
  --dvltr-caption-size: 16px;
}

[data-dvltr-icon] {
  width: 20px;
  height: 20px;
  fill: currentColor;
}

[data-dvltr-btn] {
  background: none;
  border: none;
  color: var(--dvltr-text);
  cursor: pointer;
  padding: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  opacity: 0.9;
  transition: opacity 0.15s;
  flex-shrink: 0;
}
[data-dvltr-btn]:hover { opacity: 1; }

[data-dvltr-time] {
  color: var(--dvltr-text);
  font-size: var(--dvltr-font-size);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  user-select: none;
  flex-shrink: 0;
  padding: 0 4px;
}

[data-dvltr-seek],
[data-dvltr-volume] {
  height: var(--dvltr-track-height);
  cursor: pointer;
  border-radius: 2px;
  -webkit-appearance: none;
  appearance: none;
  outline: none;
}
[data-dvltr-seek] { flex: 1; }
[data-dvltr-volume] { width: 60px; }

[data-dvltr-seek]::-webkit-slider-thumb,
[data-dvltr-volume]::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: var(--dvltr-thumb-width);
  height: var(--dvltr-thumb-height);
  background: var(--dvltr-thumb);
  border: none;
  border-radius: 1px;
  cursor: pointer;
  box-shadow: var(--dvltr-thumb-shadow);
  transition: width 0.1s, height 0.1s;
}
[data-dvltr-seek]:hover::-webkit-slider-thumb,
[data-dvltr-volume]:hover::-webkit-slider-thumb {
  width: calc(var(--dvltr-thumb-width) + 1px);
  height: calc(var(--dvltr-thumb-height) + 2px);
}
[data-dvltr-seek]::-moz-range-thumb,
[data-dvltr-volume]::-moz-range-thumb {
  width: var(--dvltr-thumb-width);
  height: var(--dvltr-thumb-height);
  background: var(--dvltr-thumb);
  border: none;
  border-radius: 1px;
  cursor: pointer;
  box-shadow: var(--dvltr-thumb-shadow);
}
[data-dvltr-seek]:hover::-moz-range-thumb,
[data-dvltr-volume]:hover::-moz-range-thumb {
  width: calc(var(--dvltr-thumb-width) + 1px);
  height: calc(var(--dvltr-thumb-height) + 2px);
}

[data-dvltr-volume-group] {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

[data-dvltr-caption-wrap] {
  position: relative;
  flex-shrink: 0;
}

[data-dvltr-menu] {
  position: absolute;
  bottom: 100%;
  right: 0;
  margin-bottom: 4px;
  background: var(--dvltr-menu-bg);
  border-radius: 6px;
  padding: 4px 0;
  min-width: 120px;
  backdrop-filter: blur(8px);
}

[data-dvltr-menu-item] {
  display: block;
  width: 100%;
  padding: 6px 12px;
  background: none;
  border: none;
  color: var(--dvltr-text);
  font-size: var(--dvltr-font-size);
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}
[data-dvltr-menu-item]:hover {
  background: rgba(255,255,255,0.1);
}

[data-dvltr-big-play] {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: rgba(0,0,0,0.5);
  border: none;
  border-radius: 50%;
  width: var(--dvltr-big-play-size);
  height: var(--dvltr-big-play-size);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--dvltr-text);
  cursor: pointer;
  backdrop-filter: blur(4px);
}
[data-dvltr-big-play] svg {
  width: 32px;
  height: 32px;
  fill: currentColor;
}

[data-dvltr-bar] {
  padding: 24px 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: opacity 0.25s ease;
}

[data-dvltr-bar-row] {
  display: flex;
  align-items: center;
  gap: 4px;
}

[data-dvltr-spacer] { flex: 1; }

[data-dvltr-caption-overlay] {
  position: absolute;
  bottom: 56px;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  pointer-events: none;
  padding: 0 16px;
  transition: bottom 0.25s ease;
}
[data-dvltr-caption-overlay]:not([data-controls-visible]) {
  bottom: 16px;
}

[data-dvltr-caption-text] {
  background: rgba(0,0,0,0.8);
  color: #fff;
  font-size: var(--dvltr-caption-size);
  line-height: 1.5;
  padding: 6px 12px;
  border-radius: 4px;
  text-align: center;
  max-width: 80%;
  text-shadow: 0 1px 2px rgba(0,0,0,0.5);
  transition: opacity 0.3s ease;
}
[data-dvltr-caption-text][data-stale] {
  opacity: 0.5;
  font-size: calc(var(--dvltr-caption-size) - 1px);
}

[data-dvltr-transcript] {
  overflow-y: auto;
  scroll-behavior: smooth;
}

[data-dvltr-transcript-cue] {
  display: flex;
  gap: 12px;
  padding: 8px 12px;
  width: 100%;
  background: none;
  border: none;
  border-bottom: 1px solid rgba(128,128,128,0.15);
  color: inherit;
  font: inherit;
  font-size: 14px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.15s, background 0.15s;
}
[data-dvltr-transcript-cue]:hover {
  opacity: 0.85;
  background: rgba(128,128,128,0.08);
}
[data-dvltr-transcript-cue][data-active] {
  opacity: 1;
  background: rgba(128,128,128,0.12);
}

[data-dvltr-transcript-time] {
  flex-shrink: 0;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  opacity: 0.5;
  min-width: 36px;
  padding-top: 2px;
}

[data-dvltr-transcript-text] {
  flex: 1;
}

[data-dvltr-speed-wrap] {
  position: relative;
  flex-shrink: 0;
}

[data-dvltr-speed-label] {
  background: none;
  border: none;
  color: var(--dvltr-text);
  cursor: pointer;
  padding: 4px 6px;
  font-size: var(--dvltr-font-size);
  font-variant-numeric: tabular-nums;
  opacity: 0.9;
  transition: opacity 0.15s;
  flex-shrink: 0;
}
[data-dvltr-speed-label]:hover { opacity: 1; }

[data-dvltr-quality-wrap] {
  position: relative;
  flex-shrink: 0;
}

[data-dvltr-quality-label] {
  background: none;
  border: none;
  color: var(--dvltr-text);
  cursor: pointer;
  padding: 4px 6px;
  font-size: var(--dvltr-font-size);
  font-variant-numeric: tabular-nums;
  opacity: 0.9;
  transition: opacity 0.15s;
  flex-shrink: 0;
}
[data-dvltr-quality-label]:hover { opacity: 1; }
} /* @layer dvltr */
`;

export function useControlStyles() {
	React.useEffect(() => {
		if (document.getElementById(STYLES_ID)) return;
		const style = document.createElement("style");
		style.id = STYLES_ID;
		style.textContent = CSS;
		document.head.appendChild(style);
	}, []);
}
