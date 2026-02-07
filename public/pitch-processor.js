class PitchProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.bufferSize = 4096;
        this.buffer = new Float32Array(this.bufferSize);
        this.writeIndex = 0;
        this.readIndex = 0;
        this.pitchRatio = 1.0;

        // Windowing for smoothing grains
        this.fadeLength = 1200;
        this.fadeIndex = 0;
    }

    static get parameterDescriptors() {
        return [{
            name: 'pitch',
            defaultValue: 0,
            minValue: -12,
            maxValue: 12,
            automationRate: "k-rate"
        }];
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        const pitchSemitones = parameters.pitch[0];

        // Calculate pitch ratio from semitones
        // 2^(semitones/12)
        const targetRatio = Math.pow(2, pitchSemitones / 12);

        // Smooth parameter changes
        this.pitchRatio = this.pitchRatio * 0.95 + targetRatio * 0.05;

        // If no input, do nothing
        if (!input || !input.length) return true;

        const inputChannel = input[0];
        const outputChannel = output[0];
        // If stereo, just process left channel for now or duplicate logic. 
        // Typically AudioWorklet inputs are [channel][sample].
        // For simplicity in this mono-compatible implementation, we operate on channel 0 and copy to others if needed.
        // But let's support stereo basic pass-through/processing if possible.
        // Actually, for pitch shifting, independent processing of channels can cause phase issues.
        // Best to process one and copy, or process both lock-step.
        // Let's implement mono-in, stereo-out based on input 0.

        for (let i = 0; i < inputChannel.length; i++) {
            // Write to circular buffer
            this.buffer[this.writeIndex] = inputChannel[i];
            this.writeIndex = (this.writeIndex + 1) % this.bufferSize;

            // Read from circular buffer with pitch shift
            // We use a simple granular approach:
            // Read pointer moves at speed 'pitchRatio'.
            // If it drifts too far from write pointer, we crossfade to a new position.

            const dist = (this.writeIndex - this.readIndex + this.bufferSize) % this.bufferSize;

            // Logic to keep read pointer within a reasonable window behind write pointer
            // If pitch > 1 (faster), read catches up to write.
            // If pitch < 1 (slower), read falls behind.

            // "Jungle" / Granular-ish Logic
            // The read index is conceptually moving at speed `pitchRatio` relative to sample rate.

            let val = 0;

            if (Math.abs(1.0 - this.pitchRatio) < 0.01) {
                // Passthrough-ish if close to 1.0
                val = this.buffer[(this.writeIndex - 100 + this.bufferSize) % this.bufferSize];
                this.readIndex = (this.writeIndex - 100 + this.bufferSize) % this.bufferSize;
            } else {
                // Cubic or Linear Interpolation for read
                const iRead = Math.floor(this.readIndex);
                const frac = this.readIndex - iRead;

                const p0 = this.buffer[(iRead + this.bufferSize) % this.bufferSize];
                const p1 = this.buffer[(iRead + 1 + this.bufferSize) % this.bufferSize];

                val = p0 + frac * (p1 - p0);

                // Move read pointer
                this.readIndex += this.pitchRatio;

                // Check bounds and jump/fade if needed
                // Ideal distance is somewhat arbitrary, say 1/2 buffer.
                // If we impinge on the write head or get too far, we reset.
                // A primitive phase vocoder / granulizer resets repeatedly.

                // Let's try a strict window approach:
                // We always want to read from the past.
                // Determine a customized delay window.
                const minDelay = 100;
                const maxDelay = this.bufferSize - 100;

                // Calculate actual delay
                // Since readIndex is arbitrary float, we compare to writeIndex
                let currentDelay = (this.writeIndex - this.readIndex + this.bufferSize) % this.bufferSize;
                // If negative logic (read ahead of write), it wraps to huge positive.

                if (currentDelay < minDelay || currentDelay > maxDelay) {
                    // Jump back to a safe spot.
                    // To avoid clicks, we should have been fading.
                    // A simple Strategy: crossfade two read pointers. 
                    // But that requires two pointers.

                    // Simple snap for MVP:
                    this.readIndex = (this.writeIndex - this.bufferSize / 2 + this.bufferSize) % this.bufferSize;
                }
            }

            outputChannel[i] = val;

            // Simple Stereo Copy
            if (output.length > 1) {
                output[1][i] = val;
            }
        }

        return true;
    }
}

