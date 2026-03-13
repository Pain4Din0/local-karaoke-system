const fs = require('fs');
const path = require('path');

const { DOWNLOAD_DIR, SEPARATED_DIR, ensureRuntimeDirs } = require('../config/runtime');
const logger = require('../utils/logger');

const GENERATED_MEDIA_PATTERN = /^\d+_(?:video|audio|karaoke)\.[a-z0-9]+$/i;
const GENERATED_LYRICS_PATTERN = /^\d+_(?:lyrics_[a-z0-9_-]+\.json|lyriccap.*\.vtt)$/i;
const TEMP_FILE_PATTERN = /\.(?:part|tmp|temp|ytdl)$/i;

const safeReadDir = (dirPath) => {
    try {
        return fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (error) {
        logger.warn('Cleanup', `Failed to list directory: ${dirPath}`, error);
        return [];
    }
};

const safeRemovePath = (targetPath) => {
    try {
        fs.rmSync(targetPath, { recursive: true, force: true });
        return true;
    } catch (error) {
        logger.warn('Cleanup', `Failed to remove path: ${targetPath}`, error);
        return false;
    }
};

const isRuntimeDownloadArtifact = (filename, removeMedia = true) => {
    if (TEMP_FILE_PATTERN.test(filename)) return true;
    if (GENERATED_LYRICS_PATTERN.test(filename)) return true;
    if (removeMedia && GENERATED_MEDIA_PATTERN.test(filename)) return true;
    return false;
};

const cleanupDownloadArtifacts = ({ removeMedia = true, reason = 'manual' } = {}) => {
    ensureRuntimeDirs();
    const removed = [];

    for (const entry of safeReadDir(DOWNLOAD_DIR)) {
        if (!entry.isFile()) continue;
        if (!isRuntimeDownloadArtifact(entry.name, removeMedia)) continue;
        const fullPath = path.join(DOWNLOAD_DIR, entry.name);
        if (safeRemovePath(fullPath)) {
            removed.push(entry.name);
        }
    }

    if (removed.length > 0) {
        logger.info('Cleanup', `Removed ${removed.length} download artifact(s)`, {
            reason,
            files: removed.slice(0, 20),
            truncated: removed.length > 20 ? removed.length - 20 : 0,
        });
    }

    return removed.length;
};

const cleanupSeparatedArtifacts = ({ reason = 'manual' } = {}) => {
    ensureRuntimeDirs();
    let removed = 0;

    for (const entry of safeReadDir(SEPARATED_DIR)) {
        const fullPath = path.join(SEPARATED_DIR, entry.name);
        if (safeRemovePath(fullPath)) {
            removed += 1;
        }
    }

    if (removed > 0) {
        logger.info('Cleanup', `Removed ${removed} separated artifact(s)`, { reason });
    }

    return removed;
};

const cleanupRuntimeArtifacts = ({ removeMedia = true, reason = 'manual' } = {}) => {
    const removedDownloads = cleanupDownloadArtifacts({ removeMedia, reason });
    const removedSeparated = cleanupSeparatedArtifacts({ reason });
    return { removedDownloads, removedSeparated };
};

module.exports = {
    cleanupDownloadArtifacts,
    cleanupSeparatedArtifacts,
    cleanupRuntimeArtifacts,
};
