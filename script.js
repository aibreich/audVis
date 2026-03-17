class RhythmTracker {
  constructor() {
    // Short vs long-term energy tracking (lightweight onset detection)
    this.currentEnergy = 0;
    this.smoothedEnergy = 0;
    this.longTermEnergy = 0;
    this.beatDetected = false;
    this.bpmEstimate = 0;

    // Tunables (chosen for stability on varied devices/content)
    this.lowHzMin = 20;
    this.lowHzMax = 150;
    this.longTermAlpha = 0.015; // slower = steadier baseline (higher = more reactive)
    this.shortTermAlpha = 0.18; // energy smoothing (higher = snappier)
    this.thresholdMultiplier = 1.4; // beat when energy exceeds baseline * multiplier (tune 1.2..1.6)
    this.minBeatIntervalMs = 260; // debounce window to avoid double-triggers (tune 200..400)

    // Optional adaptive thresholding (helps reduce false positives on noisy input)
    this._adaptive = 1.0; // multiplies thresholdMultiplier, slowly self-corrects
    this._adaptiveMin = 0.92;
    this._adaptiveMax = 1.18;

    // BPM estimation via recent beat intervals
    this._lastBeatTs = 0;
    this._intervals = new Float32Array(8);
    this._intervalWrite = 0;
    this._intervalCount = 0;

    // Edge / peak detection helpers
    this._prevRatio = 0;
    this._prevSmoothed = 0;
  }

  update(byteFrequencyData, sampleRate, timestampMs) {
    this.beatDetected = false;
    if (!byteFrequencyData || byteFrequencyData.length === 0 || !sampleRate) {
      this.currentEnergy = 0;
      this.smoothedEnergy *= 0.95;
      this.longTermEnergy *= 0.995;
      this._prevRatio *= 0.9;
      this._prevSmoothed *= 0.9;
      return;
    }

    // Map target low-frequency band to FFT bins
    const binCount = byteFrequencyData.length;
    const nyquist = sampleRate * 0.5;
    const hzPerBin = nyquist / binCount;
    let startBin = (this.lowHzMin / hzPerBin) | 0;
    let endBin = (this.lowHzMax / hzPerBin) | 0;
    if (startBin < 0) startBin = 0;
    if (endBin > binCount - 1) endBin = binCount - 1;
    if (endBin <= startBin) endBin = Math.min(binCount - 1, startBin + 1);

    // Energy = average of squared magnitudes (normalized 0..1)
    let sumSq = 0;
    const denom = 255 * 255;
    const count = endBin - startBin + 1;
    for (let i = startBin; i <= endBin; i++) {
      const v = byteFrequencyData[i];
      sumSq += (v * v) / denom;
    }
    const energy = sumSq / count;
    this.currentEnergy = energy;

    // Smooth current energy and update long-term baseline (EMA)
    this.smoothedEnergy += (energy - this.smoothedEnergy) * this.shortTermAlpha;
    this.longTermEnergy +=
      (this.smoothedEnergy - this.longTermEnergy) * this.longTermAlpha;

    // Onset/beat detection (threshold + rising-edge + debounce)
    const baseline = Math.max(1e-6, this.longTermEnergy);
    const ratio = this.smoothedEnergy / baseline;
    const sinceLast = timestampMs - this._lastBeatTs;

    // Rising edge gating reduces random flashes on steady tones/noise
    const rising = this.smoothedEnergy > this._prevSmoothed;
    const ratioRising = ratio > this._prevRatio;
    const threshold = this.thresholdMultiplier * this._adaptive;

    if (
      rising &&
      ratioRising &&
      ratio > threshold &&
      sinceLast >= this.minBeatIntervalMs
    ) {
      this.beatDetected = true;
      this._recordBeat(timestampMs);
    }

    this._prevRatio = ratio;
    this._prevSmoothed = this.smoothedEnergy;
  }

  _recordBeat(timestampMs) {
    if (this._lastBeatTs > 0) {
      const interval = timestampMs - this._lastBeatTs;

      // Adaptive thresholding:
      // - If beats are coming "too fast", gently increase threshold to stop chatter.
      // - If beats are sparse, gently relax threshold to stay responsive.
      if (interval < this.minBeatIntervalMs * 1.15) {
        this._adaptive = Math.min(this._adaptiveMax, this._adaptive + 0.03);
      } else if (interval > 520) {
        this._adaptive = Math.max(this._adaptiveMin, this._adaptive - 0.015);
      } else {
        // drift slowly back toward neutral
        this._adaptive += (1.0 - this._adaptive) * 0.03;
      }

      // Keep plausible BPM (60..200) to avoid wild estimates
      if (interval >= 300 && interval <= 1000) {
        this._intervals[this._intervalWrite] = interval;
        this._intervalWrite = (this._intervalWrite + 1) & 7; // size 8
        if (this._intervalCount < 8) this._intervalCount++;

        // Compute average interval (tiny array; no allocations)
        let sum = 0;
        for (let i = 0; i < this._intervalCount; i++) sum += this._intervals[i];
        const avg = sum / this._intervalCount;
        this.bpmEstimate = avg > 0 ? 60000 / avg : 0;
      }
    }
    this._lastBeatTs = timestampMs;
  }
}

class AdaptiveEnergyNormalizer {
  constructor() {
    // Band definitions (Hz). Kept wide so different genres still register.
    this.lowHzMin = 20;
    this.lowHzMax = 150;
    this.midHzMin = 150;
    this.midHzMax = 2000;
    this.highHzMin = 2000;
    this.highHzMax = 8000;

    // Rolling min/max “envelopes” (fast attack, slow release) per band.
    // This approximates a rolling window without storing history.
    this.fastAttack = 0.25; // how quickly min/max snaps to new extremes
    this.slowRelease = 0.006; // how quickly envelopes drift back (seconds-scale)
    this.minRange = 0.02; // prevents divide-by-tiny-range explosions

    // Per-band energy (raw 0..1), normalized 0..1
    this.lowEnergy = 0;
    this.midEnergy = 0;
    this.highEnergy = 0;
    this.lowNorm = 0;
    this.midNorm = 0;
    this.highNorm = 0;

    // Envelopes
    this._lowMin = 1;
    this._lowMax = 0;
    this._midMin = 1;
    this._midMax = 0;
    this._highMin = 1;
    this._highMax = 0;

    // Combined
    this.combinedNorm = 0;
    this.dominantBand = 1; // 0 low, 1 mid, 2 high

    // Extra smoothing so visuals don’t jitter when ranges adapt
    this._combinedSmoothed = 0;
    this.combinedSmoothing = 0.08; // tune 0.04..0.12
  }

  update(byteFrequencyData, sampleRate) {
    if (!byteFrequencyData || byteFrequencyData.length === 0 || !sampleRate) {
      this.lowEnergy = this.midEnergy = this.highEnergy = 0;
      this.lowNorm = this.midNorm = this.highNorm = 0;
      this._combinedSmoothed *= 0.95;
      this.combinedNorm = this._combinedSmoothed;
      this.dominantBand = 1;
      return;
    }

    const binCount = byteFrequencyData.length;
    const nyquist = sampleRate * 0.5;
    const hzPerBin = nyquist / binCount;

    // Compute per-band energies (average squared magnitude, normalized 0..1)
    this.lowEnergy = this._bandEnergy(
      byteFrequencyData,
      hzPerBin,
      this.lowHzMin,
      this.lowHzMax,
    );
    this.midEnergy = this._bandEnergy(
      byteFrequencyData,
      hzPerBin,
      this.midHzMin,
      this.midHzMax,
    );
    this.highEnergy = this._bandEnergy(
      byteFrequencyData,
      hzPerBin,
      this.highHzMin,
      Math.min(this.highHzMax, nyquist),
    );

    // Update envelopes and normalize each band
    this.lowNorm = this._normalizeWithEnvelope(
      this.lowEnergy,
      "_lowMin",
      "_lowMax",
    );
    this.midNorm = this._normalizeWithEnvelope(
      this.midEnergy,
      "_midMin",
      "_midMax",
    );
    this.highNorm = this._normalizeWithEnvelope(
      this.highEnergy,
      "_highMin",
      "_highMax",
    );

    // Dominant band (for optional future behavior variance)
    if (this.lowNorm >= this.midNorm && this.lowNorm >= this.highNorm)
      this.dominantBand = 0;
    else if (this.highNorm >= this.midNorm && this.highNorm >= this.lowNorm)
      this.dominantBand = 2;
    else this.dominantBand = 1;

    // Balanced blend: ensures non-bass tracks still animate
    // (Weights chosen to feel “musical” but not bass-only)
    const combined =
      this.lowNorm * 0.45 + this.midNorm * 0.35 + this.highNorm * 0.2;

    // Smooth combined to avoid small range-adaptation jitter
    this._combinedSmoothed +=
      (combined - this._combinedSmoothed) * this.combinedSmoothing;
    this.combinedNorm = this._combinedSmoothed;
  }

  _bandEnergy(byteFrequencyData, hzPerBin, hzMin, hzMax) {
    let startBin = (hzMin / hzPerBin) | 0;
    let endBin = (hzMax / hzPerBin) | 0;
    const last = byteFrequencyData.length - 1;
    if (startBin < 0) startBin = 0;
    if (endBin > last) endBin = last;
    if (endBin <= startBin) endBin = Math.min(last, startBin + 1);

    let sumSq = 0;
    const denom = 255 * 255;
    const count = endBin - startBin + 1;
    for (let i = startBin; i <= endBin; i++) {
      const v = byteFrequencyData[i];
      sumSq += (v * v) / denom;
    }
    return sumSq / count;
  }

  _normalizeWithEnvelope(x, minKey, maxKey) {
    // Update rolling min/max envelopes with fast-attack / slow-release behavior
    let min = this[minKey];
    let max = this[maxKey];

    // Min envelope
    if (x < min) min += (x - min) * this.fastAttack;
    else min += (x - min) * this.slowRelease;

    // Max envelope
    if (x > max) max += (x - max) * this.fastAttack;
    else max += (x - max) * this.slowRelease;

    this[minKey] = min;
    this[maxKey] = max;

    const range = Math.max(this.minRange, max - min);
    let n = (x - min) / range;
    if (n < 0) n = 0;
    else if (n > 1) n = 1;
    return n;
  }
}

class StyleEngine {
  constructor() {
    // Public, smoothed classification (string label for debugging/telemetry)
    this.profile = "mid_energy_balanced";

    // Internal smoothed descriptors (0..1)
    this.energy = 0;
    this.variability = 0;
    this.low = 0;
    this.mid = 0;
    this.high = 0;

    // Beat envelope for subtle modulation (no flashing)
    this._beatEnv = 0;
    this._lastUpdateTs = 0;

    // Smoothed outputs consumed by visuals (avoid per-frame allocations)
    this.out = {
      // Spectrum smoothing: smaller = snappier, larger = smoother
      spectrumAlpha: 0.15,

      // Global mapping multipliers (applied in main loop)
      scaleAmp: 0.02, // targetScale = 1 + visualEnergy * scaleAmp
      intensityBase: 0.15,
      intensityAmp: 0.35,

      // Rhythm-based global behavior (small ranges; continuous; no pulses)
      // - `motionSpeedMultiplier` affects time-based motion rates.
      // - `decayRateMultiplier` affects fade/decay speeds (higher = faster decay).
      // - `detailIntensityMultiplier` affects small-detail density (trails/glow/line thickness).
      // - `colorShift` is a subtle 0..1 factor you can map to hue offsets if desired.
      motionSpeedMultiplier: 1.0,
      decayRateMultiplier: 1.0,
      detailIntensityMultiplier: 1.0,
      colorShift: 0.0,

      // Per-mode behavior knobs
      barSpacingScale: 1.0,
      barWidthScale: 1.0,
      barHeightScale: 1.0,

      circlesRadiusScale: 1.0,
      circlesSizeScale: 1.0,
      circlesTrailScale: 1.0,

      // Subtle rhythmic modulation
      beatEnv: 0,

      // Optional recommendation (no auto-switch by default)
      recommendedVisualType: "frequency3x",
    };

    // Tunables (kept conservative to avoid jitter)
    this._alphaEnergy = 0.04;
    this._alphaVariability = 0.06;
    this._alphaBands = 0.08;
    this._alphaOutputs = 0.06;

    // Hysteresis for discrete labels (prevents rapid flipping)
    this._energyLabel = "mid";
    this._variabilityLabel = "balanced";
  }

