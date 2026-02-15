const { createApp, ref, computed, nextTick, watch } = Vue;
const socket = io();
let art = null;
let tickInterval = null;

// ============================================================
// PRECISION AUDIO MANAGER - AudioBuffer-based Sync System
// ============================================================
// This replaces the old HTML Audio element approach.
// Audio is decoded into memory buffers and scheduled with
// sample-accurate precision using Web Audio API.
// Video element is the SINGLE source of truth for playback time.
// ============================================================

class PrecisionAudioManager {
    constructor() {
        this.ctx = null;
        this.pitchNode = null;

        // Session management for async ops
        this.currentSessionId = 0;

        // AudioBuffers (decoded audio data in memory)
        this.originalBuffer = null;
        this.karaokeBuffer = null;

        // Active source nodes (recreated on each play/seek)
        this.originalSource = null;
        this.karaokeSource = null;

        // Playback state tracking
        this.isPlaying = false;
        this.startOffset = 0;         // Audio offset when playback started
        this.startContextTime = 0;    // AudioContext.currentTime when playback started

        // Audio mode
        this.isKaraokeMode = false;

        // Gain nodes (persistent across playback)
        this.originalGain = null;
        this.karaokeGain = null;
        this.volumeGain = null;
        this.loudnessGain = null;

        // Settings
        this.volume = 0.8;
        this.loudnessAdjustment = 0;  // dB
        this.isLoudnessNormEnabled = true;

        // Crossfade settings
        this.CROSSFADE_TIME = 0.1;    // 100ms crossfade

        // Active song ID validation
        this.currentSongId = null;
        this.isLoadingKaraoke = false;
    }

    // Initialize AudioContext and processing chain
    async init() {
        if (this.ctx) return;

        try {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();

            // Load pitch processor worklet
            await this.ctx.audioWorklet.addModule('pitch-processor.js');
            this.pitchNode = new AudioWorkletNode(this.ctx, 'pitch-processor');

            // Create gain nodes
            this.originalGain = this.ctx.createGain();
            this.karaokeGain = this.ctx.createGain();
            this.volumeGain = this.ctx.createGain();
            this.loudnessGain = this.ctx.createGain();

            // Initial gain values
            this.originalGain.gain.value = 1.0;
            this.karaokeGain.gain.value = 0.0;
            this.volumeGain.gain.value = this.volume;
            this.loudnessGain.gain.value = 1.0;

            // Connect processing chain:
            // [OriginalGain + KaraokeGain] -> VolumeGain -> LoudnessGain -> PitchNode -> Destination
            this.originalGain.connect(this.volumeGain);
            this.karaokeGain.connect(this.volumeGain);
            this.volumeGain.connect(this.loudnessGain);
            this.loudnessGain.connect(this.pitchNode);
            this.pitchNode.connect(this.ctx.destination);

            // Expose globally for pitch control
            window.audioCtx = this.ctx;
            window.pitchNode = this.pitchNode;

            console.log('[AudioManager] Initialized successfully');
        } catch (e) {
            console.error('[AudioManager] Init failed:', e);
        }
    }

