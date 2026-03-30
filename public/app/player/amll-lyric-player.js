const STYLE = {
    root: 'amll-lyric-player',
    dom: 'dom',
    playing: 'playing',
    disableSpring: 'amll-lp-disable-spring',
    hasDuetLine: 'amll-lp-has-duet-line',
    line: 'amll-lp-line',
    bgLine: 'amll-lp-bg-line',
    duetLine: 'amll-lp-duet-line',
    mainLine: 'amll-lp-main-line',
    subLine: 'amll-lp-sub-line',
    romanWord: 'amll-lp-roman-word',
    rubyWord: 'amll-lp-ruby-word',
    wordWithRuby: 'amll-lp-word-with-ruby',
    wordBody: 'amll-lp-word-body',
    emphasizeWrapper: 'amll-lp-emphasize-wrapper',
    emphasize: 'amll-lp-emphasize',
    interludeDots: 'amll-lp-interlude-dots',
    bottomLine: 'amll-lp-bottom-line',
    enabled: 'amll-lp-enabled',
    duet: 'amll-lp-duet',
    active: 'amll-lp-active',
    tmpDisableTransition: 'amll-lp-tmp-disable-transition',
    dirty: 'amll-lp-dirty',
};

const LYRIC_RENDER_MODE = {
    SOLID: 0,
    GRADIENT: 1,
};

const DEFAULT_MAIN_LINE_HEIGHT_RATIO = 5;
const ANIMATION_FRAME_QUANTITY = 32;

const isCJK = (char) => /^[\p{Unified_Ideograph}\u0800-\u9FFC]+$/u.test(char || '');

const derivative = (fn) => {
    const h = 0.001;
    return (x) => (fn(x + h) - fn(x - h)) / (2 * h);
};

const getVelocity = (fn) => derivative(fn);

const structuredCloneSafe = (value) => {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
};

const detectLyricTextLang = (text) => {
    if (!text) return '';
    if (/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/u.test(text)) return 'ko';
    if (/[\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff]/u.test(text)) return 'ja';
    if (/[體國樂藝灣廣東歲劍聲學醫龍歡點燈貓戀櫻雙證讓讀變靜]/u.test(text)) return 'zh-Hant';
    if (/[\u3400-\u4dbf\u4e00-\u9fff]/u.test(text)) return 'zh-Hans';
    return '';
};

const detectStrongLyricTextLang = (text) => {
    if (!text) return '';
    if (/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/u.test(text)) return 'ko';
    if (/[\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff]/u.test(text)) return 'ja';
    if (/[體國樂藝灣廣東歲劍聲學醫龍歡點燈貓戀櫻雙證讓讀變靜]/u.test(text)) return 'zh-Hant';
    return '';
};

const inferPreferredLyricLang = (lines) => {
    const counts = new Map();
    for (const line of lines) {
        const text = line?.words?.map((word) => word.word).join('') || '';
        const lang = detectStrongLyricTextLang(text);
        if (!lang) continue;
        counts.set(lang, (counts.get(lang) || 0) + 1);
    }
    let preferred = '';
    let maxCount = 0;
    for (const [lang, count] of counts.entries()) {
        if (count > maxCount) {
            preferred = lang;
            maxCount = count;
        }
    }
    return preferred;
};

const cubicBezier = (mX1, mY1, mX2, mY2) => {
    if (mX1 === mY1 && mX2 === mY2) return (x) => x;

    const NEWTON_ITERATIONS = 4;
    const NEWTON_MIN_SLOPE = 0.001;
    const SUBDIVISION_PRECISION = 1e-7;
    const SUBDIVISION_MAX_ITERATIONS = 10;
    const SPLINE_TABLE_SIZE = 11;
    const SAMPLE_STEP_SIZE = 1 / (SPLINE_TABLE_SIZE - 1);

    const sampleValues = new Float32Array(SPLINE_TABLE_SIZE);

    const A = (a1, a2) => 1 - 3 * a2 + 3 * a1;
    const B = (a1, a2) => 3 * a2 - 6 * a1;
    const C = (a1) => 3 * a1;
    const calcBezier = (t, a1, a2) => (((A(a1, a2) * t + B(a1, a2)) * t) + C(a1)) * t;
    const getSlope = (t, a1, a2) => (3 * A(a1, a2) * t * t) + (2 * B(a1, a2) * t) + C(a1);

    for (let i = 0; i < SPLINE_TABLE_SIZE; i++) {
        sampleValues[i] = calcBezier(i * SAMPLE_STEP_SIZE, mX1, mX2);
    }

    const binarySubdivide = (x, a, b) => {
        let currentX;
        let currentT;
        let i = 0;
        do {
            currentT = a + ((b - a) / 2);
            currentX = calcBezier(currentT, mX1, mX2) - x;
            if (currentX > 0) {
                b = currentT;
            } else {
                a = currentT;
            }
        } while (Math.abs(currentX) > SUBDIVISION_PRECISION && ++i < SUBDIVISION_MAX_ITERATIONS);
        return currentT;
    };

    const newtonRaphsonIterate = (x, guessT) => {
        let t = guessT;
        for (let i = 0; i < NEWTON_ITERATIONS; i++) {
            const currentSlope = getSlope(t, mX1, mX2);
            if (currentSlope === 0) return t;
            const currentX = calcBezier(t, mX1, mX2) - x;
            t -= currentX / currentSlope;
        }
        return t;
    };

    const getTForX = (x) => {
        let intervalStart = 0;
        let currentSample = 1;
        const lastSample = SPLINE_TABLE_SIZE - 1;

        for (; currentSample !== lastSample && sampleValues[currentSample] <= x; currentSample++) {
            intervalStart += SAMPLE_STEP_SIZE;
        }
        currentSample -= 1;

        const dist = (x - sampleValues[currentSample]) / (sampleValues[currentSample + 1] - sampleValues[currentSample]);
        const guessForT = intervalStart + (dist * SAMPLE_STEP_SIZE);
        const initialSlope = getSlope(guessForT, mX1, mX2);

        if (initialSlope >= NEWTON_MIN_SLOPE) return newtonRaphsonIterate(x, guessForT);
        if (initialSlope === 0) return guessForT;
        return binarySubdivide(x, intervalStart, intervalStart + SAMPLE_STEP_SIZE);
    };

    return (x) => {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        return calcBezier(getTForX(x), mY1, mY2);
    };
};

const norNum = (min, max) => (x) => Math.min(1, Math.max(0, (x - min) / (max - min)));
const EMP_EASING_MID = 0.5;
const beginNum = norNum(0, EMP_EASING_MID);
const endNum = norNum(EMP_EASING_MID, 1);
const bezIn = cubicBezier(0.2, 0.4, 0.58, 1.0);
const bezOut = cubicBezier(0.3, 0.0, 0.58, 1.0);
const makeEmpEasing = (mid) => (x) => (x < mid ? bezIn(beginNum(x)) : 1 - bezOut(endNum(x)));

function createMatrix4() {
    return [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
    ];
}

function scaleMatrix4(m, scale = 1, origin = { x: 0, y: 0 }) {
    const ox = origin.x;
    const oy = origin.y;
    return [
        m[0] * scale, m[1] * scale, m[2] * scale, m[3],
        m[4] * scale, m[5] * scale, m[6] * scale, m[7],
        m[8] * scale, m[9] * scale, m[10] * scale, m[11],
        m[12] - ox * scale + ox, m[13] - oy * scale + oy, m[14], m[15],
    ];
}

function matrix4ToCSS(m, fractionDigits = 4) {
    return `matrix3d(${m.map((n) => n.toFixed(fractionDigits)).join(', ')})`;
}

class Spring {
    constructor(currentPosition = 0) {
        this.targetPosition = currentPosition;
        this.currentPosition = currentPosition;
        this.currentTime = 0;
        this.params = {};
        this.currentSolver = () => this.targetPosition;
        this.getV = () => 0;
        this.getV2 = () => 0;
        this.queueParams = undefined;
        this.queuePosition = undefined;
    }

    resetSolver() {
        const curV = this.getV(this.currentTime);
        this.currentTime = 0;
        this.currentSolver = solveSpring(
            this.currentPosition,
            curV,
            this.targetPosition,
            0,
            this.params,
        );
        this.getV = getVelocity(this.currentSolver);
        this.getV2 = getVelocity(this.getV);
    }

    arrived() {
        return (
            Math.abs(this.targetPosition - this.currentPosition) < 0.01 &&
            this.getV(this.currentTime) < 0.01 &&
            this.getV2(this.currentTime) < 0.01 &&
            this.queueParams === undefined &&
            this.queuePosition === undefined
        );
    }

    setPosition(targetPosition) {
        this.targetPosition = targetPosition;
        this.currentPosition = targetPosition;
        this.currentSolver = () => this.targetPosition;
        this.getV = () => 0;
        this.getV2 = () => 0;
    }

    update(delta = 0) {
        this.currentTime += delta;
        this.currentPosition = this.currentSolver(this.currentTime);

        if (this.queueParams) {
            this.queueParams.time -= delta;
            if (this.queueParams.time <= 0) {
                this.updateParams({ ...this.queueParams });
            }
        }
        if (this.queuePosition) {
            this.queuePosition.time -= delta;
            if (this.queuePosition.time <= 0) {
                this.setTargetPosition(this.queuePosition.position);
            }
        }
        if (this.arrived()) {
            this.setPosition(this.targetPosition);
        }
    }

    updateParams(params, delay = 0) {
        if (delay > 0) {
            this.queueParams = {
                ...(this.queuePosition ?? {}),
                ...params,
                time: delay,
            };
            return;
        }

        this.queuePosition = undefined;
        this.params = {
            ...this.params,
            ...params,
        };
        this.resetSolver();
    }

    setTargetPosition(targetPosition, delay = 0) {
        if (delay > 0) {
            this.queuePosition = {
                ...(this.queuePosition ?? {}),
                position: targetPosition,
                time: delay,
            };
            return;
        }

        this.queuePosition = undefined;
        this.targetPosition = targetPosition;
        this.resetSolver();
    }

    getCurrentPosition() {
        return this.currentPosition;
    }
}

function solveSpring(from, velocity, to, delay = 0, params = {}) {
    const soft = params.soft ?? false;
    const stiffness = params.stiffness ?? 100;
    const damping = params.damping ?? 10;
    const mass = params.mass ?? 1;
    const delta = to - from;

    if (soft || 1.0 <= damping / (2.0 * Math.sqrt(stiffness * mass))) {
        const angularFrequency = -Math.sqrt(stiffness / mass);
        const leftover = -angularFrequency * delta - velocity;
        return (t) => {
            const time = t - delay;
            if (time < 0) return from;
            return to - (delta + time * leftover) * Math.E ** (time * angularFrequency);
        };
    }

    const dampingFrequency = Math.sqrt(4.0 * mass * stiffness - damping ** 2.0);
    const leftover = (damping * delta - 2.0 * mass * velocity) / dampingFrequency;
    const dfm = (0.5 * dampingFrequency) / mass;
    const dm = -(0.5 * damping) / mass;
    return (t) => {
        const time = t - delay;
        if (time < 0) return from;
        return to - (
            (Math.cos(time * dfm) * delta + Math.sin(time * dfm) * leftover) *
            Math.E ** (time * dm)
        );
    };
}

function generateFadeGradient(
    width,
    padding = 0,
    bright = 'rgba(0,0,0,var(--bright-mask-alpha, 1.0))',
    dark = 'rgba(0,0,0,var(--dark-mask-alpha, 1.0))',
) {
    const totalAspect = 2 + width + padding;
    const widthInTotal = width / totalAspect;
    const leftPos = (1 - widthInTotal) / 2;
    return [
        `linear-gradient(to right,${bright} ${leftPos * 100}%,${dark} ${(leftPos + widthInTotal) * 100}%)`,
        totalAspect,
    ];
}

