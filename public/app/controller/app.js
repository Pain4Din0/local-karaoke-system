import { messages } from './messages.js';

const { createApp, ref, computed, nextTick } = window.Vue;
const socket = window.io();

function throttle(func, limit) {
    let lastFunc, lastRan;
    return function () {
        const context = this, args = arguments;
        if (!lastRan) { func.apply(context, args); lastRan = Date.now(); }
        else { clearTimeout(lastFunc); lastFunc = setTimeout(function () { if ((Date.now() - lastRan) >= limit) { func.apply(context, args); lastRan = Date.now(); } }, limit - (Date.now() - lastRan)); }
    }
}

createApp({
    setup() {
        const lang = ref('zh');

        // Load saved language if available
        const savedLang = localStorage.getItem('ktv_lang');
        if (savedLang && messages[savedLang]) {
            lang.value = savedLang;
        }

        const t = (key) => messages[lang.value][key];
        const toggleLang = () => {
            const keys = Object.keys(messages);
            lang.value = keys[(keys.indexOf(lang.value) + 1) % keys.length];
            localStorage.setItem('ktv_lang', lang.value);
        };

        const nickname = ref(localStorage.getItem('ktv_nickname') || "");
        const tempNick = ref("");
        const isRenaming = ref(false);
        const playlist = ref([]);
        const history = ref([]);
        const currentPlaying = ref(null);
        const addUrl = ref("");
        const isAdding = ref(false);
        const activeTab = ref('playlist');
        const notifications = ref([]);

        const localPlaying = ref(false);
        const localCurrentTime = ref(0);
        const localDuration = ref(0);
        const localVolumeDisplay = ref(80);
        const localPitch = ref(0);
        const localVocalRemoval = ref(false);
        const localLoudnessNorm = ref(true); // Loudness normalization on by default
        const isDragging = ref(false);
        const showTuning = ref(false);
        const autoProcessKaraoke = ref(false);

        const karaokeAvailable = computed(() => currentPlaying.value && currentPlaying.value.karaokeReady);
        const lyricsSourceOptions = computed(() => ([
            { value: 'auto', label: t('lyrics_source_auto') },
            { value: 'sidecar', label: t('lyrics_source_sidecar') },
            { value: 'ytmusic', label: t('lyrics_source_ytmusic') },
            { value: 'youtube_captions', label: t('lyrics_source_youtube_captions') },
            { value: 'lrclib', label: t('lyrics_source_lrclib') },
        ]));

        const showShareModal = ref(false);
        const showPlaylistModal = ref(false);
        const showAdvancedSettings = ref(false);
        const advancedConfig = ref({
            ytdlp: { videoFormat: 'bestvideo[ext=mp4]/bestvideo', audioFormat: 'bestaudio[ext=m4a]/bestaudio', concurrentFragments: 16, httpChunkSize: '10M', noPlaylist: true, proxy: '', socketTimeout: 0, retries: 10, fragmentRetries: 10, userAgent: '', extractorArgs: '', postprocessorArgs: '', noCheckCertificates: false, limitRate: '', geoBypass: true, addHeader: [], mergeOutputFormat: '', flatPlaylist: true, dumpJson: true, noWarnings: false, ignoreErrors: false, abortOnError: false, noPart: false, restrictFilenames: false, windowsFilenames: false, noOverwrites: false, forceIPv4: false, forceIPv6: false },
            demucs: { model: 'htdemucs', twoStems: 'vocals', outputFormat: 'mp3', overlap: 0.25, segment: 7.8, shifts: 1, overlapOutput: false, float32: false, clipMode: 'rescale', noSegment: false, jobs: 0, device: '', repo: '' },
            ffmpeg: { loudnessI: -16, loudnessTP: -1.5, loudnessLRA: 11, loudnessGainClamp: 12 },
            system: { deleteDelayMs: 20000, maxConcurrentDownloads: 1 },
            lyrics: { enabled: true, source: 'auto' }
        });
        const playlistItems = ref([]);
        const selectedItems = ref(new Set()); // using Set for indices

        const networks = ref([{ name: 'Loading', ip: '...' }]);
        const currentNetIndex = ref(0);
        const systemSSID = ref('...');
        const systemPort = ref('8080');

        const currentNetwork = computed(() => networks.value[currentNetIndex.value] || networks.value[0]);
        const isAllSelected = computed(() => playlistItems.value.length > 0 && selectedItems.value.size === playlistItems.value.length);
        let notificationId = 0;
        const clearBrowserState = () => {
            ['ktv_lang', 'ktv_nickname', 'ktv_tutorial_completed'].forEach((key) => localStorage.removeItem(key));
        };

        const dismissNotification = (id) => {
            notifications.value = notifications.value.filter(item => item.id !== id);
        };

        const pushNotification = (message, type = 'error', timeoutMs = 4500) => {
            const text = typeof message === 'string'
                ? message
                : (message && typeof message.message === 'string' ? message.message : 'Operation failed');
            const item = { id: ++notificationId, text, type };
            notifications.value = [...notifications.value, item];
            setTimeout(() => dismissNotification(item.id), timeoutMs);
        };

        const logAndNotify = (message, payload, type = 'error', timeoutMs = 4500) => {
            console[type === 'error' ? 'error' : 'warn']('[Controller]', message, payload || '');
            pushNotification(message, type, timeoutMs);
        };


        const saveNickname = () => {
            if (!tempNick.value) return;
            nickname.value = tempNick.value;
            localStorage.setItem('ktv_nickname', nickname.value);
            isRenaming.value = false;

            // Check if tutorial should be shown
            if (!localStorage.getItem('ktv_tutorial_completed')) {
                startTutorial();
            }
        };
        const startRename = () => {
            tempNick.value = nickname.value;
            isRenaming.value = true;
        };
        const cancelRename = () => {
            isRenaming.value = false;
        };
        const formatTime = (seconds) => { if (!seconds || isNaN(seconds)) return "00:00"; const m = Math.floor(seconds / 60); const s = Math.floor(seconds % 60); return `${m}:${s.toString().padStart(2, '0')}`; };

        const addSong = () => {
            const nextUrl = String(addUrl.value || '').trim();
            if (!nextUrl) {
                pushNotification(t('pasteLink'));
                return;
            }
            addUrl.value = nextUrl;
            isAdding.value = true;
            socket.emit('parse_url', nextUrl);
        };

        const closePlaylistModal = (options = {}) => {
            const keepBusyState = !!options.keepBusyState;
            showPlaylistModal.value = false;
            playlistItems.value = [];
            selectedItems.value.clear();
            if (!keepBusyState) {
                isAdding.value = false;
            }
            addUrl.value = "";
        };

        const toggleItem = (index) => {
            if (selectedItems.value.has(index)) {
                selectedItems.value.delete(index);
            } else {
                selectedItems.value.add(index);
            }
        };

        const toggleSelectAll = () => {
            if (isAllSelected.value) {
                selectedItems.value.clear();
            } else {
                playlistItems.value.forEach((_, idx) => selectedItems.value.add(idx));
            }
        };

        const confirmAddBatch = () => {
            const songsToAdd = Array.from(selectedItems.value)
                .map(idx => playlistItems.value[idx])
                .filter(Boolean);
            if (songsToAdd.length > 0) {
                socket.emit('add_batch_songs', { songs: songsToAdd, requester: nickname.value });
                isAdding.value = true;
                closePlaylistModal({ keepBusyState: true });
            } else {
                pushNotification(t('select_songs_first'));
                closePlaylistModal();
            }
        };

        const manageQueue = (action, item) => socket.emit('manage_queue', { action, id: item.id });
        const shuffleQueue = () => socket.emit('shuffle_queue');
        const skipSong = () => socket.emit('next_song', { manual: true });
        const control = (type) => socket.emit('control_action', { type });
        const resetSystem = () => {
            if (confirm(t('reset_confirm'))) {
                socket.emit('system_reset');
            }
        };
        const factoryResetSystem = () => {
            if (confirm(t('factory_reset_confirm'))) {
                socket.emit('system_factory_reset');
            }
        };
        const reAddHistory = (item) => { socket.emit('readd_history', item); activeTab.value = 'playlist'; };

        const exportHistory = () => {
            let text = "\uFEFF=== PLAYLIST HISTORY ===\n\n";
            history.value.forEach((item, index) => { text += `${index + 1}. ${item.title}\n   UP: ${item.uploader} | BY: ${item.requester} | URL: ${item.originalUrl}\n\n`; });
            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `playlist_${new Date().toISOString().slice(0, 10)}.txt`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        };

        const sendSeek = (val) => socket.emit('control_action', { type: 'seek', value: val });
        const sendVolume = throttle((val) => socket.emit('control_action', { type: 'volume', value: val / 100 }), 100);
        const sendPitch = throttle((val) => socket.emit('control_action', { type: 'pitch', value: val }), 100);

        const onSeekInput = () => { isDragging.value = true; };

        // Tutorial Logic
        const showTutorialOverlay = ref(false);
        const tutorialStep = ref(1);

        const mockPlaying = ref(false);
        const mockVocalRemoved = ref(false);
        const mockProcessing = ref(false);
        const mockVolume = ref(80);
        const mockPitch = ref(0);
        const mockShowBatch = ref(false);
        const mockBatchList = ref([
            { title: '眩耀夜行', artist: 'スリーズブーケ', selected: true },
            { title: 'エウレカ', artist: '菅叶和', selected: true },
            { title: '自己肯定感爆上げ↑↑しゅきしゅきソング', artist: '藤田ことね (CV. 飯田ヒカル)', selected: true }
        ]);
        const mockBatchSelectedCount = computed(() => mockBatchList.value.filter(i => i.selected).length);
        const mockBatchAllSelected = computed({
            get: () => mockBatchList.value.length > 0 && mockBatchList.value.every(i => i.selected),
            set: (val) => mockBatchList.value.forEach(i => i.selected = val)
        });

        const startTutorial = () => {
            tutorialStep.value = 1;
            showTutorialOverlay.value = true;
        };

        const endTutorial = () => {
            showTutorialOverlay.value = false;
            localStorage.setItem('ktv_tutorial_completed', 'true');
        };

        const nextStep = () => {
            mockShowBatch.value = false;
            if (tutorialStep.value < 7) tutorialStep.value++;
        };

        const prevStep = () => {
            mockShowBatch.value = false;
            if (tutorialStep.value > 1) tutorialStep.value--;
        };

        const mockAction = (action) => {
            if (action === 'toggle_play') {
                mockPlaying.value = !mockPlaying.value;
            } else if (action === 'toggle_vocal') {
                if (!mockProcessing.value) {
                    if (mockVocalRemoved.value) {
                        mockVocalRemoved.value = false;
                    } else {
                        mockProcessing.value = true;
                        setTimeout(() => {
                            mockProcessing.value = false;
                            mockVocalRemoved.value = true;
                        }, 1500);
                    }
                }
            } else if (action === 'open_batch') {
                mockShowBatch.value = true;
            }
        };

        const restartTutorial = () => {
            isRenaming.value = false;
            startTutorial();
        };

        if (nickname.value && !localStorage.getItem('ktv_tutorial_completed')) {
            setTimeout(() => startTutorial(), 500);
        }
        const onSeekEnd = () => { isDragging.value = false; sendSeek(localCurrentTime.value); };
        const onVolumeInput = () => sendVolume(localVolumeDisplay.value);

        const changePitch = (delta) => {
            const newVal = Math.max(-12, Math.min(12, localPitch.value + delta));
            if (newVal !== localPitch.value) {
                localPitch.value = newVal;
                sendPitch(newVal);
            }
        };

        const resetPitch = () => {
            localPitch.value = 0;
            sendPitch(0);
        };

        const toggleVocalRemoval = () => {
            if (currentPlaying.value && currentPlaying.value.karaokeProcessing) return;
            localVocalRemoval.value = !localVocalRemoval.value;
            socket.emit('control_action', { type: 'vocal_removal', value: localVocalRemoval.value });
        };

        const toggleAutoProcess = () => {
            autoProcessKaraoke.value = !autoProcessKaraoke.value;
            socket.emit('set_auto_process', autoProcessKaraoke.value);
        };

        const toggleLoudnessNorm = () => {
            localLoudnessNorm.value = !localLoudnessNorm.value;
            socket.emit('control_action', { type: 'loudness_norm', value: localLoudnessNorm.value });
        };

        socket.on('system_info', (info) => {
            networks.value = info.networks;
            systemSSID.value = info.ssid;
            systemPort.value = info.port;
        });

        const openShare = () => {
            showShareModal.value = true;
            nextTick(() => generateQR());
        };

        const openAdvancedSettings = () => {
            showAdvancedSettings.value = true;
            socket.emit('get_advanced_config');
        };
        const closeAdvancedSettings = () => { showAdvancedSettings.value = false; };
        const saveAdvancedSettings = () => {
            socket.emit('set_advanced_config', advancedConfig.value);
        };
        const restoreAdvancedDefaults = () => {
            if (!confirm(t('restore_defaults_confirm'))) return;
            socket.emit('reset_advanced_config');
        };

        const nextNetwork = () => {
            if (networks.value.length <= 1) return;
            currentNetIndex.value = (currentNetIndex.value + 1) % networks.value.length;
            nextTick(() => generateQR());
        };

        const generateQR = () => {
            const container = document.getElementById('qrcode_mobile');
            if (container && currentNetwork.value.ip !== '...') {
                container.innerHTML = '';
                const url = `http://${currentNetwork.value.ip}:${systemPort.value}/controller.html`;
                new QRCode(container, {
                    text: url,
                    width: 200,
                    height: 200,
                    colorDark: "#000000",
                    colorLight: "#ffffff",
                    correctLevel: QRCode.CorrectLevel.L
                });
            }
        };

        socket.on('sync_state', (state) => {
            playlist.value = state.playlist;
            currentPlaying.value = state.currentPlaying;
            history.value = state.history;
            if (state.autoProcessKaraoke !== undefined) autoProcessKaraoke.value = state.autoProcessKaraoke;
            if (state.playerStatus) {
                if (state.playerStatus.vocalRemoval !== undefined) localVocalRemoval.value = state.playerStatus.vocalRemoval;
                if (state.playerStatus.pitch !== undefined) localPitch.value = state.playerStatus.pitch;
                if (state.playerStatus.volume !== undefined) localVolumeDisplay.value = Math.round(state.playerStatus.volume * 100);
                if (state.playerStatus.loudnessNorm !== undefined) localLoudnessNorm.value = state.playerStatus.loudnessNorm;
            }
        });
        socket.on('sync_tick', (status) => {
            localPlaying.value = status.playing;
            if (!isDragging.value) localCurrentTime.value = Math.floor(status.currentTime);
            localDuration.value = Math.floor(status.duration);
            if (Math.abs(localVolumeDisplay.value - Math.round(status.volume * 100)) > 2) localVolumeDisplay.value = Math.round(status.volume * 100);
            if (status.pitch !== undefined) localPitch.value = status.pitch;
            if (status.vocalRemoval !== undefined) localVocalRemoval.value = status.vocalRemoval;
            if (status.loudnessNorm !== undefined) localLoudnessNorm.value = status.loudnessNorm;
        });
        socket.on('update_progress', ({ id, progress }) => {
            const item = playlist.value.find(p => p.id === id); if (item) item.progress = progress;
            if (currentPlaying.value && currentPlaying.value.id === id) currentPlaying.value.progress = progress;
        });
        socket.on('karaoke_progress', ({ id, progress }) => {
            if (currentPlaying.value && currentPlaying.value.id === id) {
                currentPlaying.value.karaokeProgress = progress;
            }
            const item = playlist.value.find(p => p.id === id);
            if (item) item.karaokeProgress = progress;
        });
        socket.on('add_success', (payload) => {
            isAdding.value = false;
            addUrl.value = "";
            const count = Number(payload?.count || 0);
            if (count > 1) {
                pushNotification(`${count} songs added`, 'success', 2200);
            }
        });
        socket.on('error_msg', (msg) => {
            isAdding.value = false;
            logAndNotify(typeof msg === 'string' ? msg : (msg?.message || 'Operation failed'), msg, 'error');
        });
        socket.on('song_error', (payload) => {
            const title = payload && payload.title ? `${payload.title}: ` : '';
            logAndNotify(`${title}${payload?.message || 'Song processing failed'}`, payload, 'error', 6000);
        });
        socket.on('advanced_config', (config) => {
            if (config && typeof config === 'object') advancedConfig.value = config;
        });
        socket.on('advanced_config_saved', () => {
            closeAdvancedSettings();
        });

        socket.on('parse_result', (result) => {
            if (result && result.list) {
                if (result.list.length === 1) {
                    socket.emit('add_batch_songs', { songs: result.list, requester: nickname.value });
                } else {
                    playlistItems.value = result.list;
                    selectedItems.value = new Set(result.list.map((_, i) => i));
                    showPlaylistModal.value = true;
                    isAdding.value = false;
                }
            } else {
                isAdding.value = false;
                logAndNotify('Failed to parse URL', result, 'error');
            }
        });

        socket.on('connect_error', (error) => {
            logAndNotify(error?.message || 'Connection error', error, 'warn', 5000);
        });

        socket.on('disconnect', (reason) => {
            logAndNotify(`Connection lost: ${reason}`, { reason }, 'warn', 5000);
        });

        socket.on('connect', () => {
            pushNotification('Connected', 'success', 1800);
        });
        socket.on('exec_control', (action) => {
            if (!action || typeof action.type !== 'string') return;
            if (action.type === 'clear_client_storage') {
                clearBrowserState();
                return;
            }
            if (action.type === 'reload') {
                location.reload();
            }
        });

        const getQueueProgressStyle = (item) => {
            const progress = item.progress || 0;
            if (progress >= 100) return { width: '100%', transition: 'width 0.5s ease-out' };
            if (progress >= 80) return { width: '100%', transition: 'width 10s cubic-bezier(0.4, 0, 0.2, 1)' };
            return { width: `${progress}%`, transition: 'width 0.3s linear' };
        };

        return {
            nickname, tempNick, saveNickname,
            playlist, currentPlaying, history, activeTab,
            addUrl, isAdding,
            notifications, dismissNotification,
            localPlaying, localCurrentTime, localDuration, localVolumeDisplay, isDragging,
            addSong, manageQueue, shuffleQueue, skipSong, control, resetSystem, factoryResetSystem,
            reAddHistory, exportHistory,
            onSeekInput, onSeekEnd, onVolumeInput, formatTime,

            lang, t, toggleLang, isRenaming, startRename, cancelRename, restartTutorial,
            showShareModal, openShare, networks, currentNetwork, nextNetwork, systemSSID, systemPort,
            showTuning, changePitch, resetPitch, localPitch,
            localVocalRemoval, toggleVocalRemoval,
            localLoudnessNorm, toggleLoudnessNorm,
            lyricsSourceOptions,
            autoProcessKaraoke, toggleAutoProcess, karaokeAvailable,
            showPlaylistModal, playlistItems, selectedItems, isAllSelected,
            closePlaylistModal, toggleItem, toggleSelectAll, confirmAddBatch,
            showAdvancedSettings, advancedConfig, openAdvancedSettings, closeAdvancedSettings, saveAdvancedSettings, restoreAdvancedDefaults,
            getQueueProgressStyle,
            showTutorialOverlay, tutorialStep, startTutorial, endTutorial, nextStep, prevStep,
            mockPlaying, mockVocalRemoved, mockProcessing, mockVolume, mockPitch,
            mockShowBatch, mockAction, mockBatchList, mockBatchSelectedCount, mockBatchAllSelected
        };
    }
}).mount('#app');
