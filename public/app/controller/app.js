import { messages } from './messages.js';

const { createApp, ref, computed, nextTick } = window.Vue;
const socket = window.io();
const YTM_SEARCH_PAGE_SIZE = 24;
const YTM_SEARCH_MAX_LIMIT = 120;
const YTM_DETAIL_PAGE_SIZE = 100;
const YTM_PLAYLIST_PAGE_SIZE = 200;
const YTM_DETAIL_MAX_LIMIT = 500;
const YTM_SEARCH_FILTERS = ['songs', 'albums', 'singles', 'artists'];
const YTM_DEFAULT_FILTER = 'songs';
const YTM_TRACK_FEEDBACK_MS = 1400;
const YTM_KNOWN_ERROR_CODES = new Set([
    'helper_missing',
    'helper_timeout',
    'helper_spawn_failed',
    'helper_empty_response',
    'helper_invalid_json',
    'helper_stdin_failed',
    'upstream_failed',
    'invalid_detail_payload',
    'invalid_request',
    'ytmusic_failed',
]);

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
        const formatMessage = (key, vars = {}) => String(t(key) || '').replace(/\{(\w+)\}/g, (_, name) => (
            Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : ''
        ));
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
            { value: 'ytmusic', label: t('lyrics_source_ytmusic') },
            { value: 'apple_music', label: t('lyrics_source_apple_music') },
            { value: 'qq_music', label: t('lyrics_source_qq_music') },
        ]));

        const showShareModal = ref(false);
        const showPlaylistModal = ref(false);
        const showAdvancedSettings = ref(false);
        const showYtmSearch = ref(false);
        const ytmQuery = ref('');
        const ytmFilter = ref(YTM_DEFAULT_FILTER);
        const ytmSections = ref([]);
        const ytmDetail = ref(null);
        const ytmViewMode = ref('search');
        const ytmLoading = ref(false);
        const ytmDetailLoading = ref(false);
        const ytmHasSearched = ref(false);
        const ytmNavigationStack = ref([]);
        const ytmSearchLimit = ref(YTM_SEARCH_PAGE_SIZE);
        const ytmSearchCanLoadMore = ref(false);
        const ytmSearchReachedEnd = ref(false);
        const ytmSearchLoadingMore = ref(false);
        const ytmDetailLimit = ref(0);
        const ytmDetailCanLoadMore = ref(false);
        const ytmDetailReachedEnd = ref(false);
        const ytmDetailLoadingMore = ref(false);
        const ytmActiveDetailRequest = ref(null);
        const ytmErrorState = ref(null);
        const showYtmCounterpartChoice = ref(false);
        const ytmCounterpartChoiceTrack = ref(null);
        const ytmCounterpartChoiceVideo = ref(null);
        const ytmResolvingTrackId = ref('');
        const ytmAddingTrackIds = ref({});
        const ytmAddedTrackIds = ref({});
        const advancedConfig = ref({
            ytdlp: { videoFormat: 'bestvideo[ext=mp4]/bestvideo', audioFormat: 'bestaudio[ext=m4a]/bestaudio', concurrentFragments: 16, httpChunkSize: '10M', noPlaylist: true, proxy: '', socketTimeout: 0, retries: 10, fragmentRetries: 10, userAgent: '', extractorArgs: '', postprocessorArgs: '', noCheckCertificates: false, limitRate: '', geoBypass: true, addHeader: [], mergeOutputFormat: '', flatPlaylist: true, dumpJson: true, noWarnings: false, ignoreErrors: false, abortOnError: false, noPart: false, restrictFilenames: false, windowsFilenames: false, noOverwrites: false, forceIPv4: false, forceIPv6: false },
            demucs: { model: 'htdemucs', twoStems: 'vocals', outputFormat: 'mp3', overlap: 0.25, segment: 7.8, shifts: 1, overlapOutput: false, float32: false, clipMode: 'rescale', noSegment: false, jobs: 0, device: '', repo: '' },
            ffmpeg: { loudnessI: -16, loudnessTP: -1.5, loudnessLRA: 11, loudnessGainClamp: 12 },
            system: { deleteDelayMs: 20000, maxConcurrentDownloads: 1 },
            lyrics: { enabled: true, source: 'auto', utatenRomajiEnabled: false }
        });
        const playlistItems = ref([]);
        const selectedItems = ref(new Set()); // using Set for indices

        const networks = ref([{ name: 'Loading', ip: '...' }]);
        const currentNetIndex = ref(0);
        const systemSSID = ref('...');
        const systemPort = ref('8080');

        const currentNetwork = computed(() => networks.value[currentNetIndex.value] || networks.value[0]);
        const isAllSelected = computed(() => playlistItems.value.length > 0 && selectedItems.value.size === playlistItems.value.length);
        const ytmFilterOptions = computed(() => ([
            { value: 'songs', label: t('ytm_filter_songs') },
            { value: 'albums', label: t('ytm_filter_albums') },
            { value: 'singles', label: t('ytm_filter_singles') },
            { value: 'artists', label: t('ytm_filter_artists') },
        ]));
        const ytmCanGoBack = computed(() => ytmNavigationStack.value.length > 0);
        const ytmHasVisibleResults = computed(() => (
            ytmViewMode.value === 'detail'
                ? countYtmDetailItems(ytmDetail.value) > 0
                : countYtmSearchItems(ytmSections.value) > 0
        ));
        const ytmCanLoadMoreCurrent = computed(() => (
            ytmViewMode.value === 'detail'
                ? ytmDetailCanLoadMore.value
                : ytmSearchCanLoadMore.value
        ));
        const ytmReachedEndCurrent = computed(() => (
            ytmViewMode.value === 'detail'
                ? ytmDetailReachedEnd.value
                : ytmSearchReachedEnd.value
        ));
        const ytmLoadingMoreCurrent = computed(() => (
            ytmViewMode.value === 'detail'
                ? ytmDetailLoadingMore.value
                : ytmSearchLoadingMore.value
        ));
        const ytmVisibleCountCurrent = computed(() => (
            ytmViewMode.value === 'detail'
                ? countYtmDetailItems(ytmDetail.value)
                : countYtmSearchItems(ytmSections.value)
        ));
        let notificationId = 0;
        let ytmSearchRequestId = null;
        let ytmDetailRequestId = null;
        let ytmSearchRequestMeta = null;
        let ytmDetailRequestMeta = null;
        let ytmLastAutoLoadAt = 0;
        let ytmCounterpartRequestSeq = 0;
        const ytmCounterpartRequests = new Map();
        const ytmPendingAddRequests = new Map();
        const ytmTrackSuccessTimers = new Map();
        const clearBrowserState = () => {
            ['ktv_lang', 'ktv_nickname', 'ktv_tutorial_completed'].forEach((key) => localStorage.removeItem(key));
        };

        const countYtmSearchItems = (sections) => (
            Array.isArray(sections)
                ? sections.reduce((total, section) => total + (Array.isArray(section?.items) ? section.items.length : 0), 0)
                : 0
        );

        const countYtmDetailItems = (detail) => {
            if (!detail || typeof detail !== 'object') return 0;
            const trackCount = Array.isArray(detail.tracks) ? detail.tracks.length : 0;
            const sectionCount = Array.isArray(detail.sections)
                ? detail.sections.reduce((total, section) => total + (Array.isArray(section?.items) ? section.items.length : 0), 0)
                : 0;
            return trackCount + sectionCount;
        };

        const createYtmCancelledError = () => {
            const error = new Error('ytm_counterpart_cancelled');
            error.cancelled = true;
            return error;
        };

        const closeYtmCounterpartChoice = () => {
            showYtmCounterpartChoice.value = false;
            ytmCounterpartChoiceTrack.value = null;
            ytmCounterpartChoiceVideo.value = null;
        };

        const clearYtmCounterpartRequestState = () => {
            for (const pending of ytmCounterpartRequests.values()) {
                if (pending?.timer) clearTimeout(pending.timer);
                if (typeof pending?.reject === 'function') {
                    pending.reject(createYtmCancelledError());
                }
            }
            ytmCounterpartRequests.clear();
            ytmResolvingTrackId.value = '';
            closeYtmCounterpartChoice();
        };

        const isYtmTrackResolving = (item) => {
            const key = String(item?.id || item?.videoId || '').trim();
            return !!key && key === ytmResolvingTrackId.value;
        };

        const getYtmTrackActionKey = (item) => String(item?.id || item?.videoId || '').trim();

        const clearYtmTrackSuccessState = (trackKey) => {
            const key = String(trackKey || '').trim();
            if (!key) return;
            if (ytmTrackSuccessTimers.has(key)) {
                clearTimeout(ytmTrackSuccessTimers.get(key));
                ytmTrackSuccessTimers.delete(key);
            }
            if (!ytmAddedTrackIds.value[key]) return;
            const next = { ...ytmAddedTrackIds.value };
            delete next[key];
            ytmAddedTrackIds.value = next;
        };

        const setYtmTrackAddingState = (trackKey, isAdding) => {
            const key = String(trackKey || '').trim();
            if (!key) return;
            if (isAdding) {
                ytmAddingTrackIds.value = { ...ytmAddingTrackIds.value, [key]: true };
                return;
            }
            if (!ytmAddingTrackIds.value[key]) return;
            const next = { ...ytmAddingTrackIds.value };
            delete next[key];
            ytmAddingTrackIds.value = next;
        };

        const flashYtmTrackAddedState = (trackKey) => {
            const key = String(trackKey || '').trim();
            if (!key) return;
            setYtmTrackAddingState(key, false);
            clearYtmTrackSuccessState(key);
            ytmAddedTrackIds.value = { ...ytmAddedTrackIds.value, [key]: true };
            const timer = setTimeout(() => clearYtmTrackSuccessState(key), YTM_TRACK_FEEDBACK_MS);
            ytmTrackSuccessTimers.set(key, timer);
        };

        const beginYtmTrackAddRequest = (trackKey, requestId) => {
            const key = String(trackKey || '').trim();
            const nextRequestId = String(requestId || '').trim();
            if (!key || !nextRequestId) return;
            clearYtmTrackSuccessState(key);
            setYtmTrackAddingState(key, true);
            ytmPendingAddRequests.set(nextRequestId, key);
        };

        const finishYtmTrackAddRequest = (requestId, { success = false } = {}) => {
            const key = String(requestId || '').trim();
            if (!key || !ytmPendingAddRequests.has(key)) return false;
            const trackKey = ytmPendingAddRequests.get(key);
            ytmPendingAddRequests.delete(key);
            if (success) {
                flashYtmTrackAddedState(trackKey);
            } else {
                setYtmTrackAddingState(trackKey, false);
            }
            return true;
        };

        const resetYtmTrackFeedbackState = () => {
            for (const timer of ytmTrackSuccessTimers.values()) {
                clearTimeout(timer);
            }
            ytmTrackSuccessTimers.clear();
            ytmPendingAddRequests.clear();
            ytmAddingTrackIds.value = {};
            ytmAddedTrackIds.value = {};
        };

        const isYtmTrackAdding = (item) => {
            const key = getYtmTrackActionKey(item);
            return !!key && !!ytmAddingTrackIds.value[key];
        };

        const isYtmTrackAdded = (item) => {
            const key = getYtmTrackActionKey(item);
            return !!key && !!ytmAddedTrackIds.value[key];
        };

        const isYtmTrackBusy = (item) => isYtmTrackResolving(item) || isYtmTrackAdding(item);

        const getYtmTrackAddButtonClass = (item) => {
            if (isYtmTrackAdded(item)) {
                return 'bg-emerald-500 text-white border-emerald-300/70 shadow-[0_10px_24px_rgba(16,185,129,0.35)] scale-105 pointer-events-none';
            }
            if (isYtmTrackBusy(item)) {
                return 'bg-zinc-100 text-black border-white/20 shadow-[0_10px_24px_rgba(255,255,255,0.12)]';
            }
            return 'bg-white text-black border-white/10';
        };

        const buildYtmQueueItem = (item, variant = 'song', counterpartOverride = null) => {
            if (!item || item.itemType !== 'track') return null;
            if (variant === 'video') {
                const counterpart = counterpartOverride && typeof counterpartOverride === 'object'
                    ? counterpartOverride
                    : null;
                if (!counterpart || !String(counterpart.videoId || '').trim()) return null;
                return {
                    ...counterpart,
                    title: counterpart.title || item.title,
                    track: counterpart.track || counterpart.title || item.title,
                    artist: counterpart.artist || counterpart.uploader || item.artist || item.uploader || 'Unknown',
                    uploader: counterpart.uploader || counterpart.artist || item.artist || item.uploader || 'Unknown',
                    duration: counterpart.duration ?? item.duration ?? null,
                    durationText: counterpart.durationText || item.durationText || '',
                    sourceId: counterpart.sourceId || counterpart.videoId || null,
                    extractor: counterpart.extractor || 'Youtube',
                    originalUrl: counterpart.originalUrl,
                    sourcePlatform: counterpart.sourcePlatform || 'youtube',
                    playlistId: null,
                    counterpartOf: item.videoId || null,
                };
            }
            return {
                ...item,
                sourcePlatform: 'ytmusic',
                originalUrl: item.originalUrl,
            };
        };

        const resolveYtmCounterpartForTrack = (item) => new Promise((resolve, reject) => {
            const videoId = String(item?.videoId || '').trim();
            if (!videoId) {
                resolve(null);
                return;
            }
            const requestId = `ytm_counterparts_${Date.now()}_${++ytmCounterpartRequestSeq}`;
            const timer = setTimeout(() => {
                ytmCounterpartRequests.delete(requestId);
                reject(new Error('ytm_counterpart_timeout'));
            }, 10000);

            ytmCounterpartRequests.set(requestId, {
                resolve,
                reject,
                timer,
            });
            socket.emit('ytmusic_resolve_counterparts', {
                requestId,
                language: lang.value,
                tracks: [{
                    videoId,
                    playlistId: String(item?.playlistId || '').trim() || null,
                }],
            });
        });

        const getYtmDetailPageSize = (detailRequest) => (
            detailRequest?.kind === 'playlist' ? YTM_PLAYLIST_PAGE_SIZE : YTM_DETAIL_PAGE_SIZE
        );

        const canPaginateYtmDetail = (detail, detailRequest = ytmActiveDetailRequest.value) => {
            const kind = detail?.kind || detailRequest?.kind || '';
            return kind === 'playlist' || kind === 'artist_collection';
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

        const queueSongs = (songs, options = {}) => {
            const nextSongs = Array.isArray(songs)
                ? songs.filter((item) => item && typeof item.originalUrl === 'string' && item.originalUrl)
                : [];
            if (nextSongs.length === 0) return false;
            socket.emit('add_batch_songs', {
                songs: nextSongs,
                requester: nickname.value,
                requestId: String(options.requestId || '').trim() || undefined,
            });
            if (options.keepBusyState) {
                isAdding.value = true;
            }
            return true;
        };

        const openSongSelection = (items, options = {}) => {
            const nextItems = Array.isArray(items) ? items.filter(Boolean) : [];
            playlistItems.value = nextItems;
            selectedItems.value = new Set(nextItems.map((_, index) => index));
            showPlaylistModal.value = true;
            if (!options.keepBusyState) {
                isAdding.value = false;
            }
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
                queueSongs(songsToAdd, { keepBusyState: true });
                closePlaylistModal({ keepBusyState: true });
            } else {
                pushNotification(t('select_songs_first'));
                closePlaylistModal();
            }
        };

        const cloneYtmViewState = () => JSON.parse(JSON.stringify({
            viewMode: ytmViewMode.value,
            query: ytmQuery.value,
            filter: ytmFilter.value,
            sections: ytmSections.value,
            detail: ytmDetail.value,
            hasSearched: ytmHasSearched.value,
            searchLimit: ytmSearchLimit.value,
            searchCanLoadMore: ytmSearchCanLoadMore.value,
            searchReachedEnd: ytmSearchReachedEnd.value,
            detailLimit: ytmDetailLimit.value,
            detailCanLoadMore: ytmDetailCanLoadMore.value,
            detailReachedEnd: ytmDetailReachedEnd.value,
            activeDetailRequest: ytmActiveDetailRequest.value,
        }));

        const restoreYtmViewState = (snapshot) => {
            if (!snapshot || typeof snapshot !== 'object') return;
            ytmViewMode.value = snapshot.viewMode || 'search';
            ytmQuery.value = snapshot.query || '';
            ytmFilter.value = YTM_SEARCH_FILTERS.includes(snapshot.filter) ? snapshot.filter : YTM_DEFAULT_FILTER;
            ytmSections.value = Array.isArray(snapshot.sections) ? snapshot.sections : [];
            ytmDetail.value = snapshot.detail || null;
            ytmHasSearched.value = !!snapshot.hasSearched;
            ytmSearchLimit.value = Number(snapshot.searchLimit) || YTM_SEARCH_PAGE_SIZE;
            ytmSearchCanLoadMore.value = !!snapshot.searchCanLoadMore;
            ytmSearchReachedEnd.value = !!snapshot.searchReachedEnd;
            ytmSearchLoadingMore.value = false;
            ytmDetailLimit.value = Number(snapshot.detailLimit) || 0;
            ytmDetailCanLoadMore.value = !!snapshot.detailCanLoadMore;
            ytmDetailReachedEnd.value = !!snapshot.detailReachedEnd;
            ytmDetailLoadingMore.value = false;
            ytmActiveDetailRequest.value = snapshot.activeDetailRequest || null;
            ytmLoading.value = false;
            ytmDetailLoading.value = false;
            ytmErrorState.value = null;
        };

        const clearYtmErrorState = () => {
            ytmErrorState.value = null;
        };

        const setYtmErrorState = (nextState) => {
            ytmErrorState.value = nextState && typeof nextState === 'object'
                ? { ...nextState }
                : null;
        };

        const cancelYtmPendingRequests = (options = {}) => {
            const cancelSearch = options.search !== false;
            const cancelDetail = options.detail !== false;
            if (cancelSearch) {
                ytmSearchRequestId = null;
                ytmSearchRequestMeta = null;
                ytmLoading.value = false;
                ytmSearchLoadingMore.value = false;
            }
            if (cancelDetail) {
                ytmDetailRequestId = null;
                ytmDetailRequestMeta = null;
                ytmDetailLoading.value = false;
                ytmDetailLoadingMore.value = false;
            }
        };

        const resetYtmSearchState = () => {
            clearYtmCounterpartRequestState();
            resetYtmTrackFeedbackState();
            ytmQuery.value = '';
            ytmFilter.value = YTM_DEFAULT_FILTER;
            ytmSections.value = [];
            ytmDetail.value = null;
            ytmViewMode.value = 'search';
            ytmLoading.value = false;
            ytmDetailLoading.value = false;
            ytmHasSearched.value = false;
            ytmNavigationStack.value = [];
            ytmSearchLimit.value = YTM_SEARCH_PAGE_SIZE;
            ytmSearchCanLoadMore.value = false;
            ytmSearchReachedEnd.value = false;
            ytmSearchLoadingMore.value = false;
            ytmDetailLimit.value = 0;
            ytmDetailCanLoadMore.value = false;
            ytmDetailReachedEnd.value = false;
            ytmDetailLoadingMore.value = false;
            ytmActiveDetailRequest.value = null;
            ytmSearchRequestId = null;
            ytmDetailRequestId = null;
            ytmSearchRequestMeta = null;
            ytmDetailRequestMeta = null;
            ytmErrorState.value = null;
        };

        const openYtmSearch = () => {
            showYtmSearch.value = true;
            nextTick(() => {
                const input = document.getElementById('ytm-search-input');
                if (input) input.focus();
            });
        };

        const closeYtmSearch = () => {
            cancelYtmPendingRequests();
            showYtmSearch.value = false;
            resetYtmSearchState();
        };

        const getYtmSectionTitle = (section) => {
            const key = section && section.key ? `ytm_section_${section.key}` : '';
            return (messages[lang.value] && messages[lang.value][key]) || section?.title || '';
        };

        const getYtmItemTypeLabel = (item) => {
            if (!item || typeof item !== 'object') return '';
            if (item.itemType === 'track') return t('ytm_filter_songs');
            if (item.itemType === 'album') return t('ytm_filter_albums');
            if (item.itemType === 'single') return t('ytm_filter_singles');
            if (item.itemType === 'artist') return t('ytm_filter_artists');
            return '';
        };

        const isYtmNonArtistMetaText = (value) => {
            const text = String(value || '').trim();
            if (!text) return false;
            const lowered = text.toLowerCase();
            const hasNumber = /\d/.test(text);
            const startsWithMetric = [
                '播放次数',
                '觀看次數',
                '观看次数',
                '再生回数',
                '高評価',
                '每月观众',
                '每月觀眾',
                '月间听众',
                '月間聽眾',
                '每月听众',
                '每月聽眾',
                'monthly listeners',
                'monthly audience',
                'monthly viewers',
                'views',
                'view count',
                'likes',
                'subscribers',
                'subscriber count',
            ].some((prefix) => lowered.startsWith(prefix));
            if (lowered.startsWith('高評価') || text.includes('回視聴') || text.includes('回观看') || text.includes('回觀看')) {
                return true;
            }
            if (startsWithMetric) {
                return text.includes(':') || text.includes('：') || hasNumber;
            }
            if (!hasNumber) return false;
            return [
                ' views',
                ' view',
                ' subscribers',
                ' subscriber',
                ' listeners',
                ' audience',
                ' viewers',
                '播放次数',
                '觀看次數',
                '观看次数',
                '再生回数',
                '每月观众',
                '每月觀眾',
                '月间听众',
                '月間聽眾',
                '每月听众',
                '每月聽眾',
                '回視聴',
                '回观看',
                '回觀看',
                '高評価',
                ' likes',
                ' like',
            ].some((keyword) => lowered.includes(keyword));
        };

        const getYtmTrackArtistLinks = (item) => {
            if (!item || item.itemType !== 'track' || !Array.isArray(item.artists)) return [];
            const seen = new Set();
            return item.artists
                .map((artist) => ({
                    name: String(artist?.name || '').trim(),
                    id: String(artist?.id || '').trim(),
                    key: `${String(artist?.id || '').trim() || 'name'}:${String(artist?.name || '').trim()}`,
                }))
                .filter((artist) => {
                    if (!artist.name || isYtmNonArtistMetaText(artist.name)) return false;
                    const key = artist.key.toLowerCase();
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
        };

        const getYtmTrackAlbumLink = (item) => {
            const albumName = String(item?.albumRef?.name || '').trim();
            if (!albumName) return null;
            return {
                id: String(item?.albumRef?.id || '').trim(),
                name: albumName,
                searchFilter: String(item?.albumRef?.searchFilter || '').trim(),
            };
        };

        const hasYtmTrackMetaLinks = (item) => (
            getYtmTrackArtistLinks(item).length > 0 || !!getYtmTrackAlbumLink(item)
        );

        const openYtmSearchFallback = (query, filter = YTM_DEFAULT_FILTER) => {
            const nextQuery = String(query || '').trim();
            const nextFilter = YTM_SEARCH_FILTERS.includes(filter) ? filter : YTM_DEFAULT_FILTER;
            if (!nextQuery) return;
            submitYtmSearch(nextQuery, {
                filterOverride: nextFilter,
                pushCurrentView: true,
                restoreOnFailure: true,
            });
        };

        const openYtmArtistRef = (artist) => {
            const title = String(artist?.name || '').trim();
            const browseId = String(artist?.id || '').trim();
            if (!title) return;
            if (!browseId) {
                openYtmSearchFallback(title, 'artists');
                return;
            }
            fetchYtmDetail({
                kind: 'artist',
                browseId,
                title,
            });
        };

        const openYtmAlbumRef = (album) => {
            const title = String(album?.name || '').trim();
            const browseId = String(album?.id || '').trim();
            if (!title) return;
            if (!browseId) {
                openYtmSearchFallback(title, album?.searchFilter || 'albums');
                return;
            }
            fetchYtmDetail({
                kind: 'album',
                browseId,
                title,
            });
        };

        const getYtmErrorTitle = () => {
            const code = String(ytmErrorState.value?.code || '').trim();
            if (!code) return '';
            if (code === 'helper_missing') return t('ytm_error_helper_missing');
            if (code === 'helper_timeout') return t('ytm_error_helper_timeout');
            if (code === 'upstream_failed') return t('ytm_error_upstream_failed');
            if (['helper_spawn_failed', 'helper_empty_response', 'helper_invalid_json', 'helper_stdin_failed'].includes(code)) {
                return t('ytm_error_host_failed');
            }
            if (ytmErrorState.value?.scope === 'detail') return t('ytm_error_detail_failed');
            return t('ytm_error_search_failed');
        };

        const getYtmErrorHint = () => (
            ytmVisibleCountCurrent.value > 0
                ? t('ytm_error_showing_previous_results')
                : t('ytm_error_retry_hint')
        );

        const getYtmLoadedAllText = () => formatMessage('ytm_loaded_all_count', {
            count: ytmVisibleCountCurrent.value,
        });

        const retryYtmRequest = () => {
            const retry = ytmErrorState.value?.retry;
            if (!retry || typeof retry !== 'object') return;
            clearYtmErrorState();
            if (retry.type === 'detail') {
                fetchYtmDetail(retry.detailRequest, {
                    append: !!retry.append,
                    limitOverride: retry.limitOverride,
                });
                return;
            }
            submitYtmSearch(retry.query, {
                append: !!retry.append,
                limitOverride: retry.limitOverride,
                filterOverride: retry.filter,
                pushCurrentView: !!retry.pushCurrentView,
                restoreOnFailure: !!retry.restoreOnFailure,
            });
        };

        const queuePreparedYtmTrack = (item, variant = 'song', counterpartOverride = null) => {
            const trackKey = getYtmTrackActionKey(item);
            const queuedItem = buildYtmQueueItem(item, variant, counterpartOverride);
            if (!queuedItem) {
                pushNotification(t('ytm_no_results'));
                return false;
            }
            const requestId = trackKey
                ? `ytm_add_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
                : '';
            if (requestId) {
                beginYtmTrackAddRequest(trackKey, requestId);
            }
            if (!queueSongs([queuedItem], { requestId })) {
                if (requestId) {
                    finishYtmTrackAddRequest(requestId);
                }
                pushNotification(t('ytm_no_results'));
                return false;
            }
            return true;
        };

        const chooseYtmCounterpartVariant = (variant = 'song') => {
            const track = ytmCounterpartChoiceTrack.value;
            const counterpart = ytmCounterpartChoiceVideo.value;
            closeYtmCounterpartChoice();
            queuePreparedYtmTrack(track, variant, counterpart);
        };

        const queueSingleYtmTrack = async (item) => {
            if (!item || item.itemType !== 'track' || isYtmTrackBusy(item) || isYtmTrackAdded(item)) return;
            const resolvingKey = String(item.id || item.videoId || '').trim();
            if (!resolvingKey) {
                queuePreparedYtmTrack(item, 'song');
                return;
            }

            ytmResolvingTrackId.value = resolvingKey;
            try {
                const counterpart = await resolveYtmCounterpartForTrack(item);
                if (counterpart && typeof counterpart === 'object' && String(counterpart.videoId || '').trim()) {
                    ytmCounterpartChoiceTrack.value = item;
                    ytmCounterpartChoiceVideo.value = counterpart;
                    showYtmCounterpartChoice.value = true;
                    return;
                }
                queuePreparedYtmTrack(item, 'song');
            } catch (error) {
                if (error?.cancelled) return;
                console.warn('[Controller][YTM] Counterpart lookup failed, falling back to song', error || '');
                queuePreparedYtmTrack(item, 'song');
            } finally {
                if (ytmResolvingTrackId.value === resolvingKey) {
                    ytmResolvingTrackId.value = '';
                }
            }
        };

        const openYtmBatchSelection = (tracks) => {
            const items = Array.isArray(tracks)
                ? tracks.map((item) => buildYtmQueueItem(item, 'song')).filter(Boolean)
                : [];
            if (items.length === 0) {
                pushNotification(t('select_songs_first'));
                return;
            }
            openSongSelection(items);
        };

        const queueYtmDetailTracks = () => {
            const tracks = Array.isArray(ytmDetail.value?.tracks)
                ? ytmDetail.value.tracks.map((item) => buildYtmQueueItem(item, 'song')).filter(Boolean)
                : [];
            if (!queueSongs(tracks)) {
                pushNotification(t('select_songs_first'));
            }
        };

        const fetchYtmDetail = (detailRequest, options = {}) => {
            if (!detailRequest || typeof detailRequest !== 'object') return;
            const append = !!options.append;
            const baseRequest = append
                ? { ...(ytmActiveDetailRequest.value || {}) }
                : { ...detailRequest };
            cancelYtmPendingRequests({ search: !append, detail: true });
            if (!append) clearYtmCounterpartRequestState();
            clearYtmErrorState();
            const pageSize = getYtmDetailPageSize(baseRequest);
            const nextLimit = Math.min(
                YTM_DETAIL_MAX_LIMIT,
                Math.max(
                    pageSize,
                    Number(options.limitOverride) || (append ? (ytmDetailLimit.value + pageSize) : pageSize),
                ),
            );
            if (append && nextLimit <= ytmDetailLimit.value) {
                ytmDetailCanLoadMore.value = false;
                ytmDetailReachedEnd.value = true;
                return;
            }

            if (!append) {
                ytmNavigationStack.value.push(cloneYtmViewState());
                ytmViewMode.value = 'detail';
                ytmDetail.value = {
                    title: baseRequest.title || '',
                    subtitle: '',
                    description: '',
                    tracks: [],
                    sections: [],
                    kind: baseRequest.kind || '',
                };
                ytmDetailReachedEnd.value = false;
                ytmDetailCanLoadMore.value = false;
            }

            ytmActiveDetailRequest.value = { ...baseRequest };
            ytmDetailLoadingMore.value = append;
            ytmDetailLoading.value = !append;
            ytmDetailRequestId = `ytm_detail_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            ytmDetailRequestMeta = {
                append,
                requestedLimit: nextLimit,
                previousCount: append ? countYtmDetailItems(ytmDetail.value) : 0,
                detailRequest: { ...baseRequest },
                retry: {
                    type: 'detail',
                    detailRequest: { ...baseRequest },
                    append,
                    limitOverride: nextLimit,
                },
            };
            socket.emit('ytmusic_get_detail', {
                requestId: ytmDetailRequestId,
                detail: {
                    ...baseRequest,
                    limit: nextLimit,
                },
                language: lang.value,
            });
        };

        const openYtmItem = (item) => {
            if (!item || typeof item !== 'object') return;
            if (item.itemType === 'track') {
                queueSingleYtmTrack(item);
                return;
            }
            if (item.openAction && typeof item.openAction === 'object') {
                fetchYtmDetail(item.openAction);
            }
        };

        const openYtmSection = (section) => {
            if (!section || typeof section !== 'object') return;
            if (section.openAction && typeof section.openAction === 'object') {
                fetchYtmDetail(section.openAction);
            }
        };

        const goBackYtmView = () => {
            cancelYtmPendingRequests();
            const snapshot = ytmNavigationStack.value.pop();
            if (snapshot) {
                restoreYtmViewState(snapshot);
                return;
            }
            closeYtmSearch();
        };

        const onYtmQueryInput = () => {
            const query = String(ytmQuery.value || '').trim();
            if (ytmViewMode.value === 'search') {
                clearYtmErrorState();
            }
            if (!query && ytmViewMode.value === 'search') {
                ytmSections.value = [];
                ytmHasSearched.value = false;
                ytmSearchLimit.value = YTM_SEARCH_PAGE_SIZE;
                ytmSearchCanLoadMore.value = false;
                ytmSearchReachedEnd.value = false;
                ytmSearchLoadingMore.value = false;
                return;
            }
            if (ytmViewMode.value === 'search') {
                ytmSearchLimit.value = YTM_SEARCH_PAGE_SIZE;
                ytmSearchCanLoadMore.value = false;
                ytmSearchReachedEnd.value = false;
                ytmSearchLoadingMore.value = false;
            }
        };

        const submitYtmSearch = (queryOverride = null, options = {}) => {
            const query = String(queryOverride ?? ytmQuery.value ?? '').trim();
            if (!query) {
                pushNotification(t('ytm_empty_query'));
                return;
            }
            const append = !!options.append;
            const filter = YTM_SEARCH_FILTERS.includes(options.filterOverride)
                ? options.filterOverride
                : ytmFilter.value;
            const shouldPushCurrentView = !append && (
                !!options.pushCurrentView
                || ytmViewMode.value === 'detail'
            );
            const previousSnapshot = shouldPushCurrentView ? cloneYtmViewState() : null;
            const nextLimit = Math.min(
                YTM_SEARCH_MAX_LIMIT,
                Math.max(
                    YTM_SEARCH_PAGE_SIZE,
                    Number(options.limitOverride) || (append ? (ytmSearchLimit.value + YTM_SEARCH_PAGE_SIZE) : YTM_SEARCH_PAGE_SIZE),
                ),
            );
            if (append && nextLimit <= ytmSearchLimit.value) {
                ytmSearchCanLoadMore.value = false;
                ytmSearchReachedEnd.value = true;
                return;
            }
            cancelYtmPendingRequests();
            if (!append) clearYtmCounterpartRequestState();
            clearYtmErrorState();
            ytmQuery.value = query;
            ytmFilter.value = filter;
            ytmViewMode.value = 'search';
            ytmDetail.value = null;
            ytmActiveDetailRequest.value = null;
            if (shouldPushCurrentView && previousSnapshot) {
                ytmNavigationStack.value.push(previousSnapshot);
            } else if (!append) {
                ytmNavigationStack.value = [];
            }
            ytmLoading.value = !append;
            ytmSearchLoadingMore.value = append;
            ytmHasSearched.value = true;
            if (!append) {
                ytmSearchReachedEnd.value = false;
                ytmSearchCanLoadMore.value = false;
            }
            ytmSearchRequestId = `ytm_search_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            ytmSearchRequestMeta = {
                append,
                requestedQuery: query,
                requestedLimit: nextLimit,
                previousCount: append ? countYtmSearchItems(ytmSections.value) : 0,
                requestedFilter: filter,
                previousSnapshot,
                pushedNavigation: shouldPushCurrentView,
                restoreOnFailure: !!options.restoreOnFailure || !!previousSnapshot,
                retry: {
                    type: 'search',
                    query,
                    filter,
                    append,
                    limitOverride: nextLimit,
                    pushCurrentView: shouldPushCurrentView,
                    restoreOnFailure: !!options.restoreOnFailure || !!previousSnapshot,
                },
            };
            socket.emit('ytmusic_search', {
                requestId: ytmSearchRequestId,
                query,
                filter,
                limit: nextLimit,
                language: lang.value,
            });
        };

        const changeYtmFilter = (filter) => {
            if (!YTM_SEARCH_FILTERS.includes(filter) || ytmFilter.value === filter) return;
            ytmFilter.value = filter;
            if (String(ytmQuery.value || '').trim()) {
                submitYtmSearch();
            }
        };

        const loadMoreYtmResults = (options = {}) => {
            if (ytmViewMode.value === 'detail') {
                if (!ytmDetailCanLoadMore.value || ytmDetailLoading.value || ytmDetailLoadingMore.value || !ytmActiveDetailRequest.value) return;
                fetchYtmDetail(ytmActiveDetailRequest.value, { append: true, ...options });
                return;
            }
            if (!ytmSearchCanLoadMore.value || ytmLoading.value || ytmSearchLoadingMore.value) return;
            submitYtmSearch(null, { append: true, ...options });
        };

        const onYtmResultsScroll = (event) => {
            const target = event?.target;
            if (!target || typeof target.scrollTop !== 'number') return;
            if (ytmErrorState.value || !ytmCanLoadMoreCurrent.value || ytmLoadingMoreCurrent.value || ytmLoading.value || ytmDetailLoading.value) return;
            const remain = target.scrollHeight - target.scrollTop - target.clientHeight;
            if (remain > 160) return;
            const now = Date.now();
            if (now - ytmLastAutoLoadAt < 800) return;
            ytmLastAutoLoadAt = now;
            loadMoreYtmResults({ fromScroll: true });
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
            finishYtmTrackAddRequest(payload?.requestId, { success: true });
            isAdding.value = false;
            addUrl.value = "";
            const count = Number(payload?.count || 0);
            if (count > 1) {
                pushNotification(`${count} songs added`, 'success', 2200);
            }
        });
        socket.on('error_msg', (msg) => {
            finishYtmTrackAddRequest(msg?.requestId);
            isAdding.value = false;
            if (showYtmSearch.value && YTM_KNOWN_ERROR_CODES.has(String(msg?.code || ''))) {
                console.warn('[Controller][YTM]', msg?.message || 'YouTube Music request failed', msg || '');
                return;
            }
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

        socket.on('ytmusic_search_result', (payload) => {
            if (!payload || payload.requestId !== ytmSearchRequestId) return;
            ytmLoading.value = false;
            ytmSearchLoadingMore.value = false;
            const requestMeta = ytmSearchRequestMeta || {
                append: false,
                requestedQuery: String(payload?.query || ytmQuery.value || '').trim(),
                requestedLimit: YTM_SEARCH_PAGE_SIZE,
                previousCount: 0,
                requestedFilter: ytmFilter.value,
                previousSnapshot: null,
                pushedNavigation: false,
                restoreOnFailure: false,
                retry: null,
            };
            if (payload.ok !== true) {
                if (requestMeta.restoreOnFailure && requestMeta.previousSnapshot) {
                    restoreYtmViewState(requestMeta.previousSnapshot);
                } else {
                    ytmSearchCanLoadMore.value = false;
                }
                setYtmErrorState({
                    code: String(payload?.error?.code || 'ytmusic_failed').trim(),
                    scope: 'search',
                    append: !!requestMeta.append,
                    retry: requestMeta.retry || {
                        type: 'search',
                        query: requestMeta.requestedQuery,
                        filter: requestMeta.requestedFilter,
                        append: !!requestMeta.append,
                        limitOverride: requestMeta.requestedLimit,
                        pushCurrentView: !!requestMeta.pushedNavigation,
                        restoreOnFailure: !!requestMeta.restoreOnFailure,
                    },
                });
                ytmSearchRequestMeta = null;
                return;
            }
            clearYtmErrorState();
            ytmSections.value = Array.isArray(payload.sections) ? payload.sections : [];
            const totalCount = countYtmSearchItems(ytmSections.value);
            const canInferSearchEnd = YTM_SEARCH_FILTERS.includes(requestMeta.requestedFilter);
            ytmSearchLimit.value = requestMeta.requestedLimit;
            if (totalCount <= 0) {
                ytmSearchCanLoadMore.value = false;
                ytmSearchReachedEnd.value = false;
                ytmSearchRequestMeta = null;
                return;
            }
            if (requestMeta.append) {
                const hasGrowth = totalCount > requestMeta.previousCount;
                ytmSearchReachedEnd.value = !hasGrowth || requestMeta.requestedLimit >= YTM_SEARCH_MAX_LIMIT || (canInferSearchEnd && totalCount < requestMeta.requestedLimit);
                ytmSearchCanLoadMore.value = hasGrowth && requestMeta.requestedLimit < YTM_SEARCH_MAX_LIMIT && !(canInferSearchEnd && totalCount < requestMeta.requestedLimit);
            } else {
                ytmSearchReachedEnd.value = canInferSearchEnd && totalCount < requestMeta.requestedLimit;
                ytmSearchCanLoadMore.value = !ytmSearchReachedEnd.value && requestMeta.requestedLimit < YTM_SEARCH_MAX_LIMIT;
            }
            ytmSearchRequestMeta = null;
        });

        socket.on('ytmusic_detail_result', (payload) => {
            if (!payload || payload.requestId !== ytmDetailRequestId) return;
            ytmDetailLoading.value = false;
            ytmDetailLoadingMore.value = false;
            const requestMeta = ytmDetailRequestMeta || {
                append: false,
                requestedLimit: 0,
                previousCount: 0,
                detailRequest: ytmActiveDetailRequest.value,
                retry: null,
            };
            if (payload.ok !== true) {
                if (requestMeta.append) {
                    ytmDetailCanLoadMore.value = false;
                } else {
                    const previousView = ytmNavigationStack.value.pop();
                    if (previousView) restoreYtmViewState(previousView);
                }
                setYtmErrorState({
                    code: String(payload?.error?.code || 'ytmusic_failed').trim(),
                    scope: 'detail',
                    append: !!requestMeta.append,
                    retry: requestMeta.retry || {
                        type: 'detail',
                        detailRequest: requestMeta.detailRequest,
                        append: !!requestMeta.append,
                        limitOverride: requestMeta.requestedLimit,
                    },
                });
                ytmDetailRequestMeta = null;
                return;
            }
            clearYtmErrorState();
            ytmDetail.value = payload.detail && typeof payload.detail === 'object' ? payload.detail : null;
            ytmViewMode.value = 'detail';
            ytmDetailLimit.value = requestMeta.requestedLimit;
            ytmActiveDetailRequest.value = requestMeta.detailRequest || ytmActiveDetailRequest.value;
            const totalCount = countYtmDetailItems(ytmDetail.value);
            const paginatable = canPaginateYtmDetail(ytmDetail.value, ytmActiveDetailRequest.value);
            if (!paginatable || totalCount <= 0) {
                ytmDetailCanLoadMore.value = false;
                ytmDetailReachedEnd.value = false;
                ytmDetailRequestMeta = null;
                return;
            }
            if (requestMeta.append) {
                const hasGrowth = totalCount > requestMeta.previousCount;
                ytmDetailReachedEnd.value = !hasGrowth || requestMeta.requestedLimit >= YTM_DETAIL_MAX_LIMIT || totalCount < requestMeta.requestedLimit;
                ytmDetailCanLoadMore.value = hasGrowth && requestMeta.requestedLimit < YTM_DETAIL_MAX_LIMIT && totalCount >= requestMeta.requestedLimit;
            } else {
                ytmDetailReachedEnd.value = totalCount < requestMeta.requestedLimit;
                ytmDetailCanLoadMore.value = !ytmDetailReachedEnd.value && requestMeta.requestedLimit < YTM_DETAIL_MAX_LIMIT;
            }
            ytmDetailRequestMeta = null;
        });

        socket.on('ytmusic_counterparts_result', (payload) => {
            const requestId = String(payload?.requestId || '').trim();
            if (!requestId || !ytmCounterpartRequests.has(requestId)) return;
            const pending = ytmCounterpartRequests.get(requestId);
            ytmCounterpartRequests.delete(requestId);
            if (pending?.timer) clearTimeout(pending.timer);

            if (payload.ok !== true) {
                if (typeof pending?.reject === 'function') {
                    pending.reject(payload?.error || new Error('ytm_counterpart_failed'));
                }
                return;
            }

            const counterpart = Array.isArray(payload.items) && payload.items[0] && payload.items[0].counterpart
                ? payload.items[0].counterpart
                : null;
            if (typeof pending?.resolve === 'function') {
                pending.resolve(counterpart);
            }
        });

        socket.on('parse_result', (result) => {
            if (result && result.list) {
                if (result.list.length === 1) {
                    queueSongs(result.list, { keepBusyState: true });
                } else {
                    openSongSelection(result.list);
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
            showYtmSearch, openYtmSearch, closeYtmSearch,
            showYtmCounterpartChoice, ytmCounterpartChoiceTrack, closeYtmCounterpartChoice, chooseYtmCounterpartVariant,
            ytmQuery, ytmFilter, ytmFilterOptions, ytmSections, ytmDetail,
            ytmViewMode, ytmLoading, ytmDetailLoading, ytmHasSearched, ytmCanGoBack,
            ytmHasVisibleResults, ytmCanLoadMoreCurrent, ytmReachedEndCurrent, ytmLoadingMoreCurrent, ytmErrorState,
            onYtmQueryInput, submitYtmSearch, changeYtmFilter, goBackYtmView,
            getYtmSectionTitle, getYtmItemTypeLabel, openYtmItem, openYtmSection,
            getYtmTrackArtistLinks, getYtmTrackAlbumLink, hasYtmTrackMetaLinks,
            isYtmTrackResolving, isYtmTrackAdded, isYtmTrackBusy, getYtmTrackAddButtonClass,
            openYtmArtistRef, openYtmAlbumRef,
            getYtmErrorTitle, getYtmErrorHint, getYtmLoadedAllText, retryYtmRequest,
            queueSingleYtmTrack, openYtmBatchSelection, queueYtmDetailTracks, loadMoreYtmResults, onYtmResultsScroll,
            showAdvancedSettings, advancedConfig, openAdvancedSettings, closeAdvancedSettings, saveAdvancedSettings, restoreAdvancedDefaults,
            getQueueProgressStyle,
            showTutorialOverlay, tutorialStep, startTutorial, endTutorial, nextStep, prevStep,
            mockPlaying, mockVocalRemoved, mockProcessing, mockVolume, mockPitch,
            mockShowBatch, mockAction, mockBatchList, mockBatchSelectedCount, mockBatchAllSelected
        };
    }
}).mount('#app');