function chunkAndSplitLyricWords(words) {
    const atoms = [];
    const hasSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter !== 'undefined';

    for (const word of words) {
        const content = (word.word || '').trim();
        const isSpace = content.length === 0;
        const romanWord = word.romanWord ?? '';
        const obscene = word.obscene ?? false;
        const hasRuby = (word.ruby?.length ?? 0) > 0;

        if (isSpace || hasRuby) {
            atoms.push({ ...word });
            continue;
        }

        const parts = String(word.word || '').split(/(\s+)/).filter((part) => part.length > 0);
        let currentOffset = 0;
        const totalLength = String(word.word || '').replace(/\s/g, '').length || 1;

        for (const part of parts) {
            if (!part.trim()) {
                const startTime = word.startTime + (currentOffset / totalLength) * (word.endTime - word.startTime);
                atoms.push({
                    ...word,
                    word: part,
                    romanWord: '',
                    startTime,
                    endTime: startTime,
                    obscene,
                });
                continue;
            }

            if (isCJK(part) && part.length > 1 && romanWord.trim().length === 0) {
                for (const char of part.split('')) {
                    const charDuration = (1 / totalLength) * (word.endTime - word.startTime);
                    const startTime = word.startTime + (currentOffset / totalLength) * (word.endTime - word.startTime);
                    atoms.push({
                        ...word,
                        word: char,
                        romanWord: '',
                        startTime,
                        endTime: startTime + charDuration,
                        obscene,
                    });
                    currentOffset += 1;
                }
                continue;
            }

            const partRealLen = part.length;
            const duration = (partRealLen / totalLength) * (word.endTime - word.startTime);
            const startTime = word.startTime + (currentOffset / totalLength) * (word.endTime - word.startTime);
            atoms.push({
                ...word,
                word: part,
                romanWord,
                startTime,
                endTime: startTime + duration,
                obscene,
            });
            currentOffset += partRealLen;
        }
    }

    if (!hasSegmenter) {
        return atoms;
    }

    const fullText = atoms.map((atom) => atom.word).join('');
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    const segments = Array.from(segmenter.segment(fullText));
    const result = [];
    let atomIndex = 0;
    let expectedLength = 0;
    let actualLength = 0;
    let currentGroup = [];

    for (const segment of segments) {
        expectedLength += segment.segment.length;
        while (actualLength < expectedLength && atomIndex < atoms.length) {
            const currentAtom = atoms[atomIndex];
            currentGroup.push(currentAtom);
            actualLength += currentAtom.word.length;
            atomIndex += 1;
        }

        if (actualLength === expectedLength) {
            while (currentGroup.length > 1 && !currentGroup[0].word.trim()) {
                result.push(currentGroup.shift());
            }
            if (currentGroup.length === 1) {
                result.push(currentGroup[0]);
            } else if (currentGroup.length > 1) {
                result.push(currentGroup);
            }
            currentGroup = [];
        }
    }

    while (atomIndex < atoms.length) {
        result.push(atoms[atomIndex]);
        atomIndex += 1;
    }

    if (currentGroup.length > 0) {
        result.push(currentGroup.length === 1 ? currentGroup[0] : currentGroup);
    }

    return result;
}

function resetLineTimestamps(lines) {
    for (const line of lines) {
        if (
            line.words.length === 1 &&
            line.words[0].startTime === 0 &&
            line.words[0].endTime === 0 &&
            (line.startTime !== 0 || line.endTime !== 0)
        ) {
            line.words[0].startTime = line.startTime;
            line.words[0].endTime = line.endTime;
        } else if (line.words.length > 0) {
            line.startTime = line.words[0].startTime;
            line.endTime = line.words[line.words.length - 1].endTime;
        }
    }
}

function convertExcessiveBackgroundLines(lines) {
    let consecutiveBgCount = 0;
    for (const line of lines) {
        if (line.isBG) {
            consecutiveBgCount += 1;
            if (consecutiveBgCount > 1) {
                line.isBG = false;
            }
        } else {
            consecutiveBgCount = 0;
        }
    }
}

function syncMainAndBackgroundLines(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.isBG) continue;
        const nextLine = lines[i + 1];
        if (!nextLine?.isBG) continue;

        const allWords = [...line.words, ...nextLine.words].filter((word) => word.word.trim().length > 0);
        if (allWords.length === 0) continue;

        const minStart = Math.min(...allWords.map((word) => word.startTime));
        const maxEnd = Math.max(...allWords.map((word) => word.endTime));
        const finalStart = Math.min(minStart, line.startTime, nextLine.startTime);
        const finalEnd = Math.max(maxEnd, line.endTime, nextLine.endTime);
        line.startTime = finalStart;
        line.endTime = finalEnd;
        nextLine.startTime = finalStart;
        nextLine.endTime = finalEnd;
    }
}

function cleanUnintentionalOverlaps(lines) {
    for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        if (line.isBG) continue;

        let nextMainIndex = i + 1;
        while (nextMainIndex < lines.length && lines[nextMainIndex].isBG) {
            nextMainIndex += 1;
        }

        if (nextMainIndex >= lines.length) continue;

        const nextLine = lines[nextMainIndex];
        const overlap = line.endTime - nextLine.startTime;
        if (overlap <= 0) continue;

        const nextDuration = nextLine.endTime - nextLine.startTime;
        const percentageThreshold = nextDuration * 0.1;
        const isIntentionalOverlap = overlap > 100 && overlap > percentageThreshold;
        if (isIntentionalOverlap) continue;

        line.endTime = nextLine.startTime;
        const attachedBgLine = lines[i + 1];
        if (attachedBgLine?.isBG) {
            attachedBgLine.endTime = nextLine.startTime;
        }
    }
}

function tryAdvanceStartTime(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.isBG) continue;

        let prevLine = null;
        if (i > 0) {
            let prevIndex = i - 1;
            if (lines[prevIndex].isBG) prevIndex -= 1;
            if (prevIndex >= 0) prevLine = lines[prevIndex];
        }

        let targetAdvanceAmount = 0;
        let safeBoundary = 0;
        if (prevLine) {
            const originallyHadGap = line.startTime >= prevLine.endTime;
            if (originallyHadGap) {
                targetAdvanceAmount = 1000;
                safeBoundary = prevLine.endTime;
            } else {
                targetAdvanceAmount = 400;
                const prevDuration = prevLine.endTime - prevLine.startTime;
                safeBoundary = prevLine.startTime + prevDuration * 0.3;
            }
        } else {
            targetAdvanceAmount = 1000;
        }

        const targetTime = line.startTime - targetAdvanceAmount;
        const newStartTime = Math.max(safeBoundary, targetTime);
        if (newStartTime < line.startTime) {
            line.startTime = newStartTime;
        }

        const nextLine = lines[i + 1];
        if (nextLine?.isBG) {
            nextLine.startTime = line.startTime;
        }
    }
}

function optimizeLyricLines(lines) {
    for (const line of lines) {
        for (const word of line.words) {
            word.word = String(word.word || '').replace(/\s+/g, ' ');
        }
    }

    resetLineTimestamps(lines);
    convertExcessiveBackgroundLines(lines);
    syncMainAndBackgroundLines(lines);
    cleanUnintentionalOverlaps(lines);
    tryAdvanceStartTime(lines);
}

function easeInOutBack(x) {
    const c1 = 1.70158;
    const c2 = c1 * 1.525;
    return x < 0.5
        ? ((2 * x) ** 2 * (((c2 + 1) * 2 * x) - c2)) / 2
        : (((2 * x - 2) ** 2 * (((c2 + 1) * (x * 2 - 2)) + c2)) + 2) / 2;
}

function easeOutExpo(x) {
    return x === 1 ? 1 : 1 - 2 ** (-10 * x);
}

function clamp(min, cur, max) {
    return Math.max(min, Math.min(cur, max));
}

const LINE_CLICK_EVENT = 'amll-line-click';

class InterludeDots {
    constructor() {
        this.element = document.createElement('div');
        this.dot0 = document.createElement('span');
        this.dot1 = document.createElement('span');
        this.dot2 = document.createElement('span');
        this.left = 0;
        this.top = 0;
        this.playing = true;
        this.lastStyle = '';
        this.currentInterlude = undefined;
        this.currentTime = 0;
        this.targetBreatheDuration = 1500;

        this.element.className = STYLE.interludeDots;
        this.element.append(this.dot0, this.dot1, this.dot2);
    }

    getElement() {
        return this.element;
    }

    setTransform(left = this.left, top = this.top) {
        this.left = left;
        this.top = top;
        this.update(0);
    }

    setInterlude(interlude) {
        this.currentInterlude = interlude;
        this.currentTime = interlude?.[0] ?? 0;
        this.element.classList.toggle(STYLE.enabled, !!interlude);
    }

    setDuet(duet) {
        this.element.classList.toggle(STYLE.duet, !!duet);
    }

    pause() {
        this.playing = false;
        this.element.classList.remove(STYLE.playing);
    }

    resume() {
        this.playing = true;
        this.element.classList.add(STYLE.playing);
    }

    update(delta = 0) {
        if (!this.playing) return;
        this.currentTime += delta;

        let style = `transform:translate(${this.left.toFixed(2)}px, ${this.top.toFixed(2)}px)`;
        if (!this.currentInterlude) {
            style += ' scale(0);';
            if (style !== this.lastStyle) {
                this.element.setAttribute('style', style);
                this.lastStyle = style;
            }
            this.dot0.style.opacity = '0';
            this.dot1.style.opacity = '0';
            this.dot2.style.opacity = '0';
            return;
        }

        const interludeDuration = this.currentInterlude[1] - this.currentInterlude[0];
        const currentDuration = this.currentTime - this.currentInterlude[0];
        if (currentDuration <= interludeDuration) {
            const breatheDuration = interludeDuration / Math.ceil(interludeDuration / this.targetBreatheDuration);
            let scale = 1;
            let globalOpacity = 1;

            scale *= (Math.sin(1.5 * Math.PI - (currentDuration / breatheDuration) * 2) / 20) + 1;
            if (currentDuration < 2000) {
                scale *= easeOutExpo(currentDuration / 2000);
            }
            if (currentDuration < 500) {
                globalOpacity = 0;
            } else if (currentDuration < 1000) {
                globalOpacity *= (currentDuration - 500) / 500;
            }
            if (interludeDuration - currentDuration < 750) {
                scale *= 1 - easeInOutBack((750 - (interludeDuration - currentDuration)) / 750 / 2);
            }
            if (interludeDuration - currentDuration < 375) {
                globalOpacity *= clamp(0, (interludeDuration - currentDuration) / 375, 1);
            }

            const dotsDuration = Math.max(0, interludeDuration - 750);
            scale = Math.max(0, scale) * 0.7;
            style += ` scale(${scale})`;

            const dot0Opacity = clamp(0.25, ((currentDuration * 3) / dotsDuration) * 0.75, 1);
            const dot1Opacity = clamp(0.25, (((currentDuration - dotsDuration / 3) * 3) / dotsDuration) * 0.75, 1);
            const dot2Opacity = clamp(0.25, (((currentDuration - ((dotsDuration / 3) * 2)) * 3) / dotsDuration) * 0.75, 1);

            this.dot0.style.opacity = String(clamp(0, Math.max(0, globalOpacity * dot0Opacity), 1));
            this.dot1.style.opacity = String(clamp(0, Math.max(0, globalOpacity * dot1Opacity), 1));
            this.dot2.style.opacity = String(clamp(0, Math.max(0, globalOpacity * dot2Opacity), 1));
        } else {
            style += ' scale(0)';
            this.dot0.style.opacity = '0';
            this.dot1.style.opacity = '0';
            this.dot2.style.opacity = '0';
        }

        style += ';';
        if (style !== this.lastStyle) {
            this.element.setAttribute('style', style);
            this.lastStyle = style;
        }
    }

