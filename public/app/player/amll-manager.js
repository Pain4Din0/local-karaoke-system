/**
 * Apple Music-like Lyrics Manager (AMLL Manager)
 */

import { AMLLLyricPlayer } from './amll-lyric-player.js';
import { AMLLMeshBackground } from './amll-mesh-background.js';

export class AMLLManager {
    constructor() {
        this.overlay = null;
        this.bgContainer = null;
        this.content = null;
        this.leftPanel = null;
        this.rightPanel = null;
        this.coverContainer = null;
        this.lyricsContainer = null;
        this.metaContainer = null;
        this.qrContainer = null;

        this.background = null;
        this.lyrics = null;
        this.isVisible = false;
        this.isPlaying = false;
        this.currentTime = 0;
        this.coverImg = null;
        this.coverSource = null;
        this.seekHandler = null;
        this.lineContextMenuHandler = null;
        this.bottomInfo = null;
        this.currentLyricsData = null;
        this.localeStrings = {
            songwriterLabel: 'Songwriter:',
        };
        this.resizeObserver = null;
        this.layoutFrame = 0;
    }

    init(appEl) {
        if (this.overlay) return;

        // Create overlay structure
        this.overlay = document.createElement('div');
        this.overlay.id = 'amll-overlay';
        this.overlay.className = 'amll-overlay amll-shell amll-paused';

        // Background layer
        this.bgContainer = document.createElement('div');
        this.bgContainer.className = 'amll-bg';
        this.overlay.appendChild(this.bgContainer);

        // Content layer
        this.content = document.createElement('div');
        this.content.className = 'amll-content amll-shell-layout';
        this.overlay.appendChild(this.content);

        // Left panel (cover)
        this.leftPanel = document.createElement('div');
        this.leftPanel.className = 'amll-left-panel';
        this.content.appendChild(this.leftPanel);

        this.coverContainer = document.createElement('div');
        this.coverContainer.className = 'amll-cover-wrapper';
        this.leftPanel.appendChild(this.coverContainer);

        this.coverImg = document.createElement('canvas');
        this.coverImg.className = 'amll-cover-img';
        this.coverContainer.appendChild(this.coverImg);

        this.metaContainer = document.createElement('div');
        this.metaContainer.className = 'amll-meta';
        this.leftPanel.appendChild(this.metaContainer);

        // QR code – repositioned bottom-left
        this.qrContainer = document.createElement('div');
        this.qrContainer.className = 'amll-qr-corner';
        this.leftPanel.appendChild(this.qrContainer);

        // Right panel (lyrics)
        this.rightPanel = document.createElement('div');
        this.rightPanel.className = 'amll-right-panel';
        this.content.appendChild(this.rightPanel);

        this.lyricsContainer = document.createElement('div');
        this.lyricsContainer.className = 'amll-lyrics-container';
        this.rightPanel.appendChild(this.lyricsContainer);

        appEl.appendChild(this.overlay);

        // Initialize sub-components now that elements are in the DOM and have bounds
        this.background = new AMLLMeshBackground(this.bgContainer);
        this.lyrics = new AMLLLyricPlayer(this.lyricsContainer);
        this.lyrics.setWordFadeWidth(0.5);
        this.lyrics.setEnableSpring(true);
        this.lyrics.setEnableBlur(true);
        this.lyrics.setEnableScale(true);
        this.lyrics.setHidePassedLines(false);
        this.bottomInfo = document.createElement('div');
        this.bottomInfo.className = 'amll-bottom-info';
        this.lyrics.getBottomLineElement().appendChild(this.bottomInfo);
        this.lyricsContainer.addEventListener('amll-line-click', (event) => {
            const line = event.detail?.line;
            if (!line || !this.seekHandler) return;
            this.seekHandler(line.startTime / 1000);
        });
        this.lyricsContainer.addEventListener('amll-line-contextmenu', (event) => {
            if (!this.lineContextMenuHandler) return;
            this.lineContextMenuHandler(event.detail);
        });

        this.resizeObserver = new ResizeObserver(() => {
            this.scheduleLayoutUpdate();
        });
        this.resizeObserver.observe(this.overlay);
        this.resizeObserver.observe(this.coverContainer);
        this.resizeObserver.observe(this.rightPanel);
        this.scheduleLayoutUpdate();
    }

