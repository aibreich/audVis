# AudVis 🎧✨

A lightweight, real-time audio visualizer inspired by classic Xbox‑era visuals. Built with **Web Audio API + HTML5 Canvas**, no bundler, no dependencies.

## Features

- **Real-time audio visualization** via `AnalyserNode` (FFT \(= 256\))
- **Audio input modes**
  - **Microphone** (`getUserMedia`)
  - **Screen share / system audio (desktop)** (`getDisplayMedia({ audio: true })`)
  - **Mobile “system audio” fallback path**: multiple capture strategies with final fallback to enhanced/basic microphone capture
- **Visualization modes**
  - **Waveform**
  - **Circular**
  - **Lissajous** (oscilloscope-style curve with subtle trails)
  - **Particle Flow** (fixed particle pool; energy-driven swirl/outflow)
  - **Frequency 2x** (mirrored bars from bottom)
  - **Rain Drops** (`frequency3x`, mirrored bars from top + raindrop overlay)
  - **Frequency Bars** (`frequency4x`, 4-quadrant center-out)
  - **Circles** (up to 64 points + trail)
- **Controls**
  - **Sensitivity** slider
  - **Hue** (global palette rotation)
  - **Fullscreen mode** with auto-hiding UI (mouse move / click shows controls)
  - **Pause/Stop** (stops animation + tears down streams)
  - **Reset preferences**
- **Preferences persistence** using `localStorage` (mode, sensitivity, hue)
- **Mobile-friendly layout** + touch optimizations

## Demo

- **`index.html`**: the actual visualizer app (canvas + controls).
- **`demo.html`**: a static “how to use” page. Note: it may mention features that are not currently wired into `index.html` (see **Roadmap**).

## Installation

This is a static project. No build step.

- **Option A (recommended)**: run a local static server (avoids browser permission quirks).

```bash
npx serve .
```

- **Option B**: open `index.html` directly in a browser (works in many browsers, but permissions can be stricter depending on browser settings).

## Usage

- **Start microphone**
  - Open `index.html`
  - Click **Start Microphone**
  - Approve permission prompt
- **Visualize system/screen audio (desktop)**
  - Click **Share Screen / System Audio**
  - Select a tab/window/screen
  - If the picker offers it, enable **Share audio**
- **Switch modes**
  - Use **Visualization Type** dropdown
- **Tune visuals**
  - Increase **Sensitivity** for stronger response
  - Adjust **Hue** to rotate the color palette
- **Fullscreen**
  - Click the fullscreen button (⛶)
  - Move mouse / click to reveal controls; press **Esc** to exit

## Project Structure

```text
audVis/
├─ index.html            # Main app shell (controls + canvas)
├─ script.js             # Audio capture, analysis, render loop, all visual modes
├─ styles.css            # Material-inspired dark UI + fullscreen overlay behavior
├─ demo.html             # Static usage/demo page (no app logic)
├─ streaming-service.js  # Streaming platform detection + demo oscillator stream (currently not integrated)
└─ README.md             # Project documentation
```

## Architecture

- **UI (HTML/CSS)**
  - Controls in `index.html` are bound in `AudioVisualizer.setupEventListeners()`
  - Fullscreen mode is a **CSS-driven layout** (`.fullscreen-mode`, `.show-ui`) with JS controlling visibility timing
- **Audio input**
  - **Mic**: `startMicrophone()` → `getUserMedia({ audio: true })` → `MediaStreamAudioSourceNode`
  - **Desktop screen/system audio**: `startScreenShare()` → `getDisplayMedia({ video: true, audio: true })`
  - **Mobile path**: `startScreenShare()` attempts multiple strategies; ultimately falls back to microphone capture if true system audio is not possible
- **Processing**
  - `AnalyserNode` feeds:
    - `frequencyData` (`getByteFrequencyData`)
    - `dataArray` (`getByteTimeDomainData`)
  - `applyHighEndBoost()` builds a boosted spectrum buffer (reused per frame)
  - `RhythmTracker` + `AdaptiveEnergyNormalizer` + `StyleEngine` derive a smooth **behavior profile** (energy bands, beat envelope, motion/detail knobs)
- **Render loop**
  - `startVisualization()` runs `requestAnimationFrame` with an explicit **FPS throttle** (`targetFPS = 45`)
  - Each frame: sample analyser → update energy/rhythm/style → smooth spectrum → `draw()` dispatches to the current mode renderer

## Feature Inventory (audit)

- ✅ **Completed**
  - Microphone input
  - Desktop screen share with audio (when browser supports audio sharing)
  - Mobile “best effort” audio capture flow + UI indicator (`mobile-audio-mode`)
  - 8 visualization modes listed in the UI
  - Fullscreen mode with auto-hide controls
  - Preference save/load/reset (mode, sensitivity, hue)
  - Performance-minded rendering (buffer reuse, fixed particle pool, mode-specific clearing/trails, FPS throttle)

- ⚠️ **In-progress / partially implemented**
  - “System audio capture” strategies on mobile/desktop beyond `getDisplayMedia` include multiple experimental methods (constraints tricks, MediaRecorder approach, etc.). Some branches are best-effort and environment-dependent.
  - `demo.html` content is not fully aligned with the current app UI (it mentions features that are not present in `index.html`).

- ❌ **Planned / scaffolded but not integrated**
  - **Streaming URL support** (YouTube/Spotify/Apple Music): implemented as `streaming-service.js` (platform detection + demo oscillator stream), but **not imported/used** by `index.html`/`script.js`.
  - **Audio file upload**: no UI control and no implementation path in `script.js` currently.
  - **Volume control UI**: `gainNode` exists in some paths (often muted), but there is **no slider** wired in the UI.
  - **Preferences import/export UI**: `exportPreferences()` / `importPreferences()` exist in `script.js`, but no UI elements call them.

## Performance Notes

- **Known hotspots**
  - **Particle Flow**: per-frame loop over ~60–140 particles (default 120) is fine, but the cost scales with resolution and fill rate.
  - **Bars + raindrops**: raindrop timers per bar + per-frame updates can add overhead on low-end devices.
  - **Multiple global event listeners**: fullscreen handlers add listeners on enter; cleanup happens on stop.
- **Current mitigations in code**
  - `targetFPS = 45` throttling
  - Typed arrays + buffer reuse (no per-frame allocations in hot paths)
  - Hard caps (e.g., circles limited to 64, particle pool clamped)
- **Suggested next optimizations**
  - Dynamically lower `particleFlowCount` / visual detail on small screens or when frame time exceeds budget
  - Consider devicePixelRatio-aware canvas scaling with a capped DPR (reduces fill-rate cost on high-DPI)
  - Ensure fullscreen event listeners are removed on exit (currently cleaned up on `stopVisualizer()`, but not on `exitFullscreen()` alone)

## Roadmap

- **Streaming support integration**
  - Wire `streaming-service.js` into the app and add a URL input + start/stop controls
- **UI improvements**
  - Tighten `demo.html` to reflect the live feature set
  - Optional: formalize the Material-inspired dark theme (tokens already exist in `styles.css`)
- **Performance**
  - Adaptive quality mode (auto-tune FPS / particle count based on frame time)
- **More visual modes**
  - Add new `drawX()` method + dropdown option + switch case in `AudioVisualizer.draw()`

## Contributing

- Fork the repo
- Create a feature branch
- Keep changes dependency-free (vanilla HTML/CSS/JS)
- Open a PR with a short summary and screenshots/video if visuals changed

## License

**TBD.** Add a `LICENSE` file (MIT/Apache-2.0/etc.) and update this section accordingly.