    dispose() {
        this.element.remove();
    }
}

class BottomLineEl {
    constructor(lyricPlayer) {
        this.lyricPlayer = lyricPlayer;
        this.element = document.createElement('div');
        this.left = 0;
        this.top = 0;
        this.delay = 0;
        this.lineSize = [0, 0];
        this.lastStyle = '';
        this.isFocused = false;
        this.blur = 0;
        this.lineTransforms = {
            posX: new Spring(0),
            posY: new Spring(0),
        };

        this.element.className = `${STYLE.line} ${STYLE.bottomLine}`;
        this.element.dataset.bottomLine = 'true';
        this.rebuildStyle();
    }

    getElement() {
        return this.element;
    }

    show() {
        this.rebuildStyle();
    }

    hide() {
        this.rebuildStyle();
    }

    setFocused(focused = false) {
        if (this.isFocused === !!focused) return;
        this.isFocused = !!focused;
        if (this.isFocused) {
            this.element.dataset.focused = 'true';
        } else {
            delete this.element.dataset.focused;
        }
    }

    setTransform(left = this.left, top = this.top, blur = 0, force = false, delay = 0) {
        this.left = left;
        this.top = top;
        this.delay = (delay * 1000) | 0;
        if (force || !this.lyricPlayer.getEnableSpring()) {
            this.blur = Math.min(32, blur);
            if (force) this.element.classList.add(STYLE.tmpDisableTransition);
            this.lineTransforms.posX.setPosition(left);
            this.lineTransforms.posY.setPosition(top);
            if (!this.lyricPlayer.getEnableSpring()) this.show();
            else this.rebuildStyle();
            if (force) {
                requestAnimationFrame(() => {
                    this.element.classList.remove(STYLE.tmpDisableTransition);
                });
            }
            return;
        }
        this.blur = Math.min(5, blur);
        this.lineTransforms.posX.setTargetPosition(left, delay);
        this.lineTransforms.posY.setTargetPosition(top, delay);
    }

    update(delta = 0) {
        if (!this.lyricPlayer.getEnableSpring()) return;
        this.lineTransforms.posX.update(delta);
        this.lineTransforms.posY.update(delta);
        if (this.isInSight) this.show();
        else this.hide();
    }

    rebuildStyle() {
        let style = `transform:translate(${this.lineTransforms.posX.getCurrentPosition().toFixed(2)}px,${this.lineTransforms.posY.getCurrentPosition().toFixed(2)}px);`;
        if (!this.lyricPlayer.getEnableSpring() && this.isInSight) {
            style += `transition-delay:${this.delay}ms;`;
        }
        style += `filter:blur(${Math.min(5, this.blur)}px);`;
        if (style !== this.lastStyle) {
            this.lastStyle = style;
            this.element.setAttribute('style', style);
        }
    }

    get isInSight() {
        const left = this.lineTransforms.posX.getCurrentPosition();
        const top = this.lineTransforms.posY.getCurrentPosition();
        const right = left + this.lineSize[0];
        const bottom = top + this.lineSize[1];
        return !(left > this.lyricPlayer.size[0] || top > this.lyricPlayer.size[1] || right < 0 || bottom < 0);
    }

    dispose() {
        this.element.remove();
    }
}

function shouldEmphasize(word) {
    if (isCJK(word.word)) return word.endTime - word.startTime >= 1000;
    const length = word.word.trim().length;
    return word.endTime - word.startTime >= 1000 && length <= 7 && length > 1;
}

class LyricLineEl {
    constructor(lyricPlayer, lyricLine) {
        this.lyricPlayer = lyricPlayer;
        this.lyricLine = lyricLine;
        this.element = document.createElement('div');
        this.splittedWords = [];
        this.built = false;
        this.lineSize = [0, 0];
        this.renderMode = LYRIC_RENDER_MODE.SOLID;
        this.currentBrightAlpha = 1.0;
        this.currentDarkAlpha = 0.2;
        this.targetBrightAlpha = 1.0;
        this.targetDarkAlpha = 0.2;
        this.isEnabled = false;
        this.lastWord = undefined;
        this.lastStyle = '';
        this.lineTransforms = {
            posY: new Spring(0),
            scale: new Spring(100),
        };

        this.element.className = STYLE.line;
        if (this.lyricLine.isBG) this.element.classList.add(STYLE.bgLine);
        if (this.lyricLine.isDuet) this.element.classList.add(STYLE.duetLine);
        this.lineTransforms.posY.setPosition(window.innerHeight * 2);

        const main = document.createElement('div');
        const trans = document.createElement('div');
        const roman = document.createElement('div');
        main.className = STYLE.mainLine;
        trans.className = STYLE.subLine;
        roman.className = STYLE.subLine;
        roman.dataset.amllRomanLine = 'true';
        const mainLang = this.lyricLine.preferredLang || detectLyricTextLang(this.lyricLine.words.map((word) => word.word).join(''));
        const transLang = detectLyricTextLang(this.lyricLine.translatedLyric || '');
        this.mainLang = mainLang || '';
        this.transLang = transLang || '';
        if (mainLang) main.lang = mainLang;
        if (transLang) trans.lang = transLang;
        this.element.append(main, trans, roman);
        this.rebuildStyle();
    }

    getElement() {
        return this.element;
    }

    getLine() {
        return this.lyricLine;
    }

    enable(maskAnimationTime = this.lyricLine.startTime, shouldPlay = true) {
        this.isEnabled = true;
        this.element.classList.add(STYLE.active);
        const main = this.element.children[0];
        main.classList.add(STYLE.active);

        const relativeTime = Math.max(0, maskAnimationTime - this.lyricLine.startTime);
        const actualMaskTime = maskAnimationTime === this.lyricLine.startTime
            ? this.lyricPlayer.getCurrentTime()
            : maskAnimationTime;
        const maskRelativeTime = Math.max(0, actualMaskTime - this.lyricLine.startTime);

        for (const word of this.splittedWords) {
            for (const animation of word.elementAnimations) {
                animation.currentTime = relativeTime;
                animation.playbackRate = 1;
                const timing = animation.effect?.getComputedTiming();
                const duration = Number(timing?.duration) || 0;
                const delay = Number(timing?.delay) || 0;
                const endTime = delay + duration;
                if (shouldPlay && relativeTime < endTime) animation.play();
                else animation.pause();
            }
            for (const animation of word.maskAnimations) {
                const currentTime = Math.min(this.totalDuration, maskRelativeTime);
                animation.currentTime = currentTime;
                animation.playbackRate = 1;
                const timing = animation.effect?.getComputedTiming();
                const duration = Number(timing?.duration) || 0;
                const delay = Number(timing?.delay) || 0;
                const endTime = delay + duration;
                if (shouldPlay && currentTime < endTime) animation.play();
                else animation.pause();
            }
        }
    }

    disable() {
        this.isEnabled = false;
        this.element.classList.remove(STYLE.active);
        this.renderMode = LYRIC_RENDER_MODE.SOLID;
        const main = this.element.children[0];
        main.classList.remove(STYLE.active);

        for (const word of this.splittedWords) {
            for (const animation of word.elementAnimations) {
                if (animation.id === 'float-word' || animation.id.includes('emphasize-word-float')) {
                    animation.playbackRate = -1;
                    animation.play();
                }
            }
            for (const animation of word.maskAnimations) {
                animation.pause();
            }
        }
    }

    resume() {
        if (!this.isEnabled) return;
        for (const word of this.splittedWords) {
            const shouldResume = !this.lastWord || this.splittedWords.indexOf(this.lastWord) < this.splittedWords.indexOf(word);
            if (!shouldResume) continue;

            for (const animation of word.elementAnimations) {
                const timing = animation.effect?.getComputedTiming();
                const duration = Number(timing?.duration) || 0;
                const delay = Number(timing?.delay) || 0;
                const endTime = delay + duration;
                const currentTime = Number(animation.currentTime) || 0;
                if (animation.playState !== 'finished' && currentTime < endTime) {
                    animation.play();
                }
            }
            for (const animation of word.maskAnimations) {
                const timing = animation.effect?.getComputedTiming();
                const duration = Number(timing?.duration) || 0;
                const delay = Number(timing?.delay) || 0;
                const endTime = delay + duration;
                const currentTime = Number(animation.currentTime) || 0;
                if (animation.playState !== 'finished' && currentTime < endTime) {
                    animation.play();
                }
            }
        }
    }

    pause() {
        if (!this.isEnabled) return;
        for (const word of this.splittedWords) {
            for (const animation of word.elementAnimations) {
                animation.pause();
            }
            for (const animation of word.maskAnimations) {
                animation.pause();
            }
        }
    }

    setMaskAnimationState(maskAnimationTime = 0) {
        const t = maskAnimationTime - this.lyricLine.startTime;
        for (const word of this.splittedWords) {
            for (const animation of word.maskAnimations) {
                animation.currentTime = Math.min(this.totalDuration, Math.max(0, t));
                animation.playbackRate = 1;
                if (t >= 0 && t < this.totalDuration) animation.play();
                else animation.pause();
            }
        }
    }

    show() {
        if (!this.element.parentElement) {
            this.lyricPlayer.getElement().appendChild(this.element);
            this.lyricPlayer.resizeObserver.observe(this.element);
        }
        if (!this.built) {
            this.rebuildElement();
            this.built = true;
            this.updateMaskImageSync();
        }
        this.rebuildStyle();
    }

    hide() {
        if (this.element.parentElement) {
            this.lyricPlayer.getElement().removeChild(this.element);
            this.lyricPlayer.resizeObserver.unobserve(this.element);
        }
        if (this.built) {
            this.disposeElements();
            this.built = false;
        }
    }

    rebuildStyle() {
        let style = `transform:translateY(${this.lineTransforms.posY.getCurrentPosition().toFixed(1)}px) scale(${(this.lineTransforms.scale.getCurrentPosition() / 100).toFixed(4)});`;
        if (!this.lyricPlayer.getEnableSpring() && this.isInSight) {
            style += `transition-delay:${this.delay}ms;`;
        }
        style += `filter:blur(${Math.min(5, this.blur)}px);`;
        if (style !== this.lastStyle) {
            this.lastStyle = style;
            this.element.setAttribute('style', style);
        }
    }

    rebuildElement() {
        this.disposeElements();
        const main = this.element.children[0];
        const trans = this.element.children[1];
        const roman = this.element.children[2];

        if (this.lyricPlayer.getIsNonDynamic()) {
            main.innerText = this.lyricLine.words.map((word) => word.word).join('');
            this.setSubLinesText(trans, roman);
            return;
        }

        const chunkedWords = chunkAndSplitLyricWords(this.lyricLine.words);
        const hasRubyLine = this.lyricLine.words.some((word) => (word.ruby?.length ?? 0) > 0);
        const hasRomanLine = this.lyricLine.words.some((word) => (word.romanWord?.trim().length ?? 0) > 0);
        main.innerHTML = '';

        for (const chunk of chunkedWords) {
            this.buildWord(chunk, main, hasRubyLine, hasRomanLine);
        }
        this.setSubLinesText(trans, roman);
    }

    setSubLinesText(trans, roman) {
        trans.innerText = this.lyricLine.translatedLyric || '';
        roman.innerText = this.lyricLine.romanLyric || '';
        trans.style.display = trans.innerText.trim().length > 0 ? '' : 'none';
        roman.style.display = roman.innerText.trim().length > 0 ? '' : 'none';
    }

    getRubySegments(word) {
        return (word.ruby ?? []).filter((ruby) => (ruby?.word?.trim().length ?? 0) > 0);
    }

    getRubyCharCount(word) {
        return this.getRubySegments(word).reduce((total, ruby) => total + ruby.word.length, 0);
    }