    setSeekHandler(handler) {
        this.seekHandler = typeof handler === 'function' ? handler : null;
    }

    setLineContextMenuHandler(handler) {
        this.lineContextMenuHandler = typeof handler === 'function' ? handler : null;
    }

    setLocaleStrings(strings = {}) {
        this.localeStrings = {
            ...this.localeStrings,
            ...strings,
        };
        if (this.currentLyricsData) {
            this.setBottomInfo(this.buildBottomInfo(this.currentLyricsData));
        }
    }

    scheduleLayoutUpdate() {
        if (this.layoutFrame) return;
        this.layoutFrame = requestAnimationFrame(() => {
            this.layoutFrame = 0;
            this.updateLayout();
        });
    }

    updateLayout() {
        if (!this.content || !this.coverContainer || !this.rightPanel || !this.lyrics) return;

        const contentRect = this.content.getBoundingClientRect();
        if (!contentRect.width || !contentRect.height) return;

        const isVertical = contentRect.width < contentRect.height;
        this.content.classList.toggle('amll-vertical', isVertical);
        this.content.classList.toggle('amll-horizontal', !isVertical);

        this.lyrics.setWordFadeWidth(0.5);
        this.lyrics.setEnableSpring(true);
        this.lyrics.setEnableBlur(true);
        this.lyrics.setEnableScale(true);
        this.lyrics.setHidePassedLines(false);

        if (isVertical) {
            this.lyrics.setAlignAnchor('top');
            this.lyrics.setAlignPosition(0.1);
            return;
        }

        this.lyrics.setAlignAnchor('center');
        this.lyrics.setAlignPosition(0.44);
        this.redrawCover();
    }

    async setAlbumArt(videoElement, picUrl) {
        if (!videoElement) return;

        try {
            let source = null;

            if (videoElement.readyState >= 2 && videoElement.videoWidth > 0 && videoElement.videoHeight > 0) {
                source = videoElement;
            } else if (picUrl) {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                const imageReady = new Promise((resolve, reject) => {
                    img.onload = () => resolve(img);
                    img.onerror = reject;
                });
                img.src = picUrl;
                try {
                    await imageReady;
                    source = img;
                } catch (e) {
                    source = null;
                }
            }

            this.coverSource = source || videoElement;
            this.redrawCover();

            if (this.background) {
                await this.background.setAlbum(this.coverImg);
            }
            this.scheduleLayoutUpdate();
        } catch (error) {
            console.warn('[AMLL] Failed to set album art:', error);
        }
    }

    refreshCover(videoElement) {
        if (!videoElement || !this.coverImg) return;
        try {
            this.coverSource = videoElement;
            this.redrawCover();
            if (this.background) {
                this.background.setAlbum(this.coverImg);
            }
            this.scheduleLayoutUpdate();
        } catch (e) {
            // ignore cross-origin
        }
    }

    setMeta(title, artist, requester) {
        if (!this.metaContainer) return;
        this.metaContainer.innerHTML = `
            <div class="amll-meta-title">${this._escapeHtml(title || '')}</div>
            <div class="amll-meta-artist">${this._escapeHtml(artist || '')}</div>
        `;
        this.scheduleLayoutUpdate();
    }

    setBottomInfo(content = '') {
        if (!this.bottomInfo) return;
        this.bottomInfo.innerHTML = content || '';
        this.scheduleLayoutUpdate();
    }

    setLyrics(lyricsData) {
        if (!this.lyrics) return;
        this.currentLyricsData = lyricsData;
        this.lyrics.setLines(lyricsData);
        this.lyrics.seek(this.currentTime);
        this.lyrics.setPlaying(this.isPlaying);
        this.setBottomInfo(this.buildBottomInfo(lyricsData));
        this.scheduleLayoutUpdate();
    }

