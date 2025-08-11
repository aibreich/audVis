/**
 * Streaming Service for Audio Visualizer
 * Handles YouTube, Spotify, and Apple Music streaming
 */

class StreamingService {
  constructor() {
    this.supportedPlatforms = {
      youtube: {
        domains: ["youtube.com", "youtu.be", "www.youtube.com"],
        apiKey: null, // YouTube API key would be needed for full functionality
        patterns: [
          /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/,
          /youtube\.com\/embed\/([a-zA-Z0-9_-]+)/,
          /youtube\.com\/v\/([a-zA-Z0-9_-]+)/,
        ],
      },
      spotify: {
        domains: ["spotify.com", "open.spotify.com"],
        clientId: null, // Spotify Client ID would be needed for full functionality
        patterns: [
          /spotify\.com\/track\/([a-zA-Z0-9]+)/,
          /spotify\.com\/album\/([a-zA-Z0-9]+)/,
          /spotify\.com\/playlist\/([a-zA-Z0-9]+)/,
        ],
      },
      appleMusic: {
        domains: ["music.apple.com", "itunes.apple.com"],
        patterns: [
          /music\.apple\.com\/[a-z]{2}\/album\/[^\/]+\/(\d+)/,
          /itunes\.apple\.com\/[a-z]{2}\/album\/[^\/]+\/(\d+)/,
        ],
      },
    };
  }

