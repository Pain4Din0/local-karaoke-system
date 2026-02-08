# Local Karaoke System

A robust, locally hosted karaoke solution that enables seamless queuing and playback of content from YouTube, Bilibili, and other supported platforms using `yt-dlp`. Designed for home entertainment and social gatherings, it features a dual-interface architecture with a dedicated **Player** for large screens and a mobile-optimized **Controller** for remote management.

> **Disclaimer**: The code for this project was written almost entirely by LLMs (including this sentence). I only performed prompt engineering and minor detail adjustments. Please perform full testing before use.

## ✨ Features

- **Universal Content Support**: Queue songs directly via URL from YouTube, Bilibili, and any platform supported by `yt-dlp`.
- **Playlist & Batch Import**: Seamless import of **Bilibili Favorites/Collections** and **YouTube Playlists**. Select multiple tracks to queue in bulk.
- **AI-Powered Vocal Removal**: Remove vocals from any song using [Demucs](https://github.com/facebookresearch/demucs) for studio-quality karaoke. Enable auto-processing to prepare instrumental tracks as songs are queued.
- **Intelligent Queue System**:
  - **Sequential Downloading**: Strict one-at-a-time downloading prevents bandwidth congestion and ensures stability.
  - **Robust Deletion**: Instantly terminates active downloads and cleans up files when a song is removed.
  - **Priority Queuing**: Move urgent requests to the top.
  - **Auto-Play & History**: Automatically plays the next track and allows quick re-queuing.
- **Dual-Interface System**:
  - **Player VIew**: A clean, distraction-free interface for TV or projector output.
  - **Controller View**: A responsive mobile web app for guests to search, queue, and control playback.
- **Automated Deployment**: The included `start.bat` handles all dependencies (Node.js, yt-dlp, FFmpeg, Demucs) automatically.

## 🛠 Prerequisites

- **Operating System**: Windows 10/11 (64-bit)
- **Network**: Active internet connection (required for first-run setup and media retrieval)

> **Note**: All runtime dependencies (Node.js, Python, yt-dlp, FFmpeg, Demucs) are automatically downloaded and configured on first run. No pre-installation required.

## 🚀 Installation & Usage

### 1. Quick Start
1.  **Clone or Download** this repository.
2.  **Run `start.bat`**.
    - On first run, you'll be prompted to select a download source:
      - **[1] China Mainland**: Uses mirrors (npmmirror, Huawei Cloud, Aliyun) for faster downloads in China.
      - **[2] International**: Uses official sources (nodejs.org, python.org, github.com).
    - The script will automatically set up a complete portable environment including Node.js, Python, yt-dlp, FFmpeg, and all required dependencies.
    - Your choice is saved and won't be asked again. Delete `.mirror_config` to reset.

### 2. Connect Interfaces
-   **Player (Host)**:
    - The script automatically opens `http://localhost:8080/player.html`. Move this window to your TV or projector.
-   **Controller (Remote)**:
    1.  Ensure your mobile device is on the **same Wi-Fi network** as the host PC.
    2.  Locate your PC's local IP address (displayed in the console output).
    3.  Open `http://<YOUR_LOCAL_IP>:8080/` in your mobile browser.

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

## 📄 License

This project is licensed under the GPLv3 License - see the `LICENSE` file for details.
