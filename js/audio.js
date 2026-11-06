/**
 * FreeRetro - CC0 Generative Ambient Music Engine (Web Audio API)
 *
 * 100% Public Domain (CC0) procedural ambient synthesizer.
 * Generates warm, relaxing background soundscapes (Eno-style generative pads,
 * singing bowls, and soft rain) with zero external audio files required.
 */

export class AmbientMusicEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.isPlaying = false;
    this.isLocallyMuted = false;
    this.style = 'zen'; // 'zen' | 'bowls' | 'rain'
    this.chordInterval = null;
    this.noiseNode = null;
    this.activeNodes = new Set();
  }

  initContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return false;
      this.ctx = new AudioCtx();

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(0.001, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return true;
  }

  setStyle(style) {
    if (this.style === style) return;
    this.style = style || 'zen';
    if (this.isPlaying) {
      this.stop(true);
      this.start(this.style);
    }
  }

  toggleLocalMute() {
    this.isLocallyMuted = !this.isLocallyMuted;
    if (this.ctx && this.masterGain) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
      this.masterGain.gain.linearRampToValueAtTime(
        this.isLocallyMuted ? 0.0001 : 0.14,
        now + 0.5
      );
    }
    return this.isLocallyMuted;
  }

  start(style = this.style) {
    this.style = style || 'zen';
    if (this.isPlaying) return;
    if (!this.initContext()) return;

    this.isPlaying = true;
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(0.001, now);
    this.masterGain.gain.linearRampToValueAtTime(
      this.isLocallyMuted ? 0.0001 : 0.14,
      now + 2.0
    );

    if (this.style === 'rain') {
      this.startSoftRain();
    }

    // Play first chord immediately, then schedule generative chords
    this.triggerGenerativeChord();
    this.chordInterval = setInterval(() => {
      if (!this.isPlaying) return;
      if (this.ctx?.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      this.triggerGenerativeChord();
    }, 5200);
  }

  stop(immediate = false) {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    clearInterval(this.chordInterval);
    this.chordInterval = null;

    if (this.ctx && this.masterGain) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
      this.masterGain.gain.linearRampToValueAtTime(0.0001, now + (immediate ? 0.15 : 1.2));
    }

    setTimeout(() => {
      if (!this.isPlaying) {
        this.cleanupActiveNodes();
      }
    }, immediate ? 180 : 1300);
  }

  cleanupActiveNodes() {
    for (const node of this.activeNodes) {
      try {
        node.stop?.();
        node.disconnect?.();
      } catch (e) {}
    }
    this.activeNodes.clear();
    if (this.noiseNode) {
      try {
        this.noiseNode.stop();
        this.noiseNode.disconnect();
      } catch (e) {}
      this.noiseNode = null;
    }
  }

  triggerGenerativeChord() {
    if (!this.ctx || !this.isPlaying) return;

    // Warm pentatonic / major-9th frequencies in Hz (C4Maj9 / FMaj7 palette)
    const chords = [
      [130.81, 196.00, 246.94, 293.66], // C3, G3, B3, D4
      [174.61, 220.00, 261.63, 329.63], // F3, A3, C4, E4
      [146.83, 220.00, 261.63, 392.00], // D3, A3, C4, G4
      [164.81, 196.00, 293.66, 329.63]  // E3, G3, D4, E4
    ];

    const chord = chords[Math.floor(Math.random() * chords.length)];
    const now = this.ctx.currentTime;

    chord.forEach((freq, idx) => {
      // Slight stagger per note for natural arpeggiation
      const startOffset = idx * 0.35 + Math.random() * 0.2;
      this.playWarmPadNote(freq, now + startOffset, 6.5);
    });

    // Occasional high bell/bowl harmonic
    if (this.style === 'bowls' || Math.random() > 0.45) {
      const bellNotes = [523.25, 587.33, 659.25, 783.99];
      const bellFreq = bellNotes[Math.floor(Math.random() * bellNotes.length)];
      this.playWarmPadNote(bellFreq, now + 1.2, 5.0, true);
    }
  }

  playWarmPadNote(freq, startTime, duration, isBell = false) {
    if (!this.ctx) return;

    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const noteGain = this.ctx.createGain();

    osc1.type = 'sine';
    osc2.type = isBell ? 'sine' : 'triangle';

    osc1.frequency.setValueAtTime(freq, startTime);
    osc2.frequency.setValueAtTime(freq * (isBell ? 2.0 : 1.002), startTime); // Gentle chorus detune

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(isBell ? 1200 : 620, startTime);

    const peakGain = isBell ? 0.05 : 0.11;
    const attack = isBell ? 0.4 : 2.2;
    const release = isBell ? 3.5 : 3.2;

    noteGain.gain.setValueAtTime(0.0001, startTime);
    noteGain.gain.linearRampToValueAtTime(peakGain, startTime + attack);
    noteGain.gain.setValueAtTime(peakGain, startTime + duration - release);
    noteGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(noteGain);
    noteGain.connect(this.masterGain);

    osc1.start(startTime);
    osc2.start(startTime);
    osc1.stop(startTime + duration + 0.1);
    osc2.stop(startTime + duration + 0.1);

    this.activeNodes.add(osc1);
    this.activeNodes.add(osc2);

    osc1.onended = () => {
      this.activeNodes.delete(osc1);
      this.activeNodes.delete(osc2);
      try {
        noteGain.disconnect();
        filter.disconnect();
      } catch (e) {}
    };
  }

  startSoftRain() {
    if (!this.ctx || this.noiseNode) return;
    // Generate 3 seconds of warm pink-filtered noise buffer looped seamlessly
    const bufferSize = this.ctx.sampleRate * 3;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;

    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      output[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.015;
      b6 = white * 0.115926;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(520, this.ctx.currentTime);

    const rainGain = this.ctx.createGain();
    rainGain.gain.setValueAtTime(0.35, this.ctx.currentTime);

    noise.connect(filter);
    filter.connect(rainGain);
    rainGain.connect(this.masterGain);

    noise.start();
    this.noiseNode = noise;
  }
}

