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

    this.sensitivity = 1.0;
    this.visualType = "frequency3x";

    // Fullscreen mode properties
    this.isFullscreen = false;
    this.uiTimeout = null;
    this.uiHideDelay = 2000; // Hide UI after 2 seconds of no mouse movement

    // Raindrop effect properties for Frequency 3x
    this.raindrops = [];
    this.lastRaindropTime = 0;
    this.raindropInterval = 200; // Create raindrop every 200ms when bars are active (increased from 100ms)
    this.barRaindropTimers = []; // Individual timers for each bar position

    // Performance controls
    this.targetFPS = 45; // reduce FPS for lower resource usage
    this.lastFrameTime = 0;

    this.init();
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
      this.saveUserPreferences(); // Save preference
    });

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
  }

  handleResize() {
    this.setupCanvas();
  }

  async startMicrophone() {
    try {
      this.updateStatus("Requesting microphone access...", "active");

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioContext = new (window.AudioContext ||
        window.webkitAudioContext)();
      this.analyser = this.audioContext.createAnalyser();
      this.gainNode = this.audioContext.createGain();
      this.microphone = this.audioContext.createMediaStreamSource(stream);

      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.9; // Increased from 0.8 for smoother response

      // Initialize smoothing buffer to zeros
      this.smoothedFrequencyData = new Float32Array(this.frequencyData.length);

      this.microphone.connect(this.analyser);
      // Remove audio playback - only connect for visualization
      // this.analyser.connect(this.gainNode);
      // this.gainNode.connect(this.audioContext.destination);

      this.isPlaying = true;
      this.updateStatus(
        "Microphone active - Speak or play music! (Audio not played back)",
        "active"
      );
      this.updateButtonStates(); // Update button states
      this.startVisualization();
    } catch (error) {
      console.error("Error accessing microphone:", error);
      this.updateStatus(
        "Error: Could not access microphone. Please check permissions.",
        "error"
      );
    }
  }

  async startScreenShare() {
    try {
      this.updateStatus("Requesting screen share access...", "active");

      // Better mobile detection - check for actual mobile capabilities
      const isMobile =
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
          navigator.userAgent
        ) ||
        (window.innerWidth <= 768 && window.innerHeight > window.innerWidth) ||
        ("ontouchstart" in window && window.innerWidth <= 768);

      // Mobile detection and enhanced audio capture
      if (isMobile) {
        this.updateStatus(
          "Mobile detected - Attempting system audio capture...",
          "active"
        );

        // Show user guidance for better system audio capture
        setTimeout(() => {
          this.updateStatus(
            "💡 Tip: For best system audio capture, play music through your phone's speakers or headphones",
            "info"
          );
        }, 2000);

        // Try multiple methods to capture system audio
        let stream = null;
        let captureMethod = "unknown";

        // Method 1: Try to capture from audio output devices (speakers, headphones)
        try {
          this.updateStatus(
            "Trying to capture from audio output devices...",
            "active"
          );
          stream = await this.tryAudioOutputCapture();
          if (stream) {
            captureMethod = "audiooutput";
            this.updateStatus(
              "Audio output device capture successful!",
              "active"
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
              "active"
            );
            stream = await this.tryCaptureSystemAudio();
            if (stream) {
              captureMethod = "advanced";
              this.updateStatus(
                "Advanced system audio capture successful!",
                "active"
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
              "active"
            );
            stream = await this.tryAudioContextCapture();
            if (stream) {
              captureMethod = "audiocontext";
              this.updateStatus(
                "Audio context system audio capture successful!",
                "active"
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
              "active"
            );
            stream = await this.tryAudioWorkletCapture();
            if (stream) {
              captureMethod = "audioworklet";
              this.updateStatus(
                "AudioWorklet system audio capture successful!",
                "active"
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
              "active"
            );
            stream = await this.tryAlternativeSystemAudio();
            if (stream) {
              captureMethod = "alternative";
              this.updateStatus(
                "Alternative system audio capture successful!",
                "active"
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
              "active"
            );
            stream = await this.tryMediaRecorderSystemAudio();
            if (stream) {
              captureMethod = "mediarecorder";
              this.updateStatus(
                "MediaRecorder system audio capture successful!",
                "active"
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
              "active"
            );
            stream = await this.tryDisplayMediaSystemAudio();
            if (stream) {
              captureMethod = "display";
              this.updateStatus(
                "Display media system audio capture successful!",
                "active"
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
              "active"
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
              "active"
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
              "active"
            );
          } catch (error) {
            console.error("All mobile audio capture methods failed:", error);
            this.updateStatus(
              "Mobile audio capture failed. Please check microphone permissions.",
              "error"
            );
            return;
          }
        }

        // Log the capture method used
        console.log(
          `Mobile audio capture completed using method: ${captureMethod}`
        );

        // Set up audio context and analyser with the captured stream
        if (stream) {
          this.audioContext = new (window.AudioContext ||
            window.webkitAudioContext)();
          this.analyser = this.audioContext.createAnalyser();
          this.analyser.fftSize = 256;
          this.analyser.smoothingTimeConstant = 0.8;
          this.analyser.minDecibels = -90;
          this.analyser.maxDecibels = -10;

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
                  "active"
                );
                break;
              case "system":
                screenShareBtn.textContent = "📱 System Audio Active";
                this.updateStatus(
                  "System audio capture successful! Place device near speakers for best results.",
                  "active"
                );
                break;
              case "audiocontext":
                screenShareBtn.textContent = "📱 System Audio Active";
                this.updateStatus(
                  "Audio context system audio capture successful! Music and sounds from your phone will now be visualized.",
                  "active"
                );
                break;
              case "audioworklet":
                screenShareBtn.textContent = "📱 System Audio Active";
                this.updateStatus(
                  "AudioWorklet system audio capture successful! Music and sounds from your phone will now be visualized.",
                  "active"
                );
                break;
              case "alternative":
                screenShareBtn.textContent = "📱 Alt System Audio Active";
                this.updateStatus(
                  "Alternative system audio capture successful! Place device near speakers for best results.",
                  "active"
                );
                break;
              case "display":
                screenShareBtn.textContent = "📱 Display Audio Active";
                this.updateStatus(
                  "Display audio capture successful! Place device near speakers for best results.",
                  "active"
                );
                break;
              case "enhanced":
                screenShareBtn.textContent = "📱 Enhanced Audio Active";
                this.updateStatus(
                  "Enhanced audio capture active! Place device near speakers for best results.",
                  "active"
                );
                break;
              default:
                screenShareBtn.textContent = "📱 Basic Audio Active";
                this.updateStatus(
                  "Basic audio capture active! Place device near speakers for best results.",
                  "active"
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

      this.audioContext = new (window.AudioContext ||
        window.webkitAudioContext)();
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
        "active"
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
          "error"
        );
      } else {
        this.updateStatus(
          "Error starting screen share: " + error.message,
          "error"
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
      this.lastFrameTime = timestamp;

      // Ensure frequency data arrays are properly sized
      if (this.frequencyData && this.frequencyData.length > 0) {
        this.analyser.getByteFrequencyData(this.frequencyData);
        this.analyser.getByteTimeDomainData(this.dataArray);

        // Create boosted frequency data for enhanced high-end response
        this.boostedFrequencyData = this.applyHighEndBoost(this.frequencyData);

        // Temporal smoothing (exponential moving average)
        if (
          !this.smoothedFrequencyData ||
          this.smoothedFrequencyData.length !== this.frequencyData.length
        ) {
          this.smoothedFrequencyData = new Float32Array(
            this.frequencyData.length
          );
        }
        const alpha = 0.15; // Reduced smoothing factor for smoother animations (was 0.2)
        for (let i = 0; i < this.frequencyData.length; i++) {
          const current = this.boostedFrequencyData[i];
          this.smoothedFrequencyData[i] =
            alpha * current + (1 - alpha) * this.smoothedFrequencyData[i];
        }
      }

      this.draw();
      this.animationId = requestAnimationFrame(animate);
    };

    this.animationId = requestAnimationFrame(animate);
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
      "active"
    );
  }

  exitFullscreen() {
    const container = document.querySelector(".container");
    if (!container) return;

    container.classList.remove("fullscreen-mode", "show-ui");
    this.isFullscreen = false;

    // Restore original canvas size
    this.setupCanvas();

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
      container.classList.add("show-ui");

      // Clear existing timeout
      if (this.uiTimeout) {
        clearTimeout(this.uiTimeout);
      }

      // Hide UI after delay
      this.uiTimeout = setTimeout(() => {
        if (this.isFullscreen) {
          container.classList.remove("show-ui");
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

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Use boosted frequency data if available, otherwise fall back to original
    const frequencyData = this.boostedFrequencyData || this.frequencyData;

    switch (this.visualType) {
      case "waveform":
        this.drawWaveform();
        break;
      case "circular":
        this.drawCircular();
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
      case "starlight":
        this.drawStarlight();
        break;
      case "retroBox":
        this.drawRetroBox();
        break;
    }

    // Removed updateAudioInfo() for better performance
  }

  // High-end frequency boost function to enhance treble response
  applyHighEndBoost(frequencyData) {
    if (!frequencyData || frequencyData.length === 0) return frequencyData;

    const boostedData = new Float32Array(frequencyData.length);
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

      boostedData[i] = value;
    }

    return boostedData;
  }

  // Raindrop effect methods for Frequency 3x
  createRaindrop(x, y, width, height, value) {
    const raindrop = {
      x: x + width / 2, // Center of the bar
      y: y + height, // Bottom of the bar
      width: Math.max(1, width * 0.3), // 30% of bar width, minimum 1px
      height: Math.max(2, height * 0.1), // 10% of bar height, minimum 2px
      speed: 1.5 + (value / 255) * 2.5, // Reduced speed from 2-5 to 1.5-4 for longer duration
      alpha: 0.8, // Initial opacity
      value: value, // Store frequency value for color
    };
    this.raindrops.push(raindrop);
  }

  updateRaindrops() {
    for (let i = this.raindrops.length - 1; i >= 0; i--) {
      const raindrop = this.raindrops[i];

      // Move raindrop downward
      raindrop.y += raindrop.speed;

      // Fade out more slowly for longer duration
      raindrop.alpha -= 0.005; // Reduced from 0.01 to 0.005 for longer visibility

      // Remove raindrops that are off canvas or fully transparent
      if (raindrop.y > this.canvas.height || raindrop.alpha <= 0) {
        this.raindrops.splice(i, 1);
      }
    }
  }

  drawRaindrops() {
    this.raindrops.forEach((raindrop) => {
      // Color based on frequency value (same as bars)
      const hue = raindrop.value + 200;
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
        raindrop.y + radius
      );
      this.ctx.lineTo(
        raindrop.x + raindrop.width,
        raindrop.y + raindrop.height
      );
      this.ctx.lineTo(raindrop.x, raindrop.y + raindrop.height);
      this.ctx.lineTo(raindrop.x, raindrop.y + radius);
      this.ctx.quadraticCurveTo(
        raindrop.x,
        raindrop.y,
        raindrop.x + radius,
        raindrop.y
      );
      this.ctx.closePath();
      this.ctx.fill();
    });
  }

  drawWaveform() {
    if (!this.dataArray || this.dataArray.length === 0) return;
    if (!this.canvas) return;
    if (!this.frequencyData || this.frequencyData.length === 0) return;

    this.ctx.lineWidth = 4;
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
      const hue = mappedFreqValue * this.sensitivity + 200; // Same formula as frequency bars
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
      const hue = mappedFreqValue * this.sensitivity + 200; // Same formula as frequency bars
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
    this.ctx.lineWidth = 3;

    // Draw multiple circles based on frequency data
    for (let i = 0; i < this.frequencyData.length; i += 4) {
      const value = this.frequencyData[i] * this.sensitivity;
      const currentRadius = radius + (value / 255) * 100;
      const alpha = (value / 255) * 0.8 + 0.2;

      this.ctx.strokeStyle = `hsla(${value + 200}, 70%, 60%, ${alpha})`;
      this.ctx.lineWidth = (value / 255) * 5 + 1;

      this.ctx.beginPath();
      this.ctx.arc(centerX, centerY, currentRadius, 0, 2 * Math.PI);
      this.ctx.stroke();
    }
  }

  // New: mirrored frequency bars centered on canvas
  drawFrequencyBars2x() {
    if (!this.frequencyData || this.frequencyData.length === 0) return;
    if (!this.canvas) return;

    const data =
      this.boostedFrequencyData ||
      (this.smoothedFrequencyData &&
      this.smoothedFrequencyData.length === this.frequencyData.length
        ? this.smoothedFrequencyData
        : this.frequencyData);

    const totalBars = data.length;
    const centerX = this.canvas.width / 2;

    // Each side uses half the canvas width for all bins
    const perSideSpacing = this.canvas.width / 2 / totalBars;
    const barWidth = perSideSpacing + 5; // Expand width by 5px
    const barHeight = this.canvas.height * 0.8;

    const radius = Math.max(2, Math.min(6, barWidth * 0.3));

    // Helper to draw a single rounded bar with flat color (rounded top only)
    const drawRoundedBarFlat = (x, y, width, height, value) => {
      this.ctx.fillStyle = `hsl(${value + 200}, 70%, 50%)`;
      const w = width;
      const h = height;
      const r = Math.min(radius, w / 2, h / 2);
      this.ctx.beginPath();
      this.ctx.moveTo(x + r, y);
      this.ctx.lineTo(x + w - r, y);
      this.ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      this.ctx.lineTo(x + w, y + h);
      this.ctx.lineTo(x, y + h);
      this.ctx.lineTo(x, y + r);
      this.ctx.quadraticCurveTo(x, y, x + r, y);
      this.ctx.closePath();
      this.ctx.fill();
    };

    for (let i = 0; i < totalBars; i++) {
      const value = data[i] * this.sensitivity;
      const height = (value / 255) * barHeight;
      const y = this.canvas.height - height; // Bars start from bottom

      // Right side - center bar in its spacing
      const xRight =
        centerX + i * perSideSpacing + (perSideSpacing - barWidth) / 2;
      drawRoundedBarFlat(xRight, y, barWidth, height, value);

      // Left side (mirrored) - center bar in its spacing
      const xLeft =
        centerX - (i + 1) * perSideSpacing + (perSideSpacing - barWidth) / 2;
      drawRoundedBarFlat(xLeft, y, barWidth, height, value);
    }
  }

  // New: Frequency 3x - Frequency 2x flipped vertically (bars start from top)
  drawFrequencyBars3x() {
    if (!this.frequencyData || this.frequencyData.length === 0) return;
    if (!this.canvas) return;

    const data =
      this.boostedFrequencyData ||
      (this.smoothedFrequencyData &&
      this.smoothedFrequencyData.length === this.frequencyData.length
        ? this.smoothedFrequencyData
        : this.frequencyData);

    const totalBars = data.length;
    const centerX = this.canvas.width / 2;

    // Each side uses half the canvas width for all bins
    const perSideSpacing = this.canvas.width / 2 / totalBars;
    const barWidth = perSideSpacing + 5; // Expand width by 5px
    const barHeight = this.canvas.height * 0.35; // Reduced from 0.5 to 0.35 for more raindrop focus

    const radius = Math.max(2, Math.min(6, barWidth * 0.3));

    // Helper to draw a single rounded bar with flat color (rounded top only)
    const drawRoundedBarFlat = (x, y, width, height, value) => {
      this.ctx.fillStyle = `hsl(${value + 200}, 70%, 50%)`;
      const w = width;
      const h = height;
      const r = Math.min(radius, w / 2, h / 2);
      this.ctx.beginPath();
      this.ctx.moveTo(x + r, y);
      this.ctx.lineTo(x + w - r, y);
      this.ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      this.ctx.lineTo(x + w, y + h);
      this.ctx.lineTo(x, y + h);
      this.ctx.lineTo(x, y + r);
      this.ctx.quadraticCurveTo(x, y, x + r, y);
      this.ctx.closePath();
      this.ctx.fill();
    };

    for (let i = 0; i < totalBars; i++) {
      const value = data[i] * this.sensitivity;
      const height = (value / 255) * barHeight * 0.6; // Reduced to 60% of original height for more compact bars

      // Vertical flip: bars start from top and grow downward (opposite of 2x)
      const y = 0; // Bars are anchored to top of canvas (y=0)

      // Same positioning as Frequency 2x: bars grow from edges toward center
      const xRight =
        centerX + i * perSideSpacing + (perSideSpacing - barWidth) / 2;
      drawRoundedBarFlat(xRight, y, barWidth, height, value);

      // Left side (mirrored) - same as Frequency 2x
      const xLeft =
        centerX - (i + 1) * perSideSpacing + (perSideSpacing - barWidth) / 2;
      drawRoundedBarFlat(xLeft, y, barWidth, height, value);

      // Create raindrops for active bars (when height is significant) - even distribution across all bars
      if (height > 15) {
        // Initialize timers array if needed
        if (!this.barRaindropTimers[i]) {
          this.barRaindropTimers[i] = 0;
        }

        // Check if enough time has passed for this specific bar position
        if (Date.now() - this.barRaindropTimers[i] > this.raindropInterval) {
          this.createRaindrop(xRight, y, barWidth, height, value);
          this.createRaindrop(xLeft, y, barWidth, height, value);
          this.barRaindropTimers[i] = Date.now();
        }
      }
    }

    // Update and draw raindrops
    this.updateRaindrops();
    this.drawRaindrops();
  }

  // New: 4-quadrant frequency bars centered on canvas
  drawFrequencyBars4x() {
    if (!this.frequencyData || this.frequencyData.length === 0) return;
    if (!this.canvas) return;

    const data =
      this.boostedFrequencyData ||
      (this.smoothedFrequencyData &&
      this.smoothedFrequencyData.length === this.frequencyData.length
        ? this.smoothedFrequencyData
        : this.frequencyData);

    const totalBars = data.length;
    const centerX = this.canvas.width / 2;
    const centerY = this.canvas.height / 2;

    // Each quadrant uses a quarter of the canvas space
    const perQuadrantSpacing = this.canvas.width / 2 / totalBars; // Use half canvas width per side for more coverage
    const barWidth = perQuadrantSpacing + 4; // Increase bar width by 4px total (2px + 2px)
    const maxBarHeight = this.canvas.height / 3; // Increase height to use more vertical space

    const radius = Math.max(2, Math.min(6, barWidth * 0.3));

    // Helper to draw a single rounded bar with flat color (rounded top only)
    const drawRoundedBarFlat = (x, y, width, height, value) => {
      this.ctx.fillStyle = `hsl(${value + 200}, 70%, 50%)`;
      const w = width;
      const h = height;
      const r = Math.min(radius, w / 2, h / 2);
      this.ctx.beginPath();
      this.ctx.moveTo(x + r, y);
      this.ctx.lineTo(x + w - r, y);
      this.ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      this.ctx.lineTo(x + w, y + h);
      this.ctx.lineTo(x, y + h);
      this.ctx.lineTo(x, y + r);
      this.ctx.quadraticCurveTo(x, y, x + r, y);
      this.ctx.closePath();
      this.ctx.fill();
    };

    for (let i = 0; i < totalBars; i++) {
      const value = data[i] * this.sensitivity;
      const height = (value / 255) * maxBarHeight;

      // Top-right quadrant
      const xTopRight =
        centerX + i * perQuadrantSpacing + (perQuadrantSpacing - barWidth) / 2;
      const yTopRight = centerY - height;
      drawRoundedBarFlat(xTopRight, yTopRight, barWidth, height, value);

      // Top-left quadrant (mirror of top-right)
      const xTopLeft =
        centerX -
        (i + 1) * perQuadrantSpacing +
        (perQuadrantSpacing - barWidth) / 2;
      const yTopLeft = centerY - height;
      drawRoundedBarFlat(xTopLeft, yTopLeft, barWidth, height, value);

      // Bottom-right quadrant (x-axis flip) - overlap by 0.5px for seamless connection
      const xBottomRight =
        centerX + i * perQuadrantSpacing + (perQuadrantSpacing - barWidth) / 2;
      const yBottomRight = centerY - 0.5; // Overlap by 0.5px
      drawRoundedBarFlat(xBottomRight, yBottomRight, barWidth, height, value);

      // Bottom-left quadrant (x-axis flip, y-axis mirror) - overlap by 0.5px for seamless connection
      const xBottomLeft =
        centerX -
        (i + 1) * perQuadrantSpacing +
        (perQuadrantSpacing - barWidth) / 2;
      const yBottomLeft = centerY - 0.5; // Overlap by 0.5px
      drawRoundedBarFlat(xBottomLeft, yBottomLeft, barWidth, height, value);
    }
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
    const maxRadius = Math.min(centerX, centerY) * 0.8;

    // Create circle positions around the canvas
    const circleCount = Math.min(data.length, 64); // Limit to 64 circles for performance
    const angleStep = (2 * Math.PI) / circleCount;

    // Initialize or update previous positions for trailing effect
    if (!this.previousCirclePositions) {
      this.previousCirclePositions = new Array(circleCount);
      for (let i = 0; i < circleCount; i++) {
        this.previousCirclePositions[i] = { x: centerX, y: centerY };
      }
    }

    for (let i = 0; i < circleCount; i++) {
      const value = data[i] * this.sensitivity;
      const angle = i * angleStep;

      // Calculate circle position in a spiral pattern
      const distance = (value / 255) * maxRadius;
      const x = centerX + Math.cos(angle) * distance;
      const y = centerY + Math.sin(angle) * distance;

      // Store current position for next frame
      const prevPos = this.previousCirclePositions[i];
      this.previousCirclePositions[i] = { x, y };

      // Circle size based on frequency value
      const circleSize = (value / 255) * 8 + 2; // 2px to 10px

      // Color based on frequency value (like other visualizations)
      const hue = value + 200;
      const saturation = 70 + (value / 255) * 20; // 70% to 90%
      const lightness = 50 + (value / 255) * 30; // 50% to 80%

      // Draw trailing effect (fading trail)
      if (prevPos && (prevPos.x !== x || prevPos.y !== y)) {
        const trailLength = Math.min(
          20,
          Math.sqrt((x - prevPos.x) ** 2 + (y - prevPos.y) ** 2)
        );
        const trailSteps = Math.min(10, Math.floor(trailLength / 2));

        for (let step = 1; step <= trailSteps; step++) {
          const trailX = prevPos.x + (x - prevPos.x) * (step / trailSteps);
          const trailY = prevPos.y + (y - prevPos.y) * (step / trailSteps);
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
      if (value > 128) {
        this.ctx.shadowColor = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
        this.ctx.shadowBlur = circleSize * 2;
        this.ctx.fill();
        this.ctx.shadowBlur = 0; // Reset shadow
      }
    }
  }

  // New: Starlight visualization - stationary circles scattered like stars in night sky
  drawStarlight() {
    if (!this.frequencyData || this.frequencyData.length === 0) return;
    if (!this.canvas) return;

    const data =
      this.boostedFrequencyData ||
      (this.smoothedFrequencyData &&
      this.smoothedFrequencyData.length === this.frequencyData.length
        ? this.smoothedFrequencyData
        : this.frequencyData);

    // Check if canvas size has changed and regenerate stars if needed
    const currentCanvasSize = `${this.canvas.width}x${this.canvas.height}`;
    if (!this.starPositions || this.lastCanvasSize !== currentCanvasSize) {
      this.starPositions = [];
      this.starSizes = [];
      this.lastCanvasSize = currentCanvasSize;
      const starCount = Math.min(data.length, 128); // More stars for a richer night sky

      // Helper function to check if a position overlaps with existing stars
      const isOverlapping = (x, y, size) => {
        for (const existingStar of this.starPositions) {
          const distance = Math.sqrt(
            (x - existingStar.x) ** 2 + (y - existingStar.y) ** 2
          );
          const minDistance = (size + existingStar.size) * 1.5; // 1.5x spacing for better separation
          if (distance < minDistance) return true;
        }
        return false;
      };

      for (let i = 0; i < starCount; i++) {
        let attempts = 0;
        let x, y, size;

        // Keep trying until we find a non-overlapping position
        do {
          x = Math.random() * (this.canvas.width - 100) + 50;
          y = Math.random() * (this.canvas.height - 100) + 50;
          size = Math.random() * 3 + 1;
          attempts++;
        } while (isOverlapping(x, y, size) && attempts < 100);

        // If we couldn't find a non-overlapping position, use the last attempt
        this.starPositions.push({ x, y, size });
        this.starSizes.push(size);
      }
    }

    // Draw each star
    for (let i = 0; i < this.starPositions.length; i++) {
      const star = this.starPositions[i];
      const baseSize = this.starSizes[i];
      const value = data[i % data.length] * this.sensitivity; // Cycle through frequency data

      // Calculate star brightness and size based on frequency
      const brightness = value / 255;
      const starSize = baseSize + brightness * 3; // Size increases with brightness

      // More vibrant colors with higher saturation and contrast
      const hue = value + 200;
      const saturation = 85 + brightness * 15; // 85% to 100% (more vibrant)
      const lightness = 25 + brightness * 55; // 25% to 80% (more contrast)

      // Draw star with varying opacity based on brightness
      const alpha = 0.4 + brightness * 0.6; // 40% to 100% opacity (more visible)
      this.ctx.fillStyle = `hsla(${hue}, ${saturation}%, ${lightness}%, ${alpha})`;

      this.ctx.beginPath();
      this.ctx.arc(star.x, star.y, starSize, 0, 2 * Math.PI);
      this.ctx.fill();

      // Add glow effect for brighter stars
      if (brightness > 0.5) {
        this.ctx.shadowColor = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
        this.ctx.shadowBlur = starSize * 2;
        this.ctx.fill();
        this.ctx.shadowBlur = 0; // Reset shadow
      }

      // Add twinkling effect for very bright stars
      if (brightness > 0.8) {
        this.ctx.fillStyle = `hsla(${hue}, ${saturation}%, 95%, ${
          brightness * 0.7
        })`;
        this.ctx.beginPath();
        this.ctx.arc(star.x, star.y, starSize * 0.5, 0, 2 * Math.PI);
        this.ctx.fill();
      }
    }
  }

  // Xbox-style Retro Box visualizer
  drawRetroBox() {
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;

    // Clear canvas with dark background
    ctx.fillStyle = "rgba(0, 0, 0, 0.15)";
    ctx.fillRect(0, 0, width, height);

    // Get frequency data (prioritize boosted data)
    const data =
      this.boostedFrequencyData ||
      this.smoothedFrequencyData ||
      this.frequencyData;
    if (!data || data.length === 0) return;

    // Xbox-style parameters
    const barHeight = height * 0.8;
    const barWidth = 8;
    const spacing = 4;
    const centerY = height / 2;
    const maxBars = Math.floor(width / (barWidth + spacing));

    // Create wave motion effect
    const time = Date.now() * 0.001;
    const waveSpeed = 2;
    const waveAmplitude = 20;

    // Classic old-school car dashboard green color
    const classicCarGreen = {
      primary: "#39ff14", // Bright phosphor green (like old car dashboards)
      secondary: "#32cd32", // Lime green
      accent: "#ffffff", // White for highlights
    };

    // Use the classic car green instead of color cycling
    const colors = classicCarGreen;

    // Draw horizontal bars in Xbox style
    for (let i = 0; i < maxBars; i++) {
      const x = i * (barWidth + spacing);
      const dataIndex = Math.floor((i / maxBars) * data.length);
      const value = data[dataIndex] || 0;

      // Create wave motion
      const waveOffset = Math.sin(time * waveSpeed + i * 0.1) * waveAmplitude;
      const barLength = (value / 255) * barHeight * 0.6 + 10; // Minimum bar length

      // Xbox-style bar positioning (centered, horizontal)
      const startY = centerY - barLength / 2 + waveOffset;
      const endY = centerY + barLength / 2 + waveOffset;

      // Create car dashboard-style gradient with classic green
      const gradient = ctx.createLinearGradient(x, startY, x + barWidth, endY);
      gradient.addColorStop(0, colors.primary); // Bright phosphor green
      gradient.addColorStop(0.3, colors.secondary); // Lime green
      gradient.addColorStop(0.7, colors.secondary); // Lime green
      gradient.addColorStop(1, colors.primary); // Bright phosphor green again

      // Draw main bar
      ctx.fillStyle = gradient;
      ctx.fillRect(x, startY, barWidth, barLength);

      // Add car dashboard glow effect
      ctx.shadowColor = colors.primary;
      ctx.shadowBlur = 15;
      ctx.fillRect(x, startY, barWidth, barLength);

      // Reset shadow
      ctx.shadowBlur = 0;

      // Add highlight line (car dashboard signature)
      ctx.fillStyle = colors.accent;
      ctx.fillRect(x, startY, barWidth, 2);

      // Add bottom accent line
      ctx.fillStyle = colors.primary;
      ctx.fillRect(x, endY - 2, barWidth, 2);

      // Add subtle inner glow for that phosphor effect
      ctx.fillStyle = `rgba(57, 255, 20, 0.4)`;
      ctx.fillRect(x + 1, startY + 1, barWidth - 2, barLength - 2);
    }

    // Add car dashboard-style center line
    ctx.strokeStyle = colors.primary;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Add subtle scan lines for retro car dashboard effect
    ctx.strokeStyle = `rgba(57, 255, 20, 0.1)`;
    ctx.lineWidth = 1;
    for (let y = 0; y < height; y += 3) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Add car dashboard-style corner accents (like speedometer corners)
    const cornerSize = 25;
    ctx.strokeStyle = colors.primary;
    ctx.lineWidth = 2;

    // Top-left corner (like speedometer)
    ctx.beginPath();
    ctx.moveTo(cornerSize, cornerSize);
    ctx.lineTo(cornerSize, cornerSize + 20);
    ctx.moveTo(cornerSize, cornerSize);
    ctx.lineTo(cornerSize + 20, cornerSize);
    ctx.stroke();

    // Top-right corner
    ctx.beginPath();
    ctx.moveTo(width - cornerSize, cornerSize);
    ctx.lineTo(width - cornerSize, cornerSize + 20);
    ctx.moveTo(width - cornerSize, cornerSize);
    ctx.lineTo(width - cornerSize - 20, cornerSize);
    ctx.stroke();

    // Bottom-left corner
    ctx.beginPath();
    ctx.moveTo(cornerSize, height - cornerSize);
    ctx.lineTo(cornerSize, height - cornerSize - 20);
    ctx.moveTo(cornerSize, height - cornerSize);
    ctx.lineTo(cornerSize + 20, height - cornerSize);
    ctx.stroke();

    // Bottom-right corner
    ctx.beginPath();
    ctx.moveTo(width - cornerSize, height - cornerSize);
    ctx.lineTo(width - cornerSize, height - cornerSize - 20);
    ctx.moveTo(width - cornerSize, height - cornerSize);
    ctx.lineTo(width - cornerSize - 20, height - cornerSize);
    ctx.stroke();
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

      localStorage.setItem("audVis_visualType", visualType);
      localStorage.setItem("audVis_sensitivity", sensitivity);

      // Save additional preferences
      localStorage.setItem("audVis_lastUsed", new Date().toISOString());

      console.log("Preferences saved:", { visualType, sensitivity });

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

      if (savedVisualType) {
        const visualTypeSelect = document.getElementById("visualType");
        if (visualTypeSelect) {
          visualTypeSelect.value = savedVisualType;
          this.visualType = savedVisualType;
          console.log("Loaded visual type:", savedVisualType);
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

      // Show feedback if preferences were loaded
      if (savedVisualType || savedSensitivity) {
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
      console.log("Preferences cleared");

      // Reset to defaults
      this.visualType = "frequency3x";
      this.sensitivity = 1.0;

      // Update UI
      const visualTypeSelect = document.getElementById("visualType");
      const sensitivitySlider = document.getElementById("sensitivity");
      const sensitivityValue = document.getElementById("sensitivityValue");

      if (visualTypeSelect) visualTypeSelect.value = this.visualType;
      if (sensitivitySlider) sensitivitySlider.value = this.sensitivity;
      if (sensitivityValue)
        sensitivityValue.textContent = this.sensitivity.toFixed(1);

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
            preferences.sensitivity
          ).toFixed(1);
        }

        // Save to local storage
        this.saveUserPreferences();

        this.showPreferenceFeedback(
          "Preferences imported successfully!",
          "success"
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

        // Update button text to show current state
        startBtn.textContent = "🎤 Visualizer Active";
        stopBtn.textContent = "⏹️ Stop Visualizer";
      } else {
        // Visualizer is stopped
        startBtn.disabled = false;
        screenShareBtn.disabled = false;
        stopBtn.disabled = true;

        // Reset button text to default
        startBtn.textContent = "🎤 Start Microphone";
        stopBtn.textContent = "⏹️ Stop Visualizer";
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
            constraint
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
        const audioContext = new (window.AudioContext ||
          window.webkitAudioContext)();

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
          device.label.toLowerCase().includes("system")
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
              device.label
            );
            return stream;
          } catch (error) {
            console.warn(
              `Failed to capture from device ${device.label}:`,
              error
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
      const audioContext = new (window.AudioContext ||
        window.webkitAudioContext)();

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
