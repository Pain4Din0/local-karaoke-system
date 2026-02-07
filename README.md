# Local Karaoke System

A robust, locally hosted karaoke solution that enables seamless queuing and playback of content from YouTube, Bilibili, and other supported platforms using `yt-dlp`. Designed for home entertainment and social gatherings, it features a dual-interface architecture with a dedicated **Player** for large screens and a mobile-optimized **Controller** for remote management.

> **Disclaimer**: The code for this project was written almost entirely by LLMs (including this sentence). I only performed prompt engineering and minor detail adjustments. Please perform full testing before use.

## ✨ Features

- **Universal Content Support**: Queue songs directly via URL from YouTube, Bilibili, and any platform supported by `yt-dlp`.
- **Intelligent Queue Management**:
  - **Priority Queuing**: Move urgent requests to the top.
  - **Auto-Play**: Automatically plays the next track.
  - **History & Re-Queue**: Quickly access and re-add previously played songs.
  - **Request Tracking**: Identifies who requested each song.
- **Dual-Interface System**:
  - **Player VIew**: A clean, distraction-free interface for TV or projector output.
  - **Controller View**: A responsive mobile web app for guests to search, queue, and control playback.
- **Automated Deployment**: The included `start.bat` handles all dependencies (Node.js, yt-dlp, FFmpeg) automatically.

## 🛠 Prerequisites

- **Operating System**: Windows 10/11
- **Network**: Active internet connection (required for media retrieval)

## 🚀 Installation & Usage

### 1. Quick Start
1.  **Clone or Download** this repository.
2.  **Run `start.bat`**.
    - The script will automatically configure a portable Node.js environment, download necessary binaries (`yt-dlp`, `ffmpeg`), install dependencies, and launch the server.

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

## 📄 License

This project is licensed under the GPLv3 License - see the `LICENSE` file for details.
