let lastIssuedMs = 0;
let issuedCount = 0;

const clampText = (value, fallback = '', maxLength = 300) => {
    if (value === undefined || value === null) return fallback;
    const text = String(value).trim();
    if (!text) return fallback;
    return text.slice(0, maxLength);
};

const normalizeDuration = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return Math.round(numeric);
};

const generateSongId = () => {
    const now = Date.now();
    if (now === lastIssuedMs) {
        issuedCount += 1;
    } else {
        lastIssuedMs = now;
        issuedCount = 0;
    }
    return (now * 1000) + issuedCount;
};

const getRequesterName = (requester) => clampText(requester, 'Guest', 80);

const buildBaseSong = (meta = {}, requester = 'Guest') => {
    const title = clampText(meta.title, clampText(meta.track, 'Unknown Title'));
    const uploader = clampText(meta.uploader, 'Unknown');
    const artist = clampText(meta.artist, uploader);

    return {
        id: generateSongId(),
        title,
        uploader,
        artist,
        album: clampText(meta.album, ''),
        track: clampText(meta.track, title),
        duration: normalizeDuration(meta.duration),
        sourceId: clampText(meta.sourceId, '', 120) || null,
        extractor: clampText(meta.extractor, '', 80) || null,
        pic: meta.pic || null,
        requester: getRequesterName(requester),
        originalUrl: clampText(meta.originalUrl, '', 2048),
        status: 'pending',
        progress: 0,
        src: null,
        audioSrc: null,
        localVideoPath: null,
        localAudioPath: null,
        loudnessGain: 0,
        karaokeReady: false,
        karaokeProcessing: false,
        karaokeProgress: 0,
        karaokeSrc: null,
        lyricsData: null,
        lyricsStatus: 'idle',
        lyricsSource: null,
        lyricsType: null,
        lyricsAvailable: false,
        lastError: null,
        createdAt: new Date().toISOString(),
    };
};

const createSongFromMeta = (meta, requester) => buildBaseSong(meta, requester);

const createSongFromHistoryItem = (historyItem = {}) => {
    const replaySong = buildBaseSong(historyItem, historyItem.requester);
    replaySong.originalUrl = clampText(historyItem.originalUrl, replaySong.originalUrl, 2048);
    replaySong.pic = historyItem.pic || null;
    replaySong.sourceId = clampText(historyItem.sourceId, replaySong.sourceId || '', 120) || null;
    replaySong.extractor = clampText(historyItem.extractor, replaySong.extractor || '', 80) || null;
    return replaySong;
};

const setSongError = (song, message, stage = 'runtime') => {
    if (!song) return;
    song.lastError = {
        stage,
        message: clampText(message, 'Unknown error', 500),
        at: new Date().toISOString(),
    };
};

module.exports = {
    createSongFromMeta,
    createSongFromHistoryItem,
    getRequesterName,
    setSongError,
};
