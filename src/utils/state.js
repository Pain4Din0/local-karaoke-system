const DEFAULT_PLAYER_STATUS = Object.freeze({
    playing: false,
    currentTime: 0,
    duration: 0,
    volume: 0.8,
    pitch: 0,
    vocalRemoval: false,
    loudnessNorm: true,
    lyricsEnabled: true,
    lyricsSource: 'auto',
});

class StateStore {
    constructor() {
        this.io = null;
        this.resetRuntimeState();
    }

    createDefaultPlayerStatus() {
        return JSON.parse(JSON.stringify(DEFAULT_PLAYER_STATUS));
    }

    resetRuntimeState() {
        this.playlist = [];
        this.history = [];
        this.currentPlaying = null;
        this.playerStatus = this.createDefaultPlayerStatus();
        this.isDownloading = false;
        this.autoProcessKaraoke = false;
        this.isProcessingKaraoke = false;
        this.currentDownloadingId = null;
        this.activeKaraokeProcesses = new Map(); // songId -> { proc, song }
        this.activeDownloads = new Map(); // songId -> proc
    }

    getAllSongs() {
        return [
            this.currentPlaying,
            ...this.playlist,
            ...this.history,
        ].filter(Boolean);
    }

    setIO(io) {
        this.io = io;
    }

    buildSyncPayload() {
        return {
            playlist: this.playlist,
            currentPlaying: this.currentPlaying,
            playerStatus: this.playerStatus,
            history: this.history,
            autoProcessKaraoke: this.autoProcessKaraoke,
        };
    }

    emitSync() {
        if (this.io) {
            this.io.emit('sync_state', this.buildSyncPayload());
        }
    }
}

module.exports = new StateStore();