    createWord(word, shouldEmp, hasRubyLine, hasRomanLine) {
        const mainWordEl = document.createElement('span');
        const subElements = [];
        const romanWord = word.romanWord?.trim() ?? '';
        const wordContainer = hasRubyLine ? document.createElement('div') : mainWordEl;
        if (this.mainLang) {
            mainWordEl.lang = this.mainLang;
            wordContainer.lang = this.mainLang;
        }

        if (hasRubyLine) {
            const rubyWordEl = document.createElement('div');
            rubyWordEl.classList.add(STYLE.rubyWord);
            if (this.mainLang) rubyWordEl.lang = this.mainLang;
            for (const ruby of this.getRubySegments(word)) {
                const rubyPartEl = document.createElement('span');
                rubyPartEl.innerText = ruby.word;
                rubyPartEl.dataset.startTime = String(ruby.startTime);
                rubyPartEl.dataset.endTime = String(ruby.endTime);
                if (this.mainLang) rubyPartEl.lang = this.mainLang;
                rubyWordEl.appendChild(rubyPartEl);
            }
            mainWordEl.classList.add(STYLE.wordWithRuby);
            wordContainer.classList.add(STYLE.wordBody);
            mainWordEl.append(rubyWordEl, wordContainer);
        }

        if (shouldEmp) {
            mainWordEl.classList.add(STYLE.emphasize);
            for (const char of word.word.trim()) {
                const charEl = document.createElement('span');
                charEl.innerText = char;
                if (this.mainLang) charEl.lang = this.mainLang;
                subElements.push(charEl);
                wordContainer.appendChild(charEl);
            }
        } else if (hasRomanLine) {
            const body = document.createElement('div');
            body.innerText = word.word.trim();
            if (this.mainLang) body.lang = this.mainLang;
            wordContainer.appendChild(body);
        } else if (romanWord.length === 0) {
            wordContainer.innerText = word.word.trim();
        }

        if (hasRomanLine) {
            const romanWordEl = document.createElement('div');
            romanWordEl.innerText = romanWord.length > 0 ? romanWord : '\u00A0';
            romanWordEl.classList.add(STYLE.romanWord);
            wordContainer.appendChild(romanWordEl);
        }

        return {
            ...word,
            mainElement: mainWordEl,
            subElements,
            elementAnimations: [this.initFloatAnimation(word, mainWordEl)],
            maskAnimations: [],
            width: 0,
            height: 0,
            padding: 0,
            shouldEmphasize: shouldEmp,
        };
    }

    buildWord(input, main, hasRubyLine, hasRomanLine) {
        const chunk = Array.isArray(input) ? input : [input];
        if (chunk.length === 0) return;

        if (chunk.every((word) => !word.word.trim())) {
            main.appendChild(document.createTextNode(chunk.map((word) => word.word).join('')));
            return;
        }

        const merged = chunk.reduce((acc, word) => ({
            ...acc,
            word: acc.word + word.word,
            startTime: Math.min(acc.startTime, word.startTime),
            endTime: Math.max(acc.endTime, word.endTime),
        }), {
            word: '',
            romanWord: '',
            startTime: Number.POSITIVE_INFINITY,
            endTime: Number.NEGATIVE_INFINITY,
            obscene: false,
        });

        let emphasize = chunk.some((word) => shouldEmphasize(word));
        if (!isCJK(merged.word)) {
            emphasize = emphasize || shouldEmphasize(merged);
        }

        const wrapperWordEl = document.createElement('span');
        wrapperWordEl.classList.add(STYLE.emphasizeWrapper);
        if (this.mainLang) wrapperWordEl.lang = this.mainLang;
        const characterElements = [];

        for (const word of chunk) {
            if (!word.word.trim()) {
                wrapperWordEl.appendChild(document.createTextNode(word.word));
                continue;
            }

            const realWord = this.createWord(word, emphasize, hasRubyLine, hasRomanLine);
            if (emphasize) {
                characterElements.push(...realWord.subElements);
            }
            this.splittedWords.push(realWord);
            wrapperWordEl.appendChild(realWord.mainElement);
        }

        if (emphasize && this.splittedWords.length > 0) {
            const lastWordOfChunk = this.splittedWords[this.splittedWords.length - 1];
            const rubyCharCount = chunk.reduce((total, word) => total + this.getRubyCharCount(word), 0);
            lastWordOfChunk.elementAnimations.push(
                ...this.initEmphasizeAnimation(
                    merged,
                    characterElements,
                    merged.endTime - merged.startTime,
                    merged.startTime - this.lyricLine.startTime,
                    rubyCharCount,
                ),
            );
        }

        main.appendChild(wrapperWordEl);
    }

    initFloatAnimation(word, wordEl) {
        const delay = word.startTime - this.lyricLine.startTime;
        const duration = Math.max(1000, word.endTime - word.startTime);
        let up = 0.05;
        if (this.lyricLine.isBG) up *= 2;
        const animation = wordEl.animate(
            [
                { transform: 'translateY(0px)' },
                { transform: `translateY(${-up}em)` },
            ],
            {
                duration: Number.isFinite(duration) ? duration : 0,
                delay: Number.isFinite(delay) ? delay : 0,
                id: 'float-word',
                composite: 'add',
                fill: 'both',
                easing: 'ease-out',
            },
        );
        animation.pause();
        return animation;
    }

    initEmphasizeAnimation(word, characterElements, duration, delay, rubyCharCount) {
        const de = Math.max(0, delay);
        let du = Math.max(1000, duration);
        const anchorCharCount = rubyCharCount > 0 ? rubyCharCount : Math.max(1, characterElements.length);

        let amount = du / 2000;
        amount = amount > 1 ? Math.sqrt(amount) : amount ** 3;
        let blur = du / 3000;
        blur = blur > 1 ? Math.sqrt(blur) : blur ** 3;
        amount *= 0.6;
        blur *= 0.5;

        if (
            this.lyricLine.words.length > 0 &&
            word.word.includes(this.lyricLine.words[this.lyricLine.words.length - 1].word)
        ) {
            amount *= 1.6;
            blur *= 1.5;
            du *= 1.2;
        }

        amount = Math.min(1.2, amount);
        blur = Math.min(0.8, blur);
        const animateDu = Number.isFinite(du) ? du : 0;
        const empEasing = makeEmpEasing(EMP_EASING_MID);

        return characterElements.flatMap((element, index, all) => {
            const wordDelay = de + ((du / 2.5 / anchorCharCount) * index);
            const result = [];

            const frames = new Array(ANIMATION_FRAME_QUANTITY).fill(0).map((_, frameIndex) => {
                const x = (frameIndex + 1) / ANIMATION_FRAME_QUANTITY;
                const transX = empEasing(x);
                const glowLevel = empEasing(x) * blur;
                const mat = scaleMatrix4(createMatrix4(), 1 + transX * 0.1 * amount);
                const offsetX = -transX * 0.03 * amount * ((all.length / 2) - index);
                const offsetY = -transX * 0.025 * amount;
                return {
                    offset: x,
                    transform: `${matrix4ToCSS(mat, 4)} translate(${offsetX}em, ${offsetY}em)`,
                    textShadow: `0 0 ${Math.min(0.3, blur * 0.3)}em rgba(255, 255, 255, ${glowLevel})`,
                };
            });

            const glow = element.animate(frames, {
                duration: animateDu,
                delay: Number.isFinite(wordDelay) ? wordDelay : 0,
                id: `emphasize-word-${element.innerText}-${index}`,
                iterations: 1,
                composite: 'replace',
                fill: 'both',
            });
            glow.onfinish = () => glow.pause();
            glow.pause();
            result.push(glow);

            const floatFrames = new Array(ANIMATION_FRAME_QUANTITY).fill(0).map((_, frameIndex) => {
                const x = (frameIndex + 1) / ANIMATION_FRAME_QUANTITY;
                let y = Math.sin(x * Math.PI);
                if (this.lyricLine.isBG) y *= 2;
                return {
                    offset: x,
                    transform: `translateY(${-y * 0.05}em)`,
                };
            });

            const float = element.animate(floatFrames, {
                duration: animateDu * 1.4,
                delay: Number.isFinite(wordDelay) ? wordDelay - 400 : 0,
                id: 'emphasize-word-float',
                iterations: 1,
                composite: 'add',
                fill: 'both',
            });
            float.onfinish = () => float.pause();
            float.pause();
            result.push(float);

            return result;
        });
    }

    get totalDuration() {
        return this.lyricLine.endTime - this.lyricLine.startTime;
    }

    onLineSizeChange() {
        this.updateMaskImageSync();
    }

    updateMaskImageSync() {
        for (const word of this.splittedWords) {
            const el = word.mainElement;
            if (!el) {
                word.width = 0;
                word.height = 0;
                word.padding = 0;
                continue;
            }
            word.padding = Number.parseFloat(getComputedStyle(el).paddingLeft) || 0;
            word.width = el.clientWidth - word.padding * 2;
            word.height = el.clientHeight - word.padding * 2;
        }

        if (this.lyricPlayer.supportMaskImage) {
            this.generateWebAnimationBasedMaskImage();
        } else {
            this.generateCalcBasedMaskImage();
        }

        if (this.isEnabled) {
            this.enable(this.lyricPlayer.getCurrentTime(), this.lyricPlayer.getIsPlaying());
        }
    }

    generateCalcBasedMaskImage() {
        for (const word of this.splittedWords) {
            const wordEl = word.mainElement;
            if (!wordEl) continue;
            word.width = wordEl.clientWidth;
            word.height = wordEl.clientHeight;
            const fadeWidth = word.height * this.lyricPlayer.getWordFadeWidth();
            const [maskImage, totalAspect] = generateFadeGradient(fadeWidth / word.width);
            const totalAspectStr = `${totalAspect * 100}% 100%`;

            wordEl.style.maskImage = maskImage;
            wordEl.style.maskRepeat = 'no-repeat';
            wordEl.style.maskOrigin = 'left';
            wordEl.style.maskSize = totalAspectStr;
            wordEl.style.webkitMaskImage = maskImage;
            wordEl.style.webkitMaskRepeat = 'no-repeat';
            wordEl.style.webkitMaskOrigin = 'left';
            wordEl.style.webkitMaskSize = totalAspectStr;

            const width = word.width + fadeWidth;
            const maskPos = `clamp(${-width}px,calc(${-width}px + (var(--amll-player-time) - ${word.startTime})*${width / Math.abs(word.endTime - word.startTime)}px),0px) 0px`;
            wordEl.style.maskPosition = maskPos;
            wordEl.style.webkitMaskPosition = maskPos;
        }
    }