  update({
    timestampMs,
    combinedNorm,
    normDelta,
    lowNorm,
    midNorm,
    highNorm,
    dominantBand,
    beatDetected,
    bpmEstimate,
  }) {
    // Time step (for beat envelope decay)
    const ts = typeof timestampMs === "number" ? timestampMs : 0;
    const dtMs =
      this._lastUpdateTs > 0 ? Math.max(0, ts - this._lastUpdateTs) : 16;
    this._lastUpdateTs = ts;

    // Smooth descriptors (all 0..1)
    const e = clamp01(combinedNorm);
    const v = clamp01(normDelta);
    this.energy += (e - this.energy) * this._alphaEnergy;
    this.variability += (v - this.variability) * this._alphaVariability;
    this.low += (clamp01(lowNorm) - this.low) * this._alphaBands;
    this.mid += (clamp01(midNorm) - this.mid) * this._alphaBands;
    this.high += (clamp01(highNorm) - this.high) * this._alphaBands;

    // Beat envelope: quick rise on beat, smooth decay
    if (beatDetected) this._beatEnv = Math.min(1, this._beatEnv + 0.25);
    const beatDecayPerMs = 0.0016; // ~0.6s to fade from 1 -> 0
    this._beatEnv = Math.max(0, this._beatEnv - dtMs * beatDecayPerMs);

    // Discrete labels with hysteresis (used only for profile string + recommendations)
    this._energyLabel = this._hysteresisEnergyLabel(
      this.energy,
      this._energyLabel,
    );
    this._variabilityLabel = this._hysteresisVariabilityLabel(
      this.variability,
      this._variabilityLabel,
    );

    const bandLabel =
      dominantBand === 0
        ? "bass_heavy"
        : dominantBand === 2
          ? "high_heavy"
          : "balanced";

    // Style profile string (stable, but still updates over time)
    this.profile = `${this._energyLabel}_energy_${this._variabilityLabel}`;

    // Map style → continuous behavior knobs.
    // Goal: feel "aware" but never jumpy; all outputs are smoothed below.
    const target = this._computeTargets({
      energy: this.energy,
      variability: this.variability,
      bandLabel,
      bpmEstimate: typeof bpmEstimate === "number" ? bpmEstimate : 0,
      beatEnv: this._beatEnv,
    });

    // Smooth outputs (single object reused; no allocations)
    for (const k in target) {
      this.out[k] += (target[k] - this.out[k]) * this._alphaOutputs;
    }

    // Discrete recommendation (smoothed by using conservative switching rules)
    this.out.recommendedVisualType = this._recommendMode({
      energyLabel: this._energyLabel,
      variabilityLabel: this._variabilityLabel,
      bandLabel,
      bpmEstimate,
    });

    // Expose beat envelope for subtle modulation
    this.out.beatEnv = this._beatEnv;
  }

  _computeTargets({ energy, variability, bandLabel, bpmEstimate, beatEnv }) {
    // Spectrum smoothing: more snappy when energetic/dynamic, smoother when calm/stable
    const spectrumAlpha =
      lerp(0.1, 0.2, 1 - energy) * lerp(1.05, 0.85, variability);

    // Global scale/intensity mappings (kept subtle)
    const scaleAmp = lerp(0.016, 0.028, energy) * lerp(0.95, 1.05, variability);
    const intensityBase = lerp(0.12, 0.2, energy);
    const intensityAmp =
      lerp(0.26, 0.46, energy) * lerp(0.9, 1.08, variability);

    // Bars: tighter + taller for energetic/dynamic, wider + calmer for smooth/low
    const barSpacingScale =
      lerp(1.08, 0.92, energy) * lerp(1.05, 0.95, variability);
    const barWidthScale = lerp(1.1, 0.95, energy);
    const barHeightScale =
      lerp(0.92, 1.12, energy) * lerp(0.95, 1.05, variability);

    // Circles: larger radius / slower-looking motion for low energy; tighter + sharper for high energy
    const circlesRadiusScale = lerp(1.18, 0.92, energy);
    const circlesSizeScale = lerp(1.1, 0.92, energy);
    const circlesTrailScale =
      lerp(1.25, 0.85, energy) * lerp(1.1, 0.95, variability);

    const bpm = clamp(bpmEstimate || 0, 0, 220);
    const bpmNorm = bpm > 0 ? clamp01((bpm - 70) / 90) : 0.45; // 70..160 -> 0..1

    // Beat envelope can also gently lift intensity (no pulses)
    const beatLift = 1 + beatEnv * 0.06;

    return {
      spectrumAlpha: clamp(spectrumAlpha, 0.08, 0.24),
      scaleAmp: clamp(scaleAmp, 0.012, 0.032),
      intensityBase: clamp(intensityBase, 0.1, 0.24),
      intensityAmp: clamp(intensityAmp * beatLift, 0.22, 0.55),

      // Standardized rhythm behavior knobs (keep within ~1.0..1.1 ranges):
      // - Beat envelope provides short-lived lift.
      // - BPM provides a stable baseline: faster songs = slightly faster motion + decay.
      motionSpeedMultiplier: clamp(
        lerp(0.98, 1.08, bpmNorm) * (1 + beatEnv * 0.04),
        0.95,
        1.12,
      ),
      decayRateMultiplier: clamp(
        lerp(0.98, 1.09, bpmNorm) * (1 + beatEnv * 0.03),
        0.95,
        1.14,
      ),
      detailIntensityMultiplier: clamp(
        lerp(0.98, 1.08, energy) * (1 + beatEnv * 0.05),
        0.95,
        1.15,
      ),
      // Subtle continuous color drift driver (0..1). No direct hue jumps are applied by default.
      colorShift: clamp01(lerp(0.25, 0.75, bpmNorm) * 0.7 + beatEnv * 0.2),

      barSpacingScale: clamp(barSpacingScale, 0.8, 1.2),
      barWidthScale: clamp(barWidthScale, 0.85, 1.2),
      barHeightScale: clamp(barHeightScale, 0.8, 1.25),

      circlesRadiusScale: clamp(circlesRadiusScale, 0.8, 1.35),
      circlesSizeScale: clamp(circlesSizeScale, 0.8, 1.25),
      circlesTrailScale: clamp(circlesTrailScale, 0.7, 1.5),
    };
  }

  _recommendMode({ energyLabel, variabilityLabel, bandLabel, bpmEstimate }) {
    // Conservative, "suggestion-only" recommendations.
    // Avoid rapid changes: recommendation itself is not auto-applied unless user enables it.
    if (energyLabel === "low" && variabilityLabel === "smooth")
      return "circles";
    if (energyLabel === "high" && variabilityLabel === "fast")
      return "frequency3x";
    return "frequency4x";
  }

  _hysteresisEnergyLabel(x, prev) {
    // Thresholds (with hysteresis band) tuned for combinedNorm 0..1.
    const lowToMid = 0.32;
    const midToHigh = 0.62;
    const h = 0.04;
    if (prev === "low") {
      return x > lowToMid + h ? "mid" : "low";
    }
    if (prev === "high") {
      return x < midToHigh - h ? "mid" : "high";
    }
    // prev === mid
    if (x < lowToMid - h) return "low";
    if (x > midToHigh + h) return "high";
    return "mid";
  }

  _hysteresisVariabilityLabel(x, prev) {
    const smoothToBal = 0.2;
    const balToFast = 0.55;
    const h = 0.05;
    if (prev === "smooth") {
      return x > smoothToBal + h ? "balanced" : "smooth";
    }
    if (prev === "fast") {
      return x < balToFast - h ? "balanced" : "fast";
    }
    // balanced
    if (x < smoothToBal - h) return "smooth";
    if (x > balToFast + h) return "fast";
    return "balanced";
  }
}

function clamp(x, min, max) {
  return x < min ? min : x > max ? max : x;
}
function clamp01(x) {
  return x <= 0 ? 0 : x >= 1 ? 1 : x;
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}

class AudioVisualizer {
  constructor() {
    this.audioContext = null;
    this.analyser = null;
    this.microphone = null;
    this.gainNode = null;
    this.isPlaying = false;
    this.animationId = null;
    this.screenShare = null;

    this.canvas = document.getElementById("visualizer");
    this.ctx = this.canvas.getContext("2d");
    this.canvas.width = 1400;
    this.canvas.height = 800;

    this.dataArray = new Uint8Array(128);
    this.frequencyData = new Uint8Array(128);
    this.smoothedFrequencyData = new Float32Array(128);
    this.boostedFrequencyData = new Float32Array(128);

    // Lissajous mode buffers (time-domain smoothing; no per-frame allocations)
    // Stored as normalized floats in [-1..1]
    this._lissX = new Float32Array(this.dataArray.length);
    this._lissY = new Float32Array(this.dataArray.length);
    this._lissOffset = (this.dataArray.length * 0.25) | 0; // phase offset fallback (pseudo-stereo)
    this._lissT = 0; // running phase for infinity motion

    // Rhythm / beat tracking (kept lightweight, no per-frame allocations)
    this.rhythm = new RhythmTracker();
    this.energyNorm = new AdaptiveEnergyNormalizer();
    this.style = new StyleEngine();
    this.behavior = this.style.out;
    // Continuous (non-beat) energy signal for visuals (smoothed; no spikes)
    this.visualEnergy = 0; // 0..1-ish
    this.visualScale = 1; // smoothed scale derived from visualEnergy
    this.visualIntensity = 0; // 0..1 subtle global intensity (no flashing)
    // Adaptive smoothing state (fast tracks vs slow tracks)
    this._prevTargetEnergy = 0;
    this._deltaEnv = 0.02; // rolling “typical delta” envelope to normalize change rate

    this.sensitivity = 1.0;
    // Hue offset (0..360) to rotate the global rainbow palette
    this.hueOffset = 200;
    this.visualType = "frequency3x";
    this._lastVisualType = this.visualType;

    // Fullscreen mode properties
    this.isFullscreen = false;
    this.uiTimeout = null;
    this.uiHideDelay = 2000; // Hide UI after 2 seconds of no mouse movement

    // Raindrop effect properties for Frequency 3x
    this.raindrops = [];
    this.lastRaindropTime = 0;
    this.raindropInterval = 200; // Create raindrop every 200ms when bars are active (increased from 100ms)
    this.barRaindropTimers = []; // Individual timers for each bar position

    // Particle flow effect properties
    // Keep a relatively small, fixed pool for performance.
    this.particleFlowParticles = [];
    // Hard-cap to a low, safe range (will be clamped again in init).
    this.particleFlowCount = 120;
    this._particleFlowFrame = 0;
    // Adaptive quality: dynamically adjusts particle count when the renderer is under load.
    // Key design choice: only touches Particle Flow (other modes remain visually identical).
    this._perf = {
      avgFrameMs: 0,
      lastFrameTs: 0,
      lastAdjustTs: 0,
    };
    this._particlePerf = {
      // Conservative thresholds: aim for smoothness over maximum particle density.
      adjustCooldownMs: 2200,
      slowFactor: 1.35, // avgFrameMs > budget * slowFactor => reduce particles
      fastFactor: 0.85, // avgFrameMs < budget * fastFactor => increase particles
      stepDown: 10,
      stepUp: 6,
      minCount: 70,
      maxCount: 140,
    };
    // Tiny cache to reduce per-particle HSLA string churn in Particle Flow.
    // Cleared opportunistically when it grows too large.
    this._hslaCache = new Map();
    this._hslaCacheMax = 2048;

    // Performance controls
    this.targetFPS = 45; // reduce FPS for lower resource usage
    this.lastFrameTime = 0;
    // Debounced preference writes (sliders can fire dozens of events per second).
    this._prefsSaveTimer = null;

    // Optional: auto mode switching (disabled by default; recommendation-only unless enabled)
    this.autoModeSwitch = false;
    this._lastAutoSwitchTs = 0;
    this._autoSwitchCooldownMs = 14000; // slow transitions only

    this.init();
    this.initParticleFlowPool();
    this.loadUserPreferences(); // Load saved preferences
    this.updateButtonStates(); // Initialize button states
  }

  init() {
    this.setupEventListeners();
    this.setupCanvas();
  }

  setupEventListeners() {
    document
      .getElementById("startBtn")
      .addEventListener("click", () => this.startMicrophone());
    document
      .getElementById("screenShareBtn")
      .addEventListener("click", () => this.startScreenShare());
    document
      .getElementById("stopBtn")
      .addEventListener("click", () => this.stopVisualizer());
    document
      .getElementById("fullscreenBtn")
      .addEventListener("click", () => this.toggleFullscreen());
    document
      .getElementById("resetPreferencesBtn")
      .addEventListener("click", () => this.clearUserPreferences());
    document.getElementById("visualType").addEventListener("change", (e) => {
      this.visualType = e.target.value;
      this.saveUserPreferences(); // Save preference
    });
    document.getElementById("sensitivity").addEventListener("input", (e) => {
      this.sensitivity = parseFloat(e.target.value);
      const sensitivityValue = document.getElementById("sensitivityValue");
      if (sensitivityValue) {
        sensitivityValue.textContent = this.sensitivity.toFixed(1);
      }
      // Debounce saves to keep UI responsive while dragging.
      this.scheduleSaveUserPreferences();
    });
    const hueSlider = document.getElementById("hueOffset");
    if (hueSlider) {
      hueSlider.addEventListener("input", (e) => {
        const v = parseInt(e.target.value, 10);
        this.hueOffset = Number.isFinite(v) ? v : 200;
        const hueValue = document.getElementById("hueOffsetValue");
        if (hueValue) hueValue.textContent = String(this.hueOffset);
        // Debounce saves to keep UI responsive while dragging.
        this.scheduleSaveUserPreferences();
      });
    }

    // Handle window resize
    window.addEventListener("resize", () => this.handleResize());

    // Handle fullscreen resize
    window.addEventListener("resize", () => {
      if (this.isFullscreen) {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
      }
    });
  }

