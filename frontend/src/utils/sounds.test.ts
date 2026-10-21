import { beforeEach, describe, expect, it, vi } from 'vitest';

const makeParam = () => ({
  setValueAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
  exponentialRampToValueAtTime: vi.fn(),
});

class FakeGainNode {
  gain = makeParam();
  connect = vi.fn(<T>(target: T) => target);
}

class FakeOscillatorNode {
  type = 'square';
  frequency = makeParam();
  connect = vi.fn(<T>(target: T) => target);
  start = vi.fn();
  stop = vi.fn();
}

/** Records the audio graph the sounds build, starting at `currentTime` 5s. */
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 5;
  destination = { kind: 'speakers' };
  gains: FakeGainNode[] = [];
  oscillators: FakeOscillatorNode[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createGain() {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }

  createOscillator() {
    const node = new FakeOscillatorNode();
    this.oscillators.push(node);
    return node;
  }
}

/** The module caches its AudioContext, so each test loads a fresh copy. */
async function loadSounds() {
  vi.resetModules();
  return import('./sounds');
}

const at = (seconds: number) => expect.closeTo(seconds, 6);

beforeEach(() => {
  FakeAudioContext.instances = [];
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

describe('playActivitySound', () => {
  it('plays two short rising sine tones through a shared fade-out envelope', async () => {
    const { playActivitySound } = await loadSounds();

    playActivitySound();

    const [context] = FakeAudioContext.instances;
    const [envelope, firstToneGain, secondToneGain] = context.gains;
    expect(envelope.connect).toHaveBeenCalledWith(context.destination);
    expect(envelope.gain.setValueAtTime).toHaveBeenCalledWith(0, 5);
    expect(envelope.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.16, at(5.012));
    expect(envelope.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.001, at(5.18));

    const [first, second] = context.oscillators;
    expect(context.oscillators).toHaveLength(2);
    expect([first.type, second.type]).toEqual(['sine', 'sine']);
    expect(first.frequency.setValueAtTime).toHaveBeenCalledWith(640, at(5));
    expect(first.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(1280, at(5.08));
    expect(second.frequency.setValueAtTime).toHaveBeenCalledWith(960, at(5.03));
    expect(second.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(1920, at(5.11));
    expect(first.start).toHaveBeenCalledWith(at(5));
    expect(first.stop).toHaveBeenCalledWith(at(5.2));
    expect(second.start).toHaveBeenCalledWith(at(5.03));
    expect(second.stop).toHaveBeenCalledWith(at(5.23));

    expect(first.connect).toHaveBeenCalledWith(firstToneGain);
    expect(firstToneGain.connect).toHaveBeenCalledWith(envelope);
    expect(second.connect).toHaveBeenCalledWith(secondToneGain);
    expect(secondToneGain.connect).toHaveBeenCalledWith(envelope);
  });
});

describe('playCompletionSound', () => {
  it('plays an ascending C-major arpeggio, one note every 120ms', async () => {
    const { playCompletionSound } = await loadSounds();

    playCompletionSound();

    const [context] = FakeAudioContext.instances;
    expect(context.oscillators.map((osc) => osc.frequency.setValueAtTime.mock.calls[0][0])).toEqual(
      [523.25, 659.25, 783.99, 1046.5]
    );
    context.oscillators.forEach((osc, index) => {
      const gain = context.gains[index];
      const start = 5 + index * 0.12;
      expect(osc.type).toBe('sine');
      expect(osc.connect).toHaveBeenCalledWith(gain);
      expect(gain.connect).toHaveBeenCalledWith(context.destination);
      expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0, at(start));
      expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.15, at(start + 0.02));
      expect(gain.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.001, at(start + 0.22));
      expect(osc.start).toHaveBeenCalledWith(at(start));
      expect(osc.stop).toHaveBeenCalledWith(at(start + 0.27));
    });
  });
});

describe('audio context handling', () => {
  it('reuses one AudioContext for every sound', async () => {
    const { playActivitySound, playCompletionSound } = await loadSounds();

    playActivitySound();
    playCompletionSound();
    playActivitySound();

    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0].oscillators).toHaveLength(8);
  });

  it('falls back to the prefixed webkitAudioContext (older Safari)', async () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', FakeAudioContext);
    const { playActivitySound } = await loadSounds();

    playActivitySound();

    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('stays silent without crashing when Web Audio is unavailable', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { playActivitySound, playCompletionSound } = await loadSounds();

    expect(() => playActivitySound()).not.toThrow();
    expect(() => playCompletionSound()).not.toThrow();

    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('Audio not supported');
  });

  it('allows sounds by default', async () => {
    const { canPlaySound } = await loadSounds();

    expect(canPlaySound()).toBe(true);
  });
});
