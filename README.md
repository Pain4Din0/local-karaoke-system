# Local Karaoke System

A simple, locally hosted karaoke system that allows you to queue and play songs from YouTube and other supported platforms using `yt-dlp`. Designed for home parties and small gatherings, it features a separate player view and a controller interface for mobile devices.

## Features

- **Queue Songs via URL**: Supports YouTube, Bilibili, and other platforms supported by `yt-dlp`.
- **Playback Control**: Play, pause, seek, and volume control.
- **Queue Management**:
  - Auto-play next song.
  - Priority queuing (Move to top).
  - Delete songs from queue.
  - History tracking with quick re-add function.
- **Multi-Device Support**:
  - **Player View**: Dedicated for the TV or projector.
  - **Controller View**: Optimize for mobile devices to control the playlist remotely.
- **Automatic Setup**: `start.bat` handles dependency checks and installation (Node.js, yt-dlp, FFmpeg).

## Prerequisites

- **OS**: Windows (tested on Windows 10/11).
- **Internet**: Required for downloading songs.

## Installation & Usage

1.  **Clone or Download** this repository.
2.  **Run `start.bat`**.
    - This script will automatically:
        - Download portable Node.js if not installed.
        - Download latest `yt-dlp.exe` and `ffmpeg`.
        - Install necessary npm dependencies (`express`, `socket.io`).
        - Start the server.
3.  **Open the Player**:
    - The script should automatically open `http://localhost:8080/player.html` in your default browser. Move this window to your TV or projector screen.
4.  **Connect a Controller**:
    - Ensure your mobile device is on the **same Wi-Fi network** as the PC.
    - Check the server console output or find your PC's local IP address (e.g., `192.168.1.X`).
    - Open `http://<YOUR_LOCAL_IP>:8080/` in your mobile browser.

## Technologies Used

- **Node.js**: Runtime environment.
- **Express**: Web server.
- **Socket.io**: Real-time communication between player and controller.
- **yt-dlp**: Media downloading.
- **FFmpeg**: Media processing.

## License

This project is licensed under the GPLv3 License - see the `LICENSE` file for details.