// Just a more robust Grain-based shifter for better quality
// The above linear read with jump is 'glitchy'.
// Let's implement a dual-pointer crossfading delay (basic precise pitch shifter).

class JungleProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.bufferSize = 8192; // Larger buffer
        this.buffer = new Float32Array(this.bufferSize);
        this.writePos = 0;

        this.readPosA = 0;
        this.readPosB = 0; // Not used in simple logic but needed for overlaps

        // We use a phasor phase (0..1) to control grains
        this.phase = 0;
    }

    static get parameterDescriptors() {
        return [{ name: 'pitch', defaultValue: 0 }];
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        const pitch = parameters.pitch.length > 1 ? parameters.pitch[0] : parameters.pitch[0];

        // 2^(semitones/12)
        const ratio = Math.pow(2, pitch / 12);

        // In a delay-line pitch shifter, the grain rate is related to the pitch shift.
        // read_speed = 1.0;
        // The *delay* modulation speed is (1 - ratio).

        if (!input || !input.length) return true;
        const inputL = input[0];
        const outputL = output[0];
        const outputR = output[1] || outputL;

        const grainSize = 2048; // Size of window

        for (let i = 0; i < inputL.length; i++) {
            // Write
            this.buffer[this.writePos] = inputL[i];

            // Phasor frequency determines how fast we scan through the delay line
            // Frequency = (1 - ratio) / grain_duration_in_samples ?
            // Actually, we want the delay to change by (1-ratio) samples per sample.
            // So the 'delay head' moves at speed (ratio - 1).

            // If ratio = 1, speed = 0 (constant delay).
            // If ratio = 2, speed = 1 (delay increases by 1 sample per sample, effectively reading at 0 speed? No.)

            // Let's use the rotating tape head analogy.
            // Read Pointer = Write Pointer - Delay
            // Delay varies.

            // Delay is modulated by a sawtooth wave (phasor).
            // When phasor wraps, we crossfade.

            const speed = (1.0 - ratio);
            this.phase += speed / grainSize;

            if (this.phase > 1.0) this.phase -= 1.0;
            if (this.phase < 0.0) this.phase += 1.0;

            // Two Delay Taps, 180 degrees out of phase
            let phaseA = this.phase;
            let phaseB = (this.phase + 0.5) % 1.0;

            // Delay in samples (0 to grainSize)
            let delayA = phaseA * grainSize;
            let delayB = phaseB * grainSize;

            // Read positions
            let posA = (this.writePos - delayA + this.bufferSize) % this.bufferSize;
            let posB = (this.writePos - delayB + this.bufferSize) % this.bufferSize;

            // Interpolated Read A
            let idxA = Math.floor(posA);
            const fracA = posA - idxA;
            const valA = this.buffer[idxA] * (1 - fracA) + this.buffer[(idxA + 1) % this.bufferSize] * fracA;

            // Interpolated Read B
            let idxB = Math.floor(posB);
            const fracB = posB - idxB;
            const valB = this.buffer[idxB] * (1 - fracB) + this.buffer[(idxB + 1) % this.bufferSize] * fracB;

            // Window (Triangle or Hanning)
            // Triangle window for 0..1 phase, centered at 0.5?
            // Actually the "fades" happen at the wrap points of the delay.
            // The tape head jump happens when delay wraps from max to 0.
            // So we want volume 0 at phase 0 and 1. Volume 1 at phase 0.5.

            // Triangle window based on phase (0->0, 0.5->1, 1->0)
            let gainA = 1.0 - 2.0 * Math.abs(phaseA - 0.5);
            let gainB = 1.0 - 2.0 * Math.abs(phaseB - 0.5);

            // Output
            let outSample = (valA * gainA + valB * gainB);

            outputL[i] = outSample;
            if (output.length > 1) outputR[i] = outSample;

            // Increment write
            this.writePos = (this.writePos + 1) % this.bufferSize;
        }

        return true;
    }
}

registerProcessor('pitch-processor', JungleProcessor);