  // Debounced wrapper for preference persistence.
  // Rationale: localStorage writes can cause jank on some devices when called per slider tick.
  scheduleSaveUserPreferences(delayMs = 160) {
    if (this._prefsSaveTimer) clearTimeout(this._prefsSaveTimer);
    this._prefsSaveTimer = setTimeout(() => {
      this._prefsSaveTimer = null;
      this.saveUserPreferences();
    }, delayMs);
  }

  setupCanvas() {
    // Set canvas size based on container and device
    const container = this.canvas.parentElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const isMobile = window.innerWidth <= 768;

    if (isMobile) {
      // Mobile-first sizing
      this.canvas.width = rect.width - 20; // Full width minus padding
      this.canvas.height = Math.min(window.innerHeight * 0.5, 400); // 50% of viewport height, max 400px

      // Ensure canvas is properly initialized for mobile
      if (this.canvas.width <= 0 || this.canvas.height <= 0) {
        this.canvas.width = 320; // Fallback width for mobile
        this.canvas.height = 240; // Fallback height for mobile
      }
    } else {
      // Desktop sizing
      this.canvas.width = Math.min(1200, rect.width - 40);
      this.canvas.height = Math.min(800, rect.width * 0.6);
    }

    // Store last canvas size for comparison
    this.lastCanvasSize = {
      width: this.canvas.width,
      height: this.canvas.height,
    };

    // Ensure context is available
    if (!this.ctx) {
      this.ctx = this.canvas.getContext("2d");
    }

    if (this.particleFlowParticles && this.particleFlowParticles.length > 0) {
      this.initParticleFlowPool();
    }
  }

  handleResize() {
    this.setupCanvas();
  }

  async startMicrophone() {
    try {
      this.updateStatus("Requesting microphone access...", "active");

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioContext = new (
        window.AudioContext || window.webkitAudioContext
      )();
      this.analyser = this.audioContext.createAnalyser();
      this.gainNode = this.audioContext.createGain();
      this.microphone = this.audioContext.createMediaStreamSource(stream);

      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.9; // Increased from 0.8 for smoother response
      this.syncAnalyserBuffers();

      this.microphone.connect(this.analyser);
      // Remove audio playback - only connect for visualization
      // this.analyser.connect(this.gainNode);
      // this.gainNode.connect(this.audioContext.destination);

      this.isPlaying = true;
      this.updateStatus(
        "Microphone active - Speak or play music! (Audio not played back)",
        "active",
      );
      this.updateButtonStates(); // Update button states
      this.startVisualization();
    } catch (error) {
      console.error("Error accessing microphone:", error);
      this.updateStatus(
        "Error: Could not access microphone. Please check permissions.",
        "error",
      );
    }
  }

