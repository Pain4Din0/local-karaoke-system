# Local Karaoke System

A robust, locally hosted karaoke solution that enables seamless queuing and playback of content from YouTube, Bilibili, and other supported platforms using `yt-dlp`. Designed for home entertainment and social gatherings, it features a dual-interface architecture with a dedicated **Player** for large screens and a mobile-optimized **Controller** for remote management.

> **Disclaimer**: The code for this project was written almost entirely by LLMs (including this sentence). I only performed prompt engineering and minor detail adjustments. Please perform full testing before use.

## ✨ Features

- **Universal Content Support**: Queue songs directly via URL from YouTube, Bilibili, and any platform supported by `yt-dlp`.
- **Pro Audio Experience**:
  - **AI Vocal Removal**: Real-time source separation using [Demucs](https://github.com/facebookresearch/demucs).
  - **Pitch Shifting (Beta)**: Adjust key in real-time to match your vocal range.
  - **Seamless Crossfade**: Smooth transitions between original and karaoke tracks.
  - **Loudness Normalization**: Consistent volume levels across different sources.
- **Interactive UX**:
  - **Smart Controller**: Mobile-first interface with intuitive status indicators and interactive tutorials for new users.
  - **Batch Import**: One-click import for Bilibili Collections and YouTube Playlists.
- **Intelligent Queue System**:
  - **Reliable Downloading**: Sequential processing queue with auto-retry and robust error handling.
  - **Priority Management**: Move urgent requests to the top of the queue.
- **Automated Deployment**: The included `start.bat` handles all dependencies (Node.js, yt-dlp, FFmpeg, Demucs) automatically.

## 🛠 Prerequisites

To ensure optimal performance and stability, we recommend setting up the following environment manually before running the system.

### System Requirements
- **Operating System**: Windows 10/11 (64-bit)
- **Network**: Active internet connection (for fetching media content)

### Dependencies
The system relies on the following core components. Please install them and ensure they are accessible via your system's PATH:

- **[Node.js](https://nodejs.org/)** (Runtime Environment): Powers the web server and application logic.
- **[Python](https://www.python.org/)** (3.10+): Required for AI vocal separation (Demucs).
- **[FFmpeg](https://ffmpeg.org/)** (Multimedia Framework): Handles audio/video processing.
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** (Media Downloader): Extracts content from streaming platforms.
- **[Visual C++ Redistributable](https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist)**: Often required for Python and media libraries to run correctly.

> **Note on Automated Setup**: The included `start.bat` script is designed to automatically check for these dependencies and attempt a portable installation if they are missing. However, **we strongly advise against relying solely on this feature**, as network restrictions or mirror availability may cause failures.

## 🚀 Installation & Usage

### 1. Quick Start
1.  **Clone or Download** this repository.
2.  **Run `start.bat`**.
    - On first run, you'll be prompted to select a download source:
      - **[1] China Mainland**: Uses mirrors (npmmirror, Huawei Cloud, Aliyun) for faster downloads in China.
      - **[2] Original**: Uses official sources (nodejs.org, python.org, github.com).
    - The script will automatically set up a complete portable environment including Node.js, Python, yt-dlp, FFmpeg, and all required dependencies.
    - Your choice is saved and won't be asked again. Delete `.mirror_config` to reset.

### 2. Connect Interfaces
-   **Player (Host)**:
    - The script automatically opens `http://localhost:<PORT>/player.html` (Port is randomly assigned). Move this window to your TV or projector.
-   **Controller (Remote)**:
    1.  Ensure your mobile device is on the **same Wi-Fi network** as the host PC.
    2.  Locate your PC's local IP address and **Port** (displayed in the console output or Player screen).
    3.  Open `http://<YOUR_LOCAL_IP>:<PORT>/` in your mobile browser.

## 🍪 Advanced Configuration: Platform Cookies

To access premium content (1080p+), age-restricted videos, or bypass platform verification, you can provide `Netscape HTTP Cookie File` formatted cookies.

### Supported Platforms
- **YouTube**: Save as `cookies_youtube.txt`
- **Bilibili**: Save as `cookies_bilibili.txt`

### Setup Instructions
Place the cookie files directly in the **root directory** of the project. The system will automatically detect and utilize them.

> [!WARNING]
> **Security Notice**
> 1.  **Sensitive Data**: These files contain active session tokens. Possession of these files grants full access to your account.
> 2.  **Git Safety**: Ensure these files are **never committed** to version control. An updated `.gitignore` is included to prevent accidental tracking.
> 3.  **Risk Mitigation**: Using personal cookies with third-party tools may violate Terms of Service.

## 🏗 Technologies Used

-   **Node.js**: Backend Runtime
-   **Express**: Web Server Framework
-   **Socket.io**: Real-time State Synchronization
-   **yt-dlp**: Media Extraction Engine
-   **FFmpeg**: Media Processing
-   **Python**: AI Processing Runtime
-   **Demucs**: AI-Powered Audio Source Separation
-   **Web Audio API**: Precision Audio Processing
-   **Driver.js**: Interactive User Guides

## 📄 License

This project is licensed under the GPLv3 License - see the `LICENSE` file for details.
