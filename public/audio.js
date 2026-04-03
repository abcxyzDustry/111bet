// VN Casino – Audio Engine (Web Audio API, no external files)

(function () {
  'use strict';

  let ctx = null;
  let masterGain = null;
  let sfxGain = null;
  let bgGain = null;
  let bgNodes = [];
  let bgRunning = false;
  let _muted = false;
  let _bgMuted = false;

  function getCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain(); masterGain.gain.value = 1.0;
      masterGain.connect(ctx.destination);
      sfxGain = ctx.createGain(); sfxGain.gain.value = 0.7;
      sfxGain.connect(masterGain);
      bgGain = ctx.createGain(); bgGain.gain.value = 0.18;
      bgGain.connect(masterGain);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /* ─── Helpers ───────────────────────────────────────────────── */
  function osc(freq, type, startTime, dur, gainVal, dest) {
    const c = getCtx();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, startTime);
    g.gain.setValueAtTime(gainVal, startTime);
    g.gain.exponentialRampToValueAtTime(0.001, startTime + dur);
    o.connect(g); g.connect(dest || sfxGain);
    o.start(startTime); o.stop(startTime + dur + 0.01);
  }

  function noise(startTime, dur, gainVal, filterFreq) {
    const c = getCtx();
    const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const flt = c.createBiquadFilter();
    flt.type = 'bandpass'; flt.frequency.value = filterFreq || 800;
    flt.Q.value = 0.5;
    const g = c.createGain();
    g.gain.setValueAtTime(gainVal, startTime);
    g.gain.exponentialRampToValueAtTime(0.001, startTime + dur);
    src.connect(flt); flt.connect(g); g.connect(sfxGain);
    src.start(startTime); src.stop(startTime + dur + 0.05);
  }

  /* ─── Sound Effects ─────────────────────────────────────────── */

  window.SFX = {

    // Short chip click when selecting chip amount
    chip() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      osc(1200, 'sine', t, 0.06, 0.3);
      osc(1800, 'sine', t + 0.02, 0.04, 0.2);
    },

    // Coin drop when placing a bet
    bet() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      osc(600, 'sine', t, 0.04, 0.5);
      osc(900, 'sine', t + 0.04, 0.08, 0.4);
      osc(1100, 'sine', t + 0.10, 0.06, 0.25);
      noise(t, 0.03, 0.15, 2000);
    },

    // Rapid tumbling sound for dice roll
    diceRoll() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      for (let i = 0; i < 18; i++) {
        const delay = i * 0.06 + Math.random() * 0.02;
        const pitch = 180 + Math.random() * 120;
        noise(t + delay, 0.04, 0.25 + Math.random() * 0.2, pitch);
        if (i % 3 === 0) osc(pitch * 2, 'square', t + delay, 0.03, 0.08);
      }
    },

    // Bầu Cua shake sound
    bauCuaRoll() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      for (let i = 0; i < 14; i++) {
        const delay = i * 0.08 + Math.random() * 0.03;
        noise(t + delay, 0.05, 0.3 + Math.random() * 0.15, 300 + Math.random() * 200);
      }
      osc(400, 'sawtooth', t, 0.05, 0.1);
    },

    // Spinning ball on roulette
    rouletteSpin() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      const dur = 3.5;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(220, t);
      o.frequency.linearRampToValueAtTime(80, t + dur * 0.7);
      o.frequency.linearRampToValueAtTime(30, t + dur);
      g.gain.setValueAtTime(0.08, t);
      g.gain.setValueAtTime(0.12, t + 0.3);
      g.gain.linearRampToValueAtTime(0.04, t + dur * 0.8);
      g.gain.linearRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(sfxGain);
      o.start(t); o.stop(t + dur + 0.1);

      // Clicking ticks as ball bounces
      for (let i = 0; i < 28; i++) {
        const rate = Math.max(0.05, 0.18 - i * 0.005);
        const delay = i * rate * 0.7;
        if (delay > dur) break;
        noise(t + delay, 0.025, 0.35, 1200 + Math.random() * 400);
      }
    },

    // Roulette ball landing clunk
    rouletteLand() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      noise(t, 0.12, 0.6, 800);
      osc(160, 'sine', t, 0.18, 0.4);
      osc(260, 'sine', t + 0.05, 0.12, 0.25);
    },

    // Slot machine reel spin
    slotSpin() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      const dur = 1.8;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(60, t);
      o.frequency.exponentialRampToValueAtTime(30, t + dur);
      g.gain.setValueAtTime(0.07, t);
      g.gain.linearRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(sfxGain);
      o.start(t); o.stop(t + dur + 0.05);

      // Reel clicks
      for (let i = 0; i < 22; i++) {
        const delay = i * 0.055 * (1 + i * 0.015);
        if (delay > dur) break;
        noise(t + delay, 0.03, 0.2 + Math.random() * 0.15, 600 + Math.random() * 300);
      }
    },

    // Slot reel stop thud
    slotStop(reelIndex) {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime + (reelIndex || 0) * 0.22;
      noise(t, 0.08, 0.55, 500);
      osc(120 - (reelIndex || 0) * 10, 'sine', t, 0.12, 0.3);
    },

    // Win fanfare
    win() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      const notes = [523, 659, 784, 1047];
      notes.forEach((f, i) => {
        osc(f, 'sine', t + i * 0.14, 0.35, 0.45);
        osc(f * 1.5, 'sine', t + i * 0.14, 0.25, 0.15);
      });
      osc(1047, 'sine', t + 0.7, 0.5, 0.55);
      // Coin shower
      for (let i = 0; i < 10; i++) {
        const d = 0.5 + i * 0.07 + Math.random() * 0.05;
        osc(800 + Math.random() * 400, 'sine', t + d, 0.05, 0.3);
        noise(t + d, 0.04, 0.2, 1800);
      }
    },

    // Big jackpot win
    jackpot() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      const melody = [523, 659, 784, 1047, 784, 1047, 1319, 1047];
      melody.forEach((f, i) => {
        osc(f, 'sine', t + i * 0.12, 0.28, 0.55);
        osc(f / 2, 'triangle', t + i * 0.12, 0.28, 0.2);
      });
      for (let i = 0; i < 18; i++) {
        const d = 0.3 + i * 0.09 + Math.random() * 0.04;
        noise(t + d, 0.05, 0.3, 1200 + Math.random() * 600);
      }
    },

    // Loss sound
    loss() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      osc(300, 'sine', t, 0.15, 0.35);
      osc(240, 'sine', t + 0.15, 0.2, 0.35);
      osc(180, 'sine', t + 0.35, 0.3, 0.3);
    },

    // Tab switch click
    tabClick() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      osc(800, 'sine', t, 0.04, 0.2);
      osc(1000, 'sine', t + 0.03, 0.03, 0.15);
    },

    // Countdown tick
    tick() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      osc(440, 'sine', t, 0.04, 0.2);
    },

    // Countdown end (beep)
    tickEnd() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      osc(880, 'sine', t, 0.12, 0.4);
      osc(660, 'sine', t + 0.12, 0.1, 0.3);
    }
  };

  /* ─── Background Music ──────────────────────────────────────── */

  // Vietnamese-inspired pentatonic melody loop using Web Audio API
  const BG_TEMPO = 138; // bpm
  const BG_BEAT = 60 / BG_TEMPO;

  // Pentatonic scale: C D E G A (casino-lounge feel)
  const SCALE = [
    261.63, 293.66, 329.63, 392.00, 440.00,   // C4 D4 E4 G4 A4
    523.25, 587.33, 659.25, 784.00, 880.00     // C5 D5 E5 G5 A5
  ];

  const MELODY = [4,5,6,8,9,8,6,5, 4,5,4,3,2,3,4,5,
                  6,8,9,9,8,6,5,4, 3,2,1,0,1,2,3,4];
  const BASS   = [0,0,0,0, 5,5,5,5, 3,3,3,3, 2,2,2,2];

  let bgSeq = null;

  function startBGMusic() {
    if (bgRunning || _bgMuted) return;
    bgRunning = true;
    const c = getCtx();

    let step = 0;
    let bassStep = 0;
    let nextTime = c.currentTime + 0.1;

    function schedule() {
      while (nextTime < c.currentTime + 0.5) {

        // Melody note
        const mi = MELODY[step % MELODY.length];
        const mf = SCALE[mi];
        const mo = c.createOscillator();
        const mg = c.createGain();
        mo.type = 'triangle';
        mo.frequency.value = mf;
        mg.gain.setValueAtTime(0, nextTime);
        mg.gain.linearRampToValueAtTime(0.55, nextTime + 0.02);
        mg.gain.setValueAtTime(0.45, nextTime + BG_BEAT * 0.6);
        mg.gain.linearRampToValueAtTime(0, nextTime + BG_BEAT * 0.85);
        mo.connect(mg); mg.connect(bgGain);
        mo.start(nextTime); mo.stop(nextTime + BG_BEAT);

        // Harmony (3rd above)
        const hf = mf * 1.26;
        const ho = c.createOscillator();
        const hg = c.createGain();
        ho.type = 'sine';
        ho.frequency.value = hf;
        hg.gain.setValueAtTime(0, nextTime);
        hg.gain.linearRampToValueAtTime(0.18, nextTime + 0.03);
        hg.gain.linearRampToValueAtTime(0, nextTime + BG_BEAT * 0.8);
        ho.connect(hg); hg.connect(bgGain);
        ho.start(nextTime); ho.stop(nextTime + BG_BEAT);

        // Bass (every 4 steps)
        if (step % 4 === 0) {
          const bi = BASS[bassStep % BASS.length];
          const bf = SCALE[bi] / 2;
          const bo = c.createOscillator();
          const bg2 = c.createGain();
          bo.type = 'sawtooth';
          bo.frequency.value = bf;
          bg2.gain.setValueAtTime(0, nextTime);
          bg2.gain.linearRampToValueAtTime(0.28, nextTime + 0.04);
          bg2.gain.linearRampToValueAtTime(0, nextTime + BG_BEAT * 3.8);
          bo.connect(bg2); bg2.connect(bgGain);
          bo.start(nextTime); bo.stop(nextTime + BG_BEAT * 4);
          bassStep++;
        }

        // Hi-hat every beat
        noise(nextTime, 0.03, 0.06, 8000);

        // Kick every 4 steps
        if (step % 4 === 0) {
          const ko = c.createOscillator();
          const kg = c.createGain();
          ko.type = 'sine';
          ko.frequency.setValueAtTime(120, nextTime);
          ko.frequency.exponentialRampToValueAtTime(40, nextTime + 0.12);
          kg.gain.setValueAtTime(0.5, nextTime);
          kg.gain.exponentialRampToValueAtTime(0.001, nextTime + 0.25);
          ko.connect(kg); kg.connect(bgGain);
          ko.start(nextTime); ko.stop(nextTime + 0.3);
        }

        // Snare on beats 2 and 4
        if (step % 4 === 2) {
          noise(nextTime, 0.10, 0.22, 1200);
          osc(200, 'sine', nextTime, 0.08, 0.25, bgGain);
        }

        nextTime += BG_BEAT;
        step++;
      }
    }

    bgSeq = setInterval(schedule, 200);
  }

  function stopBGMusic() {
    bgRunning = false;
    if (bgSeq) { clearInterval(bgSeq); bgSeq = null; }
  }

  /* ─── Public Controls ───────────────────────────────────────── */
  window.AudioCtrl = {
    start() { getCtx(); startBGMusic(); },
    stop()  { stopBGMusic(); },

    toggleMute() {
      _muted = !_muted;
      sfxGain && (sfxGain.gain.value = _muted ? 0 : 0.7);
      return _muted;
    },

    toggleBGMusic() {
      _bgMuted = !_bgMuted;
      if (_bgMuted) { stopBGMusic(); bgGain && (bgGain.gain.value = 0); }
      else { bgGain && (bgGain.gain.value = 0.18); startBGMusic(); }
      return _bgMuted;
    },

    isMuted()   { return _muted; },
    isBGMuted() { return _bgMuted; },

    setBGVolume(v) { if (bgGain) bgGain.gain.value = v; },
    setSFXVolume(v) { if (sfxGain) sfxGain.gain.value = v; }
  };

})();