  async startScreenShare() {
    try {
      this.updateStatus("Requesting screen share access...", "active");

      // Better mobile detection - check for actual mobile capabilities
      const isMobile =
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
          navigator.userAgent,
        ) ||
        (window.innerWidth <= 768 && window.innerHeight > window.innerWidth) ||
        ("ontouchstart" in window && window.innerWidth <= 768);

      // Mobile detection and enhanced audio capture
      if (isMobile) {
        this.updateStatus(
          "Mobile detected - Attempting system audio capture...",
          "active",
        );

        // Show user guidance for better system audio capture
        setTimeout(() => {
          this.updateStatus(
            "💡 Tip: For best system audio capture, play music through your phone's speakers or headphones",
            "info",
          );
        }, 2000);

        // Try multiple methods to capture system audio
        let stream = null;
        let captureMethod = "unknown";

        // Method 1: Try to capture from audio output devices (speakers, headphones)
        try {
          this.updateStatus(
            "Trying to capture from audio output devices...",
            "active",
          );
          stream = await this.tryAudioOutputCapture();
          if (stream) {
            captureMethod = "audiooutput";
            this.updateStatus(
              "Audio output device capture successful!",
              "active",
            );
          }
        } catch (error) {
          console.warn("Audio output device capture failed:", error);
        }

        // Method 2: Try advanced system audio constraints
        if (!stream) {
          try {
            this.updateStatus(
              "Trying advanced system audio capture...",
              "active",
            );
            stream = await this.tryCaptureSystemAudio();
            if (stream) {
              captureMethod = "advanced";
              this.updateStatus(
                "Advanced system audio capture successful!",
                "active",
              );
            }
          } catch (error) {
            console.warn("Advanced system audio capture failed:", error);
          }
        }

        // Method 3: Try audio context monitoring
        if (!stream) {
          try {
            this.updateStatus(
              "Trying audio context system audio capture...",
              "active",
            );
            stream = await this.tryAudioContextCapture();
            if (stream) {
              captureMethod = "audiocontext";
              this.updateStatus(
                "Audio context system audio capture successful!",
                "active",
              );
            }
          } catch (error) {
            console.warn("Audio context system audio capture failed:", error);
          }
        }

        // Method 4: Try AudioWorklet system audio capture
        if (!stream) {
          try {
            this.updateStatus(
              "Trying AudioWorklet system audio capture...",
              "active",
            );
            stream = await this.tryAudioWorkletCapture();
            if (stream) {
              captureMethod = "audioworklet";
              this.updateStatus(
                "AudioWorklet system audio capture successful!",
                "active",
              );
            }
          } catch (error) {
            console.warn("AudioWorklet system audio capture failed:", error);
          }
        }

        // Method 5: Try alternative system audio methods if previous methods failed
        if (!stream) {
          try {
            this.updateStatus(
              "Trying alternative system audio capture...",
              "active",
            );
            stream = await this.tryAlternativeSystemAudio();
            if (stream) {
              captureMethod = "alternative";
              this.updateStatus(
                "Alternative system audio capture successful!",
                "active",
              );
            }
          } catch (error) {
            console.warn("Alternative system audio capture failed:", error);
          }
        }

        // Method 6: Try MediaRecorder approach if previous methods failed
        if (!stream) {
          try {
            this.updateStatus(
              "Trying MediaRecorder system audio capture...",
              "active",
            );
            stream = await this.tryMediaRecorderSystemAudio();
            if (stream) {
              captureMethod = "mediarecorder";
              this.updateStatus(
                "MediaRecorder system audio capture successful!",
                "active",
              );
            }
          } catch (error) {
            console.warn("MediaRecorder system audio capture failed:", error);
          }
        }

        // Method 7: Try getDisplayMedia with audio if previous methods failed
        if (!stream) {
          try {
            this.updateStatus(
              "Trying display media system audio capture...",
              "active",
            );
            stream = await this.tryDisplayMediaSystemAudio();
            if (stream) {
              captureMethod = "display";
              this.updateStatus(
                "Display media system audio capture successful!",
                "active",
              );
            }
          } catch (error) {
            console.warn("Display media system audio capture failed:", error);
          }
        }

        // Method 8: Enhanced microphone as fallback (only if all system audio methods fail)
        if (!stream) {
          try {
            this.updateStatus(
              "All system audio methods failed - Trying enhanced microphone...",
              "active",
            );
            stream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                sampleRate: 48000,
                channelCount: 2,
                // Try to get the best quality microphone input
                googEchoCancellation: false,
                googNoiseSuppression: false,
                googAutoGainControl: false,
              },
            });
            captureMethod = "enhanced";
            this.updateStatus(
              "Enhanced microphone active - Place device near speakers for best results!",
              "active",
            );
          } catch (error) {
            console.warn("Enhanced microphone failed:", error);
          }
        }

        // Method 9: Basic microphone as final fallback
        if (!stream) {
          try {
            this.updateStatus("Trying basic microphone capture...", "active");
            stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
            });
            captureMethod = "basic";
            this.updateStatus(
              "Basic microphone active - Place device near speakers for best results!",
              "active",
            );
          } catch (error) {
            console.error("All mobile audio capture methods failed:", error);
            this.updateStatus(
              "Mobile audio capture failed. Please check microphone permissions.",
              "error",
            );
            return;
          }
        }

        // Log the capture method used
        console.log(
          `Mobile audio capture completed using method: ${captureMethod}`,
        );

        // Set up audio context and analyser with the captured stream
        if (stream) {
          this.audioContext = new (
            window.AudioContext || window.webkitAudioContext
          )();
          this.analyser = this.audioContext.createAnalyser();
          this.analyser.fftSize = 256;
          this.analyser.smoothingTimeConstant = 0.8;
          this.analyser.minDecibels = -90;
          this.analyser.maxDecibels = -10;
          this.syncAnalyserBuffers();

          // Create gain node for volume control
          this.gainNode = this.audioContext.createGain();
          this.gainNode.gain.value = 0; // Mute playback

          // Connect the audio stream
          this.microphone = this.audioContext.createMediaStreamSource(stream);
          this.microphone.connect(this.analyser);
          this.analyser.connect(this.gainNode);
          this.gainNode.connect(this.audioContext.destination);

          this.isPlaying = true;

          // Update button text based on what was captured
          const screenShareBtn = document.getElementById("screenShareBtn");
          if (screenShareBtn) {
            screenShareBtn.classList.add("mobile-audio-mode");
            const audioSource = this.detectAudioSource(stream);

            switch (audioSource) {
              case "audiooutput":
                screenShareBtn.textContent = "📱 System Audio Active";
                this.updateStatus(
                  "System audio capture successful! Music and sounds from your phone will now be visualized.",
                  "active",
                );
                break;
              case "system":
                screenShareBtn.textContent = "📱 System Audio Active";
                this.updateStatus(
                  "System audio capture successful! Place device near speakers for best results.",
                  "active",
                );
                break;
              case "audiocontext":
                screenShareBtn.textContent = "📱 System Audio Active";
                this.updateStatus(
                  "Audio context system audio capture successful! Music and sounds from your phone will now be visualized.",
                  "active",
                );
                break;
              case "audioworklet":
                screenShareBtn.textContent = "📱 System Audio Active";
                this.updateStatus(
                  "AudioWorklet system audio capture successful! Music and sounds from your phone will now be visualized.",
                  "active",
                );
                break;
              case "alternative":
                screenShareBtn.textContent = "📱 Alt System Audio Active";
                this.updateStatus(
                  "Alternative system audio capture successful! Place device near speakers for best results.",
                  "active",
                );
                break;
              case "display":
                screenShareBtn.textContent = "📱 Display Audio Active";
                this.updateStatus(
                  "Display audio capture successful! Place device near speakers for best results.",
                  "active",
                );
                break;
              case "enhanced":
                screenShareBtn.textContent = "📱 Enhanced Audio Active";
                this.updateStatus(
                  "Enhanced audio capture active! Place device near speakers for best results.",
                  "active",
                );
                break;
              default:
                screenShareBtn.textContent = "📱 Basic Audio Active";
                this.updateStatus(
                  "Basic audio capture active! Place device near speakers for best results.",
                  "active",
                );
                break;
            }
          }

          this.updateButtonStates(); // Update button states
          this.startVisualization();

          // Handle stream ending
          stream.getAudioTracks()[0].onended = () => {
            this.stopScreenShare();
            this.updateStatus("Mobile audio capture ended", "info");
          };
        }

        return;
      }

      // Desktop: Request screen share with audio
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      this.audioContext = new (
        window.AudioContext || window.webkitAudioContext
      )();
      this.analyser = this.audioContext.createAnalyser();
      this.gainNode = this.audioContext.createGain();

      // Create media stream source from screen share
      this.screenShare = this.audioContext.createMediaStreamSource(stream);

      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.9; // Increased from 0.8 for smoother response

      // Initialize smoothing buffer to zeros
      this.smoothedFrequencyData = new Float32Array(this.frequencyData.length);

      // Connect screen share audio to analyser
      this.screenShare.connect(this.analyser);
      // No need to connect to destination - just for visualization

      this.isPlaying = true;
      this.updateStatus(
        "Screen share active - Audio from your screen is being visualized!",
        "active",
      );
      this.updateButtonStates(); // Update button states
      this.startVisualization();

      // Handle stream stop
      stream.getVideoTracks()[0].onended = () => {
        this.stopScreenShare();
        this.updateStatus("Screen share ended", "info");
      };
    } catch (error) {
      console.error("Error starting screen share:", error);
      if (error.name === "NotAllowedError") {
        this.updateStatus(
          "Screen share denied. Please allow access to share your screen.",
          "error",
        );
      } else {
        this.updateStatus(
          "Error starting screen share: " + error.message,
          "error",
        );
      }
    }
  }

  stopScreenShare() {
    if (this.screenShare) {
      this.screenShare.disconnect();
      this.screenShare = null;
    }

    // Remove mobile mode visual indicator
    const screenShareBtn = document.getElementById("screenShareBtn");
    if (screenShareBtn) {
      screenShareBtn.classList.remove("mobile-audio-mode");
      screenShareBtn.textContent = "🖥️ Share Screen / Mobile Audio";
    }

    this.stopVisualization();
    this.updateStatus("Screen share stopped", "info");
  }

  startVisualization() {
    if (this.animationId) return;
    if (!this.analyser) return;
    if (!this.canvas || !this.ctx) return;

    // Ensure canvas and context are properly set up for mobile
    if (this.canvas.width <= 0 || this.canvas.height <= 0) {
      console.warn("Invalid canvas dimensions, resetting...");
      this.setupCanvas();
    }

    const animate = (timestamp) => {
      if (!this.isPlaying || !this.analyser) return;

      // Throttle to target FPS
      const minDelta = 1000 / this.targetFPS;
      if (this.lastFrameTime && timestamp - this.lastFrameTime < minDelta) {
        this.animationId = requestAnimationFrame(animate);
        return;
      }

      // Lightweight performance tracking for adaptive Particle Flow quality.
      // We track *rendered* frame times (after throttle) so the signal is stable.
      if (!this._perf.lastFrameTs) this._perf.lastFrameTs = timestamp;
      const renderedDelta = timestamp - this._perf.lastFrameTs;
      this._perf.lastFrameTs = timestamp;
      // EMA: stable on jittery clocks; low overhead.
      this._perf.avgFrameMs = this._perf.avgFrameMs
        ? this._perf.avgFrameMs * 0.9 + renderedDelta * 0.1
        : renderedDelta;
      this.lastFrameTime = timestamp;

      // Ensure frequency data arrays are properly sized
      if (this.frequencyData && this.frequencyData.length > 0) {
        this.analyser.getByteFrequencyData(this.frequencyData);
        this.analyser.getByteTimeDomainData(this.dataArray);

        // Create boosted frequency data for enhanced high-end response (reused buffer)
        this.applyHighEndBoost(this.frequencyData, this.boostedFrequencyData);

        const sr = this.audioContext ? this.audioContext.sampleRate : 0;

        // Rhythm tracking (uses low-frequency energy)
        this.rhythm.update(this.frequencyData, sr, timestamp);

        // Adaptive normalization (low/mid/high + combinedNorm)
        this.energyNorm.update(this.frequencyData, sr);

        // Compute energy change rate (already used for adaptive smoothing); reuse for style intelligence.
        const targetEnergyForDelta = this.energyNorm.combinedNorm;
        const deltaForStyle = Math.abs(
          targetEnergyForDelta - this._prevTargetEnergy,
        );

        // Rolling delta envelope (fast attack, slow release)
        if (deltaForStyle > this._deltaEnv)
          this._deltaEnv += (deltaForStyle - this._deltaEnv) * 0.25;
        else this._deltaEnv += (deltaForStyle - this._deltaEnv) * 0.02;
        const normDeltaForStyle = Math.min(
          1,
          deltaForStyle / Math.max(1e-6, this._deltaEnv),
        );

        // Update style engine (smoothed classification + behavior knobs)
        this.style.update({
          timestampMs: timestamp,
          combinedNorm: targetEnergyForDelta,
          normDelta: normDeltaForStyle,
          lowNorm: this.energyNorm.lowNorm,
          midNorm: this.energyNorm.midNorm,
          highNorm: this.energyNorm.highNorm,
          dominantBand: this.energyNorm.dominantBand,
          beatDetected: this.rhythm.beatDetected,
          bpmEstimate: this.rhythm.bpmEstimate,
        });

        // Optional auto mode switching (disabled by default)
        if (this.autoModeSwitch) {
          const now = timestamp;
          const rec = this.behavior.recommendedVisualType;
          if (
            rec &&
            rec !== this.visualType &&
            now - this._lastAutoSwitchTs >= this._autoSwitchCooldownMs
          ) {
            this.visualType = rec;
            const visualTypeSelect = document.getElementById("visualType");
            if (visualTypeSelect) visualTypeSelect.value = rec;
            this.saveUserPreferences();
            this._lastAutoSwitchTs = now;
          }
        }

        // Temporal smoothing (exponential moving average) over boosted data (no allocations).
        // Alpha is driven by StyleEngine: energetic/dynamic tracks feel snappier; calm tracks feel smoother.
        const alpha = this.behavior.spectrumAlpha;
        for (let i = 0; i < this.frequencyData.length; i++) {
          const current = this.boostedFrequencyData[i];
          this.smoothedFrequencyData[i] =
            alpha * current + (1 - alpha) * this.smoothedFrequencyData[i];
        }

        // Visual mappings (all smoothed; no spikes):
        // - `visualEnergy` is the primary driver (0..1).
        // - `visualScale` stays subtle; `visualIntensity` can be used to gently boost contrast.
        const targetEnergy = targetEnergyForDelta;

        // Adaptive smoothing:
        // - Measure energy change rate (delta).
        // - High delta => lower smoothing (faster response for rapid transients).
        // - Low delta  => higher smoothing (stable for slow/ambient sections).
        // - Asymmetric smoothing: faster attack, slower decay.
        const delta = deltaForStyle;
        this._prevTargetEnergy = targetEnergy;
        const normDelta = normDeltaForStyle;
        const lerp = (a, b, t) => a + (b - a) * t;

        // Tune: minAlpha/maxAlpha control slow vs fast responsiveness
        const minAlpha = 0.04; // smoothest
        const maxAlpha = 0.22; // snappiest (still non-jittery)
        const baseAlpha = lerp(minAlpha, maxAlpha, normDelta);

        const diff = targetEnergy - this.visualEnergy;
        const alphaEnergy =
          diff >= 0
            ? Math.min(maxAlpha, baseAlpha * 1.15) // faster attack
            : Math.max(minAlpha, baseAlpha * 0.75); // slower decay
        this.visualEnergy += diff * alphaEnergy;

        const targetScale = 1 + this.visualEnergy * this.behavior.scaleAmp; // subtle, style-aware
        // Scale follows energy but slightly more damped than energy
        const alphaScale = Math.max(0.03, baseAlpha * 0.55);
        this.visualScale += (targetScale - this.visualScale) * alphaScale;
        const targetIntensity =
          this.behavior.intensityBase +
          this.visualEnergy * this.behavior.intensityAmp;
        // Intensity should be smoothest to avoid any perceived flashing
        const alphaIntensity = Math.max(0.02, baseAlpha * 0.4);
        this.visualIntensity +=
          (targetIntensity - this.visualIntensity) * alphaIntensity;
      }

      // Adaptive particle count (Particle Flow only).
      // Keeps the rest of the app identical while smoothing the heaviest mode.
      this.maybeAdjustParticleFlowQuality(timestamp);

      this.draw();
      this.animationId = requestAnimationFrame(animate);
    };

    this.animationId = requestAnimationFrame(animate);
  }

  maybeAdjustParticleFlowQuality(timestampMs) {
    if (this.visualType !== "particleFlow") return;
    const perf = this._perf;
    const cfg = this._particlePerf;
    if (!perf || !cfg) return;

    const budget = 1000 / (this.targetFPS || 45);
    const now = timestampMs || performance.now();
    if (perf.lastAdjustTs && now - perf.lastAdjustTs < cfg.adjustCooldownMs) {
      return;
    }

    const avg = perf.avgFrameMs || 0;
    if (!avg) return;

    let next = this.particleFlowCount || 120;
    if (avg > budget * cfg.slowFactor) {
      next = Math.max(cfg.minCount, next - cfg.stepDown);
    } else if (avg < budget * cfg.fastFactor) {
      next = Math.min(cfg.maxCount, next + cfg.stepUp);
    } else {
      return;
    }

    if (next !== this.particleFlowCount) {
      this.particleFlowCount = next;
      // Reinit the pool to match the new target count.
      this.initParticleFlowPool();
      perf.lastAdjustTs = now;
    }
  }

  stopVisualization() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  toggleFullscreen() {
    if (!this.isFullscreen) {
      this.enterFullscreen();
    } else {
      this.exitFullscreen();
    }
  }

  enterFullscreen() {
    const container = document.querySelector(".container");
    if (!container) return;

    container.classList.add("fullscreen-mode");
    this.isFullscreen = true;

    // Resize canvas to full screen
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;

    // Setup mouse movement detection
    this.setupFullscreenMouseDetection();

    this.updateStatus(
      "Fullscreen mode - Move mouse to show controls, press ESC to exit",
      "active",
    );
  }

  exitFullscreen() {
    const container = document.querySelector(".container");
    if (!container) return;

    container.classList.remove("fullscreen-mode", "show-ui");
    document.body.classList.remove("cursor-hidden");
    this.isFullscreen = false;

    // Restore original canvas size
    this.setupCanvas();

    // Remove fullscreen event listeners immediately (prevents buildup if user toggles
    // fullscreen without stopping the visualizer).
    if (this.fullscreenMouseHandler) {
      container.removeEventListener("mousemove", this.fullscreenMouseHandler);
      container.removeEventListener("click", this.fullscreenMouseHandler);
      this.fullscreenMouseHandler = null;
    }
    if (this.fullscreenKeyHandler) {
      document.removeEventListener("keydown", this.fullscreenKeyHandler);
      this.fullscreenKeyHandler = null;
    }

    // Clear mouse movement timeout
    if (this.uiTimeout) {
      clearTimeout(this.uiTimeout);
      this.uiTimeout = null;
    }

    this.updateStatus("Exited fullscreen mode", "info");
  }

  setupFullscreenMouseDetection() {
    const container = document.querySelector(".container");
    if (!container) return;

    const showUI = () => {
      document.body.classList.remove("cursor-hidden");
      container.classList.add("show-ui");

      // Clear existing timeout
      if (this.uiTimeout) {
        clearTimeout(this.uiTimeout);
      }

      // Hide UI after delay
      this.uiTimeout = setTimeout(() => {
        if (this.isFullscreen) {
          container.classList.remove("show-ui");
          document.body.classList.add("cursor-hidden");
        }
      }, this.uiHideDelay);
    };

    // Show UI immediately when entering fullscreen
    showUI();

    // Track mouse movement
    const handleMouseMove = () => {
      if (this.isFullscreen) {
        showUI();
      }
    };

    // Add event listeners
    container.addEventListener("mousemove", handleMouseMove);
    container.addEventListener("click", handleMouseMove);

    // Add ESC key support for exiting fullscreen
    const handleKeyDown = (e) => {
      if (this.isFullscreen && e.key === "Escape") {
        this.exitFullscreen();
      } else if (this.isFullscreen) {
        showUI();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    // Store references for cleanup
    this.fullscreenMouseHandler = handleMouseMove;
    this.fullscreenKeyHandler = handleKeyDown;
  }

  stopVisualizer() {
    // Stop the visualization
    this.stopVisualization();

    // Stop any current audio sources
    if (this.microphone) {
      this.microphone.mediaStream.getTracks().forEach((track) => track.stop());
      this.microphone = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    // Stop screen share
    this.stopScreenShare();

    // Cleanup fullscreen handlers
    if (this.fullscreenMouseHandler) {
      const container = document.querySelector(".container");
      if (container) {
        container.removeEventListener("mousemove", this.fullscreenMouseHandler);
        container.removeEventListener("click", this.fullscreenMouseHandler);
        document.removeEventListener("keydown", this.fullscreenKeyHandler);
      }
      this.fullscreenMouseHandler = null;
      this.fullscreenKeyHandler = null;
    }

    // Reset audio context
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    // Reset state
    this.analyser = null;
    this.gainNode = null;
    this.isPlaying = false;

    // Clear raindrops
    this.raindrops = [];
    this.lastRaindropTime = 0;
    this.barRaindropTimers = []; // Clear individual bar timers

    // Clear canvas - ensure it exists first
    if (this.canvas && this.ctx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    // Reset status
    this.updateStatus("Visualizer stopped. Ready to start again.", "info");

    // Removed frequency and volume display reset for better performance
    this.updateButtonStates(); // Update button states
  }

  draw() {
    if (!this.canvas || !this.ctx) return;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Reset state that can "stick" across frames/modes (prevents phantom glow/composite).
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";

    // If mode changed, hard clear once to avoid inheriting previous mode's last frame.
    if (this._lastVisualType !== this.visualType) {
      ctx.clearRect(0, 0, w, h);
    }

    // Lissajous looks best with a subtle decay trail (stable, non-flashy).
    if (this.visualType === "lissajous") {
      // Higher alpha = faster fade (shorter afterimage)
      // Make it noticeably faster (near-clear) while still keeping a tiny trail.
      ctx.fillStyle = "rgba(6, 7, 9, 0.70)";
      ctx.fillRect(0, 0, w, h);
    } else if (this.visualType === "particleFlow") {
      // No trails: hard clear every frame.
      ctx.clearRect(0, 0, w, h);
    } else {
      ctx.clearRect(0, 0, w, h);
    }

    // Use boosted frequency data if available, otherwise fall back to original
    const frequencyData = this.boostedFrequencyData || this.frequencyData;

    // Continuous, subtle energy scale (no beat/pulse spikes)
    const scale = this.visualScale || 1;
    ctx.save();
    ctx.translate(w * 0.5, h * 0.5);
    ctx.scale(scale, scale);
    ctx.translate(-w * 0.5, -h * 0.5);
    // Very subtle global intensity boost (kept smooth; no flashing)
    ctx.globalAlpha = 0.85 + Math.min(0.15, this.visualIntensity * 0.15);

    switch (this.visualType) {
      case "waveform":
        this.drawWaveform();
        break;
      case "circular":
        this.drawCircular();
        break;
      case "lissajous":
        this.drawLissajous();
        break;
      case "frequency2x":
        this.drawFrequencyBars2x();
        break;
      case "frequency3x":
        this.drawFrequencyBars3x();
        break;
      case "frequency4x":
        this.drawFrequencyBars4x();
        break;
      case "circles":
        this.drawCircles();
        break;
      case "particleFlow":
        this.drawParticleFlow();
        break;
    }

    ctx.restore();

    this._lastVisualType = this.visualType;

    // Removed updateAudioInfo() for better performance
  }

  // High-end frequency boost function to enhance treble response
  applyHighEndBoost(frequencyData, outBuffer) {
    if (!frequencyData || frequencyData.length === 0) return;
    if (!outBuffer || outBuffer.length !== frequencyData.length) return;
    const highEndStart = Math.floor(frequencyData.length * 0.6); // Last 40% of frequencies are high-end

    for (let i = 0; i < frequencyData.length; i++) {
      let value = frequencyData[i];

      // Apply high-end boost to higher frequencies (more aggressive for better response)
      if (i >= highEndStart) {
        // Boost all high frequencies more aggressively to ensure they respond to music
        const frequencyPosition =
          (i - highEndStart) / (frequencyData.length - highEndStart);
        const boostAmount = 0.5 + frequencyPosition * 0.8; // 0.5x to 1.3x additional boost
        value = Math.min(255, value * (1 + boostAmount));
      }

      outBuffer[i] = value;
    }
  }

  syncAnalyserBuffers() {
    if (!this.analyser) return;
    const binCount = this.analyser.frequencyBinCount;

    if (!this.frequencyData || this.frequencyData.length !== binCount) {
      this.frequencyData = new Uint8Array(binCount);
    }
    if (!this.dataArray || this.dataArray.length !== binCount) {
      this.dataArray = new Uint8Array(binCount);
    }
    if (
      !this.smoothedFrequencyData ||
      this.smoothedFrequencyData.length !== binCount
    ) {
      this.smoothedFrequencyData = new Float32Array(binCount);
    }
    if (
      !this.boostedFrequencyData ||
      this.boostedFrequencyData.length !== binCount
    ) {
      this.boostedFrequencyData = new Float32Array(binCount);
    }

    // Keep Lissajous buffers in sync too
    if (!this._lissX || this._lissX.length !== binCount)
      this._lissX = new Float32Array(binCount);
    if (!this._lissY || this._lissY.length !== binCount)
      this._lissY = new Float32Array(binCount);
    this._lissOffset = (binCount * 0.25) | 0;
  }

  drawLissajous() {
    if (!this.dataArray || this.dataArray.length === 0) return;
    if (!this.canvas || !this.ctx) return;

    const ctx = this.ctx;
    const n = this.dataArray.length;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Make the sensitivity slider meaningfully affect Lissajous
    const sens = Number.isFinite(this.sensitivity) ? this.sensitivity : 1;
    // Boost more than other modes, but clamp to keep it stable.
    const sensMul = clamp(0.85 + sens * 0.55, 0.9, 2.1);

    // Time-domain smoothing factor: stable when calm, slightly snappier when energetic.
    const energy = this.visualEnergy || 0;
    const alpha = 0.12 + energy * 0.18; // 0.12..0.30
    const detail = this.behavior ? this.behavior.detailIntensityMultiplier : 1;
    const step = detail < 0.95 ? 2 : 1; // small perf win on "low detail" profiles

    // Preferred stereo would be L/R, but current graph is a single analyser.
    // Fallback: pseudo-stereo via phase offset across the same buffer.
    const off = this._lissOffset | 0 || (n * 0.25) | 0;

    // Smooth into normalized [-1..1] buffers (no allocations)
    for (let i = 0; i < n; i++) {
      const xRaw = (this.dataArray[i] - 128) * (1 / 128);
      const yRaw = (this.dataArray[(i + off) % n] - 128) * (1 / 128);
      this._lissX[i] += (xRaw - this._lissX[i]) * alpha;
      this._lissY[i] += (yRaw - this._lissY[i]) * alpha;
    }

    // Visual styling (single stroke, oscilloscope feel)
    const hue = ((this.hueOffset || 0) + 200) % 360;
    const lightness = 54 + energy * 10;
    const a = 0.9;

    ctx.save();
    ctx.translate(w * 0.5, h * 0.5);

    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = `hsla(${hue}, 85%, ${lightness}%, ${a})`;
    ctx.lineWidth = (1.2 + energy * 2.8) * detail * (0.85 + sensMul * 0.35);

    // Subtle glow; energy-driven but kept smooth by visualEnergy
    ctx.shadowColor = `hsla(${hue}, 90%, 60%, 0.65)`;
    ctx.shadowBlur = (8 + energy * 18) * (0.8 + sensMul * 0.35);

    const scale =
      0.44 * Math.min(w, h) * (0.92 + energy * 0.05) * (0.82 + sensMul * 0.28);

    ctx.beginPath();
    for (let i = 0; i < n; i += step) {
      const x = this._lissX[i] * scale;
      const y = this._lissY[i] * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    // Close the loop for a continuous shape (improves stability perception)
    ctx.closePath();
    ctx.stroke();

    ctx.restore();
  }

  // Raindrop effect methods for Frequency 3x
  createRaindrop(x, y, width, height, value) {
    const motion = this.behavior ? this.behavior.motionSpeedMultiplier : 1;
    const raindrop = {
      x: x + width / 2, // Center of the bar
      y: y + height, // Bottom of the bar
      width: Math.max(1, width * 0.3), // 30% of bar width, minimum 1px
      height: Math.max(2, height * 0.1), // 10% of bar height, minimum 2px
      // Rhythm influences motion speed continuously (no pulses)
      speed: (1.5 + (value / 255) * 2.5) * motion,
      alpha: 0.8, // Initial opacity
      value: value, // Store frequency value for color
    };
    this.raindrops.push(raindrop);
  }

  updateRaindrops() {
    const decay = this.behavior ? this.behavior.decayRateMultiplier : 1;
    for (let i = this.raindrops.length - 1; i >= 0; i--) {
      const raindrop = this.raindrops[i];

      // Move raindrop downward
      raindrop.y += raindrop.speed;

      // Fade out more slowly for longer duration
      // Rhythm influences decay continuously (higher BPM/beatEnv => slightly faster fade)
      raindrop.alpha -= 0.005 * decay; // Reduced from 0.01 to 0.005 for longer visibility

      // Remove raindrops that are off canvas or fully transparent
      if (raindrop.y > this.canvas.height || raindrop.alpha <= 0) {
        this.raindrops.splice(i, 1);
      }
    }
  }

  drawRaindrops() {
    this.raindrops.forEach((raindrop) => {
      // Color based on frequency value (same as bars)
      const hue = this.getHue(raindrop.value);
      const saturation = 70;
      const lightness = 50;

      this.ctx.fillStyle = `hsla(${hue}, ${saturation}%, ${lightness}%, ${raindrop.alpha})`;

      // Draw raindrop as a rounded rectangle
      const radius = Math.max(1, raindrop.width * 0.3);
      this.ctx.beginPath();
      this.ctx.moveTo(raindrop.x + radius, raindrop.y);
      this.ctx.lineTo(raindrop.x + raindrop.width - radius, raindrop.y);
      this.ctx.quadraticCurveTo(
        raindrop.x + raindrop.width,
        raindrop.y,
        raindrop.x + raindrop.width,
        raindrop.y + radius,
      );
      this.ctx.lineTo(
        raindrop.x + raindrop.width,
        raindrop.y + raindrop.height,
      );
      this.ctx.lineTo(raindrop.x, raindrop.y + raindrop.height);
      this.ctx.lineTo(raindrop.x, raindrop.y + radius);
      this.ctx.quadraticCurveTo(
        raindrop.x,
        raindrop.y,
        raindrop.x + radius,
        raindrop.y,
      );
      this.ctx.closePath();
      this.ctx.fill();
    });
  }

  drawWaveform() {
    if (!this.dataArray || this.dataArray.length === 0) return;
    if (!this.canvas) return;
    if (!this.frequencyData || this.frequencyData.length === 0) return;

    const detail = this.behavior ? this.behavior.detailIntensityMultiplier : 1;
    // Rhythm/detail gently modulates thickness (continuous, no pulses)
    this.ctx.lineWidth = 4 * detail;
    const sliceWidth = this.canvas.width / this.dataArray.length;

    // Draw main waveform with amplitude-based colors
    this.ctx.beginPath();
    for (let i = 0; i < this.dataArray.length; i++) {
      const v = this.dataArray[i] / 128.0;
      const y = (v * this.canvas.height) / 2;
      const x = i * sliceWidth;

      // Map amplitude to frequency range for color variation
      // Higher amplitude = higher frequency = different color
      const amplitudeRatio = Math.abs(v);
      const mappedFreqValue = Math.floor(amplitudeRatio * 255);

      // Create color based on amplitude (like frequency bars)
      const colorShift = this.behavior ? this.behavior.colorShift : 0;
      const hue = this.getHue(
        mappedFreqValue * this.sensitivity,
        colorShift * 10,
      );
      const saturation = 70 + Math.abs(v) * 20; // Higher saturation for louder parts
      const lightness = 50 + Math.abs(v) * 30; // Brighter for louder parts

      this.ctx.strokeStyle = `hsl(${hue}, ${saturation}%, ${lightness}%)`;

      if (i === 0) {
        this.ctx.moveTo(x, y);
      } else {
        this.ctx.lineTo(x, y);
      }
    }
    this.ctx.lineTo(this.canvas.width, this.canvas.height / 2);
    this.ctx.stroke();

    // Draw mirror effect with amplitude-based colors
    this.ctx.beginPath();
    for (let i = 0; i < this.dataArray.length; i++) {
      const v = this.dataArray[i] / 128.0;
      const y = this.canvas.height - (v * this.canvas.height) / 2;
      const x = i * sliceWidth;

      // Map amplitude to frequency range for color variation
      const amplitudeRatio = Math.abs(v);
      const mappedFreqValue = Math.floor(amplitudeRatio * 255);

      // Create complementary color with transparency (same hue as main waveform)
      const colorShift = this.behavior ? this.behavior.colorShift : 0;
      const hue = this.getHue(
        mappedFreqValue * this.sensitivity,
        colorShift * 10,
      );
      const saturation = 70 + Math.abs(v) * 15;
      const lightness = 40 + Math.abs(v) * 25;
      const alpha = 0.4 + Math.abs(v) * 0.3; // More transparent for quieter parts

      this.ctx.strokeStyle = `hsla(${hue}, ${saturation}%, ${lightness}%, ${alpha})`;

      if (i === 0) {
        this.ctx.moveTo(x, y);
      } else {
        this.ctx.lineTo(x, y);
      }
    }
    this.ctx.lineTo(this.canvas.width, this.canvas.height / 2);
    this.ctx.stroke();
  }

  drawCircular() {
    if (!this.frequencyData || this.frequencyData.length === 0) return;
    if (!this.canvas) return;

    const centerX = this.canvas.width / 2;
    const centerY = this.canvas.height / 2;
    const radius = Math.min(centerX, centerY) * 0.6;

    this.ctx.strokeStyle = "#ff6b6b";
    const detail = this.behavior ? this.behavior.detailIntensityMultiplier : 1;
    this.ctx.lineWidth = 3 * detail;

    // Draw multiple circles based on frequency data
    for (let i = 0; i < this.frequencyData.length; i += 4) {
      const value = this.frequencyData[i] * this.sensitivity;
      // Rhythm/detail slightly increases radius responsiveness (continuous)
      const currentRadius = radius + (value / 255) * (100 * detail);
      const alpha = (value / 255) * 0.8 + 0.2;

      const colorShift = this.behavior ? this.behavior.colorShift : 0;
      const hue = this.getHue(value, colorShift * 10);
      this.ctx.strokeStyle = `hsla(${hue}, 70%, 60%, ${alpha})`;
      this.ctx.lineWidth = (value / 255) * 5 + 1;

      this.ctx.beginPath();
      this.ctx.arc(centerX, centerY, currentRadius, 0, 2 * Math.PI);
      this.ctx.stroke();
    }
  }

  // Prefer boosted -> smoothed -> raw frequency data for visualizations
  getVizSpectrum() {
    if (this.boostedFrequencyData) return this.boostedFrequencyData;
    if (
      this.smoothedFrequencyData &&
      this.frequencyData &&
      this.smoothedFrequencyData.length === this.frequencyData.length
    ) {
      return this.smoothedFrequencyData;
    }
    return this.frequencyData;
  }

  // Global hue helper (keeps rainbow behavior; rotates palette via this.hueOffset)
  getHue(value, extra = 0) {
    const base = (this.hueOffset || 0) + (value || 0) + (extra || 0);
    const h = base % 360;
    return h < 0 ? h + 360 : h;
  }

  // Draw a single rounded bar with flat color (rounded top only)
  drawRoundedBarFlat(x, y, width, height, value, radius) {
    const ctx = this.ctx;
    ctx.fillStyle = `hsl(${this.getHue(value)}, 70%, 50%)`;
    const w = width;
    const h = height;
    const r = Math.min(radius, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
  }

  // Unified bar renderer for all bar-based visual modes
  drawBars(config) {
    const canvas = this.canvas;
    const ctx = this.ctx;
    const data = this.getVizSpectrum();
    if (!canvas || !ctx || !data || data.length === 0) return;

    const behavior = this.behavior;
    const detail = behavior ? behavior.detailIntensityMultiplier : 1;
    // IMPORTANT: some modes must have perfectly stable x-geometry.
    // Locking x disables any time-varying spacing/width modifiers.
    const lockX = !!config.lockX;
    const spacingScale = !lockX && behavior ? behavior.barSpacingScale : 1;
    const widthScale = !lockX && behavior ? behavior.barWidthScale : 1;
    const heightScale = behavior ? behavior.barHeightScale : 1;

    const w = canvas.width;
    const h = canvas.height;
    const totalBars = data.length;
    const centerX = w / 2;
    const centerY = h / 2;

    const barHeight = h * config.barHeightScale * heightScale;

    // Layout-specific spacing/width (keeps exact prior proportions)
    const perSpacing =
      (w / 2 / totalBars) *
      spacingScale; /* both mirrored and center-out use half-width */
    const widthPad = config.layout === "center-out" ? 4 : 5;
    const barWidth = (perSpacing + widthPad) * widthScale;
    const radius = Math.max(2, Math.min(6, barWidth * 0.3));

    const responseScale = this.sensitivity * (1 + (detail - 1) * 0.35);
    const now = config.enableRaindrops ? Date.now() : 0;
    const time =
      config.layout === "center-out" && !lockX
        ? (this.lastFrameTime || 0) * 0.001
        : 0;

    for (let i = 0; i < totalBars; i++) {
      const value = data[i] * responseScale;
      const height = (value / 255) * barHeight;

      if (config.layout === "mirrored") {
        const y = config.origin === "top" ? 0 : h - height;

        // Deterministic x positions (no time-based drift)
        const xRight = centerX + i * perSpacing + (perSpacing - barWidth) / 2;
        const xLeft =
          centerX - (i + 1) * perSpacing + (perSpacing - barWidth) / 2;

        this.drawRoundedBarFlat(xRight, y, barWidth, height, value, radius);
        this.drawRoundedBarFlat(xLeft, y, barWidth, height, value, radius);

        if (config.enableRaindrops && height > 15) {
          if (!this.barRaindropTimers[i]) this.barRaindropTimers[i] = 0;
          if (now - this.barRaindropTimers[i] > this.raindropInterval) {
            this.createRaindrop(xRight, y, barWidth, height, value);
            this.createRaindrop(xLeft, y, barWidth, height, value);
            this.barRaindropTimers[i] = now;
          }
        }
      } else if (config.layout === "center-out") {
        // 4x: bars expand from center in all 4 quadrants (preserves 0.5px overlap)
        // Optional subtle horizontal wobble (intentionally scoped to 4x only)
        const wobbleAmount =
          !lockX && typeof config.xWobbleAmount === "number"
            ? config.xWobbleAmount
            : 0;
        const wobbleSpeed =
          !lockX && typeof config.xWobbleSpeed === "number"
            ? config.xWobbleSpeed
            : 0;
        const wobblePhase =
          !lockX && typeof config.xWobblePhase === "number"
            ? config.xWobblePhase
            : 0.1;
        const xWobble = wobbleAmount
          ? Math.sin(time * wobbleSpeed + i * wobblePhase) * wobbleAmount
          : 0;

        const xRight =
          centerX + i * perSpacing + (perSpacing - barWidth) / 2 + xWobble;
        const xLeft =
          centerX -
          (i + 1) * perSpacing +
          (perSpacing - barWidth) / 2 -
          xWobble;

        const yTop = centerY - height;
        const yBottom = centerY - 0.5;

        this.drawRoundedBarFlat(xRight, yTop, barWidth, height, value, radius);
        this.drawRoundedBarFlat(xLeft, yTop, barWidth, height, value, radius);
        this.drawRoundedBarFlat(
          xRight,
          yBottom,
          barWidth,
          height,
          value,
          radius,
        );
        this.drawRoundedBarFlat(
          xLeft,
          yBottom,
          barWidth,
          height,
          value,
          radius,
        );
      }
    }

    if (config.enableRaindrops) {
      this.updateRaindrops();
      this.drawRaindrops();
    }
  }

  // New: mirrored frequency bars centered on canvas
  drawFrequencyBars2x() {
    this.drawBars({
      layout: "mirrored",
      origin: "bottom",
      barHeightScale: 0.8,
      enableRaindrops: false,
      lockX: true,
    });
  }

  // New: Frequency 3x - Frequency 2x flipped vertically (bars start from top)
  drawFrequencyBars3x() {
    // Old behavior: (canvas.height * 0.35 * heightScale) then * 0.6 on height
    this.drawBars({
      layout: "mirrored",
      origin: "top",
      barHeightScale: 0.35 * 0.6,
      enableRaindrops: true,
      lockX: true,
    });
  }

  // New: 4-quadrant frequency bars centered on canvas
  drawFrequencyBars4x() {
    this.drawBars({
      layout: "center-out",
      origin: "center",
      barHeightScale: 1 / 3,
      enableRaindrops: false,
      // Keep style-driven geometry + allow optional intentional wobble (defaults to 0)
      lockX: false,
      xWobbleAmount: 0,
      xWobbleSpeed: 0,
      xWobblePhase: 0.1,
    });
  }

  // New: Circles visualization - multiple circles positioned around canvas with trailing effects
  drawCircles() {
    if (!this.frequencyData || this.frequencyData.length === 0) return;
    if (!this.canvas) return;

    const data =
      this.boostedFrequencyData ||
      (this.smoothedFrequencyData &&
      this.smoothedFrequencyData.length === this.frequencyData.length
        ? this.smoothedFrequencyData
        : this.frequencyData);

    const centerX = this.canvas.width / 2;
    const centerY = this.canvas.height / 2;
    const radiusScale = this.behavior ? this.behavior.circlesRadiusScale : 1;
    const sizeScale = this.behavior ? this.behavior.circlesSizeScale : 1;
    const trailScale = this.behavior ? this.behavior.circlesTrailScale : 1;
    const motion = this.behavior ? this.behavior.motionSpeedMultiplier : 1;
    const maxRadius = Math.min(centerX, centerY) * 0.8 * radiusScale;

    // Create circle positions around the canvas
    const circleCount = Math.min(data.length, 64); // Limit to 64 circles for performance
    const angleStep = (2 * Math.PI) / circleCount;

    // Previous positions for trailing effect (typed array, no per-frame object allocations)
    const needed = circleCount * 2;
    if (
      !this.previousCirclePositions ||
      this.previousCirclePositions.length !== needed
    ) {
      this.previousCirclePositions = new Float32Array(needed);
      for (let i = 0; i < needed; i += 2) {
        this.previousCirclePositions[i] = centerX;
        this.previousCirclePositions[i + 1] = centerY;
      }
    }

    for (let i = 0; i < circleCount; i++) {
      const value = data[i] * this.sensitivity;
      const angle = i * angleStep;

      // Calculate circle position in a spiral pattern
      // Rhythm slightly increases "movement amplitude" (continuous modulation)
      const distance = (value / 255) * maxRadius * (0.97 + 0.03 * motion);
      const x = centerX + Math.cos(angle) * distance;
      const y = centerY + Math.sin(angle) * distance;

      // Store current position for next frame
      const baseIdx = i * 2;
      const prevX = this.previousCirclePositions[baseIdx];
      const prevY = this.previousCirclePositions[baseIdx + 1];
      this.previousCirclePositions[baseIdx] = x;
      this.previousCirclePositions[baseIdx + 1] = y;

      // Circle size based on frequency value
      const circleSize = ((value / 255) * 8 + 2) * sizeScale; // style-aware size

      // Color based on frequency value (like other visualizations)
      const hue = this.getHue(value);
      const saturation = 70 + (value / 255) * 20; // 70% to 90%
      const lightness = 50 + (value / 255) * 30; // 50% to 80%

      // Draw trailing effect (fading trail)
      if (prevX !== x || prevY !== y) {
        const trailLength = Math.min(
          20,
          Math.sqrt((x - prevX) ** 2 + (y - prevY) ** 2),
        );
        const trailSteps = Math.min(
          10,
          Math.floor((trailLength / 2) * trailScale),
        );

        for (let step = 1; step <= trailSteps; step++) {
          const trailX = prevX + (x - prevX) * (step / trailSteps);
          const trailY = prevY + (y - prevY) * (step / trailSteps);
          const trailAlpha = 0.3 * (1 - step / trailSteps); // Fade out trail
          const trailSize = circleSize * (1 - (step / trailSteps) * 0.5); // Shrink trail

          this.ctx.fillStyle = `hsla(${hue}, ${saturation}%, ${lightness}%, ${trailAlpha})`;
          this.ctx.beginPath();
          this.ctx.arc(trailX, trailY, trailSize, 0, 2 * Math.PI);
          this.ctx.fill();
        }
      }

      // Draw main circle
      this.ctx.fillStyle = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
      this.ctx.beginPath();
      this.ctx.arc(x, y, circleSize, 0, 2 * Math.PI);
      this.ctx.fill();

      // Add glow effect for brighter circles
      // Style-aware glow threshold: calmer tracks glow a bit sooner, energetic tracks need stronger peaks.
      const glowThreshold = this.behavior
        ? 110 + (1 - this.visualEnergy) * 20
        : 128;
      if (value > glowThreshold) {
        this.ctx.shadowColor = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
        this.ctx.shadowBlur = circleSize * 2;
        this.ctx.fill();
        this.ctx.shadowBlur = 0; // Reset shadow
      }
    }
  }

  initParticleFlowPool() {
    if (!this.canvas) return;

    // Clamp particle count to a safe range for performance.
    const desiredCount = this.particleFlowCount || 120;
    const count = Math.max(60, Math.min(140, desiredCount));
    this.particleFlowCount = count;
    const w = this.canvas.width || 1200;
    const h = this.canvas.height || 800;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const minDim = Math.min(w, h);
    const tau = Math.PI * 2;

    if (
      !this.particleFlowParticles ||
      this.particleFlowParticles.length !== count
    ) {
      // Create a fixed-size pool; objects are reused and never reallocated per-frame.
      this.particleFlowParticles = new Array(count);
      for (let i = 0; i < count; i++) {
        this.particleFlowParticles[i] = {
          x: cx,
          y: cy,
          vx: 0,
          vy: 0,
          life: 0,
          alpha: 0.2,
          // Stable per-particle seed drives variation without extra allocations.
          seed: i * 0.61803398875,
          hueOffset: (i * 17) % 360,
        };
      }
    }

    for (let i = 0; i < count; i++) {
      const p = this.particleFlowParticles[i];
      const angle = (i / count) * tau;
      const band = (i % 23) / 23;
      const radius = minDim * (0.08 + band * 0.36);
      const twist = 0.8 + (i % 7) * 0.17;

      p.x = cx + Math.cos(angle * 1.7 + p.seed) * radius * twist * 0.55;
      p.y = cy + Math.sin(angle * 1.3 + p.seed * 0.9) * radius * twist * 0.55;
      p.vx = Math.cos(angle + p.seed) * 0.2;
      p.vy = Math.sin(angle + p.seed * 1.1) * 0.2;
      p.life = (i % 100) / 100;
      // Base alpha is light; final alpha is modulated during draw.
      p.alpha = 0.15 + (i % 10) * 0.02;
    }

    this._particleFlowFrame = 0;
  }

  respawnParticleFlowParticle(p, index, frame, cx, cy, minDim) {
    const tau = Math.PI * 2;
    const seed = p.seed + index * 0.137 + frame * 0.0017;
    const angle = (seed % 1) * tau;
    const radius = minDim * (0.08 + ((index % 11) / 11) * 0.28);
    const offsetX = Math.cos(angle) * radius;
    const offsetY = Math.sin(angle) * radius;
    const drift = 0.35 + (index % 7) * 0.06;

    p.x = cx + offsetX;
    p.y = cy + offsetY;
    // Give a gentle outward drift without extra trig at runtime.
    p.vx = Math.cos(angle) * drift;
    p.vy = Math.sin(angle) * drift;
    p.alpha = 0.18 + (index % 8) * 0.02;
    p.life = seed % 1;
  }

  drawParticleFlow() {
    if (!this.canvas || !this.ctx) return;
    if (
      !this.particleFlowParticles ||
      this.particleFlowParticles.length === 0
    ) {
      this.initParticleFlowPool();
    }
    if (!this.particleFlowParticles || this.particleFlowParticles.length === 0)
      return;

    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const particles = this.particleFlowParticles;
    const behavior = this.behavior;
    const lowEnergy = this.energyNorm ? clamp01(this.energyNorm.lowNorm) : 0;
    const midEnergy = this.energyNorm ? clamp01(this.energyNorm.midNorm) : 0;
    const highEnergy = this.energyNorm ? clamp01(this.energyNorm.highNorm) : 0;
    const motion = behavior ? behavior.motionSpeedMultiplier : 1;
    const detail = behavior ? behavior.detailIntensityMultiplier : 1;
    const colorShift = behavior ? behavior.colorShift : 0;
    const beatEnv = behavior ? clamp01(behavior.beatEnv) : 0;
    const frame = this._particleFlowFrame++;
    const tau = Math.PI * 2;
    // Beat envelope adds a smooth directional "surge" (no impulses).
    const beatSwirlBoost = 1 + beatEnv * 1.55;
    const beatOutBoost = 1 + beatEnv * 1.15;
    const swirlForce = (0.004 + midEnergy * 0.11) * motion * beatSwirlBoost;
    const outwardForce = (0.02 + lowEnergy * 0.18) * motion * beatOutBoost;
    const jitterForce = (0.001 + highEnergy * 0.035) * (0.85 + detail * 0.15);
    const maxSpeed = 3.2 + lowEnergy * 1.6 + midEnergy * 1.1 + highEnergy * 0.8;
    const minDim = Math.min(cx, cy);
    const maxSpeedSq = maxSpeed * maxSpeed;
    const offscreenLimit = Math.max(40, minDim * 0.18);
    const respawnLimitX = cx * 2 + offscreenLimit;
    const respawnLimitY = cy * 2 + offscreenLimit;

    // Cache style components that are shared across particles.
    const baseHueOffset =
      this.hueOffset +
      colorShift * 80 +
      lowEnergy * 28 +
      midEnergy * 90 +
      highEnergy * 135;
    const saturation = 78;

    const minDimSafe = Math.max(1, minDim);

    // Local helpers to reduce allocations in the hot path.
    const hslaCache = this._hslaCache;
    const hslaCacheMax = this._hslaCacheMax || 2048;
    const getCachedHsla = (hueInt, satInt, lightInt, alphaBucket) => {
      // alphaBucket is an integer 0..100, representing alpha in steps of 0.01.
      // This slightly quantizes alpha but is visually indistinguishable and cuts string churn.
      const key =
        (hueInt & 511) +
        "|" +
        satInt +
        "|" +
        lightInt +
        "|" +
        alphaBucket;
      let v = hslaCache.get(key);
      if (v) return v;
      v = `hsla(${hueInt}, ${satInt}%, ${lightInt}%, ${alphaBucket * 0.01})`;
      hslaCache.set(key, v);
      // Opportunistic cap to avoid unbounded memory growth.
      if (hslaCache.size > hslaCacheMax) hslaCache.clear();
      return v;
    };

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const dx = p.x - cx;
      const dy = p.y - cy;
      const distSq = dx * dx + dy * dy + 0.001;
      const invDist = 1 / Math.sqrt(distSq);
      const radialX = dx * invDist;
      const radialY = dy * invDist;
      const tangentX = -radialY;
      const tangentY = radialX;

      // Beat: gently increases coherence of the swirl (feels like a "direction change").
      const swirlCoherence = 0.75 + (i % 5) * 0.05 + beatEnv * 0.12;
      p.vx += radialX * outwardForce;
      p.vy += radialY * outwardForce;
      p.vx += tangentX * swirlForce * swirlCoherence;
      p.vy += tangentY * swirlForce * swirlCoherence;

      // Lightweight jitter: derived later from a single sin call (see below),
      // avoids multiple trig calls per particle.

      const centerPull = 0.00004 * (1 - lowEnergy);
      p.vx -= dx * centerPull;
      p.vy -= dy * centerPull;

      p.vx *= 0.98;
      p.vy *= 0.98;

      const speedSq = p.vx * p.vx + p.vy * p.vy;
      if (speedSq > maxSpeedSq) {
        const scale = maxSpeed / Math.sqrt(speedSq);
        p.vx *= scale;
        p.vy *= scale;
      }

      p.x += p.vx;
      p.y += p.vy;

      if (
        p.x < -offscreenLimit ||
        p.x > respawnLimitX ||
        p.y < -offscreenLimit ||
        p.y > respawnLimitY
      ) {
        this.respawnParticleFlowParticle(p, i, frame, cx, cy, minDim);
        continue;
      }

      p.life += 0.0025 + highEnergy * 0.003 + midEnergy * 0.0015;
      if (p.life > 1) p.life -= 1;

      // Avoid a 2nd sqrt: dist = 1 / invDist.
      const dist = 1 / invDist;
      const centerMix = 1 - Math.min(1, dist / minDimSafe);

      // Single trig call per particle: drives both pulse and subtle jitter.
      const phase = p.life * tau + p.seed;
      const s = Math.sin(phase);
      const absS = s < 0 ? -s : s;

      // Use the same sin result for a soft size/brightness pulse.
      const pulse = 0.88 + 0.12 * absS;

      // Very small, smooth jitter based on the same phase.
      const jitterX = s * jitterForce;
      const jitterY = (s * 1.31 - 0.2) * jitterForce;
      p.x += jitterX;
      p.y += jitterY;

      // Hue is used as an integer for caching (visual match is unchanged).
      let hue = (baseHueOffset + p.hueOffset) % 360;
      if (hue < 0) hue += 360;
      hue = hue | 0;
      const alpha = clamp(
        p.alpha * 0.7 + centerMix * 0.24 + highEnergy * 0.12,
        0.06,
        0.75,
      );
      const sizeBase =
        1.85 +
        (i % 5) * 0.32 +
        lowEnergy * 0.8 +
        midEnergy * 0.35 +
        highEnergy * 0.45 +
        centerMix * 0.7;
      const size = sizeBase * pulse * 1.3;

      const lightness = (54 + centerMix * 14) | 0;
      const alphaBucket = Math.max(6, Math.min(75, (alpha * 100 + 0.5) | 0));
      ctx.fillStyle = getCachedHsla(hue, saturation, lightness, alphaBucket);
      ctx.fillRect(p.x, p.y, size, size);
    }
  }

  updateStatus(message, type = "active") {
    const statusElement = document.getElementById("statusText");
    const statusContainer = document.querySelector(".status");

    if (statusElement) {
      statusElement.textContent = message;
    }
    if (statusContainer) {
      statusContainer.className = `status ${type}`;
    }
  }

  // Save user preferences to local storage
  saveUserPreferences() {
    try {
      const visualType = document.getElementById("visualType").value;
      const sensitivity = document.getElementById("sensitivity").value;
      const hueOffset =
        document.getElementById("hueOffset")?.value ??
        String(this.hueOffset ?? 200);

      localStorage.setItem("audVis_visualType", visualType);
      localStorage.setItem("audVis_sensitivity", sensitivity);
      localStorage.setItem("audVis_hueOffset", hueOffset);

      // Save additional preferences
      localStorage.setItem("audVis_lastUsed", new Date().toISOString());

      console.log("Preferences saved:", { visualType, sensitivity, hueOffset });

      // Show brief visual feedback
      this.showPreferenceFeedback("Preferences saved!", "success");
    } catch (error) {
      console.warn("Failed to save preferences:", error);
      this.showPreferenceFeedback("Failed to save preferences", "error");
    }
  }

  // Load user preferences from local storage
  loadUserPreferences() {
    try {
      const savedVisualType = localStorage.getItem("audVis_visualType");
      const savedSensitivity = localStorage.getItem("audVis_sensitivity");
      const savedHueOffset = localStorage.getItem("audVis_hueOffset");

      if (savedVisualType) {
        const visualTypeSelect = document.getElementById("visualType");
        const allowedModes = new Set([
          "waveform",
          "circular",
          "lissajous",
          "particleFlow",
          "frequency2x",
          "frequency3x",
          "frequency4x",
          "circles",
        ]);
        if (visualTypeSelect) {
          const mode = allowedModes.has(savedVisualType)
            ? savedVisualType
            : "frequency3x";
          visualTypeSelect.value = mode;
          this.visualType = mode;
          console.log("Loaded visual type:", mode);
        }
      }

      if (savedSensitivity) {
        const sensitivitySlider = document.getElementById("sensitivity");
        const sensitivityValue = document.getElementById("sensitivityValue");

        if (sensitivitySlider) {
          sensitivitySlider.value = savedSensitivity;
          this.sensitivity = parseFloat(savedSensitivity);
          console.log("Loaded sensitivity:", savedSensitivity);
        }

        if (sensitivityValue) {
          sensitivityValue.textContent =
            parseFloat(savedSensitivity).toFixed(1);
        }
      }

      if (savedHueOffset) {
        const hueSlider = document.getElementById("hueOffset");
        const hueValue = document.getElementById("hueOffsetValue");
        const parsed = parseInt(savedHueOffset, 10);
        const hue = Number.isFinite(parsed) ? parsed : 200;
        this.hueOffset = hue;
        if (hueSlider) hueSlider.value = String(hue);
        if (hueValue) hueValue.textContent = String(hue);
        console.log("Loaded hue offset:", hue);
      }

      // Show feedback if preferences were loaded
      if (savedVisualType || savedSensitivity || savedHueOffset) {
        this.showPreferenceFeedback("Preferences loaded!", "info");
      }
    } catch (error) {
      console.warn("Failed to load preferences:", error);
    }
  }

  // Clear user preferences (useful for resetting to defaults)
  clearUserPreferences() {
    try {
      localStorage.removeItem("audVis_visualType");
      localStorage.removeItem("audVis_sensitivity");
      localStorage.removeItem("audVis_hueOffset");
      console.log("Preferences cleared");

      // Reset to defaults
      this.visualType = "frequency3x";
      this.sensitivity = 1.0;
      this.hueOffset = 200;

      // Update UI
      const visualTypeSelect = document.getElementById("visualType");
      const sensitivitySlider = document.getElementById("sensitivity");
      const sensitivityValue = document.getElementById("sensitivityValue");
      const hueSlider = document.getElementById("hueOffset");
      const hueValue = document.getElementById("hueOffsetValue");

      if (visualTypeSelect) visualTypeSelect.value = this.visualType;
      if (sensitivitySlider) sensitivitySlider.value = this.sensitivity;
      if (sensitivityValue)
        sensitivityValue.textContent = this.sensitivity.toFixed(1);
      if (hueSlider) hueSlider.value = String(this.hueOffset);
      if (hueValue) hueValue.textContent = String(this.hueOffset);

      // Show feedback
      this.showPreferenceFeedback("Preferences reset to defaults!", "info");
    } catch (error) {
      console.warn("Failed to clear preferences:", error);
      this.showPreferenceFeedback("Failed to reset preferences", "error");
    }
  }

  // Show preference feedback to user
  showPreferenceFeedback(message, type = "info") {
    const statusElement = document.getElementById("statusText");
    if (statusElement) {
      const originalText = statusElement.textContent;
      statusElement.textContent = message;

      // Restore original text after 2 seconds
      setTimeout(() => {
        if (statusElement.textContent === message) {
          statusElement.textContent = originalText;
        }
      }, 2000);
    }
  }

  // Export preferences as JSON (for backup/sharing)
  exportPreferences() {
    try {
      const preferences = {
        visualType: document.getElementById("visualType").value,
        sensitivity: document.getElementById("sensitivity").value,
        hueOffset:
          document.getElementById("hueOffset")?.value ??
          String(this.hueOffset ?? 200),
        lastUsed: new Date().toISOString(),
        version: "1.0",
      };

      const dataStr = JSON.stringify(preferences, null, 2);
      const dataBlob = new Blob([dataStr], { type: "application/json" });

      const link = document.createElement("a");
      link.href = URL.createObjectURL(dataBlob);
      link.download = "audVis_preferences.json";
      link.click();

      this.showPreferenceFeedback("Preferences exported!", "success");
    } catch (error) {
      console.warn("Failed to export preferences:", error);
      this.showPreferenceFeedback("Failed to export preferences", "error");
    }
  }

  // Import preferences from JSON file
  async importPreferences(file) {
    try {
      const text = await file.text();
      const preferences = JSON.parse(text);

      if (
        preferences.version &&
        preferences.visualType &&
        preferences.sensitivity
      ) {
        // Update UI with imported preferences
        const visualTypeSelect = document.getElementById("visualType");
        const sensitivitySlider = document.getElementById("sensitivity");
        const sensitivityValue = document.getElementById("sensitivityValue");

        if (visualTypeSelect) {
          visualTypeSelect.value = preferences.visualType;
          this.visualType = preferences.visualType;
        }

        if (sensitivitySlider) {
          sensitivitySlider.value = preferences.sensitivity;
          this.sensitivity = parseFloat(preferences.sensitivity);
        }

        if (sensitivityValue) {
          sensitivityValue.textContent = parseFloat(
            preferences.sensitivity,
          ).toFixed(1);
        }

        // Save to local storage
        this.saveUserPreferences();

        this.showPreferenceFeedback(
          "Preferences imported successfully!",
          "success",
        );
      } else {
        throw new Error("Invalid preferences file format");
      }
    } catch (error) {
      console.warn("Failed to import preferences:", error);
      this.showPreferenceFeedback("Failed to import preferences", "error");
    }
  }

  // Update button states based on visualizer status
  updateButtonStates() {
    const startBtn = document.getElementById("startBtn");
    const stopBtn = document.getElementById("stopBtn");
    const screenShareBtn = document.getElementById("screenShareBtn");

    if (startBtn && stopBtn && screenShareBtn) {
      if (this.isPlaying) {
        // Visualizer is running
        startBtn.disabled = true;
        screenShareBtn.disabled = true;
        stopBtn.disabled = false;
        stopBtn.hidden = false;

        // Update button text to show current state
        startBtn.textContent = "🎤 Visualizer Active";
        stopBtn.textContent = "⏸ Pause";
        stopBtn.setAttribute("aria-label", "Pause visualizer");
      } else {
        // Visualizer is stopped
        startBtn.disabled = false;
        screenShareBtn.disabled = false;
        stopBtn.disabled = true;
        stopBtn.hidden = true;

        // Reset button text to default
        startBtn.textContent = "🎤 Start Microphone";
        stopBtn.textContent = "⏸ Pause";
        stopBtn.setAttribute("aria-label", "Pause visualizer");
      }
    }
  }

  // Try to capture system audio using advanced methods
  async tryCaptureSystemAudio() {
    try {
      // Method 1: Try to capture with system audio constraints
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 2,
          // Advanced system audio capture attempts
          googEchoCancellation: false,
          googNoiseSuppression: false,
          googAutoGainControl: false,
          googHighpassFilter: false,
          googTypingNoiseDetection: false,
          googAudioMirroring: false,
          processing: false,
          latency: 0,
          // Try to capture from system audio output
          sourceId: "system",
          // Additional system audio hints
          deviceId: "system-audio",
          groupId: "system-audio-group",
        },
      });

      return stream;
    } catch (error) {
      console.warn("System audio capture failed:", error);
      return null;
    }
  }

  // Try to capture system audio using MediaRecorder approach
  async tryMediaRecorderSystemAudio() {
    try {
      // Method 2: Try to capture system audio using MediaRecorder
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 2,
          // Try to capture from system audio output
          sourceId: "system",
          // Additional constraints for system audio
          googEchoCancellation: false,
          googNoiseSuppression: false,
          googAutoGainControl: false,
          googHighpassFilter: false,
          googTypingNoiseDetection: false,
          googAudioMirroring: false,
          processing: false,
          latency: 0,
        },
      });

      // Try to create a MediaRecorder to capture system audio
      const mediaRecorder = new MediaRecorder(stream);
      const chunks = [];

      mediaRecorder.ondataavailable = (event) => {
        chunks.push(event.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: "audio/webm" });
        const url = URL.createObjectURL(blob);
        // Use the captured audio
        this.processCapturedAudio(url);
      };

      return stream;
    } catch (error) {
      console.warn("MediaRecorder system audio capture failed:", error);
      return null;
    }
  }

  // Try to capture system audio using getDisplayMedia (screen sharing with audio)
  async tryDisplayMediaSystemAudio() {
    try {
      // Method 3: Try to capture system audio using screen sharing with audio
      if (navigator.mediaDevices.getDisplayMedia) {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 2,
          },
          video: false, // We only want audio
        });

        // Check if we got audio tracks
        if (stream.getAudioTracks().length > 0) {
          console.log("Display media system audio capture successful!");
          return stream;
        } else {
          // No audio tracks, close the stream
          stream.getTracks().forEach((track) => track.stop());
          return null;
        }
      }
      return null;
    } catch (error) {
      console.warn("Display media system audio capture failed:", error);
      return null;
    }
  }

  // Try to capture system audio using alternative methods
  async tryAlternativeSystemAudio() {
    try {
      // Try different constraint combinations that might work on some devices
      const constraints = [
        // Samsung/Android specific
        {
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 2,
            googEchoCancellation: false,
            googNoiseSuppression: false,
            googAutoGainControl: false,
            // Samsung specific
            samsungEchoCancellation: false,
            samsungNoiseSuppression: false,
          },
        },
        // iOS specific
        {
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 2,
            // iOS specific
            iosEchoCancellation: false,
            iosNoiseSuppression: false,
          },
        },
        // Generic high-quality
        {
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 96000,
            channelCount: 2,
            latency: 0,
            processing: false,
          },
        },
      ];

      for (const constraint of constraints) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraint);
          console.log(
            "Alternative system audio capture successful with constraints:",
            constraint,
          );
          return stream;
        } catch (error) {
          console.warn("Alternative constraint failed:", error);
          continue;
        }
      }

      return null;
    } catch (error) {
      console.warn("All alternative system audio methods failed:", error);
      return null;
    }
  }

  // Try to capture system audio using AudioWorklet and advanced Web Audio methods
  async tryAudioWorkletCapture() {
    try {
      // Method: Try to use AudioWorklet for system audio capture
      if (window.AudioWorklet) {
        const audioContext = new (
          window.AudioContext || window.webkitAudioContext
        )();

        // Try to create a MediaStreamDestination that might capture system audio
        const destination = audioContext.createMediaStreamDestination();

        // Try to get system audio using getUserMedia with specific constraints
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 2,
            // Try to capture system audio specifically
            sourceId: "system",
            googEchoCancellation: false,
            googNoiseSuppression: false,
            googAutoGainControl: false,
            googHighpassFilter: false,
            googTypingNoiseDetection: false,
            googAudioMirroring: false,
            processing: false,
            latency: 0,
            // Additional system audio hints
            deviceId: "system-audio",
            groupId: "system-audio-group",
          },
        });

        // Create a source from the stream and connect it to the destination
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(destination);

        // Also try to connect to the audio context's destination to capture system audio
        if (audioContext.destination) {
          source.connect(audioContext.destination);
        }

        return destination.stream;
      }

      return null;
    } catch (error) {
      console.warn("AudioWorklet system audio capture failed:", error);
      return null;
    }
  }

  // Try to capture system audio using audio output monitoring
  async tryAudioOutputCapture() {
    try {
      // Method: Try to capture from audio output devices
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioOutputDevices = devices.filter(
        (device) =>
          device.kind === "audiooutput" ||
          device.label.toLowerCase().includes("speaker") ||
          device.label.toLowerCase().includes("output") ||
          device.label.toLowerCase().includes("system"),
      );

      if (audioOutputDevices.length > 0) {
        console.log("Found audio output devices:", audioOutputDevices);

        // Try to capture from the first available audio output device
        for (const device of audioOutputDevices) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: {
                deviceId: { exact: device.deviceId },
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                sampleRate: 48000,
                channelCount: 2,
                // Try to capture system audio
                googEchoCancellation: false,
                googNoiseSuppression: false,
                googAutoGainControl: false,
                processing: false,
                latency: 0,
              },
            });

            console.log(
              "Audio output device capture successful:",
              device.label,
            );
            return stream;
          } catch (error) {
            console.warn(
              `Failed to capture from device ${device.label}:`,
              error,
            );
            continue;
          }
        }
      }

      return null;
    } catch (error) {
      console.warn("Audio output capture failed:", error);
      return null;
    }
  }

  // Try to capture system audio using audio context monitoring
  async tryAudioContextCapture() {
    try {
      // Method: Try to create an audio context that might capture system audio
      const audioContext = new (
        window.AudioContext || window.webkitAudioContext
      )();

      // Try to create a MediaStreamDestination to capture system audio
      const destination = audioContext.createMediaStreamDestination();

      // Try to connect to system audio sources if available
      if (navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 2,
            // Try to capture from system audio
            sourceId: "system",
            googEchoCancellation: false,
            googNoiseSuppression: false,
            googAutoGainControl: false,
            processing: false,
            latency: 0,
          },
        });

        // Connect the stream to the destination
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(destination);

        return destination.stream;
      }

      return null;
    } catch (error) {
      console.warn("Audio context capture failed:", error);
      return null;
    }
  }

  // Detect the type of audio being captured
  detectAudioSource(stream) {
    const audioTrack = stream.getAudioTracks()[0];
    const trackLabel = audioTrack.label || "";
    const trackId = audioTrack.id || "";

    // Check if this appears to be audio output device capture
    if (
      trackLabel.toLowerCase().includes("speaker") ||
      trackLabel.toLowerCase().includes("output") ||
      trackLabel.toLowerCase().includes("headphone") ||
      trackLabel.toLowerCase().includes("audioout") ||
      trackId.toLowerCase().includes("speaker") ||
      trackId.toLowerCase().includes("output") ||
      trackId.toLowerCase().includes("headphone")
    ) {
      return "audiooutput";
    }

    // Check if this appears to be system audio
    if (
      trackLabel.toLowerCase().includes("system") ||
      trackLabel.toLowerCase().includes("output") ||
      trackLabel.toLowerCase().includes("speaker") ||
      trackId.toLowerCase().includes("system") ||
      trackId.toLowerCase().includes("output")
    ) {
      return "system";
    }

    // Check if this appears to be audio context capture
    if (
      trackLabel.toLowerCase().includes("audiocontext") ||
      trackLabel.toLowerCase().includes("destination") ||
      trackLabel.toLowerCase().includes("monitor") ||
      trackId.toLowerCase().includes("audiocontext") ||
      trackId.toLowerCase().includes("destination")
    ) {
      return "audiocontext";
    }

    // Check if this appears to be AudioWorklet capture
    if (
      trackLabel.toLowerCase().includes("audioworklet") ||
      trackLabel.toLowerCase().includes("worklet") ||
      trackLabel.toLowerCase().includes("processor") ||
      trackId.toLowerCase().includes("audioworklet") ||
      trackId.toLowerCase().includes("worklet")
    ) {
      return "audioworklet";
    }

    // Check if this appears to be alternative system audio
    if (
      trackLabel.toLowerCase().includes("alternative") ||
      trackLabel.toLowerCase().includes("samsung") ||
      trackLabel.toLowerCase().includes("ios") ||
      trackLabel.toLowerCase().includes("high-quality") ||
      trackId.toLowerCase().includes("alternative") ||
      trackId.toLowerCase().includes("samsung") ||
      trackId.toLowerCase().includes("ios")
    ) {
      return "alternative";
    }

    // Check if this appears to be display media audio
    if (
      trackLabel.toLowerCase().includes("display") ||
      trackLabel.toLowerCase().includes("screen") ||
      trackLabel.toLowerCase().includes("tab") ||
      trackLabel.toLowerCase().includes("window") ||
      trackId.toLowerCase().includes("display") ||
      trackId.toLowerCase().includes("screen")
    ) {
      return "display";
    }

    // Check if this appears to be enhanced microphone
    if (
      trackLabel.toLowerCase().includes("enhanced") ||
      trackLabel.toLowerCase().includes("high") ||
      trackLabel.toLowerCase().includes("quality")
    ) {
      return "enhanced";
    }

    // Default to basic microphone
    return "basic";
  }

  // Process captured audio from MediaRecorder
  processCapturedAudio(audioUrl) {
    // This method would process the captured system audio
    // For now, we'll use it as a fallback
    console.log("Processing captured system audio:", audioUrl);
  }
}

// Initialize the visualizer when the page loads
document.addEventListener("DOMContentLoaded", () => {
  new AudioVisualizer();
});