  /**
   * Detect the platform from a URL
   * @param {string} url - The URL to analyze
   * @returns {Object|null} - Platform info or null if unsupported
   */
  detectPlatform(url) {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.toLowerCase();

      for (const [platform, config] of Object.entries(
        this.supportedPlatforms
      )) {
        if (config.domains.some((domain) => hostname.includes(domain))) {
          return {
            platform,
            url: url,
            hostname: hostname,
            config: config,
          };
        }
      }

      return null;
    } catch (error) {
      console.error("Invalid URL:", error);
      return null;
    }
  }

  /**
   * Extract media ID from URL
   * @param {string} url - The URL to extract from
   * @param {Object} platformInfo - Platform information
   * @returns {string|null} - Media ID or null if not found
   */
  extractMediaId(url, platformInfo) {
    const { config } = platformInfo;

    for (const pattern of config.patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * Validate YouTube URL and extract video ID
   * @param {string} url - YouTube URL
   * @returns {Object} - Validation result with video ID
   */
  validateYouTubeUrl(url) {
    const platformInfo = this.detectPlatform(url);
    if (!platformInfo || platformInfo.platform !== "youtube") {
      return { valid: false, error: "Not a valid YouTube URL" };
    }

    const videoId = this.extractMediaId(url, platformInfo);
    if (!videoId) {
      return { valid: false, error: "Could not extract video ID" };
    }

    return { valid: true, videoId, platformInfo };
  }

  /**
   * Validate Spotify URL and extract track/album/playlist ID
   * @param {string} url - Spotify URL
   * @returns {Object} - Validation result with media ID
   */
  validateSpotifyUrl(url) {
    const platformInfo = this.detectPlatform(url);
    if (!platformInfo || platformInfo.platform !== "spotify") {
      return { valid: false, error: "Not a valid Spotify URL" };
    }

    const mediaId = this.extractMediaId(url, platformInfo);
    if (!mediaId) {
      return { valid: false, error: "Could not extract media ID" };
    }

    return { valid: true, mediaId, platformInfo };
  }

  /**
   * Validate Apple Music URL and extract album ID
   * @param {string} url - Apple Music URL
   * @returns {Object} - Validation result with album ID
   */
  validateAppleMusicUrl(url) {
    const platformInfo = this.detectPlatform(url);
    if (!platformInfo || platformInfo.platform !== "appleMusic") {
      return { valid: false, error: "Not a valid Apple Music URL" };
    }

    const albumId = this.extractMediaId(url, platformInfo);
    if (!albumId) {
      return { valid: false, error: "Could not extract album ID" };
    }

    return { valid: true, albumId, platformInfo };
  }

  /**
   * Get platform-specific metadata (for demo purposes)
   * @param {string} url - The URL to get metadata for
   * @returns {Promise<Object>} - Metadata object
   */
  async getMetadata(url) {
    const platformInfo = this.detectPlatform(url);
    if (!platformInfo) {
      throw new Error("Unsupported platform");
    }

    const mediaId = this.extractMediaId(url, platformInfo);
    if (!mediaId) {
      throw new Error("Could not extract media ID");
    }

    // Simulate metadata retrieval
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          platform: platformInfo.platform,
          mediaId: mediaId,
          title: `Sample ${platformInfo.platform} Track`,
          artist: "Unknown Artist",
          duration: "3:45",
          thumbnail: null,
        });
      }, 1000);
    });
  }

  /**
   * Create a robust demo audio stream for visualization
   * @param {string} platform - The platform name
   * @param {string} mediaId - The media ID
   * @returns {Promise<Object>} - Audio context and analyzer
   */
  async createDemoStream(platform, mediaId) {
    return new Promise(async (resolve, reject) => {
      try {
        // Create audio context
        const audioContext = new (window.AudioContext ||
          window.webkitAudioContext)();

        // Resume audio context (required for modern browsers)
        if (audioContext.state === "suspended") {
          await audioContext.resume();
        }

        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;

        // Create a more complex and robust demo audio pattern
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        const filterNode = audioContext.createBiquadFilter();
        const compressor = audioContext.createDynamicsCompressor();

        // Set up compressor for better audio quality
        compressor.threshold.setValueAtTime(-24, audioContext.currentTime);
        compressor.knee.setValueAtTime(30, audioContext.currentTime);
        compressor.ratio.setValueAtTime(12, audioContext.currentTime);
        compressor.attack.setValueAtTime(0.003, audioContext.currentTime);
        compressor.release.setValueAtTime(0.25, audioContext.currentTime);

        // Connect nodes properly
        oscillator.connect(filterNode);
        filterNode.connect(compressor);
        compressor.connect(gainNode);
        gainNode.connect(analyser);
        analyser.connect(audioContext.destination);

        // Set up filter for more interesting audio
        filterNode.type = "lowpass";
        filterNode.frequency.setValueAtTime(1000, audioContext.currentTime);
        filterNode.Q.setValueAtTime(1, audioContext.currentTime);

        // Create a musical pattern with proper timing
        const frequencies = [440, 494, 523, 587, 659, 698, 784, 880];
        const currentTime = audioContext.currentTime;
        const noteDuration = 0.5;
        const noteGap = 0.1;

        // Schedule notes with proper timing
        frequencies.forEach((freq, index) => {
          const startTime = currentTime + index * (noteDuration + noteGap);
          const endTime = startTime + noteDuration;

          // Set frequency
          oscillator.frequency.setValueAtTime(freq, startTime);

          // Set gain envelope
          gainNode.gain.setValueAtTime(0, startTime);
          gainNode.gain.linearRampToValueAtTime(0.3, startTime + 0.01);
          gainNode.gain.exponentialRampToValueAtTime(0.01, endTime);

          // Add filter variation
          filterNode.frequency.setValueAtTime(freq * 2, startTime);
          filterNode.frequency.exponentialRampToValueAtTime(
            freq * 0.5,
            endTime
          );
        });

        // Add some variation to the pattern
        filterNode.frequency.setValueAtTime(500, currentTime + 2);
        filterNode.frequency.setValueAtTime(2000, currentTime + 4);

        // Start the oscillator
        oscillator.start(currentTime);

        // Stop after the pattern completes
        const totalDuration = frequencies.length * (noteDuration + noteGap);
        oscillator.stop(currentTime + totalDuration);

        resolve({
          audioContext,
          analyser,
          oscillator,
          gainNode,
          filterNode,
          compressor,
          startTime: currentTime,
          duration: totalDuration,
          // Expose gain node for volume control
          volumeGain: gainNode,
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop demo stream
   * @param {Object} stream - Stream objects to stop
   */
  stopDemoStream(stream) {
    try {
      if (stream.oscillator) {
        stream.oscillator.stop();
      }

      if (stream.audioContext && stream.audioContext.state !== "closed") {
        stream.audioContext.close();
      }
    } catch (error) {
      console.error("Error stopping stream:", error);
    }
  }
}

// Export for use in main script
if (typeof module !== "undefined" && module.exports) {
  module.exports = StreamingService;
} else {
  window.StreamingService = StreamingService;
}