    // Decode audio file URL into AudioBuffer
    async loadBuffer(url) {
        if (!this.ctx) await this.init();
        const sessionId = this.currentSessionId; // Capture session ID at start
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
        } catch (e) {
            console.error('[AudioManager] Load failed:', url, e);
            return null;
        }
    }

    // Load both original and karaoke buffers for a song
    async loadSong(originalUrl, karaokeUrl, loudnessGain, songId) {
        // Increment session ID to invalidate any pending loads from previous songs
        this.currentSessionId++;
        const sessionId = this.currentSessionId;

        this.cleanup(false); // Cleanup but don't increment session ID again

        this.currentSongId = songId;
        this.isLoadingKaraoke = false; // Reset lock on new song
        this.loudnessAdjustment = loudnessGain || 0;
        this.isKaraokeMode = false;

        // Reset gain states
        if (this.originalGain) this.originalGain.gain.value = 1.0;
        if (this.karaokeGain) this.karaokeGain.gain.value = 0.0;

        console.log(`[AudioManager] Loading song (Session ${sessionId})`);

        // Load original buffer
        if (originalUrl) {
            const buffer = await this.loadBuffer(originalUrl);
            if (this.currentSessionId !== sessionId) return;
            this.originalBuffer = buffer;
        }

        // Load karaoke buffer if available
        if (karaokeUrl) {
            const buffer = await this.loadBuffer(karaokeUrl);
            if (this.currentSessionId !== sessionId) return;
            this.karaokeBuffer = buffer;

            // Hot-start: If we are already playing and in karaoke mode (or if we want to be ready),
            // we might need to start this source. 
            // But usually loadSong is called BEFORE playback starts for a new song.
            // The 'addKaraokeBuffer' method handles the mid-playback case.
        }

        this.updateLoudness();
        this.updateVolume();
    }

    // Add karaoke track after it becomes ready (mid-playback)
    async addKaraokeBuffer(karaokeUrl, songId) {
        if (songId !== this.currentSongId) {
            console.warn('[AudioManager] Ignoring karaoke buffer for wrong song:', songId);
            return;
        }
        if (this.karaokeBuffer || this.isLoadingKaraoke) return; // Already loaded or loading
        if (!karaokeUrl) return;

        this.isLoadingKaraoke = true;
        const sessionId = this.currentSessionId;

        try {
            const buffer = await this.loadBuffer(karaokeUrl);

            if (!buffer || this.currentSessionId !== sessionId || this.currentSongId !== songId) return;

            // Double-check if loaded while we were waiting
            if (this.karaokeBuffer) return;

            this.karaokeBuffer = buffer;
            console.log('[AudioManager] Karaoke track added mid-playback');

            // If currently playing, start the karaoke source immediately synchronized
            if (this.isPlaying && this.ctx) {
                const currentPos = this.getCurrentTime();

                // Safety check: ensure no existing source
                if (this.karaokeSource) {
                    try { this.karaokeSource.stop(); } catch (e) { }
                    this.karaokeSource.disconnect();
                }

                // Create new source
                this.karaokeSource = this.ctx.createBufferSource();
                this.karaokeSource.buffer = this.karaokeBuffer;
                this.karaokeSource.connect(this.karaokeGain);

                // Sync start
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

    // Start or resume playback from a specific time offset
    startPlayback(offset) {
        if (!this.ctx || !this.originalBuffer) return;

        // Stop any existing sources
        this.stopSources();

        // Clamp offset to valid range
        const maxDuration = Math.max(
            this.originalBuffer?.duration || 0,
            this.karaokeBuffer?.duration || 0
        );
        offset = Math.max(0, Math.min(offset, maxDuration - 0.1));

        this.startOffset = offset;
        this.startContextTime = this.ctx.currentTime;
        this.isPlaying = true;

        // Create and start original source
        if (this.originalBuffer) {
            this.originalSource = this.ctx.createBufferSource();
            this.originalSource.buffer = this.originalBuffer;
            this.originalSource.connect(this.originalGain);
            this.originalSource.start(0, offset);
        }

        // Create and start karaoke source (if available)
        if (this.karaokeBuffer) {
            this.karaokeSource = this.ctx.createBufferSource();
            this.karaokeSource.buffer = this.karaokeBuffer;
            this.karaokeSource.connect(this.karaokeGain);
            this.karaokeSource.start(0, offset);
        }

        console.log('[AudioManager] Started at:', offset.toFixed(2) + 's');
    }

    // Stop all active sources (for pause/seek)
    stopSources() {
        if (this.originalSource) {
            try { this.originalSource.stop(); } catch (e) { }
            this.originalSource.disconnect(); // Disconnect for GC
            this.originalSource = null;
        }
        if (this.karaokeSource) {
            try { this.karaokeSource.stop(); } catch (e) { }
            this.karaokeSource.disconnect(); // Disconnect for GC
            this.karaokeSource = null;
        }
        this.isPlaying = false;
    }

    // Pause playback
    pause() {
        this.stopSources();
    }

    // Seek to a new position (stop and restart at new offset)
    seek(newTime) {
        if (!this.isPlaying) {
            // Not playing, just update offset for next play
            this.startOffset = newTime;
            return;
        }
        // Stop current playback and restart at new position
        this.startPlayback(newTime);
    }

    // Switch between original and karaoke mode with crossfade
    switchMode(useKaraoke) {
        if (!this.ctx) return;

        // Safety check: Don't switch to karaoke if no buffer
        if (useKaraoke && !this.karaokeBuffer) {
            console.warn('[AudioManager] Cannot switch to karaoke: buffer not ready');
            return;
        }

        this.isKaraokeMode = useKaraoke;
        const now = this.ctx.currentTime;

        if (useKaraoke) {
            // Crossfade to karaoke
            this.originalGain.gain.cancelScheduledValues(now);
            this.originalGain.gain.setValueAtTime(this.originalGain.gain.value, now);
            this.originalGain.gain.linearRampToValueAtTime(0.0, now + this.CROSSFADE_TIME);

            this.karaokeGain.gain.cancelScheduledValues(now);
            this.karaokeGain.gain.setValueAtTime(this.karaokeGain.gain.value, now);
            this.karaokeGain.gain.linearRampToValueAtTime(1.0, now + this.CROSSFADE_TIME);
        } else {
            // Crossfade to original
            this.originalGain.gain.cancelScheduledValues(now);
            this.originalGain.gain.setValueAtTime(this.originalGain.gain.value, now);
            this.originalGain.gain.linearRampToValueAtTime(1.0, now + this.CROSSFADE_TIME);

            this.karaokeGain.gain.cancelScheduledValues(now);
            this.karaokeGain.gain.setValueAtTime(this.karaokeGain.gain.value, now);
            this.karaokeGain.gain.linearRampToValueAtTime(0.0, now + this.CROSSFADE_TIME);
        }

        console.log('[AudioManager] Mode:', useKaraoke ? 'Karaoke' : 'Original');
    }

    // Update volume gain
    setVolume(value) {
        this.volume = value;
        this.updateVolume();
    }

    updateVolume() {
        if (this.volumeGain && this.ctx) {
            this.volumeGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
        }
    }

    // Update loudness normalization
    setLoudnessNorm(enabled) {
        this.isLoudnessNormEnabled = enabled;
        this.updateLoudness();
    }

    updateLoudness() {
        if (!this.loudnessGain || !this.ctx) return;
        const linearGain = this.isLoudnessNormEnabled ?
            Math.pow(10, this.loudnessAdjustment / 20) : 1.0;
        this.loudnessGain.gain.setValueAtTime(linearGain, this.ctx.currentTime);
    }

    // Set pitch shift
    setPitch(semitones) {
        if (this.pitchNode && this.ctx) {
            const param = this.pitchNode.parameters.get('pitch');
            if (param) {
                param.setValueAtTime(semitones, this.ctx.currentTime);
            }
        }
    }

    // Resume AudioContext if suspended (browser autoplay policy)
    async resume() {
        if (this.ctx && this.ctx.state === 'suspended') {
            await this.ctx.resume();
        }
    }

    // Complete cleanup for song change
    cleanup(incrementSession = true) {
        if (incrementSession) {
            this.currentSessionId++;
        }
        this.stopSources();
        this.originalBuffer = null;
        this.karaokeBuffer = null;
        this.isKaraokeMode = false;
        this.startOffset = 0;
    }

    // Get current playback position (for UI sync verification only)
    getCurrentTime() {
        if (!this.isPlaying || !this.ctx) return this.startOffset;
        return this.startOffset + (this.ctx.currentTime - this.startContextTime);
    }
}

// Global audio manager instance
const audioManager = new PrecisionAudioManager();

const messages = {
    en: {
        init_system: "Click to Initialize System",
        label_video: "Video",
        label_audio: "Audio",
        label_processing: "Processing",
        click_qr_switch: "Click QR to Switch",
        current_network: "Current Network",
        connect_via: "Connect via URL",
        host_ssid: "Host SSID",
        requested_by: "Requested By",
        skip: "Skipped",
        replay: "Replay",
        paused: "Paused",
        playing: "Playing",
        loudness_on: "Loudness On",
        loudness_off: "Loudness Off",
        key_change: "Key",
        karaoke_not_ready: "Karaoke Not Ready",
        forward: "Forward",
        rewind: "Rewind",
        vocal_on: "Vocals On",
        vocal_off: "Vocals Off"
    },
    zh: {
        init_system: "点击初始化系统",
        label_video: "视频",
        label_audio: "音频",
        label_processing: "处理",
        click_qr_switch: "点击二维码切换网络",
        current_network: "当前网络",
        connect_via: "连接地址",
        host_ssid: "主机 SSID",
        requested_by: "点歌人",
        skip: "已切歌",
        replay: "重播",
        paused: "已暂停",
        playing: "播放中",
        loudness_on: "响度均衡 开",
        loudness_off: "响度均衡 关",
        key_change: "变调",
        karaoke_not_ready: "伴奏未就绪",
        forward: "快进",
        rewind: "快退",
        vocal_on: "原唱 开",
        vocal_off: "原唱 关"
    },
    ja: {
        init_system: "クリックしてシステムを初期化",
        label_video: "映像",
        label_audio: "音声",
        label_processing: "処理",
        click_qr_switch: "QRをクリックして切り替え",
        current_network: "現在のネットワーク",
        connect_via: "接続URL",
        host_ssid: "ホストSSID",
        requested_by: "リクエスト",
        skip: "スキップ",
        replay: "もう一度",
        paused: "一時停止",
        playing: "再生中",
        loudness_on: "ラウドネス ON",
        loudness_off: "ラウドネス OFF",
        key_change: "キー",
        karaoke_not_ready: "インスト未準備",
        forward: "早送り",
        rewind: "巻き戻し",
        vocal_on: "ボーカル ON",
        vocal_off: "ボーカル OFF"
    }
};


createApp({
    setup() {
        const lang = ref(localStorage.getItem('ktv_lang') || 'zh');
        const t = (key) => messages[lang.value] ? (messages[lang.value][key] || key) : key;

        const currentSong = ref(null);
        const showInfo = ref(false);
        const hasInteracted = ref(false);
        const systemInfo = ref({ ssid: 'Loading...', url: 'Loading...', ip: '' });
        const isPlayingVideo = computed(() => currentSong.value && currentSong.value.status === 'ready');

        const networks = ref([{ name: 'Loading', ip: '...' }]);
        const currentNetIndex = ref(0);
        const systemSSID = ref('...');
        const systemPort = ref('8080');

        const currentNetwork = computed(() => networks.value[currentNetIndex.value] || networks.value[0]);

        const hud = ref({ show: false, icon: '', text: '' });
        let hudTimeout = null;

        const showHud = (icon, text) => {
            hud.value = { show: true, icon, text };
            if (hudTimeout) clearTimeout(hudTimeout);
            hudTimeout = setTimeout(() => {
                hud.value.show = false;
            }, 2000);
        };

        // State variables for UI reporting
        let currentVolume = 0.8;
        let isVocalRemovalActive = false;
        let isLoudnessNormEnabled = true;


        const nextNetwork = () => {
            if (networks.value.length <= 1) return;
            currentNetIndex.value = (currentNetIndex.value + 1) % networks.value.length;
            nextTick(() => generateQR());
        };

        const startInteraction = () => {
            hasInteracted.value = true;
            audioManager.init().then(() => {
                audioManager.resume();
                if (art) {
                    art.play().catch(() => { });
                }
            });

            if (document.documentElement.requestFullscreen) {
                document.documentElement.requestFullscreen().catch(() => { });
            }
            nextTick(() => generateQR());
        };

        const generateQR = () => {
            const container = document.getElementById('qrcode');
            if (container && currentNetwork.value.ip !== '...') {
                container.innerHTML = '';
                const url = `http://${currentNetwork.value.ip}:${systemPort.value}/controller.html`;
                new QRCode(container, {
                    text: url,
                    width: 220,
                    height: 220,
                    colorDark: "#000000",
                    colorLight: "#ffffff",
                    correctLevel: QRCode.CorrectLevel.L
                });
            }
        };

        // ============================================================
        // HEARTBEAT - Reports player state to controller
        // No longer performs sync corrections (audio is sample-accurate)
        // ============================================================
        const startHeartbeat = () => {
            if (tickInterval) clearInterval(tickInterval);
            tickInterval = setInterval(() => {
                if (art && art.video) {
                    const currentPitch = window.pitchNode?.parameters?.get('pitch')?.value || 0;
                    socket.emit('player_tick', {
                        playing: !art.video.paused,
                        currentTime: art.currentTime,
                        duration: art.duration,
                        volume: currentVolume,
                        pitch: currentPitch,
                        vocalRemoval: isVocalRemovalActive,
                        loudnessNorm: isLoudnessNormEnabled
                    });
                }
            }, 250); // 250ms interval (just for UI, not sync)
        };

        // ============================================================
        // PLAYER INITIALIZATION
        // Video is master clock, audio follows via events
        // ============================================================
        const initPlayer = async (videoUrl, audioSrc, karaokeSrc, loudnessGain, songId) => {
            // Load audio buffers first (decode into memory)
            await audioManager.loadSong(audioSrc, karaokeSrc, loudnessGain, songId);

            if (art) {
                // Reuse existing player to maintain fullscreen status
                console.log('[Player] Switching video URL');
                await art.switchUrl(videoUrl);

                // Reset state for new song
                isVocalRemovalActive = false;

                if (hasInteracted.value) {
                    audioManager.resume();
                    art.play().catch(() => { });
                    art.video.muted = true;
                }

                // Ensure heartbeat is running
                startHeartbeat();

                return;
            }

            // Create video player
            // We set fullscreen: false to disable the default control and add our own
            art = new Artplayer({
                container: '#artplayer',
                url: videoUrl,
                autoplay: true,
                volume: 0.8,
                muted: true,
                isLive: false,
                autoSize: false,
                fullscreen: false,
                theme: '#ffffff',
                controls: [
                    {
                        name: 'fullscreen',
                        index: 100,
                        position: 'right',
                        html: '<div class="art-control-icon"><i class="ri-fullscreen-line text-xl"></i></div>',
                        tooltip: 'Fullscreen',
                        click: function () {
                            if (document.fullscreenElement) {
                                document.exitFullscreen();
                            } else {
                                document.getElementById('app').requestFullscreen();
                            }
                        },
                        mounted: function ($el) {
                            const updateIcon = () => {
                                const isFull = !!document.fullscreenElement;
                                $el.innerHTML = isFull
                                    ? '<div class="art-control-icon"><i class="ri-fullscreen-exit-line text-xl"></i></div>'
                                    : '<div class="art-control-icon"><i class="ri-fullscreen-line text-xl"></i></div>';
                            };
                            document.addEventListener('fullscreenchange', updateIcon);
                            updateIcon();
                        }
                    }
                ],
            });

            art.on('video:ended', () => socket.emit('next_song'));

            art.on('ready', () => {
                if (hasInteracted.value) {
                    audioManager.resume();
                    art.play().catch(() => { });
                    art.video.muted = true;
                }

                // Reset mode on new song
                isVocalRemovalActive = false;

                startHeartbeat();
                socket.emit('player_tick', {
                    playing: true,
                    currentTime: 0,
                    duration: art.duration,
                    volume: currentVolume,
                    pitch: 0,
                    vocalRemoval: false,
                    loudnessNorm: isLoudnessNormEnabled
                });
            });

            // ============================================================
            // VIDEO EVENT HANDLERS - Audio follows video precisely
            // ============================================================
            art.on('video:play', () => {
                console.log('[Video] Play at', art.currentTime.toFixed(2));
                audioManager.startPlayback(art.currentTime);
            });

            art.on('video:pause', () => {
                console.log('[Video] Pause');
                audioManager.pause();
            });

            art.on('video:seeked', () => {
                console.log('[Video] Seeked to', art.currentTime.toFixed(2));
                // Only restart if video is playing
                if (!art.video.paused) {
                    audioManager.seek(art.currentTime);
                } else {
                    // Just update the offset for when play resumes
                    audioManager.startOffset = art.currentTime;
                }
            });

            // Handle video stalling/buffering (rare, but handle gracefully)
            art.on('video:waiting', () => {
                console.log('[Video] Buffering...');
                audioManager.pause();
            });

            art.on('video:playing', () => {
                console.log('[Video] Resumed from buffer');
                audioManager.startPlayback(art.currentTime);
            });
        };

        // Socket handlers
        socket.on('system_info', (info) => {
            networks.value = info.networks;
            systemSSID.value = info.ssid;
            systemPort.value = info.port;
            if (!isPlayingVideo.value && hasInteracted.value) {
                nextTick(() => generateQR());
            }
        });

        socket.on('sync_state', (state) => {
            const newSong = state.currentPlaying;
            const oldSong = currentSong.value;
            currentSong.value = newSong;

            if (newSong && newSong.status === 'ready') {
                const isSameSong = oldSong && oldSong.id === newSong.id;
                const wasReady = oldSong && oldSong.status === 'ready';

                if (!isSameSong || !wasReady || !art) {
                    // New song - initialize player
                    initPlayer(
                        newSong.src,
                        newSong.audioSrc,
                        newSong.karaokeSrc || null,
                        newSong.loudnessGain,
                        newSong.id
                    );
                    showInfo.value = true;
                    setTimeout(() => showInfo.value = false, 8000);
                } else if (isSameSong && newSong.karaokeReady && !audioManager.karaokeBuffer && newSong.karaokeSrc) {
                    // Karaoke just became ready - load it
                    audioManager.addKaraokeBuffer(newSong.karaokeSrc, newSong.id);
                }
            } else if (newSong && newSong.status !== 'ready') {
                // Stop audio if switching to a song that is not ready (downloading/processing)
                if (oldSong && oldSong.id !== newSong.id) {
                    // FULL CLEANUP to prevent resuming
                    audioManager.cleanup();
                    if (art) art.pause(); // Also stop the video player
                }
            } else if (!newSong) {
                // No song playing
                if (art) {
                    art.destroy();
                    art = null;
                }
                if (tickInterval) clearInterval(tickInterval);
                audioManager.cleanup();
                if (hasInteracted.value) nextTick(() => generateQR());
            }
        });

        socket.on('update_progress', ({ id, progress }) => {
            if (currentSong.value && currentSong.value.id === id) {
                currentSong.value.progress = progress;
            }
        });

        // ============================================================
        // CONTROL HANDLER - Responds to controller commands
        // ============================================================
        socket.on('exec_control', (action) => {
            // Update internal state regardless of player readiness
            if (action.type === 'volume') {
                currentVolume = action.value;
                audioManager.setVolume(action.value);
                const vol = Math.round(action.value * 100);
                showHud(vol === 0 ? 'ri-volume-mute-line' : (vol < 50 ? 'ri-volume-down-line' : 'ri-volume-up-line'), `${vol}%`);
            } else if (action.type === 'loudness_norm') {
                isLoudnessNormEnabled = action.value;
                audioManager.setLoudnessNorm(action.value);
                showHud('ri-equalizer-line', action.value ? t('loudness_on') : t('loudness_off'));
            } else if (action.type === 'cut') {
                showHud('ri-skip-forward-fill', t('skip'));
            }

            if (!art) return;

            switch (action.type) {
                case 'toggle':
                    art.toggle();
                    // Audio will follow via play/pause events
                    // State might not be updated yet, trusting toggle
                    // FIXED: Show status AFTER toggle (paused means it IS paused)
                    showHud(art.video.paused ? 'ri-pause-fill' : 'ri-play-fill', art.video.paused ? t('paused') : t('playing'));
                    break;

                case 'seek':
                    // Just set video time - audio follows via 'seeked' event
                    art.currentTime = action.value;
                    showHud('ri-movie-line', formatTime(action.value));
                    break;

                // Volume handled above

                case 'seek_fwd':
                    art.forward = 5;
                    // Audio follows via 'seeked' event
                    showHud('ri-forward-5-line', '+5s ' + t('forward'));
                    break;

                case 'seek_rew':
                    art.backward = 5;
                    // Audio follows via 'seeked' event
                    showHud('ri-replay-5-line', '-5s ' + t('rewind'));
                    break;

                case 'replay':
                    art.currentTime = 0;
                    art.play();
                    // Audio follows via seek + play events
                    showHud('ri-restart-line', t('replay'));
                    break;

                case 'reload':
                    location.reload();
                    break;

                case 'pitch':
                    audioManager.setPitch(action.value);
                    showHud('ri-music-2-line', `${t('key_change')} ${action.value > 0 ? '+' : ''}${action.value}`);
                    break;

                case 'vocal_removal':
                    if (currentSong.value?.karaokeReady && currentSong.value?.karaokeSrc) {
                        isVocalRemovalActive = action.value;
                        audioManager.switchMode(action.value);
                        showHud(action.value ? 'ri-mic-off-line' : 'ri-mic-line', action.value ? t('vocal_off') : t('vocal_on'));
                    } else if (action.value) {
                        showHud('ri-error-warning-line', t('karaoke_not_ready'));
                    } else {
                        isVocalRemovalActive = false;
                        audioManager.switchMode(false);
                        showHud('ri-mic-line', t('vocal_on'));
                    }
                    break;

                // Loudness handled above
            }

            // Send immediate tick after control action
            setTimeout(() => {
                const currentPitch = window.pitchNode?.parameters?.get('pitch')?.value || 0;
                if (art) {
                    socket.emit('player_tick', {
                        playing: !art.video.paused,
                        currentTime: art.currentTime,
                        duration: art.duration,
                        volume: currentVolume,
                        pitch: currentPitch,
                        vocalRemoval: isVocalRemovalActive,
                        loudnessNorm: isLoudnessNormEnabled
                    });
                }
            }, 50);
        });

        const formatTime = (seconds) => {
            const m = Math.floor(seconds / 60);
            const s = Math.floor(seconds % 60);
            return `${m}:${s.toString().padStart(2, '0')}`;
        };

        return {
            currentSong, isPlayingVideo, showInfo, hasInteracted, startInteraction,
            networks, currentNetwork, currentNetIndex, nextNetwork, systemSSID, systemPort,
            t, hud
        };
    }
}).mount('#app');