    setCurrentTime(seconds) {
        this.currentTime = seconds;
        if (!this.lyrics) return;
        this.lyrics.setCurrentTime(seconds);
    }

    setLowFreqVolume(volume) {
        if (!this.background) return;
        this.background.setLowFreqVolume(volume);
    }

    seek(seconds) {
        this.currentTime = seconds;
        if (!this.lyrics) return;
        this.lyrics.seek(seconds);
    }

    setPlaying(playing) {
        this.isPlaying = playing;
        if (this.lyrics) this.lyrics.setPlaying(playing);
        if (this.background) {
            if (playing) this.background.play();
            else this.background.pause();
        }
        if (this.overlay) {
            this.overlay.classList.toggle('amll-paused', !playing);
        }
    }

    show() {
        if (this.isVisible) return;
        this.isVisible = true;
        if (this.overlay) {
            this.overlay.classList.add('amll-visible');
        }
        document.body.dataset.amllLyricsOpen = '';
        this.scheduleLayoutUpdate();
    }

    hide() {
        if (!this.isVisible) return;
        this.isVisible = false;
        if (this.overlay) {
            this.overlay.classList.remove('amll-visible');
        }
        if (this.lyrics) this.lyrics.setPlaying(false);
        if (this.background) this.background.pause();
        delete document.body.dataset.amllLyricsOpen;
    }

    moveQRCode(qrElement) {
        if (!this.qrContainer || !qrElement) return;
        // Clone the QR content
        this.qrContainer.innerHTML = '';
        const clone = qrElement.cloneNode(true);
        clone.style.width = '100px';
        clone.style.height = '100px';
        // Scale inner images
        const imgs = clone.querySelectorAll('img, canvas');
        for (const img of imgs) {
            img.style.width = '100px';
            img.style.height = '100px';
        }
        this.qrContainer.appendChild(clone);
        this.scheduleLayoutUpdate();
    }

    dispose() {
        this.hide();
        if (this.background) this.background.dispose();
        if (this.lyrics) this.lyrics.dispose();
        if (this.resizeObserver) this.resizeObserver.disconnect();
        if (this.layoutFrame) {
            cancelAnimationFrame(this.layoutFrame);
            this.layoutFrame = 0;
        }
        if (this.overlay && this.overlay.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
        }
        this.overlay = null;
        this.background = null;
        this.lyrics = null;
        this.resizeObserver = null;
        this.currentLyricsData = null;
        this.coverSource = null;
    }

    resizeCoverCanvas() {
        if (!this.coverImg || !this.coverContainer) return false;
        const rect = this.coverContainer.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round((rect.width || 400) * dpr));
        const height = Math.max(1, Math.round((rect.height || rect.width || 400) * dpr));
        if (this.coverImg.width === width && this.coverImg.height === height) {
            return false;
        }
        this.coverImg.width = width;
        this.coverImg.height = height;
        return true;
    }

    redrawCover() {
        if (!this.coverImg || !this.coverSource) return;
        const resized = this.resizeCoverCanvas();
        try {
            const ctx = this.coverImg.getContext('2d', { alpha: false });
            if (!ctx) return;
            const width = this.coverImg.width || 400;
            const height = this.coverImg.height || 400;
            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(this.coverSource, 0, 0, width, height);
            if (resized) {
                this.scheduleLayoutUpdate();
            }
        } catch (error) {
            const ctx = this.coverImg.getContext('2d', { alpha: false });
            if (!ctx) return;
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, this.coverImg.width || 400, this.coverImg.height || 400);
        }
    }

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    buildBottomInfo(lyricsData) {
        const songwriters = lyricsData?.metadata?.songwriters;
        if (!Array.isArray(songwriters) || songwriters.length === 0) return '';
        const names = songwriters
            .map((name) => this._escapeHtml(String(name || '').trim()))
            .filter((name) => name.length > 0);
        if (names.length === 0) return '';
        const label = this._escapeHtml(this.localeStrings.songwriterLabel || 'Songwriter:');
        return `<strong>${label}</strong>${names.join(', ')}`;
    }
}
