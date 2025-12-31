// Sound utility using Web Audio API
// Creates pleasant, subtle notification sounds without audio files

let audioContext: AudioContext | null = null;

const getAudioContext = (): AudioContext => {
    if (!audioContext) {
        audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    return audioContext;
};

// Soft "pop" sound for activity updates
export const playActivitySound = () => {
    try {
        const ctx = getAudioContext();
        
        // Clean, subtle click like iOS/macOS
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();
        
        // Add a filter for warmth
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 1500;

        oscillator.connect(filter);
        filter.connect(gainNode);
        gainNode.connect(ctx.destination);

        oscillator.frequency.setValueAtTime(1800, ctx.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.03);
        oscillator.type = 'triangle';

        // Very short, snappy
        gainNode.gain.setValueAtTime(0.2, ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);

        oscillator.start(ctx.currentTime);
        oscillator.stop(ctx.currentTime + 0.08);
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
