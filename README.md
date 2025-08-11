# 🎵 Audio Visualizer

A modern, reactive audio visualizer built with HTML5 Canvas and Web Audio API that creates stunning visual representations of audio in real-time.

## Features

- **Real-time Audio Input**: Microphone input with live visualization
- **Audio File Upload**: Support for various audio formats (MP3, WAV, OGG, etc.)
- **Music Streaming**: Stream directly from YouTube, Spotify, and Apple Music links

- **Volume Control**: Adjustable volume slider for all audio sources
- **Multiple Visual Modes**: Bars, waveform, circular, and particle effects
- **Adjustable Sensitivity**: Fine-tune the visualization response
- **Responsive Design**: Works on desktop and mobile devices

## 🚀 Getting Started

### Prerequisites

- Modern web browser with Web Audio API support
- Microphone access (for live audio visualization)
- Audio files (for file-based visualization)

### Installation

1. Clone or download this repository
2. Open `index.html` in your web browser
3. Allow microphone permissions when prompted
4. Start visualizing audio!

## 📱 Usage

### Using Microphone

1. Click the **"🎤 Start Microphone"** button
2. Allow microphone access when prompted
3. Speak, sing, or play music near your microphone
4. Watch the real-time visualization!

### Using Audio Files

1. Click the **"📁 Upload Audio"** button
2. Select an audio file from your device
3. The file will automatically start playing and visualizing
4. Visualization stops when the audio ends

## Using Music Streaming

1. Click the **"🎵 Stream Music"** button
2. Enter a URL from YouTube, Spotify, or Apple Music
3. Click **"Start Stream"** to begin visualization
4. The visualizer will create a demo audio stream based on the platform
5. Enjoy the visualization for 15 seconds (demo duration)

### Customizing Visualization

- **Change Visualization Type**: Use the dropdown to switch between modes
- **Adjust Sensitivity**: Use the slider to make visualizations more or less responsive
- **Real-time Info**: Monitor frequency and volume levels below the canvas

## 🔧 Technical Details

### Technologies Used

- **HTML5 Canvas**: For high-performance graphics rendering
- **Web Audio API**: For real-time audio analysis
- **CSS3**: For modern styling and animations
- **Vanilla JavaScript**: No external dependencies
- **Streaming Service**: Platform detection and URL validation for music services

### Audio Analysis

- **FFT Size**: 256 samples for optimal performance
- **Smoothing**: 0.8 time constant for smooth transitions
- **Frequency Range**: 0-22kHz (depending on sample rate)
- **Update Rate**: 60 FPS for smooth animations

### Browser Compatibility

- ✅ Chrome 66+
- ✅ Firefox 60+
- ✅ Safari 14+
- ✅ Edge 79+

### Supported Streaming Platforms

- 🎥 **YouTube**: Music videos, live streams, and audio content
- 🎵 **Spotify**: Individual tracks, albums, and playlists
- 🍎 **Apple Music**: Songs, albums, and curated playlists

## 🎨 Visualization Modes Explained

### Frequency Bars

- Each bar represents a frequency band
- Bar height corresponds to frequency intensity
- Colors shift based on frequency values
- Includes glow effects for enhanced visuals

### Waveform

- Shows real-time audio waveform
- Includes mirror effect for symmetry
- Smooth line rendering with anti-aliasing
- Responsive to audio amplitude

### Circular

- Multiple expanding circles
- Circle size based on frequency intensity
- Color and opacity variations
- Creates hypnotic ripple effects

### Particles

- 100 animated particles
- Particles connect based on audio levels
- Dynamic movement and bouncing
- Color-coded connections

## 🛠️ Customization

### Adding New Visualization Modes

1. Add new option to the HTML select element
2. Implement new drawing method in the `AudioVisualizer` class
3. Add case to the `draw()` method switch statement

### Modifying Colors and Effects

- Edit CSS variables for theme colors
- Modify canvas drawing methods for visual effects
- Adjust particle parameters in `createParticles()`

### Performance Optimization

- Reduce FFT size for better performance
- Limit particle count on mobile devices
- Use `requestAnimationFrame` for smooth animations

## 🐛 Troubleshooting

### Microphone Not Working

- Check browser permissions
- Ensure microphone is not used by other applications
- Try refreshing the page
- Check browser console for error messages

### Audio File Issues

- Ensure file format is supported (MP3, WAV, OGG, etc.)
- Check file size (very large files may cause delays)
- Verify file is not corrupted

### Performance Issues

- Reduce canvas size
- Lower FFT size
- Close other browser tabs
- Use less complex visualization modes

## 📄 License

This project is open source and available under the [MIT License](LICENSE).

## 🤝 Contributing

Contributions are welcome! Feel free to:

- Add new visualization modes
- Improve performance
- Enhance the UI/UX
- Fix bugs
- Add new features

## 📞 Support

If you encounter any issues or have questions:

1. Check the troubleshooting section
2. Review browser console for error messages
3. Ensure your browser supports Web Audio API
4. Try different audio sources

---

**Enjoy creating beautiful audio visualizations! 🎵✨**