    generateWebAnimationBasedMaskImage() {
        const totalFadeDuration = Math.max(
            this.splittedWords.reduce((prev, word) => Math.max(word.endTime, prev), 0),
            this.lyricLine.endTime,
        ) - this.lyricLine.startTime;

        this.splittedWords.forEach((word, index) => {
            const wordEl = word.mainElement;
            if (!wordEl) return;

            const fadeWidth = word.height * this.lyricPlayer.getWordFadeWidth();
            const [maskImage, totalAspect] = generateFadeGradient(
                fadeWidth / (word.width + word.padding * 2),
            );
            const totalAspectStr = `${totalAspect * 100}% 100%`;

            wordEl.style.maskImage = maskImage;
            wordEl.style.maskRepeat = 'no-repeat';
            wordEl.style.maskOrigin = 'left';
            wordEl.style.maskSize = totalAspectStr;
            wordEl.style.webkitMaskImage = maskImage;
            wordEl.style.webkitMaskRepeat = 'no-repeat';
            wordEl.style.webkitMaskOrigin = 'left';
            wordEl.style.webkitMaskSize = totalAspectStr;

            const widthBeforeSelf =
                this.splittedWords.slice(0, index).reduce((acc, other) => acc + other.width, 0) +
                (this.splittedWords[0] ? fadeWidth : 0);
            const minOffset = -(word.width + word.padding * 2 + fadeWidth);
            const clampOffset = (value) => Math.max(minOffset, Math.min(0, value));
            let curPos = -widthBeforeSelf - word.width - word.padding - fadeWidth;
            let timeOffset = 0;
            const frames = [];
            let lastPos = curPos;
            let lastTime = 0;

            const pushFrame = () => {
                const moveOffset = curPos - lastPos;
                const time = Math.max(0, Math.min(1, timeOffset));
                const duration = time - lastTime;
                const distancePerTime = Math.abs(duration / moveOffset);

                if (curPos > minOffset && lastPos < minOffset) {
                    const staticTime = Math.abs(lastPos - minOffset) * distancePerTime;
                    frames.push({
                        offset: lastTime + staticTime,
                        maskPosition: `${clampOffset(lastPos)}px 0`,
                    });
                }
                if (curPos > 0 && lastPos < 0) {
                    const staticTime = Math.abs(lastPos) * distancePerTime;
                    frames.push({
                        offset: lastTime + staticTime,
                        maskPosition: `${clampOffset(curPos)}px 0`,
                    });
                }
                frames.push({
                    offset: time,
                    maskPosition: `${clampOffset(curPos)}px 0`,
                });
                lastPos = curPos;
                lastTime = time;
            };

            pushFrame();
            let lastTimeStamp = 0;

            this.splittedWords.forEach((otherWord, otherIndex) => {
                const currentTimeStamp = otherWord.startTime - this.lyricLine.startTime;
                const staticDuration = currentTimeStamp - lastTimeStamp;
                timeOffset += staticDuration / totalFadeDuration;
                if (staticDuration > 0) pushFrame();
                lastTimeStamp = currentTimeStamp;

                const fadeDuration = Math.max(0, otherWord.endTime - otherWord.startTime);
                const rubySegments = this.getRubySegments(otherWord);
                const rubyCharCount = rubySegments.reduce((total, ruby) => total + ruby.word.length, 0);

                if (rubyCharCount > 0) {
                    const widthPerChar = otherWord.width / rubyCharCount;
                    let charIndex = 0;

                    for (const ruby of rubySegments) {
                        const rubyStartTime = Number.isFinite(ruby.startTime) ? ruby.startTime : otherWord.startTime;
                        const rubyEndTime = Number.isFinite(ruby.endTime) ? ruby.endTime : otherWord.endTime;
                        const rubyStart = Math.max(rubyStartTime, otherWord.startTime);
                        const rubyEnd = Math.min(Math.max(rubyEndTime, rubyStart), otherWord.endTime);
                        const rubyStartStamp = rubyStart - this.lyricLine.startTime;
                        const rubyStaticDuration = rubyStartStamp - lastTimeStamp;
                        timeOffset += rubyStaticDuration / totalFadeDuration;
                        if (rubyStaticDuration > 0) pushFrame();
                        lastTimeStamp = rubyStartStamp;

                        const rubyDuration = Math.max(0, rubyEnd - rubyStart);
                        const perCharDuration = rubyDuration / ruby.word.length;
                        for (let rubyCharIndex = 0; rubyCharIndex < ruby.word.length; rubyCharIndex++) {
                            timeOffset += perCharDuration / totalFadeDuration;
                            curPos += widthPerChar;
                            if (otherIndex === 0 && charIndex === 0) curPos += fadeWidth * 1.5;
                            if (otherIndex === this.splittedWords.length - 1 && charIndex === rubyCharCount - 1) {
                                curPos += fadeWidth * 0.5;
                            }
                            if (perCharDuration > 0) pushFrame();
                            lastTimeStamp += perCharDuration;
                            charIndex += 1;
                        }
                    }

                    const wordEndStamp = Math.max(otherWord.endTime - this.lyricLine.startTime, lastTimeStamp);
                    const wordTailDuration = wordEndStamp - lastTimeStamp;
                    timeOffset += wordTailDuration / totalFadeDuration;
                    if (wordTailDuration > 0) pushFrame();
                    lastTimeStamp = wordEndStamp;
                } else {
                    timeOffset += fadeDuration / totalFadeDuration;
                    curPos += otherWord.width;
                    if (otherIndex === 0) curPos += fadeWidth * 1.5;
                    if (otherIndex === this.splittedWords.length - 1) curPos += fadeWidth * 0.5;
                    if (fadeDuration > 0) pushFrame();
                    lastTimeStamp += fadeDuration;
                }
            });

            for (const animation of word.maskAnimations) {
                animation.cancel();
            }

            try {
                const animation = wordEl.animate(frames, {
                    duration: totalFadeDuration || 1,
                    id: `fade-word-${word.word}-${index}`,
                    fill: 'both',
                });
                animation.pause();
                word.maskAnimations = [animation];
            } catch (error) {
                console.warn('[AMLL] Failed to apply mask animation', error);
            }
        });
    }

    updateMaskAlphaTargets(scale) {
        const factor = Math.max(0, Math.min(1, (scale - 0.97) / 0.03));
        const dynamicDarkAlpha = factor * 0.2 + 0.2;
        const dynamicBrightAlpha = factor * 0.8 + 0.2;
        if (this.renderMode === LYRIC_RENDER_MODE.SOLID) {
            this.targetBrightAlpha = dynamicDarkAlpha;
            this.targetDarkAlpha = dynamicDarkAlpha;
        } else {
            this.targetBrightAlpha = dynamicBrightAlpha;
            this.targetDarkAlpha = dynamicDarkAlpha;
        }
    }

    applyAlphaToDom(delta) {
        const dt = delta || 0.016;
        const ATTACK_SPEED = 50.0;
        const RELEASE_SPEED = 7.0;
        const getFactor = (speed) => 1 - Math.exp(-speed * dt);

        const brightSpeed = this.targetBrightAlpha > this.currentBrightAlpha ? ATTACK_SPEED : RELEASE_SPEED;
        const brightFactor = getFactor(brightSpeed);
        if (Math.abs(this.targetBrightAlpha - this.currentBrightAlpha) < 0.001) {
            this.currentBrightAlpha = this.targetBrightAlpha;
        } else {
            this.currentBrightAlpha += (this.targetBrightAlpha - this.currentBrightAlpha) * brightFactor;
        }

        const darkSpeed = this.targetDarkAlpha > this.currentDarkAlpha ? ATTACK_SPEED : RELEASE_SPEED;
        const darkFactor = getFactor(darkSpeed);
        if (Math.abs(this.targetDarkAlpha - this.currentDarkAlpha) < 0.001) {
            this.currentDarkAlpha = this.targetDarkAlpha;
        } else {
            this.currentDarkAlpha += (this.targetDarkAlpha - this.currentDarkAlpha) * darkFactor;
        }

        this.element.style.setProperty('--bright-mask-alpha', this.currentBrightAlpha.toFixed(3));
        this.element.style.setProperty('--dark-mask-alpha', this.currentDarkAlpha.toFixed(3));
    }

    setTransform(top = this.top, scale = this.scale, opacity = 1, blur = 0, force = false, delay = 0, mode = LYRIC_RENDER_MODE.SOLID) {
        this.top = top;
        this.scale = scale;
        this.opacity = opacity;
        this.blur = blur;
        this.delay = (delay * 1000) | 0;
        this.renderMode = mode;

        const beforeInSight = this.isInSight;
        const enableSpring = this.lyricPlayer.getEnableSpring();
        const main = this.element.children[0];
        const trans = this.element.children[1];
        const roman = this.element.children[2];
        const subOpacity = opacity * (this.lyricPlayer.getIsNonDynamic() ? 0.5 : 0.3);
        main.style.opacity = `${opacity}`;
        trans.style.opacity = `${subOpacity}`;
        roman.style.opacity = `${subOpacity}`;

        if (force || !enableSpring) {
            this.blur = Math.min(32, blur);
            this.lineTransforms.posY.setPosition(top);
            this.lineTransforms.scale.setPosition(scale);
            if (!enableSpring) {
                const afterInSight = this.isInSight;
                if (beforeInSight || afterInSight) this.show();
                else this.hide();
            } else {
                this.rebuildStyle();
            }
            const currentScale = this.lineTransforms.scale.getCurrentPosition() / 100;
            this.updateMaskAlphaTargets(currentScale);
            this.currentBrightAlpha = this.targetBrightAlpha;
            this.currentDarkAlpha = this.targetDarkAlpha;
            this.element.style.setProperty('--bright-mask-alpha', String(this.currentBrightAlpha));
            this.element.style.setProperty('--dark-mask-alpha', String(this.currentDarkAlpha));
            return;
        }

        this.lineTransforms.posY.setTargetPosition(top, delay);
        this.lineTransforms.scale.setTargetPosition(scale);
        if (this.blur !== Math.min(5, blur)) {
            this.blur = Math.min(5, blur);
            this.element.style.filter = `blur(${blur.toFixed(3)}px)`;
        }
    }

    update(delta = 0) {
        if (!this.lyricPlayer.getEnableSpring()) return;
        this.lineTransforms.posY.update(delta);
        this.lineTransforms.scale.update(delta);
        if (this.isInSight) this.show();
        else this.hide();
        const currentScale = this.lineTransforms.scale.getCurrentPosition() / 100;
        this.updateMaskAlphaTargets(currentScale);
        this.applyAlphaToDom(delta);
        this.rebuildStyle();
    }

    get isInSight() {
        const top = this.lineTransforms.posY.getCurrentPosition();
        const height = this.lyricPlayer.lyricLinesSize.get(this)?.[1] ?? 0;
        const bottom = top + height;
        const playerBottom = this.lyricPlayer.size[1];
        const overscan = this.lyricPlayer.getOverscanPx();
        return !(top > playerBottom + height + overscan || bottom < -height - overscan);
    }

    disposeElements() {
        for (const realWord of this.splittedWords) {
            for (const animation of realWord.elementAnimations) {
                animation.cancel();
            }
            for (const animation of realWord.maskAnimations) {
                animation.cancel();
            }
            for (const sub of realWord.subElements) {
                sub.remove();
            }
            realWord.elementAnimations = [];
            realWord.maskAnimations = [];
            realWord.subElements = [];
            if (realWord.mainElement?.parentNode) {
                realWord.mainElement.parentNode.removeChild(realWord.mainElement);
            }
        }
        this.splittedWords = [];
        for (const child of this.element.children) {
            child.innerHTML = '';
        }
    }

    dispose() {
        this.disposeElements();
        this.lyricPlayer.resizeObserver.unobserve(this.element);
        this.element.remove();
    }
}

