// Sound utility using Web Audio API
// Creates pleasant, subtle notification sounds without audio files

let audioContext: AudioContext | null = null;

const getAudioContext = (): AudioContext => {
    if (!audioContext) {
        audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    return audioContext;
};

// Cute, uplifting two-tone chime for activity updates
export const playActivitySound = () => {
    try {
        const ctx = getAudioContext();
        const now = ctx.currentTime;

        // Shared envelope for a gentle fade
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, now);
        env.gain.linearRampToValueAtTime(0.16, now + 0.012);
        env.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        env.connect(ctx.destination);

        const makeTone = (startFreq: number, endFreq: number, delay: number) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(startFreq, now + delay);
            osc.frequency.exponentialRampToValueAtTime(endFreq, now + delay + 0.08);

            gain.gain.setValueAtTime(1, now + delay);
            osc.connect(gain).connect(env);

            osc.start(now + delay);
            osc.stop(now + delay + 0.2);
        };

        // Slightly offset dual tones for a "sparkly" feel
        makeTone(640, 1280, 0);
        makeTone(960, 1920, 0.03);
    } catch (e) {
        console.log('Audio not supported');
    }
};

// Celebratory sound for 24 hours completion
export const playCompletionSound = () => {
    try {
        const ctx = getAudioContext();
        
        // Play a pleasant ascending arpeggio
        const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6 - C major arpeggio
        const noteDuration = 0.12;
        
        notes.forEach((freq, index) => {
            const oscillator = ctx.createOscillator();
            const gainNode = ctx.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(ctx.destination);

            oscillator.frequency.setValueAtTime(freq, ctx.currentTime);
            oscillator.type = 'sine';

            const startTime = ctx.currentTime + (index * noteDuration);
            
            gainNode.gain.setValueAtTime(0, startTime);
            gainNode.gain.linearRampToValueAtTime(0.15, startTime + 0.02);
            gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + noteDuration + 0.1);

            oscillator.start(startTime);
            oscillator.stop(startTime + noteDuration + 0.15);
        });
    } catch (e) {
        console.log('Audio not supported');
    }
};

// Check if sound should play (respects user preferences)
export const canPlaySound = (): boolean => {
    // Could be extended to check localStorage for sound preferences
    return true;
};
