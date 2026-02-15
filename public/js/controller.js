const { createApp, ref, computed, nextTick } = Vue;
const socket = io();

// Messages and Localization
const messages = {
    en: {
        enterName: "Enter Nickname",
        join: "Join System",
        playlist: "Queue",
        history: "History",
        pasteLink: "Paste Link (Bilibili/YouTube)",
        queue: "Up Next",
        export: "Export List",
        idle: "Ready to play",
        join_warn: "Please enter a name first",
        reset_confirm: "Are you sure you want to reset the system? This will clear all playlists and history.",
        modify_nick: "Modify Nickname",
        save: "Save",
        cancel: "Cancel",
        tuning: "Audio Settings",
        volume: "Volume",
        pitch: "Key Shift",
        reset: "Reset",
        vocal_removal: "Vocal Remover",
        vocal_on: "Vocals On",
        vocal_off: "Vocals Off",
        vocal_hint: "Processing may take 1-2 minutes",
        vocal_warning: "Uses Demucs AI model. May cause high system load. First-time model loading might be slow (stuck at 99%), please wait.",
        vocal_unavailable: "Not Available",
        processing: "Processing",
        ready: "Ready",
        click_to_process: "Click to process",
        start_process: "Remove Vocals",
        auto_process: "Auto-process new songs",
        auto_process_hint: "Automatically prepare instrumental tracks",
        shuffle: "Shuffle",
        loudness_norm: "Loudness Normalization",
        select_songs: "Select Songs",
        select_all: "Select All",
        selected: "selected",
        add_selected: "Add Selected",
        select_songs_first: "Select at least one song",
        tutorial_restart: "Show Tutorial",
        advanced_settings: "Advanced Settings",
        restore_defaults: "Restore default settings",
        restore_defaults_confirm: "Restore all advanced settings to defaults? Current values will be lost.",
        // Tutorial Steps
        tut_start_btn: "Get Started",
        tut_welcome_title: "Welcome!",
        tut_welcome_desc: "Let's take a quick tour to learn how to use the Local Karaoke System.",
        tut_interface_title: "Main Interface",
        tut_interface_desc: "This is your main control center.",
        tut_add_title: "Add Songs",
        tut_add_desc: "Paste Bilibili or YouTube links here. We support single videos, Favorites, and Playlists!",
        tut_add_hint: "Supports Bilibili Favorites & YouTube Playlists",
        click_to_see_batch: "Click to simulate batch import",
        tut_status_title: "Status Indicators",
        tut_status_desc: "Understand what each color means.",
        status_downloading: "Blinking Blue",
        status_downloading_desc: "Downloading content...",
        status_ready: "Solid Blue",
        status_ready_desc: "Downloaded. Ready to play (original audio).",
        status_processing: "Blinking Purple",
        status_processing_desc: "Separating vocals (making instrumental)...",
        status_full_ready: "Solid Purple",
        status_full_ready_desc: "Instrumental track is ready!",
        tut_audio_title: "Audio Settings",
        tut_audio_desc: "Control vocal removal, volume, and pitch.",
        tut_misc_title: "Miscellaneous",
        tut_reset_desc: "Reset playlist & history",
        tut_share_title: "Share",
        tut_share_desc: "Invite friends via QR code",
        tut_nick_title: "Profile",
        tut_nick_desc: "Tap to rename or restart tutorial",
        tut_final_title: "You're All Set!",
        tut_final_desc: "You can now start adding songs and singing! When you return from the background or lock screen, please remember to refresh the page to sync the status.",
        back: "Back",
        next: "Next",
        mock_player: "PREVIEW PLAYER",
        try_clicking: "(Try clicking the controls)",
        status_playing: "PLAYING",
        status_paused: "PAUSED",
        status_downloading: "DOWNLOADING",
        status_separating: "SEPARATING",
        label_video: "VIDEO",
        label_audio: "AUDIO",
        label_processing: "PROCESSING"
    },
    zh: {
        enterName: "输入您的昵称",
        join: "进入系统",
        playlist: "播放列表",
        history: "历史记录",
        pasteLink: "粘贴 Bilibili / YouTube 链接",
        queue: "待播队列",
        export: "导出列表",
        idle: "当前空闲，请点歌",
        join_warn: "请先输入昵称",
        reset_confirm: "确定要重置系统吗？这将清空所有播放列表和历史记录。",
        modify_nick: "修改昵称",
        save: "保存",
        cancel: "取消",
        tuning: "音频设置",
        volume: "音量",
        pitch: "升降调",
        reset: "重置",
        vocal_removal: "人声消除",
        vocal_on: "人声开启",
        vocal_off: "人声已消除",
        vocal_hint: "处理可能需要 1-2 分钟",
        vocal_warning: "使用 Demucs AI 模型进行处理。可能会造成较大性能开销。首次加载模型时可能较慢（进度条卡在99%），请耐心等待或留意控制台输出。",
        vocal_unavailable: "暂不可用",
        processing: "处理中",
        ready: "就绪",
        click_to_process: "点击开始处理",
        start_process: "消除人声",
        auto_process: "自动处理新歌曲",
        auto_process_hint: "自动为歌曲准备纯伴奏",
        shuffle: "随机打乱",
        loudness_norm: "响度均衡",
        select_songs: "选择歌曲",
        select_all: "全选",
        selected: "已选",
        add_selected: "添加选中歌曲",
        select_songs_first: "请至少选择一首歌曲",
        tutorial_restart: "重新观看教学",
        advanced_settings: "高级设置",
        restore_defaults: "恢复默认设置",
        restore_defaults_confirm: "确定要将所有高级设置恢复为默认值吗？当前设置将丢失。",
        // Tutorial Steps
        tut_start_btn: "开始使用",
        tut_welcome_title: "欢迎！",
        tut_welcome_desc: "让我们花一点时间了解如何使用本系统。",
        tut_interface_title: "主界面",
        tut_interface_desc: "这里是您的主要控制中心。",
        tut_add_title: "点歌",
        tut_add_desc: "在此粘贴 Bilibili 或 YouTube 链接。我们支持单曲、收藏夹及播放列表导入！",
        tut_add_hint: "支持 Bilibili 收藏夹和 YouTube 播放列表",
        click_to_see_batch: "点击模拟批量导入",
        tut_status_title: "状态指示灯",
        tut_status_desc: "了解不同颜色代表的含义。",
        status_downloading: "蓝色闪烁",
        status_downloading_desc: "正在下载内容...",
        status_ready: "蓝色常亮",
        status_ready_desc: "下载完成。可以播放（原唱）。",
        status_processing: "紫色闪烁",
        status_processing_desc: "正在消除人声（制作伴奏）...",
        status_full_ready: "紫色常亮",
        status_full_ready_desc: "伴奏制作完成，已完全就绪！",
        tut_audio_title: "音频设置",
        tut_audio_desc: "控制人声消除、音量和升降调。",
        tut_misc_title: "杂项功能",
        tut_reset_desc: "重置播放列表和历史",
        tut_share_title: "分享",
        tut_share_desc: "显示二维码邀请朋友",
        tut_nick_title: "个人中心",
        tut_nick_desc: "点击此处修改昵称或重看教学",
        tut_final_title: "准备就绪！",
        tut_final_desc: "您现在可以开始点歌并尽情歌唱了！当您从后台或锁屏回来时，请注意刷新网页以同步状态。",
        back: "上一步",
        next: "下一步",
        mock_player: "演示播放器",
        try_clicking: "（试着点击控件）",
        status_playing: "播放中",
        status_paused: "已暂停",
        status_downloading: "下载中",
        status_separating: "分离中",
        label_video: "视频",
        label_audio: "音频",
        label_processing: "处理"
    },
    ja: {
        enterName: "ニックネームを入力",
        join: "参加する",
        playlist: "プレイリスト",
        history: "履歴",
        pasteLink: "リンクを貼り付け (Bilibili/YT)",
        queue: "再生待ち",
        export: "リストを出力",
        idle: "リクエスト待ち",
        join_warn: "名前を入力してください",
        reset_confirm: "システムをリセットしますか？プレイリストと履歴はすべて消去されます。",
        modify_nick: "ニックネーム変更",
        save: "保存",
        cancel: "キャンセル",
        tuning: "オーディオ設定",
        volume: "音量",
        pitch: "キー変更",
        reset: "リセット",
        vocal_removal: "ボーカル除去",
        vocal_on: "ボーカルあり",
        vocal_off: "ボーカルなし",
        vocal_hint: "処理には 1～2 分かかります",
        vocal_warning: "Demucs AIモデルを使用します。システム負荷が高くなる可能性があります。初回モデル読み込みは遅くなる場合があります（99%で停止）、お待ちください。",
        vocal_unavailable: "利用不可",
        processing: "処理中",
        ready: "準備完了",
        click_to_process: "クリックで処理開始",
        start_process: "ボーカル除去",
        auto_process: "新曲を自動処理",
        auto_process_hint: "自動的にインストを準備",
        shuffle: "シャッフル",
        loudness_norm: "ラウドネス正規化",
        select_songs: "曲を選択",
        select_all: "すべて選択",
        selected: "選択済み",
        add_selected: "選択した曲を追加",
        select_songs_first: "曲を選択してください",
        tutorial_restart: "チュートリアルを表示",
        advanced_settings: "詳細設定",
        restore_defaults: "既定に戻す",
        restore_defaults_confirm: "すべての詳細設定を既定値に戻しますか？現在の設定は失われます。",
        // Tutorial Steps
        tut_start_btn: "始める",
        tut_welcome_title: "ようこそ！",
        tut_welcome_desc: "使い方の簡単なツアーを始めましょう。",
        tut_interface_title: "メイン画面",
        tut_interface_desc: "これがメインのコントロールセンターです。",
        tut_add_title: "曲を追加",
        tut_add_desc: "BilibiliやYouTubeのリンクを貼り付けてください。リストやマイリストもサポートしています！",
        tut_add_hint: "Bilibiliマイリスト & YouTubeプレイリスト対応",
        click_to_see_batch: "クリックして一括インポートをシミュレート",
        tut_status_title: "ステータス表示",
        tut_status_desc: "色の意味を理解しましょう。",
        status_downloading: "青点滅",
        status_downloading_desc: "コンテンツをダウンロード中...",
        status_ready: "青点灯",
        status_ready_desc: "ダウンロード完了。再生可能（原曲）。",
        status_processing: "紫点滅",
        status_processing_desc: "ボーカル除去中（インスト作成中）...",
        status_full_ready: "紫点灯",
        status_full_ready_desc: "インストの準備が完了しました！",
        tut_audio_title: "オーディオ設定",
        tut_audio_desc: "ボーカル除去、音量、キー変更を操作します。",
        tut_misc_title: "その他",
        tut_reset_desc: "リストと履歴をリセット",
        tut_share_title: "共有",
        tut_share_desc: "QRコードを表示",
        tut_nick_title: "プロフィール",
        tut_nick_desc: "タップして名前変更やチュートリアル再表示",
        tut_final_title: "準備完了！",
        tut_final_desc: "曲を追加して歌い始めましょう！バックグラウンドやロック画面から戻ったときは、状態を同期するために「更新」ボタンをクリックしてください。",
        back: "戻る",
        next: "次へ",
        mock_player: "プレビュー",
        try_clicking: "（コントロールをクリックしてみてください）",
        status_playing: "再生中",
        status_paused: "停止中",
        status_downloading: "DL中",
        status_separating: "分離中",
        label_video: "映像",
        label_audio: "音声",
        label_processing: "処理"
    },
};

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

        const showShareModal = ref(false);
        const showPlaylistModal = ref(false);
        const showAdvancedSettings = ref(false);
        const advancedConfig = ref({
            ytdlp: { videoFormat: 'bestvideo[ext=mp4]/bestvideo', audioFormat: 'bestaudio[ext=m4a]/bestaudio', concurrentFragments: 16, httpChunkSize: '10M', noPlaylist: true, proxy: '', socketTimeout: 0, retries: 10, fragmentRetries: 10, userAgent: '', extractorArgs: '', postprocessorArgs: '', noCheckCertificates: false, limitRate: '', geoBypass: true, addHeader: [], mergeOutputFormat: '', flatPlaylist: true, dumpJson: true, noWarnings: false, ignoreErrors: false, abortOnError: false, noPart: false, restrictFilenames: false, windowsFilenames: false, noOverwrites: false, forceIPv4: false, forceIPv6: false },
            demucs: { model: 'htdemucs', twoStems: 'vocals', outputFormat: 'mp3', overlap: 0.25, segment: 7.8, shifts: 1, overlapOutput: false, float32: false, clipMode: 'rescale', noSegment: false, jobs: 0, device: '', repo: '' },
            ffmpeg: { loudnessI: -16, loudnessTP: -1.5, loudnessLRA: 11, loudnessGainClamp: 12 },
            system: { deleteDelayMs: 20000, maxConcurrentDownloads: 1 }
        });
        const playlistItems = ref([]);
        const selectedItems = ref(new Set()); // using Set for indices

        const networks = ref([{ name: 'Loading', ip: '...' }]);
        const currentNetIndex = ref(0);
        const systemSSID = ref('...');
        const systemPort = ref('8080');

        const currentNetwork = computed(() => networks.value[currentNetIndex.value] || networks.value[0]);
        const isAllSelected = computed(() => playlistItems.value.length > 0 && selectedItems.value.size === playlistItems.value.length);


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
            if (!addUrl.value) return;
            isAdding.value = true;
            socket.emit('parse_url', addUrl.value);
        };

        const closePlaylistModal = () => {
            showPlaylistModal.value = false;
            playlistItems.value = [];
            selectedItems.value.clear();
            isAdding.value = false;
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
            const songsToAdd = Array.from(selectedItems.value).map(idx => playlistItems.value[idx]);
            if (songsToAdd.length > 0) {
                socket.emit('add_batch_songs', { songs: songsToAdd, requester: nickname.value });
                isAdding.value = true;
            }
            closePlaylistModal();
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
        const reAddHistory = (item) => { socket.emit('readd_history', item); activeTab.value = 'playlist'; };

        const exportHistory = () => {
            let text = "\uFEFF=== PLAYLIST HISTORY ===\n\n";
            history.value.forEach((item, index) => { text += `${index + 1}. ${item.title}\n   UP: ${item.uploader} | BY: ${item.requester} | URL: ${item.originalUrl}\n\n`; });
            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = `playlist_${new Date().toISOString().slice(0, 10)}.txt`; a.click();
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
        socket.on('add_success', () => { isAdding.value = false; addUrl.value = ""; });
        socket.on('error_msg', (msg) => { alert(msg); isAdding.value = false; });
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
                alert("Failed to parse URL");
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
            localPlaying, localCurrentTime, localDuration, localVolumeDisplay, isDragging,
            addSong, manageQueue, shuffleQueue, skipSong, control, resetSystem,
            reAddHistory, exportHistory,
            onSeekInput, onSeekEnd, onVolumeInput, formatTime,

            lang, t, toggleLang, isRenaming, startRename, cancelRename, restartTutorial,
            showShareModal, openShare, networks, currentNetwork, nextNetwork, systemSSID, systemPort,
            showTuning, changePitch, resetPitch, localPitch,
            localVocalRemoval, toggleVocalRemoval,
            localLoudnessNorm, toggleLoudnessNorm,
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