class AMLLDomLyricPlayer {
    constructor() {
        this.element = document.createElement('div');
        this.element.classList.add(STYLE.root, STYLE.dom);
        this.element.style.width = '100%';
        this.element.style.height = '100%';
        this.onPageShow = () => {
            this.isPageVisible = true;
            this.setCurrentTime(this.currentTime, true);
            this.update(0);
        };
        this.onPageHide = () => {
            this.isPageVisible = false;
        };

        this.supportMaskImage = CSS.supports('mask-image', 'none');
        this.size = [0, 0];
        this.lyricLinesSize = new WeakMap();
        this.lyricLineElementMap = new WeakMap();
        this.currentLyricLines = [];
        this.processedLines = [];
        this.lyricLinesIndexes = new WeakMap();
        this.hotLines = new Set();
        this.bufferedLines = new Set();
        this.currentLyricLineObjects = [];
        this.currentTime = 0;
        this.lastCurrentTime = 0;
        this.scrollToIndex = 0;
        this.disableSpring = false;
        this.enableBlur = true;
        this.enableScale = true;
        this.hidePassedLines = false;
        this.isNonDynamic = false;
        this.hasDuetLine = false;
        this.isSeeking = false;
        this.isPlaying = true;
        this.isScrolled = false;
        this.isUserScrolling = false;
        this.allowScroll = true;
        this.scrolledHandler = 0;
        this.wheelTimeout = undefined;
        this.currentScrollId = 0;
        this.alignAnchor = 'center';
        this.alignPosition = 0.35;
        this.overscanPx = 300;
        this.wordFadeWidth = 0.5;
        this.scrollOffset = 0;
        this.scrollBoundary = [0, 0];
        this.targetAlignIndex = 0;
        this.initialLayoutFinished = false;
        this.isPageVisible = true;
        this.baseFontSize = Number.parseFloat(getComputedStyle(this.element).fontSize) || 24;
        this.interludeDotsSize = [0, 0];
        this.interludeDots = new InterludeDots();
        this.bottomLine = new BottomLineEl(this);
        this.posYSpringParams = { mass: 0.9, damping: 15, stiffness: 90 };
        this.scaleSpringParams = { mass: 2, damping: 25, stiffness: 100 };
        this.scaleForBGSpringParams = { mass: 1, damping: 20, stiffness: 50 };

        this.element.append(this.interludeDots.getElement(), this.bottomLine.getElement());

        this.resizeObserver = new ResizeObserver((entries) => {
            let shouldRelayout = false;
            let shouldRefreshFontSize = false;
            for (const entry of entries) {
                if (entry.target === this.element) {
                    this.size[0] = entry.contentRect.width;
                    this.size[1] = entry.contentRect.height;
                    shouldRefreshFontSize = true;
                    continue;
                }

                if (entry.target === this.interludeDots.getElement()) {
                    this.interludeDotsSize = [entry.target.clientWidth, entry.target.clientHeight];
                    shouldRelayout = true;
                    continue;
                }

                if (entry.target === this.bottomLine.getElement()) {
                    const newSize = [entry.target.clientWidth, entry.target.clientHeight];
                    const oldSize = this.bottomLine.lineSize;
                    if (newSize[0] !== oldSize[0] || newSize[1] !== oldSize[1]) {
                        this.bottomLine.lineSize = newSize;
                        shouldRelayout = true;
                    }
                    continue;
                }

                const lineObj = this.lyricLineElementMap.get(entry.target);
                if (!lineObj) continue;
                const newSize = [entry.target.clientWidth, entry.target.clientHeight];
                const oldSize = this.lyricLinesSize.get(lineObj) ?? [0, 0];
                if (newSize[0] !== oldSize[0] || newSize[1] !== oldSize[1]) {
                    this.lyricLinesSize.set(lineObj, newSize);
                    lineObj.onLineSizeChange(newSize);
                    shouldRelayout = true;
                }
            }

            if (shouldRefreshFontSize) {
                this.baseFontSize = Number.parseFloat(getComputedStyle(this.element).fontSize) || 24;
            }
            if (shouldRelayout) {
                this.calcLayout(true);
            }
        });

        this.resizeObserver.observe(this.element);
        this.resizeObserver.observe(this.interludeDots.getElement());
        this.resizeObserver.observe(this.bottomLine.getElement());
        this.interludeDots.setTransform(0, 200);
        window.addEventListener('pageshow', this.onPageShow);
        window.addEventListener('pagehide', this.onPageHide);

        let startScrollY = 0;
        let startTouchPosY = 0;
        let startTouchStartX = 0;
        let startTouchStartY = 0;
        let lastMoveY = 0;
        let startScrollTime = 0;
        let scrollSpeed = 0;

        this.element.addEventListener('touchstart', (event) => {
            if (!this.beginScrollHandler()) return;

            this.isUserScrolling = true;
            event.preventDefault();
            startScrollY = this.scrollOffset;
            startTouchPosY = event.touches[0].screenY;
            lastMoveY = startTouchPosY;
            startTouchStartX = event.touches[0].screenX;
            startTouchStartY = event.touches[0].screenY;
            startScrollTime = Date.now();
            scrollSpeed = 0;
            this.calcLayout(true, true);
        }, { passive: false });

        this.element.addEventListener('touchmove', (event) => {
            if (!this.beginScrollHandler()) return;

            event.preventDefault();
            const currentY = event.touches[0].screenY;
            const deltaY = currentY - startTouchPosY;
            this.scrollOffset = startScrollY - deltaY;
            this.limitScrollOffset();

            const now = Date.now();
            const deltaTime = now - startScrollTime;
            if (deltaTime > 0) {
                scrollSpeed = (currentY - lastMoveY) / deltaTime;
            }
            lastMoveY = currentY;
            startScrollTime = now;
            this.calcLayout(true, true);
        }, { passive: false });

        this.element.addEventListener('touchend', (event) => {
            if (!this.beginScrollHandler()) {
                this.isUserScrolling = false;
                return;
            }

            event.preventDefault();
            const touch = event.changedTouches[0];
            const moveX = Math.abs(touch.screenX - startTouchStartX);
            const moveY = Math.abs(touch.screenY - startTouchStartY);

            if (moveX < 10 && moveY < 10) {
                const target = document.elementFromPoint(touch.clientX, touch.clientY);
                if (target && this.element.contains(target)) {
                    target.click();
                }
                this.isUserScrolling = false;
                this.endScrollHandler();
                return;
            }

            startTouchPosY = 0;
            const scrollId = ++this.currentScrollId;
            if (Math.abs(scrollSpeed) < 0.1) scrollSpeed = 0;
            let lastFrameTime = performance.now();

            const onScrollFrame = (time) => {
                if (scrollId !== this.currentScrollId) return;

                const deltaTime = time - lastFrameTime;
                lastFrameTime = time;
                if (deltaTime <= 0 || deltaTime > 100) {
                    requestAnimationFrame(onScrollFrame);
                    return;
                }

                if (Math.abs(scrollSpeed) > 0.05) {
                    this.scrollOffset -= scrollSpeed * deltaTime;
                    this.limitScrollOffset();
                    scrollSpeed *= 0.95 ** (deltaTime / 16);
                    this.calcLayout(true, true);
                    requestAnimationFrame(onScrollFrame);
                } else {
                    this.isUserScrolling = false;
                    this.endScrollHandler();
                }
            };

            requestAnimationFrame(onScrollFrame);
        }, { passive: false });

        this.element.addEventListener('wheel', (event) => {
            if (!this.beginScrollHandler()) return;

            event.preventDefault();
            if (event.deltaMode === event.DOM_DELTA_PIXEL) {
                this.scrollOffset += event.deltaY;
                this.limitScrollOffset();
                this.calcLayout(true, false);
            } else {
                this.scrollOffset += event.deltaY * 50;
                this.limitScrollOffset();
                this.calcLayout(false, false);
            }
        }, { passive: false });
    }

    getElement() {
        return this.element;
    }

    getCurrentTime() {
        return this.currentTime;
    }

    getWordFadeWidth() {
        return this.wordFadeWidth;
    }

    setWordFadeWidth(value = 0.5) {
        this.wordFadeWidth = Math.max(0.0001, value);
        for (const line of this.currentLyricLineObjects) {
            line.updateMaskImageSync();
        }
    }

    beginScrollHandler() {
        const allowed = this.allowScroll;
        if (allowed) {
            this.isScrolled = true;
            clearTimeout(this.scrolledHandler);
            this.scrolledHandler = setTimeout(() => {
                this.isScrolled = false;
                this.scrollOffset = 0;
            }, 5000);
        }
        return allowed;
    }

    endScrollHandler() {}

    limitScrollOffset() {
        this.scrollOffset = Math.max(
            Math.min(this.scrollBoundary[1], this.scrollOffset),
            this.scrollBoundary[0],
        );
    }

    getEnableSpring() {
        return !this.disableSpring;
    }

    getEnableScale() {
        return this.enableScale;
    }

    getIsNonDynamic() {
        return this.isNonDynamic;
    }

    getIsPlaying() {
        return this.isPlaying;
    }

    setEnableSpring(enable = true) {
        this.disableSpring = !enable;
        this.element.classList.toggle(STYLE.disableSpring, !enable);
        this.calcLayout(true);
    }

    setEnableScale(enable = true) {
        this.enableScale = !!enable;
        this.calcLayout();
    }

    setEnableBlur(enable = true) {
        if (this.enableBlur === !!enable) return;
        this.enableBlur = !!enable;
        this.calcLayout();
    }

    setHidePassedLines(hide = false) {
        this.hidePassedLines = !!hide;
        this.calcLayout();
    }

    setIsSeeking(isSeeking = false) {
        this.isSeeking = !!isSeeking;
    }

    setAlignAnchor(alignAnchor = 'center') {
        this.alignAnchor = alignAnchor;
    }

    setAlignPosition(alignPosition = 0.35) {
        this.alignPosition = alignPosition;
    }

    getOverscanPx() {
        return this.overscanPx;
    }

    setOverscanPx(px) {
        this.overscanPx = Math.max(0, px | 0);
    }

    setLinePosYSpringParams(params = {}) {
        this.posYSpringParams = { ...this.posYSpringParams, ...params };
        this.bottomLine.lineTransforms.posY.updateParams(this.posYSpringParams);
        for (const line of this.currentLyricLineObjects) {
            line.lineTransforms.posY.updateParams(this.posYSpringParams);
        }
    }

    setLineScaleSpringParams(params = {}) {
        this.scaleSpringParams = { ...this.scaleSpringParams, ...params };
        this.scaleForBGSpringParams = { ...this.scaleForBGSpringParams, ...params };
        for (const line of this.currentLyricLineObjects) {
            if (line.getLine().isBG) {
                line.lineTransforms.scale.updateParams(this.scaleForBGSpringParams);
            } else {
                line.lineTransforms.scale.updateParams(this.scaleSpringParams);
            }
        }
    }

    getCurrentInterlude() {
        const currentTime = this.currentTime + 20;
        const currentIndex = this.scrollToIndex;
        const lines = this.processedLines;

        const checkGap = (index) => {
            if (index < -1 || index >= lines.length - 1) return undefined;
            const prevLine = index === -1 ? null : lines[index];
            const nextLine = lines[index + 1];
            const gapStart = prevLine ? prevLine.endTime : 0;
            const gapEnd = Math.max(gapStart, nextLine.startTime - 250);
            if (gapEnd - gapStart < 4000) return undefined;
            if (gapEnd > currentTime && gapStart < currentTime) {
                return [Math.max(gapStart, currentTime), gapEnd, index, nextLine.isDuet];
            }
            return undefined;
        };

        return checkGap(currentIndex - 1) || checkGap(currentIndex) || checkGap(currentIndex + 1);
    }

    setLyricLines(lines, initialTime = 0) {
        this.initialLayoutFinished = true;
        this.lastCurrentTime = initialTime;
        this.currentTime = initialTime;
        this.currentLyricLines = structuredCloneSafe(lines);
        this.processedLines = structuredCloneSafe(lines);
        optimizeLyricLines(this.processedLines);

        this.isNonDynamic = !this.processedLines.some((line) => line.words.length > 1);
        this.hasDuetLine = this.processedLines.some((line) => line.isDuet);
        this.element.classList.toggle(STYLE.hasDuetLine, this.hasDuetLine);
        if (!this.supportMaskImage) {
            this.element.style.setProperty('--amll-player-time', `${initialTime}`);
        }

        for (const line of this.currentLyricLineObjects) {
            line.dispose();
        }

        this.currentLyricLineObjects = this.processedLines.map((line, index) => {
            const lineEl = new LyricLineEl(this, line);
            this.lyricLinesIndexes.set(lineEl, index);
            this.lyricLineElementMap.set(lineEl.getElement(), lineEl);
            const dispatchLineEvent = (event) => {
                if (this.isUserScrolling) return;
                const customEvent = new CustomEvent(LINE_CLICK_EVENT, {
                    bubbles: true,
                    cancelable: true,
                    detail: {
                        lineIndex: index,
                        line: lineEl.getLine(),
                        nativeEvent: event,
                    },
                });
                const allowed = this.element.dispatchEvent(customEvent);
                if (!allowed || customEvent.defaultPrevented) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                }
            };
            lineEl.getElement().addEventListener('click', dispatchLineEvent);
            return lineEl;
        });

