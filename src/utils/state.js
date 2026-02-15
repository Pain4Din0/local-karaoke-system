class StateStore {
    constructor() {
        this.playlist = [];
        this.history = [];
        this.currentPlaying = null;
        this.playerStatus = {
            playing: false,
            currentTime: 0,
            duration: 0,
            volume: 0.8,
            pitch: 0,
            vocalRemoval: false
        };
        this.isDownloading = false;
        this.autoProcessKaraoke = false;
        this.isProcessingKaraoke = false;
        this.currentDownloadingId = null;

        // Maps
        this.activeKaraokeProcesses = new Map(); // songId -> { proc, song }
        this.activeDownloads = new Map(); // songId -> proc

        // Socket.io instance
        this.io = null;
    }

    setIO(io) {
        this.io = io;
    }

    emitSync() {
        if (this.io) {
            this.io.emit('sync_state', {
                playlist: this.playlist,
                currentPlaying: this.currentPlaying,
                playerStatus: this.playerStatus,
                history: this.history,
                autoProcessKaraoke: this.autoProcessKaraoke
            });
        }
    }
}

module.exports = new StateStore();
