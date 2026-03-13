export class PrecisionAudioManager {
    constructor() {
        this.ctx = null;
        this.pitchNode = null;
        this.currentSessionId = 0;
        this.originalBuffer = null;
        this.karaokeBuffer = null;
        this.originalSource = null;
        this.karaokeSource = null;
        this.isPlaying = false;
        this.startOffset = 0;
        this.startContextTime = 0;
        this.isKaraokeMode = false;
        this.originalGain = null;
        this.karaokeGain = null;
        this.volumeGain = null;
        this.loudnessGain = null;
        this.volume = 0.8;
        this.loudnessAdjustment = 0;
        this.isLoudnessNormEnabled = true;
        this.CROSSFADE_TIME = 0.1;
        this.currentSongId = null;
        this.isLoadingKaraoke = false;
    }

    async init() {
        if (this.ctx) return;

        try {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            await this.ctx.audioWorklet.addModule('/app/audio/pitch-processor.js');
            this.pitchNode = new AudioWorkletNode(this.ctx, 'pitch-processor');

            this.originalGain = this.ctx.createGain();
            this.karaokeGain = this.ctx.createGain();
            this.volumeGain = this.ctx.createGain();
            this.loudnessGain = this.ctx.createGain();

            this.originalGain.gain.value = 1.0;
            this.karaokeGain.gain.value = 0.0;
            this.volumeGain.gain.value = this.volume;
            this.loudnessGain.gain.value = 1.0;

            this.originalGain.connect(this.volumeGain);
            this.karaokeGain.connect(this.volumeGain);
            this.volumeGain.connect(this.loudnessGain);
            this.loudnessGain.connect(this.pitchNode);
            this.pitchNode.connect(this.ctx.destination);

            window.audioCtx = this.ctx;
            window.pitchNode = this.pitchNode;

            console.log('[AudioManager] Initialized successfully');
        } catch (error) {
            console.error('[AudioManager] Init failed:', error);
        }
    }

    async loadBuffer(url) {
        if (!this.ctx) await this.init();
        const sessionId = this.currentSessionId;
        try {
            console.log('[AudioManager] Loading:', url);
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();

            if (this.currentSessionId !== sessionId) {
                console.log('[AudioManager] Load aborted (session changed):', url);
                return null;
            }

            const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
            console.log('[AudioManager] Decoded:', url, `(${audioBuffer.duration.toFixed(1)}s)`);
            return audioBuffer;
        } catch (error) {
            console.error('[AudioManager] Load failed:', url, error);
            return null;
        }
    }

    async loadSong(originalUrl, karaokeUrl, loudnessGain, songId) {
        this.currentSessionId += 1;
        const sessionId = this.currentSessionId;

        this.cleanup(false);
        this.currentSongId = songId;
        this.isLoadingKaraoke = false;
        this.loudnessAdjustment = loudnessGain || 0;
        this.isKaraokeMode = false;

        if (this.originalGain) this.originalGain.gain.value = 1.0;
        if (this.karaokeGain) this.karaokeGain.gain.value = 0.0;

        console.log(`[AudioManager] Loading song (Session ${sessionId})`);

        if (originalUrl) {
            const buffer = await this.loadBuffer(originalUrl);
            if (this.currentSessionId !== sessionId) return;
            this.originalBuffer = buffer;
        }

        if (karaokeUrl) {
            const buffer = await this.loadBuffer(karaokeUrl);
            if (this.currentSessionId !== sessionId) return;
            this.karaokeBuffer = buffer;
        }

        this.updateLoudness();
        this.updateVolume();
    }

    async addKaraokeBuffer(karaokeUrl, songId) {
        if (songId !== this.currentSongId) {
            console.warn('[AudioManager] Ignoring karaoke buffer for wrong song:', songId);
            return;
        }
        if (this.karaokeBuffer || this.isLoadingKaraoke || !karaokeUrl) return;

        this.isLoadingKaraoke = true;
        const sessionId = this.currentSessionId;

        try {
            const buffer = await this.loadBuffer(karaokeUrl);
            if (!buffer || this.currentSessionId !== sessionId || this.currentSongId !== songId) return;
            if (this.karaokeBuffer) return;

            this.karaokeBuffer = buffer;
            console.log('[AudioManager] Karaoke track added mid-playback');

            if (this.isPlaying && this.ctx) {
                const currentPos = this.getCurrentTime();
                if (this.karaokeSource) {
                    try { this.karaokeSource.stop(); } catch (error) { }
                    this.karaokeSource.disconnect();
                }

                this.karaokeSource = this.ctx.createBufferSource();
                this.karaokeSource.buffer = this.karaokeBuffer;
                this.karaokeSource.connect(this.karaokeGain);
                this.karaokeSource.start(0, currentPos);

                console.log('[AudioManager] Karaoke source hot-started at:', currentPos.toFixed(2));

                if (this.isKaraokeMode) {
                    this.switchMode(true);
                }
            }
        } finally {
            this.isLoadingKaraoke = false;
        }
    }

    startPlayback(offset) {
        if (!this.ctx || !this.originalBuffer) return;

        this.stopSources();
        const maxDuration = Math.max(
            this.originalBuffer?.duration || 0,
            this.karaokeBuffer?.duration || 0
        );
        offset = Math.max(0, Math.min(offset, maxDuration - 0.1));

        this.startOffset = offset;
        this.startContextTime = this.ctx.currentTime;
        this.isPlaying = true;

        if (this.originalBuffer) {
            this.originalSource = this.ctx.createBufferSource();
            this.originalSource.buffer = this.originalBuffer;
            this.originalSource.connect(this.originalGain);
            this.originalSource.start(0, offset);
        }

        if (this.karaokeBuffer) {
            this.karaokeSource = this.ctx.createBufferSource();
            this.karaokeSource.buffer = this.karaokeBuffer;
            this.karaokeSource.connect(this.karaokeGain);
            this.karaokeSource.start(0, offset);
        }

        console.log('[AudioManager] Started at:', `${offset.toFixed(2)}s`);
    }

    stopSources() {
        if (this.originalSource) {
            try { this.originalSource.stop(); } catch (error) { }
            this.originalSource.disconnect();
            this.originalSource = null;
        }
        if (this.karaokeSource) {
            try { this.karaokeSource.stop(); } catch (error) { }
            this.karaokeSource.disconnect();
            this.karaokeSource = null;
        }
        this.isPlaying = false;
    }

    pause() {
        this.stopSources();
    }

    seek(newTime) {
        if (!this.isPlaying) {
            this.startOffset = newTime;
            return;
        }
        this.startPlayback(newTime);
    }

    switchMode(useKaraoke) {
        if (!this.ctx) return;
        if (useKaraoke && !this.karaokeBuffer) {
            console.warn('[AudioManager] Cannot switch to karaoke: buffer not ready');
            return;
        }

        this.isKaraokeMode = useKaraoke;
        const now = this.ctx.currentTime;

        if (useKaraoke) {
            this.originalGain.gain.cancelScheduledValues(now);
            this.originalGain.gain.setValueAtTime(this.originalGain.gain.value, now);
            this.originalGain.gain.linearRampToValueAtTime(0.0, now + this.CROSSFADE_TIME);

            this.karaokeGain.gain.cancelScheduledValues(now);
            this.karaokeGain.gain.setValueAtTime(this.karaokeGain.gain.value, now);
            this.karaokeGain.gain.linearRampToValueAtTime(1.0, now + this.CROSSFADE_TIME);
        } else {
            this.originalGain.gain.cancelScheduledValues(now);
            this.originalGain.gain.setValueAtTime(this.originalGain.gain.value, now);
            this.originalGain.gain.linearRampToValueAtTime(1.0, now + this.CROSSFADE_TIME);

            this.karaokeGain.gain.cancelScheduledValues(now);
            this.karaokeGain.gain.setValueAtTime(this.karaokeGain.gain.value, now);
            this.karaokeGain.gain.linearRampToValueAtTime(0.0, now + this.CROSSFADE_TIME);
        }

        console.log('[AudioManager] Mode:', useKaraoke ? 'Karaoke' : 'Original');
    }

    setVolume(value) {
        this.volume = value;
        this.updateVolume();
    }

    updateVolume() {
        if (this.volumeGain && this.ctx) {
            this.volumeGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
        }
    }

    setLoudnessNorm(enabled) {
        this.isLoudnessNormEnabled = enabled;
        this.updateLoudness();
    }

    updateLoudness() {
        if (!this.loudnessGain || !this.ctx) return;
        const linearGain = this.isLoudnessNormEnabled
            ? Math.pow(10, this.loudnessAdjustment / 20)
            : 1.0;
        this.loudnessGain.gain.setValueAtTime(linearGain, this.ctx.currentTime);
    }

    setPitch(semitones) {
        if (this.pitchNode && this.ctx) {
            const param = this.pitchNode.parameters.get('pitch');
            if (param) {
                param.setValueAtTime(semitones, this.ctx.currentTime);
            }
        }
    }

    async resume() {
        if (this.ctx && this.ctx.state === 'suspended') {
            await this.ctx.resume();
        }
    }

    cleanup(incrementSession = true) {
        if (incrementSession) {
            this.currentSessionId += 1;
        }
        this.stopSources();
        this.originalBuffer = null;
        this.karaokeBuffer = null;
        this.isKaraokeMode = false;
        this.startOffset = 0;
    }

    getCurrentTime() {
        if (!this.isPlaying || !this.ctx) return this.startOffset;
        return this.startOffset + (this.ctx.currentTime - this.startContextTime);
    }
}