        this.interludeDots.setInterlude(undefined);
        this.hotLines.clear();
        this.bufferedLines.clear();
        this.setCurrentTime(0, true);
        this.setLinePosYSpringParams({});
        this.setLineScaleSpringParams({});
        this.calcLayout(true);
        this.update(0);
    }

    setCurrentTime(time, isSeek = false) {
        this.currentTime = time;
        if (!this.initialLayoutFinished && !isSeek) return;
        const previousScrollToIndex = this.scrollToIndex;
        const relayout = (sync = false, force = false) => {
            const shouldRestoreAutoFollow = !isSeek
                && previousScrollToIndex !== this.scrollToIndex
                && (this.isScrolled || this.isUserScrolling || this.scrollOffset !== 0);
            if (shouldRestoreAutoFollow) {
                this.resetScroll();
                sync = true;
                force = false;
            }
            this.calcLayout(sync, force);
        };

        const removedIds = new Set();
        const addedIds = new Set();

        for (const hotId of this.hotLines) {
            const line = this.processedLines[hotId];
            if (!line) continue;
            if (line.isBG) continue;

            const nextLine = this.processedLines[hotId + 1];
            if (nextLine?.isBG) {
                const nextMainLine = this.processedLines[hotId + 2];
                const startTime = Math.min(line.startTime, nextLine.startTime);
                const endTime = Math.min(
                    Math.max(line.endTime, nextMainLine?.startTime ?? Number.MAX_VALUE),
                    Math.max(line.endTime, nextLine.endTime),
                );
                if (startTime > time || endTime <= time) {
                    this.hotLines.delete(hotId);
                    this.hotLines.delete(hotId + 1);
                    if (isSeek) {
                        this.currentLyricLineObjects[hotId]?.disable();
                        this.currentLyricLineObjects[hotId + 1]?.disable();
                    }
                }
            } else if (line.startTime > time || line.endTime <= time) {
                this.hotLines.delete(hotId);
                if (isSeek) this.currentLyricLineObjects[hotId]?.disable();
            }
        }

        this.currentLyricLineObjects.forEach((lineObj, index, array) => {
            const line = lineObj.getLine();
            if (!line.isBG && line.startTime <= time && line.endTime > time) {
                if (isSeek) {
                    lineObj.enable(time, this.isPlaying);
                }
                if (!this.hotLines.has(index)) {
                    this.hotLines.add(index);
                    addedIds.add(index);
                    if (!isSeek) lineObj.enable();

                    if (array[index + 1]?.getLine()?.isBG) {
                        this.hotLines.add(index + 1);
                        addedIds.add(index + 1);
                        if (isSeek) array[index + 1].enable(time, this.isPlaying);
                        else array[index + 1].enable();
                    }
                }
            }
        });

        for (const buffered of this.bufferedLines) {
            if (!this.hotLines.has(buffered)) {
                removedIds.add(buffered);
                if (isSeek) this.currentLyricLineObjects[buffered]?.disable();
            }
        }

        if (isSeek) {
            this.bufferedLines.clear();
            for (const hot of this.hotLines) {
                this.bufferedLines.add(hot);
            }
            if (this.bufferedLines.size > 0) {
                this.scrollToIndex = Math.min(...this.bufferedLines);
            } else {
                const foundIndex = this.processedLines.findIndex((line) => line.startTime >= time);
                this.scrollToIndex = foundIndex === -1 ? this.processedLines.length : foundIndex;
            }
            this.resetScroll();
            this.calcLayout(true, true);
        } else if (removedIds.size > 0 || addedIds.size > 0) {
            if (removedIds.size === 0 && addedIds.size > 0) {
                for (const added of addedIds) {
                    this.bufferedLines.add(added);
                    this.currentLyricLineObjects[added]?.enable();
                }
                this.scrollToIndex = Math.min(...this.bufferedLines);
                relayout();
            } else if (addedIds.size === 0 && removedIds.size > 0) {
                let removedCurrentAnchor = false;
                for (const buffered of Array.from(this.bufferedLines)) {
                    if (!this.hotLines.has(buffered)) {
                        if (buffered === this.scrollToIndex) {
                            removedCurrentAnchor = true;
                        }
                        this.bufferedLines.delete(buffered);
                        this.currentLyricLineObjects[buffered]?.disable();
                    }
                }

                if (this.bufferedLines.size > 0 && removedCurrentAnchor) {
                    this.scrollToIndex = Math.min(...this.bufferedLines);
                }
                relayout();
            } else {
                for (const added of addedIds) {
                    this.bufferedLines.add(added);
                    this.currentLyricLineObjects[added]?.enable();
                }
                for (const removed of removedIds) {
                    this.bufferedLines.delete(removed);
                    this.currentLyricLineObjects[removed]?.disable();
                }
                if (this.bufferedLines.size > 0) {
                    this.scrollToIndex = Math.min(...this.bufferedLines);
                }
                relayout();
            }
        }

        if (this.bufferedLines.size === 0 && this.processedLines.length > 0) {
            const lastLine = this.processedLines[this.processedLines.length - 1];
            const bottomEl = this.bottomLine.getElement();
            const hasBottomContent = bottomEl.innerHTML.trim().length > 0;
            if (time >= lastLine.endTime) {
                const targetIndex = hasBottomContent
                    ? this.processedLines.length
                    : this.processedLines.length - 1;
                if (this.scrollToIndex !== targetIndex) {
                    this.scrollToIndex = targetIndex;
                    relayout();
                }
            }
        }

        this.lastCurrentTime = time;
    }

    calcLayout(sync = false, force = false) {
        const interlude = this.getCurrentInterlude();
        let curPos = -this.scrollOffset;
        const targetAlignIndex = this.scrollToIndex;
        let isNextDuet = false;

        if (interlude) {
            isNextDuet = interlude[3];
        } else {
            this.interludeDots.setInterlude(undefined);
            this.interludeDots.setDuet(false);
        }

        const fontSize = this.baseFontSize || 24;
        const dotMargin = fontSize * 0.4;
        const totalInterludeHeight = this.interludeDotsSize[1] + dotMargin * 2;
        if (interlude && interlude[2] !== -1) {
            curPos -= totalInterludeHeight;
        }

        const fallbackLineHeight = this.size[1] / DEFAULT_MAIN_LINE_HEIGHT_RATIO;
        const offset = this.currentLyricLineObjects
            .slice(0, targetAlignIndex)
            .reduce((acc, lineEl) => {
                if (lineEl.getLine().isBG && this.isPlaying) return acc;
                return acc + (this.lyricLinesSize.get(lineEl)?.[1] ?? fallbackLineHeight);
            }, 0);

        this.scrollBoundary[0] = -offset;
        curPos -= offset;
        curPos += this.size[1] * this.alignPosition;

        const currentLine = this.currentLyricLineObjects[targetAlignIndex];
        this.targetAlignIndex = targetAlignIndex;
        const isBottomFocused = targetAlignIndex === this.currentLyricLineObjects.length;
        this.bottomLine.setFocused(isBottomFocused);

        let targetLineHeight = 0;
        if (currentLine) {
            targetLineHeight = this.lyricLinesSize.get(currentLine)?.[1] ?? fallbackLineHeight;
        } else if (isBottomFocused) {
            targetLineHeight = this.bottomLine.lineSize[1];
        }

        if (targetLineHeight > 0) {
            if (this.alignAnchor === 'bottom') curPos -= targetLineHeight;
            else if (this.alignAnchor === 'center') curPos -= targetLineHeight / 2;
        }

        const latestIndex = this.bufferedLines.size > 0 ? Math.max(...this.bufferedLines) : this.scrollToIndex;
        let delay = 0;
        let baseDelay = sync ? 0 : 0.05;
        let setDots = false;

        this.currentLyricLineObjects.forEach((lineObj, index) => {
            const hasBuffered = this.bufferedLines.has(index);
            const isActive = hasBuffered || (index >= this.scrollToIndex && index < latestIndex);
            const line = lineObj.getLine();
            const shouldShowDots = interlude && index === interlude[2] + 1;

            if (!setDots && shouldShowDots) {
                setDots = true;
                curPos += dotMargin;
                const targetX = isNextDuet ? this.size[0] - this.interludeDotsSize[0] : 0;
                this.interludeDots.setTransform(targetX, curPos);
                this.interludeDots.setInterlude([interlude[0], interlude[1]]);
                this.interludeDots.setDuet(isNextDuet);
                curPos += this.interludeDotsSize[1] + dotMargin;
            }

            let targetOpacity;
            if (this.hidePassedLines && index < (interlude ? interlude[2] + 1 : this.scrollToIndex) && this.isPlaying) {
                targetOpacity = 0.00001;
            } else if (hasBuffered) {
                targetOpacity = 0.85;
            } else {
                targetOpacity = this.isNonDynamic ? 0.2 : 1;
            }

            let blurLevel = 0;
            if (this.enableBlur) {
                if (isActive) {
                    blurLevel = 0;
                } else {
                    blurLevel = 1;
                    if (index < this.scrollToIndex) {
                        blurLevel += Math.abs(this.scrollToIndex - index) + 1;
                    } else {
                        blurLevel += Math.abs(index - Math.max(this.scrollToIndex, latestIndex));
                    }
                }
            }
            if (this.isUserScrolling) {
                blurLevel = 0;
            }

            const targetScale = !isActive && this.isPlaying
                ? (line.isBG ? 75 : (this.enableScale ? 97 : 100))
                : 100;
            const renderMode = isActive ? LYRIC_RENDER_MODE.GRADIENT : LYRIC_RENDER_MODE.SOLID;

            lineObj.setTransform(
                curPos,
                targetScale,
                targetOpacity,
                window.innerWidth <= 1024 ? blurLevel * 0.8 : blurLevel,
                force,
                delay,
                renderMode,
            );

            if (line.isBG && (isActive || !this.isPlaying)) {
                curPos += this.lyricLinesSize.get(lineObj)?.[1] ?? fallbackLineHeight;
            } else if (!line.isBG) {
                curPos += this.lyricLinesSize.get(lineObj)?.[1] ?? fallbackLineHeight;
            }

            if (curPos >= 0 && !this.isSeeking) {
                if (!line.isBG) delay += baseDelay;
                if (index >= this.scrollToIndex) baseDelay /= 1.05;
            }
        });

        this.scrollBoundary[1] = curPos + this.scrollOffset - this.size[1] / 2;
        let finalBottomBlur = 0;
        if (this.enableBlur && !this.isUserScrolling && !isBottomFocused) {
            finalBottomBlur = 1 + Math.abs(this.currentLyricLineObjects.length - Math.max(this.scrollToIndex, latestIndex));
            if (window.innerWidth <= 1024) {
                finalBottomBlur *= 0.8;
            }
        }
        this.bottomLine.setTransform(0, curPos, finalBottomBlur, force, delay);
    }

    pause() {
        this.isPlaying = false;
        this.element.classList.remove(STYLE.playing);
        this.interludeDots.pause();
        for (const line of this.currentLyricLineObjects) {
            line.pause();
        }
        this.calcLayout();
    }

    resume() {
        this.isPlaying = true;
        this.element.classList.add(STYLE.playing);
        this.interludeDots.resume();
        for (const line of this.currentLyricLineObjects) {
            line.resume();
        }
        this.calcLayout();
    }

    update(delta = 0) {
        if (!this.initialLayoutFinished) return;
        if (!this.supportMaskImage) {
            this.element.style.setProperty('--amll-player-time', `${this.currentTime}`);
        }
        if (!this.isPageVisible) return;

        const deltaSeconds = delta / 1000;
        this.interludeDots.update(delta);
        this.bottomLine.update(deltaSeconds);
        for (const line of this.currentLyricLineObjects) {
            line.update(deltaSeconds);
        }
    }

    resetScroll() {
        this.isScrolled = false;
        this.isUserScrolling = false;
        this.scrollOffset = 0;
        this.currentScrollId += 1;
        clearTimeout(this.scrolledHandler);
        this.scrolledHandler = 0;
    }

    dispose() {
        this.resizeObserver.disconnect();
        window.removeEventListener('pageshow', this.onPageShow);
        window.removeEventListener('pagehide', this.onPageHide);
        for (const line of this.currentLyricLineObjects) {
            line.dispose();
        }
        this.currentLyricLineObjects = [];
        this.bottomLine.dispose();
        this.interludeDots.dispose();
        this.element.remove();
    }
}

