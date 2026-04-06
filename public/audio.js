// VN Casino – Enhanced Audio Engine (Web Audio API)

(function () {
  'use strict';

  let ctx = null;
  let masterGain = null;
  let sfxGain = null;
  let bgGain = null;
  let bgRunning = false;
  let bgSeq = null;
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

  /* ─── Core Helpers ──────────────────────────────────────── */
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

  function noise(startTime, dur, gainVal, filterFreq, filterType) {
    const c = getCtx();
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource(); src.buffer = buf;
    const flt = c.createBiquadFilter();
    flt.type = filterType || 'bandpass';
    flt.frequency.value = filterFreq || 800;
    flt.Q.value = 0.5;
    const g = c.createGain();
    g.gain.setValueAtTime(gainVal, startTime);
    g.gain.exponentialRampToValueAtTime(0.001, startTime + dur);
    src.connect(flt); flt.connect(g); g.connect(sfxGain);
    src.start(startTime); src.stop(startTime + dur + 0.05);
  }

  // Reverb convolver for spatial casino feel
  function makeReverb(dur, decay) {
    const c = getCtx();
    const len = c.sampleRate * dur;
    const buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random()*2-1) * Math.pow(1-i/len, decay);
    }
    const conv = c.createConvolver(); conv.buffer = buf;
    return conv;
  }

  /* ─── Sound Effects ─────────────────────────────────────── */

  window.SFX = {

    // Chip click when selecting amount
    chip() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      osc(1400, 'sine', t, 0.05, 0.35);
      osc(2200, 'sine', t + 0.015, 0.04, 0.2);
      noise(t, 0.03, 0.1, 3000);
    },

    // Chip stack – placing a bet on the table
    bet() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      // 3 stacked chip drops
      [0, 0.04, 0.08].forEach((delay, i) => {
        osc(700 - i*60, 'sine', t+delay, 0.06, 0.5-i*0.1);
        noise(t+delay, 0.04, 0.2+i*0.05, 1800);
      });
    },

    // Multiple chips sliding onto table
    chipStack() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      for (let i = 0; i < 5; i++) {
        const delay = i * 0.055 + Math.random() * 0.02;
        osc(900 - i*40, 'sine', t+delay, 0.05, 0.4);
        noise(t+delay, 0.03, 0.15, 2200);
      }
    },

    // Dice rolling in cup – rattle + tumble
    diceRoll() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      // Shake sound
      for (let i = 0; i < 22; i++) {
        const delay = i * 0.055 + Math.random() * 0.025;
        const pitch = 160 + Math.random() * 140;
        noise(t + delay, 0.045, 0.28 + Math.random() * 0.22, pitch);
        if (i % 3 === 0) osc(pitch * 2.5, 'square', t+delay, 0.03, 0.07);
      }
      // Final thud when dice land
      noise(t + 1.3, 0.18, 0.6, 200, 'lowpass');
      osc(90, 'sine', t + 1.3, 0.2, 0.45);
    },

    // Table thud when dice hit the board
    diceLand() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      noise(t, 0.12, 0.7, 300, 'lowpass');
      osc(80, 'sine', t, 0.18, 0.5);
      osc(160, 'sine', t + 0.03, 0.1, 0.3);
    },

    // Bầu Cua gourd shake (heavier tumble)
    bauCuaRoll() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      for (let i = 0; i < 16; i++) {
        const delay = i * 0.07 + Math.random() * 0.03;
        noise(t + delay, 0.06, 0.35 + Math.random() * 0.18, 280 + Math.random() * 180);
      }
      osc(350, 'sawtooth', t, 0.06, 0.12);
      // Lid hit at end
      noise(t + 1.1, 0.15, 0.6, 400, 'lowpass');
      osc(200, 'sine', t + 1.1, 0.15, 0.4);
    },

    // Xóc Đĩa plate clang
    xocdiaRoll() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      // Plate clang
      osc(1200, 'sine', t, 0.08, 0.5);
      osc(1800, 'sine', t, 0.06, 0.3);
      osc(2400, 'sine', t, 0.04, 0.2);
      noise(t, 0.12, 0.4, 2000);
      // Coin rattles
      for (let i = 0; i < 12; i++) {
        const delay = 0.1 + i * 0.06 + Math.random() * 0.03;
        noise(t + delay, 0.04, 0.25, 900 + Math.random() * 400);
        osc(800 + Math.random()*600, 'sine', t+delay, 0.03, 0.1);
      }
      // Final reveal clang
      noise(t + 1.0, 0.18, 0.7, 1500);
      osc(1100, 'triangle', t + 1.0, 0.25, 0.4);
    },

    // Roulette ball spinning – realistic wheel
    rouletteSpin() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      const dur = 4.0;

      // Ball hum (high spin → slowing)
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(280, t);
      o.frequency.linearRampToValueAtTime(120, t + dur * 0.6);
      o.frequency.linearRampToValueAtTime(40, t + dur);
      g.gain.setValueAtTime(0.06, t);
      g.gain.linearRampToValueAtTime(0.1, t + 0.4);
      g.gain.linearRampToValueAtTime(0.03, t + dur * 0.85);
      g.gain.linearRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(sfxGain);
      o.start(t); o.stop(t + dur + 0.1);

      // Pocket clicks — fast then slow
      const totalClicks = 36;
      for (let i = 0; i < totalClicks; i++) {
        const progress = i / totalClicks;
        const rate = 0.04 + progress * 0.18;
        const delay = i * rate * (0.45 + progress * 0.35);
        if (delay > dur) break;
        noise(t + delay, 0.025, 0.4 + Math.random()*0.2, 1400 + Math.random()*600);
        if (i % 6 === 0) osc(500, 'sine', t+delay, 0.04, 0.15);
      }
    },

    // Ball drops into pocket — satisfying thunk
    rouletteLand() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      noise(t, 0.15, 0.75, 700);
      osc(140, 'sine', t, 0.22, 0.5);
      osc(240, 'sine', t + 0.06, 0.14, 0.3);
      osc(340, 'sine', t + 0.1, 0.08, 0.2);
      // Small bounce
      noise(t + 0.18, 0.07, 0.35, 1000);
      osc(180, 'sine', t + 0.18, 0.1, 0.25);
    },

    // Slot machine spin
    slotSpin() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      const dur = 2.0;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(65, t);
      o.frequency.exponentialRampToValueAtTime(28, t + dur);
      g.gain.setValueAtTime(0.07, t);
      g.gain.linearRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(sfxGain);
      o.start(t); o.stop(t + dur + 0.05);
      for (let i = 0; i < 24; i++) {
        const delay = i * 0.06 * (1 + i * 0.012);
        if (delay > dur) break;
        noise(t + delay, 0.03, 0.22 + Math.random()*0.15, 600 + Math.random()*300);
      }
    },

    // Slot reel stop thud (3 separate stops)
    slotStop(reelIndex) {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime + (reelIndex || 0) * 0.25;
      noise(t, 0.09, 0.65, 450);
      osc(115 - (reelIndex || 0) * 12, 'sine', t, 0.14, 0.35);
    },

    // ── Win sounds ──────────────────────────────────────────────

    // Normal win (coins falling)
    win() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      // Ascending fanfare
      const notes = [523, 659, 784, 1047];
      notes.forEach((f, i) => {
        osc(f, 'sine', t + i * 0.13, 0.38, 0.5);
        osc(f * 1.5, 'sine', t + i * 0.13, 0.22, 0.18);
      });
      osc(1047, 'sine', t + 0.65, 0.55, 0.6);
      // Coin shower
      for (let i = 0; i < 14; i++) {
        const d = 0.4 + i * 0.06 + Math.random() * 0.04;
        osc(900 + Math.random() * 500, 'sine', t + d, 0.04, 0.35);
        noise(t + d, 0.035, 0.22, 2200);
      }
    },

    // Big win — full casino celebration
    bigWin() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      const melody = [523, 659, 784, 880, 1047, 880, 1047, 1319];
      melody.forEach((f, i) => {
        osc(f, 'sine',     t + i * 0.11, 0.32, 0.6);
        osc(f * 2, 'sine', t + i * 0.11, 0.2,  0.22);
        osc(f / 2, 'triangle', t + i * 0.11, 0.22, 0.18);
      });
      // Coin explosion
      for (let i = 0; i < 25; i++) {
        const d = 0.25 + i * 0.07 + Math.random() * 0.04;
        noise(t + d, 0.04, 0.3, 1500 + Math.random() * 800);
        osc(800 + Math.random()*600, 'sine', t + d, 0.05, 0.3);
      }
      // Crowd cheer
      this._cheer(t + 0.4);
    },

    // Jackpot (max win, full orchestra)
    jackpot() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      const melody = [523, 659, 784, 1047, 784, 1047, 1319, 1047, 1319, 1568];
      melody.forEach((f, i) => {
        osc(f, 'sine', t + i * 0.10, 0.3, 0.62);
        osc(f / 2, 'triangle', t + i * 0.10, 0.26, 0.22);
        osc(f * 2, 'sine', t + i * 0.10, 0.18, 0.15);
      });
      for (let i = 0; i < 35; i++) {
        const d = 0.2 + i * 0.08 + Math.random() * 0.04;
        noise(t + d, 0.05, 0.32, 1200 + Math.random() * 900);
        osc(700 + Math.random()*700, 'sine', t+d, 0.05, 0.32);
      }
      this._cheer(t + 0.3);
    },

    // Casino crowd cheer layer
    _cheer(startTime) {
      const c = getCtx(), t = startTime;
      // Synthesized crowd: filtered noise with slow LFO
      const dur = 1.8;
      const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) {
        const envelope = Math.sin(Math.PI * i / d.length);
        d[i] = (Math.random() * 2 - 1) * envelope;
      }
      const src = c.createBufferSource(); src.buffer = buf;
      const flt = c.createBiquadFilter(); flt.type = 'bandpass';
      flt.frequency.value = 900; flt.Q.value = 0.4;
      const g = c.createGain(); g.gain.value = 0.18;
      src.connect(flt); flt.connect(g); g.connect(sfxGain);
      src.start(t); src.stop(t + dur + 0.1);
    },

    // Loss sound — descending
    loss() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      osc(320, 'sine', t, 0.14, 0.38);
      osc(255, 'sine', t + 0.16, 0.2, 0.38);
      osc(190, 'sine', t + 0.36, 0.32, 0.32);
      // Sad low thud
      noise(t + 0.5, 0.15, 0.3, 120, 'lowpass');
      osc(80, 'sine', t + 0.5, 0.2, 0.28);
    },

    // Tab / button click
    tabClick() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      osc(900, 'sine', t, 0.04, 0.2);
      osc(1100, 'sine', t + 0.025, 0.03, 0.14);
    },

    // Countdown tick (normal)
    tick() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      osc(500, 'sine', t, 0.04, 0.22);
    },

    // Last-3-seconds urgent tick
    urgentTick() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      osc(880, 'sine', t, 0.06, 0.35);
      osc(1100, 'sine', t + 0.06, 0.05, 0.28);
    },

    // Countdown end beep
    tickEnd() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      osc(1047, 'sine', t, 0.14, 0.45);
      osc(784, 'sine', t + 0.14, 0.12, 0.35);
    },

    // Bet closed buzz (when phase changes to ROLLING)
    betClosed() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      osc(300, 'sawtooth', t, 0.08, 0.35);
      osc(240, 'sawtooth', t + 0.08, 0.1, 0.3);
      noise(t, 0.08, 0.2, 400);
    },

    // New round chime
    newRound() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      [523, 659, 784].forEach((f, i) => osc(f, 'sine', t + i * 0.12, 0.2, 0.35));
    },

    // Notification / toast pop
    notify() {
      if (_muted) return;
      const c = getCtx(), t = c.currentTime;
      osc(880, 'sine', t, 0.05, 0.3);
      osc(1100, 'sine', t + 0.06, 0.04, 0.25);
    }
  };

  /* ─── Background Music ──────────────────────────────────── */
  const BG_TEMPO = 132;
  const BG_BEAT = 60 / BG_TEMPO;

  const SCALE = [
    261.63, 293.66, 329.63, 392.00, 440.00,
    523.25, 587.33, 659.25, 784.00, 880.00
  ];

  const MELODY = [4,5,6,8,9,8,6,5, 4,5,4,3,2,3,4,5,
                  6,8,9,9,8,6,5,4, 3,2,1,0,1,2,3,4];
  const BASS   = [0,0,0,0, 5,5,5,5, 3,3,3,3, 2,2,2,2];

  function startBGMusic() {
    if (bgRunning || _bgMuted) return;
    bgRunning = true;
    const c = getCtx();
    let step = 0, bassStep = 0;
    let nextTime = c.currentTime + 0.1;

    function schedule() {
      while (nextTime < c.currentTime + 0.55) {
        const mi = MELODY[step % MELODY.length];
        const mf = SCALE[mi];

        // Melody – triangle wave
        const mo = c.createOscillator(); const mg = c.createGain();
        mo.type = 'triangle'; mo.frequency.value = mf;
        mg.gain.setValueAtTime(0, nextTime);
        mg.gain.linearRampToValueAtTime(0.52, nextTime + 0.02);
        mg.gain.setValueAtTime(0.44, nextTime + BG_BEAT * 0.6);
        mg.gain.linearRampToValueAtTime(0, nextTime + BG_BEAT * 0.85);
        mo.connect(mg); mg.connect(bgGain);
        mo.start(nextTime); mo.stop(nextTime + BG_BEAT);

        // Harmony (5th above) – sine
        const hf = mf * 1.5;
        const ho = c.createOscillator(); const hg = c.createGain();
        ho.type = 'sine'; ho.frequency.value = hf;
        hg.gain.setValueAtTime(0, nextTime);
        hg.gain.linearRampToValueAtTime(0.14, nextTime + 0.03);
        hg.gain.linearRampToValueAtTime(0, nextTime + BG_BEAT * 0.75);
        ho.connect(hg); hg.connect(bgGain);
        ho.start(nextTime); ho.stop(nextTime + BG_BEAT);

        // Bass every 4 steps
        if (step % 4 === 0) {
          const bf = SCALE[BASS[bassStep % BASS.length]] / 2;
          const bo = c.createOscillator(); const bg2 = c.createGain();
          bo.type = 'sawtooth'; bo.frequency.value = bf;
          bg2.gain.setValueAtTime(0, nextTime);
          bg2.gain.linearRampToValueAtTime(0.28, nextTime + 0.04);
          bg2.gain.linearRampToValueAtTime(0, nextTime + BG_BEAT * 3.7);
          bo.connect(bg2); bg2.connect(bgGain);
          bo.start(nextTime); bo.stop(nextTime + BG_BEAT * 4);
          bassStep++;
        }

        // Hi-hat every beat
        const hatBuf = c.createBuffer(1, Math.ceil(c.sampleRate * 0.03), c.sampleRate);
        const hd = hatBuf.getChannelData(0);
        for (let i = 0; i < hd.length; i++) hd[i] = Math.random() * 2 - 1;
        const hatSrc = c.createBufferSource(); hatSrc.buffer = hatBuf;
        const hatFlt = c.createBiquadFilter(); hatFlt.type = 'highpass'; hatFlt.frequency.value = 7000;
        const hatG = c.createGain(); hatG.gain.setValueAtTime(0.045, nextTime);
        hatG.gain.exponentialRampToValueAtTime(0.001, nextTime + 0.03);
        hatSrc.connect(hatFlt); hatFlt.connect(hatG); hatG.connect(bgGain);
        hatSrc.start(nextTime); hatSrc.stop(nextTime + 0.04);

        // Kick on 1 and 3
        if (step % 4 === 0 || step % 4 === 2) {
          const ko = c.createOscillator(); const kg = c.createGain();
          ko.type = 'sine';
          ko.frequency.setValueAtTime(step % 4 === 0 ? 130 : 100, nextTime);
          ko.frequency.exponentialRampToValueAtTime(38, nextTime + 0.14);
          kg.gain.setValueAtTime(step % 4 === 0 ? 0.55 : 0.35, nextTime);
          kg.gain.exponentialRampToValueAtTime(0.001, nextTime + 0.28);
          ko.connect(kg); kg.connect(bgGain);
          ko.start(nextTime); ko.stop(nextTime + 0.32);
        }

        // Snare on 2 and 4
        if (step % 4 === 1 || step % 4 === 3) {
          const snareBuf = c.createBuffer(1, Math.ceil(c.sampleRate * 0.12), c.sampleRate);
          const sd = snareBuf.getChannelData(0);
          for (let i = 0; i < sd.length; i++) sd[i] = Math.random() * 2 - 1;
          const snSrc = c.createBufferSource(); snSrc.buffer = snareBuf;
          const snFlt = c.createBiquadFilter(); snFlt.type = 'bandpass';
          snFlt.frequency.value = 1000; snFlt.Q.value = 0.7;
          const snG = c.createGain();
          snG.gain.setValueAtTime(0.18, nextTime);
          snG.gain.exponentialRampToValueAtTime(0.001, nextTime + 0.12);
          snSrc.connect(snFlt); snFlt.connect(snG); snG.connect(bgGain);
          snSrc.start(nextTime); snSrc.stop(nextTime + 0.14);
          osc(180, 'sine', nextTime, 0.06, 0.22, bgGain);
        }

        // Accent on beat 1 (casino bell shimmer)
        if (step % 16 === 0) {
          [1200, 1500, 1800].forEach((f, i) =>
            osc(f, 'sine', nextTime + i*0.03, 0.4, 0.07, bgGain)
          );
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

  /* ─── Public Controls ───────────────────────────────────── */
  window.AudioCtrl = {
    start()  { getCtx(); startBGMusic(); },
    stop()   { stopBGMusic(); },

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

    setBGVolume(v)  { if (bgGain)  bgGain.gain.value  = v; },
    setSFXVolume(v) { if (sfxGain) sfxGain.gain.value = v; }
  };

})();
