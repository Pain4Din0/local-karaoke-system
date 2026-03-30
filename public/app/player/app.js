import { PrecisionAudioManager } from './audio-manager.js';
import { AMLLManager } from './amll-manager.js';
import { messages } from './messages.js';

const { createApp, ref, computed, nextTick } = window.Vue;
const socket = window.io();
const Artplayer = window.Artplayer;
let art = null;
let tickInterval = null;
let amllAnimFrame = null;

const audioManager = new PrecisionAudioManager();
const amllManager = new AMLLManager();

const isYouTubeMusic = (song) => {
    if (!song) return false;
    if (song.sourcePlatform === 'ytmusic') return true;
    return /music\.youtube\.com/i.test(song.originalUrl || '');
};


createApp({
    setup() {
        const lang = ref(localStorage.getItem('ktv_lang') || 'zh');
        const clearBrowserState = () => {
            localStorage.removeItem('ktv_lang');
        };
        const t = (key) => messages[lang.value] ? (messages[lang.value][key] || key) : key;

        const currentSong = ref(null);
        const showInfo = ref(false);
        const hasInteracted = ref(false);
        const isPlayingVideo = computed(() => currentSong.value && currentSong.value.status === 'ready');
        const isAMLLMode = computed(() => isPlayingVideo.value && isYouTubeMusic(currentSong.value));

        const networks = ref([{ name: 'Loading', ip: '...' }]);
        const currentNetIndex = ref(0);
        const systemSSID = ref('...');
        const systemPort = ref('8080');

        const currentNetwork = computed(() => networks.value[currentNetIndex.value] || networks.value[0]);

        const hud = ref({ show: false, icon: '', text: '' });
        const createLyricsState = (overrides = {}) => ({
            status: 'idle',
            data: null,
            ...overrides,
        });
        const lyricsState = ref(createLyricsState());
        let hudTimeout = null;

        const showHud = (icon, text) => {
            hud.value = { show: true, icon, text };
            if (hudTimeout) clearTimeout(hudTimeout);
            hudTimeout = setTimeout(() => {
                hud.value.show = false;
            }, 2000);
        };

        const logHud = (level, icon, text, payload) => {
            console[level]('[Player]', text, payload || '');
            showHud(icon, text);
        };

        // State variables for UI reporting
        let currentVolume = 0.8;
        let isVocalRemovalActive = false;
        let isLoudnessNormEnabled = true;
        let lyricsRequestId = 0;
        let lyricsEnabled = true;
        let lyricsSource = 'auto';
        let lyricsUtatenRomajiEnabled = false;
        let amllInitialized = false;
        let amllCoverRefreshed = false;

        const buildAMLLLocaleStrings = () => ({
            songwriterLabel: t('songwriter_label'),
            lyricsSearching: t('lyrics_searching'),
            lyricsSearchingHint: t('lyrics_searching_hint'),
            lyricsNotFound: t('lyrics_not_found'),
            lyricsNotFoundHint: t('lyrics_not_found_hint'),
            lyricsUnavailable: t('lyrics_unavailable'),
            lyricsUnavailableHint: t('lyrics_unavailable_hint'),
        });

        const syncAMLLLyricsState = (state = lyricsState.value) => {
            if (!amllInitialized) return;
            amllManager.setLocaleStrings(buildAMLLLocaleStrings());
            amllManager.setLyrics(state.status === 'ready' ? state.data : null);
            amllManager.setStatus(state.status);
        };

        const commitLyricsState = (nextState) => {
            lyricsState.value = nextState;
            syncAMLLLyricsState(nextState);
        };

        const resetLyricsState = () => {
            lyricsRequestId += 1;
            commitLyricsState(createLyricsState());
        };

        const setLyricsStatusState = (status) => {
            commitLyricsState(createLyricsState({
                status,
            }));
        };

        const applyLyricsData = (data) => {
            if (!data || !data.found || !Array.isArray(data.lines) || data.lines.length === 0) {
                setLyricsStatusState('empty');
                return;
            }
            commitLyricsState(createLyricsState({
                status: 'ready',
                data,
            }));
        };

        // ── AMLL synced lyrics overlay ────────────────

        const initAMLL = () => {
            if (amllInitialized) return;
            const appEl = document.getElementById('app');
            if (!appEl) return;
            amllManager.init(appEl);
            amllManager.setLocaleStrings(buildAMLLLocaleStrings());
            amllManager.setSeekHandler((seconds) => {
                if (!art) return;
                art.currentTime = seconds;
            });
            amllInitialized = true;
            syncAMLLLyricsState();
        };

        const startAMLL = (song) => {
            if (!isYouTubeMusic(song)) return;
            initAMLL();
            amllManager.setLocaleStrings(buildAMLLLocaleStrings());
            syncAMLLLyricsState();

            // Set metadata
            amllManager.setMeta(
                song.track || song.title || '',
                song.artist || song.uploader || ''
            );

            // Extract album art from video after it loads
            amllCoverRefreshed = false;
            // Instantly try setting cover from picUrl explicitly
            amllManager.setAlbumArt(null, song.pic);

            amllManager.show();

            // Move QR code into AMLL overlay
            nextTick(() => {
                const qrEl = document.getElementById('qrcode');
                if (qrEl) amllManager.moveQRCode(qrEl);
            });
        };

        const startAMLLSync = () => {
            stopAMLLSync();
            const tick = () => {
                if (art && art.video && amllInitialized) {
                    amllManager.setCurrentTime(getPlaybackTime());
                    amllManager.setLowFreqVolume(audioManager.getLowFrequencyEnergy());
                }
                amllAnimFrame = requestAnimationFrame(tick);
            };
            amllAnimFrame = requestAnimationFrame(tick);
        };

        const stopAMLLSync = () => {
            if (amllAnimFrame) {
                cancelAnimationFrame(amllAnimFrame);
                amllAnimFrame = null;
            }
        };

        const hideAMLL = () => {
            amllManager.hide();
            if (typeof amllManager.clearCover === 'function') amllManager.clearCover();
            amllManager.setLowFreqVolume(0);
            stopAMLLSync();
        };

        const getPlaybackTime = () => {
            if (!art || !art.video) return 0;
            const videoTime = Number(art.video.currentTime);
            if (Number.isFinite(videoTime)) return videoTime;
            const artTime = Number(art.currentTime);
            return Number.isFinite(artTime) ? artTime : 0;
        };

        const fetchLyrics = async (song) => {
            if (!song || !song.id || !lyricsEnabled) {
                resetLyricsState();
                return;
            }
            if (!isYouTubeMusic(song)) {
                resetLyricsState();
                return;
            }
            const requestId = ++lyricsRequestId;
            setLyricsStatusState('loading');
            try {
                const response = await fetch(`/api/lyrics/${song.id}?source=${encodeURIComponent(lyricsSource || 'auto')}`);
                if (!response.ok && response.status !== 404) {
                    throw new Error(`lyrics_http_${response.status}`);
                }
                const data = await response.json();
                if (requestId !== lyricsRequestId || !lyricsEnabled) return;
                applyLyricsData(data);
                if (!data?.found) {
                    console.warn('[Player] Lyrics not found for song:', song.title, data);
                }
            } catch (error) {
                if (requestId !== lyricsRequestId || !lyricsEnabled) return;
                console.warn('[Player] Failed to fetch lyrics for song:', song.title, error);
                setLyricsStatusState('error');
                showHud('ri-file-warning-line', t('lyrics_unavailable'));
            }
        };

        const applyLyricsSettings = (status) => {
            if (!status) return;
            const nextEnabled = status.lyricsEnabled !== undefined ? !!status.lyricsEnabled : lyricsEnabled;
            const nextSource = status.lyricsSource || lyricsSource || 'auto';
            const nextUtatenRomajiEnabled = status.lyricsUtatenRomajiEnabled !== undefined
                ? !!status.lyricsUtatenRomajiEnabled
                : lyricsUtatenRomajiEnabled;
            const changed = (
                nextEnabled !== lyricsEnabled
                || nextSource !== lyricsSource
                || nextUtatenRomajiEnabled !== lyricsUtatenRomajiEnabled
            );
            lyricsEnabled = nextEnabled;
            lyricsSource = nextSource;
            lyricsUtatenRomajiEnabled = nextUtatenRomajiEnabled;

            if (!lyricsEnabled) {
                resetLyricsState();
                return;
            }

            if (changed && currentSong.value && currentSong.value.status === 'ready') {
                if (isYouTubeMusic(currentSong.value)) {
                    fetchLyrics(currentSong.value);
                } else {
                    resetLyricsState();
                }
            }
        };


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
                        loudnessNorm: isLoudnessNormEnabled,
                        lyricsUtatenRomajiEnabled,
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
                try {
                    await art.switchUrl(videoUrl);
                } catch (error) {
                    logHud('error', 'ri-error-warning-line', t('song_failed'), error);
                    return;
                }

                // Reset state for new song
                isVocalRemovalActive = false;

                if (hasInteracted.value) {
                    audioManager.resume();
                    art.play().catch(() => { });
                    art.video.muted = true;
                }

                // Ensure heartbeat is running
                startHeartbeat();

                // Start AMLL sync if YouTube Music
                if (currentSong.value && isYouTubeMusic(currentSong.value)) {
                    if (art.video) {
                        const pic = currentSong.value?.pic;
                        setTimeout(() => {
                            if (art && art.video) {
                                amllManager.setAlbumArt(art.video, pic);
                            }
                        }, 1000);
                    }
                    startAMLLSync();
                    amllManager.setPlaying(true);
                }

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

                // Start AMLL sync if YouTube Music
                if (currentSong.value && isYouTubeMusic(currentSong.value)) {
                    // Re-trigger cover extraction in case startAMLL ran before art was created
                    if (art.video) {
                        const pic = currentSong.value?.pic;
                        amllManager.setAlbumArt(art.video, pic);
                        setTimeout(() => {
                            if (art && art.video) {
                                amllManager.setAlbumArt(art.video, pic);
                            }
                        }, 2000);
                    }
                    startAMLLSync();
                    amllManager.setPlaying(true);
                }
                socket.emit('player_tick', {
                    playing: true,
                    currentTime: 0,
                    duration: art.duration,
                    volume: currentVolume,
                    pitch: 0,
                    vocalRemoval: false,
                    loudnessNorm: isLoudnessNormEnabled,
                    lyricsUtatenRomajiEnabled,
                });
            });

            // ============================================================
            // VIDEO EVENT HANDLERS - Audio follows video precisely
            // ============================================================
            art.on('video:play', () => {
                console.log('[Video] Play at', art.currentTime.toFixed(2));
                audioManager.startPlayback(art.currentTime);
                if (isAMLLMode.value) amllManager.setPlaying(true);
            });

            art.on('video:pause', () => {
                console.log('[Video] Pause');
                audioManager.pause();
                if (isAMLLMode.value) amllManager.setPlaying(false);
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
                if (isAMLLMode.value) {
                    amllManager.seek(art.currentTime);
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
            applyLyricsSettings(state.playerStatus);

            if (newSong && newSong.status === 'ready') {
                const isSameSong = oldSong && oldSong.id === newSong.id;
                const wasReady = oldSong && oldSong.status === 'ready';

                if (!isSameSong || !wasReady || !art) {
                    // Hide AMLL from previous song
                    hideAMLL();

                    // New song - initialize player
                    initPlayer(
                        newSong.src,
                        newSong.audioSrc,
                        newSong.karaokeSrc || null,
                        newSong.loudnessGain,
                        newSong.id
                    );

                    // Start AMLL for YouTube Music sources
                    if (isYouTubeMusic(newSong)) {
                        fetchLyrics(newSong);
                        startAMLL(newSong);
                    } else {
                        resetLyricsState();
                    }

                    if (!isYouTubeMusic(newSong)) {
                        showInfo.value = true;
                        setTimeout(() => showInfo.value = false, 8000);
                    }
                } else if (isSameSong && newSong.karaokeReady && !audioManager.karaokeBuffer && newSong.karaokeSrc) {
                    // Karaoke just became ready - load it
                    audioManager.addKaraokeBuffer(newSong.karaokeSrc, newSong.id);
                    if (isYouTubeMusic(newSong) && newSong.lyricsStatus === 'ready' && !lyricsState.value.data) {
                        fetchLyrics(newSong);
                    }
                }
            } else if (newSong && newSong.status !== 'ready') {
                // Stop audio if switching to a song that is not ready (downloading/processing)
                if (oldSong && oldSong.id !== newSong.id) {
                    // FULL CLEANUP to prevent resuming
                    audioManager.cleanup();
                    if (art) art.pause(); // Also stop the video player
                }
                resetLyricsState();
                hideAMLL();
            } else if (!newSong) {
                // No song playing
                if (art) {
                    art.destroy();
                    art = null;
                }
                if (tickInterval) clearInterval(tickInterval);
                audioManager.cleanup();
                resetLyricsState();
                hideAMLL();
                if (hasInteracted.value) nextTick(() => generateQR());
            }
        });

        socket.on('update_progress', ({ id, progress }) => {
            if (currentSong.value && currentSong.value.id === id) {
                currentSong.value.progress = progress;
            }
        });

        socket.on('song_error', (payload) => {
            if (!payload || !currentSong.value || payload.id !== currentSong.value.id) return;
            logHud('error', 'ri-error-warning-line', t('song_failed'), payload);
        });

        socket.on('connect_error', (error) => {
            logHud('warn', 'ri-wifi-off-line', t('connection_lost'), error);
        });

        socket.on('disconnect', (reason) => {
            logHud('warn', 'ri-wifi-off-line', t('connection_lost'), reason);
        });

        socket.on('connect', () => {
            showHud('ri-wifi-line', t('connection_restored'));
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
            } else if (action.type === 'lyrics_toggle') {
                lyricsEnabled = !!action.value;
                if (!lyricsEnabled) resetLyricsState();
                else if (currentSong.value && currentSong.value.status === 'ready' && isYouTubeMusic(currentSong.value)) fetchLyrics(currentSong.value);
            } else if (action.type === 'lyrics_source') {
                lyricsSource = action.value || 'auto';
                if (lyricsEnabled && currentSong.value && currentSong.value.status === 'ready' && isYouTubeMusic(currentSong.value)) fetchLyrics(currentSong.value);
            } else if (action.type === 'cut') {
                showHud('ri-skip-forward-fill', t('skip'));
            } else if (action.type === 'clear_client_storage') {
                clearBrowserState();
                return;
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
                        loudnessNorm: isLoudnessNormEnabled,
                        lyricsEnabled,
                        lyricsSource,
                        lyricsUtatenRomajiEnabled,
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
            currentSong, isPlayingVideo, isAMLLMode, showInfo, hasInteracted, startInteraction,
            networks, currentNetwork, currentNetIndex, nextNetwork, systemSSID, systemPort,
            t, hud
        };
    }
}).mount('#app');