const SECONDS_TO_MILLISECONDS = 1000;

function secondsToMilliseconds(value, fallback = 0) {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number * SECONDS_TO_MILLISECONDS) : fallback;
}

function getTrackWords(track, variant = 'main') {
    const key = variant === 'background' ? 'backgroundWords' : 'words';
    return Array.isArray(track?.[key]) ? track[key] : null;
}

function getTrackText(track, variant = 'main') {
    if (!track) return '';

    const textKey = variant === 'background' ? 'backgroundText' : 'text';
    const rawText = typeof track[textKey] === 'string' ? track[textKey] : '';
    if (rawText.trim().length > 0) return rawText;

    const words = getTrackWords(track, variant);
    return Array.isArray(words) ? words.map((word) => String(word?.text ?? '')).join('').trim() : '';
}

function pickTrack(tracks, variant = 'main') {
    if (!Array.isArray(tracks) || tracks.length === 0) return null;

    return tracks.find((track) => {
        const words = getTrackWords(track, variant);
        return Array.isArray(words) && words.length > 0;
    }) ?? tracks.find((track) => getTrackText(track, variant).length > 0) ?? null;
}

function mapRubySegments(rubySegments, fallbackStartTime, fallbackEndTime) {
    if (!Array.isArray(rubySegments) || rubySegments.length === 0) return undefined;

    const mapped = rubySegments
        .map((ruby) => {
            const word = String(ruby?.word ?? '');
            if (word.trim().length === 0) return null;

            const startTime = secondsToMilliseconds(ruby?.startTime ?? ruby?.start, fallbackStartTime);
            const endTime = Math.max(
                startTime,
                secondsToMilliseconds(ruby?.endTime ?? ruby?.end, fallbackEndTime),
            );
            return {
                word,
                startTime,
                endTime,
            };
        })
        .filter(Boolean);

    return mapped.length > 0 ? mapped : undefined;
}

function createLyricWord(word, fallbackStartTime, fallbackEndTime, romanWord = '') {
    const startTime = secondsToMilliseconds(word?.startTime ?? word?.start, fallbackStartTime);
    const endTime = Math.max(
        startTime,
        secondsToMilliseconds(word?.endTime ?? word?.end, fallbackEndTime),
    );
    const nextWord = {
        word: String(word?.word ?? word?.text ?? ''),
        startTime,
        endTime,
    };

    const sourceRoman = typeof word?.romanWord === 'string' ? word.romanWord.trim() : '';
    const nextRoman = sourceRoman || romanWord.trim();
    if (nextRoman.length > 0) {
        nextWord.romanWord = nextRoman;
    }
    if (word?.obscene === true) {
        nextWord.obscene = true;
    }

    const ruby = mapRubySegments(word?.ruby, startTime, endTime);
    if (ruby) {
        nextWord.ruby = ruby;
    }

    return nextWord;
}

function createFallbackWords(text, startTime, endTime) {
    if (typeof text !== 'string' || text.length === 0) return [];
    return [{
        word: text,
        startTime,
        endTime: Math.max(startTime, endTime),
    }];
}

function mapWordTrack(words, fallbackStartTime, fallbackEndTime, romanWords = null) {
    if (!Array.isArray(words) || words.length === 0) return [];

    const shouldAttachRomanWords = Array.isArray(romanWords) && romanWords.length === words.length;

    return words.map((word, index) => createLyricWord(
        word,
        fallbackStartTime,
        fallbackEndTime,
        shouldAttachRomanWords ? String(romanWords[index]?.text ?? '') : '',
    ));
}

function createLyricLine(words, text, translatedLyric, romanLyric, startTime, endTime, isBG, isDuet) {
    const normalizedWords = words.length > 0 ? words : createFallbackWords(text, startTime, endTime);
    if (normalizedWords.length === 0) return null;

    const lineStartTime = normalizedWords[0]?.startTime ?? startTime;
    const lineEndTime = Math.max(
        lineStartTime,
        normalizedWords[normalizedWords.length - 1]?.endTime ?? endTime,
        endTime,
    );

    return {
        words: normalizedWords,
        translatedLyric: translatedLyric || '',
        romanLyric: romanLyric || '',
        startTime: lineStartTime,
        endTime: lineEndTime,
        isBG,
        isDuet,
    };
}

function convertLocalLine(line) {
    const lineStartTime = secondsToMilliseconds(line?.start, 0);
    const lineEndTime = Math.max(lineStartTime, secondsToMilliseconds(line?.end, lineStartTime));
    const backgroundStartTime = secondsToMilliseconds(line?.backgroundStart, lineStartTime);
    const backgroundEndTime = Math.max(
        backgroundStartTime,
        secondsToMilliseconds(line?.backgroundEnd, lineEndTime),
    );
    const romanTrack = pickTrack(line?.romanizations, 'main');
    const translationTrack = pickTrack(line?.translations, 'main');
    const mainWords = mapWordTrack(
        line?.words,
        lineStartTime,
        lineEndTime,
        getTrackWords(romanTrack, 'main'),
    );
    const mainRomanWords = getTrackWords(romanTrack, 'main');
    const hasWordLevelRoman = Array.isArray(mainRomanWords) && mainRomanWords.length === mainWords.length && mainWords.length > 0;

    const convertedLines = [];
    const mainLine = createLyricLine(
        mainWords,
        typeof line?.text === 'string' ? line.text : '',
        getTrackText(translationTrack, 'main'),
        hasWordLevelRoman ? '' : getTrackText(romanTrack, 'main'),
        lineStartTime,
        lineEndTime,
        false,
        !!line?.oppositeTurn,
    );
    if (mainLine) {
        convertedLines.push(mainLine);
    }

    const hasBackgroundLine = (
        (typeof line?.backgroundText === 'string' && line.backgroundText.length > 0) ||
        (Array.isArray(line?.backgroundWords) && line.backgroundWords.length > 0)
    );
    if (!hasBackgroundLine) {
        return convertedLines;
    }

    const bgRomanTrack = pickTrack(line?.romanizations, 'background');
    const bgTranslationTrack = pickTrack(line?.translations, 'background');
    const bgWords = mapWordTrack(
        line?.backgroundWords,
        backgroundStartTime,
        backgroundEndTime,
        getTrackWords(bgRomanTrack, 'background'),
    );
    const bgRomanWords = getTrackWords(bgRomanTrack, 'background');
    const hasWordLevelBgRoman = Array.isArray(bgRomanWords) && bgRomanWords.length === bgWords.length && bgWords.length > 0;
    const bgLine = createLyricLine(
        bgWords,
        typeof line?.backgroundText === 'string' ? line.backgroundText : '',
        getTrackText(bgTranslationTrack, 'background'),
        hasWordLevelBgRoman ? '' : getTrackText(bgRomanTrack, 'background'),
        backgroundStartTime,
        backgroundEndTime,
        true,
        !!line?.oppositeTurn,
    );

    if (bgLine) {
        convertedLines.push(bgLine);
    }

    return convertedLines;
}

function convertLyricsPayload(lyricsData) {
    if (!lyricsData || !lyricsData.found || !Array.isArray(lyricsData.lines)) return [];

    const convertedLines = lyricsData.lines
        .flatMap((line) => convertLocalLine(line))
        .filter((line) => line && line.words.length > 0);
    const preferredLang = inferPreferredLyricLang(convertedLines);
    if (!preferredLang) return convertedLines;

    return convertedLines.map((line) => {
        const text = line.words.map((word) => word.word).join('');
        const strongLang = detectStrongLyricTextLang(text);
        const fallbackLang = detectLyricTextLang(text);
        return {
            ...line,
            preferredLang: strongLang || (fallbackLang === 'zh-Hans' ? preferredLang : fallbackLang || preferredLang),
        };
    });
}

export class AMLLLyricPlayer {
    constructor(container) {
        this.container = container;
        this.player = new AMLLDomLyricPlayer();
        this.currentTime = 0;
        this.isPlaying = false;
        this.animationFrame = 0;
        this.lastAnimationTime = 0;
        this.tick = (timestamp) => {
            if (!this.animationFrame) return;

            if (!this.lastAnimationTime) {
                this.lastAnimationTime = timestamp;
            }

            const delta = Math.max(0, Math.min(100, timestamp - this.lastAnimationTime));
            this.lastAnimationTime = timestamp;
            this.player.update(delta);
            this.animationFrame = requestAnimationFrame(this.tick);
        };

        if (this.container) {
            this.container.innerHTML = '';
            this.container.appendChild(this.player.getElement());
        }

        this.player.pause();
        this.player.update(0);
    }

    startAnimationLoop() {
        if (this.animationFrame) return;
        this.lastAnimationTime = 0;
        this.animationFrame = requestAnimationFrame(this.tick);
    }

    stopAnimationLoop() {
        if (!this.animationFrame) return;
        cancelAnimationFrame(this.animationFrame);
        this.animationFrame = 0;
        this.lastAnimationTime = 0;
    }

    setLines(lyricsData) {
        const lines = convertLyricsPayload(lyricsData);
        this.player.setLyricLines(lines, this.currentTime);
        this.player.update(0);
    }

    setCurrentTime(seconds) {
        this.currentTime = secondsToMilliseconds(seconds, this.currentTime);
        this.player.setCurrentTime(this.currentTime, false);
        if (!this.isPlaying) {
            this.player.update(0);
        }
    }

    seek(seconds) {
        this.currentTime = secondsToMilliseconds(seconds, this.currentTime);
        this.player.setCurrentTime(this.currentTime, true);
        this.player.update(0);
    }

    setWordFadeWidth(value = 0.5) {
        this.player.setWordFadeWidth(value);
    }

    setEnableSpring(enable = true) {
        this.player.setEnableSpring(enable);
    }

    setEnableScale(enable = true) {
        this.player.setEnableScale(enable);
    }

    setEnableBlur(enable = true) {
        this.player.setEnableBlur(enable);
    }

    setHidePassedLines(hide = false) {
        this.player.setHidePassedLines(hide);
    }

    setAlignAnchor(anchor = 'center') {
        this.player.setAlignAnchor(anchor);
    }

    setAlignPosition(position = 0.35) {
        this.player.setAlignPosition(position);
    }

    setIsSeeking(isSeeking = false) {
        this.player.setIsSeeking(isSeeking);
    }

    getBottomLineElement() {
        return this.player.bottomLine.getElement();
    }

    setPlaying(playing) {
        this.isPlaying = !!playing;
        if (this.isPlaying) {
            this.player.resume();
            this.startAnimationLoop();
        } else {
            this.player.pause();
            this.stopAnimationLoop();
            this.player.update(0);
        }
    }

    dispose() {
        this.stopAnimationLoop();
        this.player.dispose();
    }
}
