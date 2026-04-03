// VN Casino – 3D Game Renderers (Three.js r128)

(function () {
  'use strict';

  // Check WebGL support
  function hasWebGL() {
    try {
      const c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch(e) { return false; }
  }

  if (!hasWebGL() || !window.THREE) {
    // Provide stub renderers that fail silently
    const stub = { init(){}, roll(){}, reset(){}, spin(){}, _dice:null, _wheel:null, _reels:[] };
    window.Dice3D = stub; window.BauCua3D = {...stub};
    window.Roulette3D = {...stub}; window.Slots3D = {...stub, _reels:[]};
    return;
  }

  /* ─── Constants ─────────────────────────────────────────────── */
  const BC_EMOJI = { bau: '🍐', cua: '🦀', tom: '🦐', ca: '🐟', ga: '🐓', nai: '🦌' };
  const BC_KEYS  = ['bau','cua','tom','ca','ga','nai'];
  const SLOT_SYM = ['7️⃣','💎','⭐','🔔','🍇','🍊','🍋','🍒'];
  const ROULETTE_RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

  /* ─── Lerp helper ───────────────────────────────────────────── */
  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpAngle(a, b, t) {
    let diff = b - a;
    while (diff > Math.PI)  diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
  }

  /* ═══════════════════════════════════════════════════════════════
     DICE 3D  –  Tài Xỉu
  ═══════════════════════════════════════════════════════════════ */
  function makeDiceFaceTex(val) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#f9f9f9';
    ctx.beginPath();
    roundRect(ctx, 6, 6, 244, 244, 28);
    ctx.fill();
    ctx.strokeStyle = '#ccc'; ctx.lineWidth = 5;
    ctx.beginPath(); roundRect(ctx, 6, 6, 244, 244, 28); ctx.stroke();
    const DOTS = {
      1: [[128,128]],
      2: [[78,78],[178,178]],
      3: [[78,78],[128,128],[178,178]],
      4: [[78,78],[178,78],[78,178],[178,178]],
      5: [[78,78],[178,78],[128,128],[78,178],[178,178]],
      6: [[78,78],[178,78],[78,128],[178,128],[78,178],[178,178]]
    };
    ctx.fillStyle = (val===1||val===4) ? '#c0392b' : '#1a1a1a';
    (DOTS[val]||[]).forEach(([x,y])=>{
      ctx.beginPath(); ctx.arc(x,y,24,0,Math.PI*2); ctx.fill();
    });
    return new THREE.CanvasTexture(c);
  }

  /* face assignments: +x→2, -x→5, +y→3, -y→4, +z→1, -z→6
     To show value V facing camera, rotate as below: */
  const DICE_ROT = {
    1: [0, 0],
    2: [0, -Math.PI/2],
    3: [-Math.PI/2, 0],
    4: [Math.PI/2, 0],
    5: [0, Math.PI/2],
    6: [0, Math.PI]
  };

  function makeDiceMesh() {
    const mats = [2,5,3,4,1,6].map(v => new THREE.MeshPhongMaterial({ map: makeDiceFaceTex(v), shininess: 80 }));
    const geo = new THREE.BoxGeometry(1,1,1);
    const mesh = new THREE.Mesh(geo, mats);
    // round edges via slight scale jitter (visual trick only)
    return mesh;
  }

  /* ─── Dice3D namespace ─────────────────────────────────────── */
  window.Dice3D = {
    _scenes: [],
    _active: false,
    _rafId: null,
    _state: 'idle', // idle | rolling | settling | done
    _targets: [0,0,0],
    _rotSpeeds: [],
    _settleProgress: 0,
    _startRots: [],
    _onDone: null,

    init(containerId) {
      try {
      const container = document.getElementById(containerId);
      if (!container) return;
      container.innerHTML = '';
      container.style.position = 'relative';
      container.style.background = '#111';
      container.style.borderRadius = '14px';
      container.style.overflow = 'hidden';

      const W = container.offsetWidth || 400;
      const H = container.offsetHeight || 180;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#111111');
      scene.fog = new THREE.Fog('#111111', 8, 20);

      const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 50);
      camera.position.set(0, 2.5, 7);
      camera.lookAt(0, 0, 0);

      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(W, H);
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.shadowMap.enabled = true;
      container.appendChild(renderer.domElement);

      // Lighting
      const ambient = new THREE.AmbientLight(0xffffff, 0.5);
      scene.add(ambient);
      const dir = new THREE.DirectionalLight(0xffffff, 0.9);
      dir.position.set(5, 10, 5);
      dir.castShadow = true;
      scene.add(dir);
      const fill = new THREE.DirectionalLight(0xffd080, 0.3);
      fill.position.set(-5, -3, 5);
      scene.add(fill);

      // Table plane
      const planeGeo = new THREE.PlaneGeometry(20, 20);
      const planeMat = new THREE.MeshPhongMaterial({ color: 0x0a1a0a });
      const plane = new THREE.Mesh(planeGeo, planeMat);
      plane.rotation.x = -Math.PI / 2;
      plane.position.y = -1;
      plane.receiveShadow = true;
      scene.add(plane);

      // Three dice
      const dice = [];
      for (let i = 0; i < 3; i++) {
        const d = makeDiceMesh();
        d.position.set((i - 1) * 2.2, 0, 0);
        d.castShadow = true;
        scene.add(d);
        dice.push(d);
      }

      this._scene = scene;
      this._camera = camera;
      this._renderer = renderer;
      this._dice = dice;
      this._state = 'idle';
      this._rotSpeeds = dice.map(() => ({ x: 0, y: 0, z: 0 }));

      const loop = () => {
        this._rafId = requestAnimationFrame(loop);
        this._tick();
        renderer.render(scene, camera);
      };
      loop();
      } catch(e) { console.warn('Dice3D init failed:', e.message); }
    },

    _tick() {
      if (!this._dice) return;
      if (this._state === 'rolling') {
        this._dice.forEach((d, i) => {
          d.rotation.x += this._rotSpeeds[i].x;
          d.rotation.y += this._rotSpeeds[i].y;
          d.rotation.z += this._rotSpeeds[i].z;
        });
      } else if (this._state === 'settling') {
        this._settleProgress += 0.04;
        const t = Math.min(this._settleProgress, 1);
        const ease = 1 - Math.pow(1 - t, 3);
        this._dice.forEach((d, i) => {
          const tx = this._targets[i][0], ty = this._targets[i][1];
          d.rotation.x = lerpAngle(this._startRots[i][0], tx, ease);
          d.rotation.y = lerpAngle(this._startRots[i][1], ty, ease);
          d.rotation.z = lerp(this._startRots[i][2], 0, ease);
        });
        if (t >= 1) {
          this._state = 'done';
          if (this._onDone) { this._onDone(); this._onDone = null; }
        }
      }
    },

    roll(values, onDone) {
      if (!this._dice) return;
      this._state = 'rolling';
      this._rotSpeeds = this._dice.map(() => ({
        x: (Math.random()-0.5)*0.4 + 0.1,
        y: (Math.random()-0.5)*0.4 + 0.1,
        z: (Math.random()-0.5)*0.2
      }));
      setTimeout(() => {
        this._targets = values.map(v => {
          const r = DICE_ROT[v] || [0,0];
          const fullTurns = Math.floor(Math.random()*3+2)*Math.PI*2;
          return [r[0] + fullTurns, r[1] + fullTurns, 0];
        });
        this._startRots = this._dice.map(d => [d.rotation.x, d.rotation.y, d.rotation.z]);
        this._settleProgress = 0;
        this._state = 'settling';
        this._onDone = onDone;
      }, 2200);
    },

    reset() {
      if (!this._dice) return;
      this._state = 'idle';
      this._dice.forEach(d => { d.rotation.set(0.3, 0.5, 0.1); });
    }
  };

  /* ═══════════════════════════════════════════════════════════════
     BAU CUA 3D
  ═══════════════════════════════════════════════════════════════ */
  function makeBCFaceTex(sym) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0d2a0d';
    ctx.beginPath(); roundRect(ctx,6,6,244,244,28); ctx.fill();
    ctx.strokeStyle = '#2a6a2a'; ctx.lineWidth = 5;
    ctx.beginPath(); roundRect(ctx,6,6,244,244,28); ctx.stroke();
    ctx.font = '108px serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(BC_EMOJI[sym]||'?', 128, 140);
    return new THREE.CanvasTexture(c);
  }

  function makeBCMesh() {
    const mats = BC_KEYS.map(k => new THREE.MeshPhongMaterial({ map: makeBCFaceTex(k), shininess: 60 }));
    return new THREE.Mesh(new THREE.BoxGeometry(1,1,1), mats);
  }

  window.BauCua3D = {
    _state: 'idle', _rotSpeeds: [], _targets: [], _startRots: [],
    _settleProgress: 0, _onDone: null,

    init(containerId) {
      try {
      const container = document.getElementById(containerId);
      if (!container) return;
      container.innerHTML = '';
      container.style.position='relative'; container.style.background='#111';
      container.style.borderRadius='14px'; container.style.overflow='hidden';

      const W = container.offsetWidth || 400, H = container.offsetHeight || 180;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#0a1a0a');

      const camera = new THREE.PerspectiveCamera(45, W/H, 0.1, 50);
      camera.position.set(0, 2.5, 7); camera.lookAt(0,0,0);

      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(W,H); renderer.setPixelRatio(window.devicePixelRatio);
      renderer.shadowMap.enabled = true;
      container.appendChild(renderer.domElement);

      const ambient = new THREE.AmbientLight(0xffffff, 0.4); scene.add(ambient);
      const dir = new THREE.DirectionalLight(0xffffff, 0.9);
      dir.position.set(5,10,5); dir.castShadow=true; scene.add(dir);
      const fill = new THREE.DirectionalLight(0x80ff80, 0.25);
      fill.position.set(-5,-3,5); scene.add(fill);

      const planeGeo = new THREE.PlaneGeometry(20,20);
      const plane = new THREE.Mesh(planeGeo, new THREE.MeshPhongMaterial({color:0x061206}));
      plane.rotation.x = -Math.PI/2; plane.position.y=-1; plane.receiveShadow=true;
      scene.add(plane);

      const dice = [];
      for (let i=0;i<3;i++) {
        const d = makeBCMesh();
        d.position.set((i-1)*2.4, 0, 0);
        d.castShadow=true; scene.add(d); dice.push(d);
      }

      this._scene=scene; this._camera=camera; this._renderer=renderer; this._dice=dice;
      this._state='idle';
      this._rotSpeeds = dice.map(()=>({x:0,y:0,z:0}));

      const loop=()=>{ requestAnimationFrame(loop); this._tick(); renderer.render(scene,camera); };
      loop();
      } catch(e) { console.warn('BauCua3D init failed:', e.message); }
    },

    _tick() {
      if (!this._dice) return;
      if (this._state==='rolling') {
        this._dice.forEach((d,i)=>{
          d.rotation.x+=this._rotSpeeds[i].x;
          d.rotation.y+=this._rotSpeeds[i].y;
          d.rotation.z+=this._rotSpeeds[i].z;
        });
      } else if (this._state==='settling') {
        this._settleProgress += 0.04;
        const t = Math.min(this._settleProgress,1);
        const ease = 1-Math.pow(1-t,3);
        this._dice.forEach((d,i)=>{
          d.rotation.x = lerpAngle(this._startRots[i][0], this._targets[i][0], ease);
          d.rotation.y = lerpAngle(this._startRots[i][1], this._targets[i][1], ease);
          d.rotation.z = lerp(this._startRots[i][2], 0, ease);
        });
        if (t>=1) {
          this._state='done';
          if (this._onDone) { this._onDone(); this._onDone=null; }
        }
      }
    },

    roll(symbols, onDone) {
      if (!this._dice) return;
      this._state='rolling';
      this._rotSpeeds = this._dice.map(()=>({
        x:(Math.random()-0.5)*0.4+0.1,
        y:(Math.random()-0.5)*0.4+0.1,
        z:(Math.random()-0.5)*0.2
      }));
      setTimeout(()=>{
        // Map symbol to which material face index faces camera
        // Materials assigned: [0]+x=bau, [1]-x=cua, [2]+y=tom, [3]-y=ca, [4]+z=ga, [5]-z=nai
        const SYM_ROT = { bau:[0,-Math.PI/2], cua:[0,Math.PI/2], tom:[-Math.PI/2,0], ca:[Math.PI/2,0], ga:[0,0], nai:[0,Math.PI] };
        this._targets = symbols.map(s=>{
          const r=SYM_ROT[s]||[0,0];
          const turns=Math.floor(Math.random()*3+2)*Math.PI*2;
          return [r[0]+turns, r[1]+turns, 0];
        });
        this._startRots = this._dice.map(d=>[d.rotation.x,d.rotation.y,d.rotation.z]);
        this._settleProgress=0; this._state='settling'; this._onDone=onDone;
      }, 2200);
    },

    reset() {
      if (!this._dice) return;
      this._state='idle';
      this._dice.forEach(d=>d.rotation.set(0.4,0.6,0.2));
    }
  };

  /* ═══════════════════════════════════════════════════════════════
     ROULETTE 3D
  ═══════════════════════════════════════════════════════════════ */
  function makeRouletteWheelTex() {
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#1a1200'; ctx.fillRect(0,0,1024,1024);

    const cx=512, cy=512, R=480, innerR=120;
    const total=37;
    const ORDER=[0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];

    for (let i=0;i<total;i++) {
      const start = (i/total)*Math.PI*2 - Math.PI/2;
      const end   = ((i+1)/total)*Math.PI*2 - Math.PI/2;
      const num   = ORDER[i];
      const col   = num===0?'#1a6b1a': ROULETTE_RED.has(num)?'#c0392b':'#1a1a1a';

      ctx.beginPath(); ctx.moveTo(cx,cy);
      ctx.arc(cx,cy,R,start,end);
      ctx.closePath(); ctx.fillStyle=col; ctx.fill();
      ctx.strokeStyle='#888'; ctx.lineWidth=1; ctx.stroke();

      // Number label
      const mid=(start+end)/2;
      const tx=cx+Math.cos(mid)*(innerR+(R-innerR)*0.72);
      const ty=cy+Math.sin(mid)*(innerR+(R-innerR)*0.72);
      ctx.save();
      ctx.translate(tx,ty); ctx.rotate(mid+Math.PI/2);
      ctx.fillStyle='#ffffff'; ctx.font='bold 22px Arial';
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(String(num),0,0);
      ctx.restore();
    }
    // Inner circle (gold)
    ctx.beginPath(); ctx.arc(cx,cy,innerR,0,Math.PI*2);
    ctx.fillStyle='#8a6900'; ctx.fill();
    ctx.beginPath(); ctx.arc(cx,cy,innerR*0.65,0,Math.PI*2);
    ctx.fillStyle='#f5c518'; ctx.fill();

    return new THREE.CanvasTexture(c);
  }

  window.Roulette3D = {
    _state: 'idle', _ballAngle: 0, _ballRadius: 3.4,
    _ballHeight: 0.25, _spinSpeed: 0, _wheelAngle: 0,
    _targetWheelAngle: 0, _targetBallAngle: 0, _onDone: null,
    _settleProgress: 0,

    init(containerId) {
      const container = document.getElementById(containerId);
      if (!container) return;
      container.innerHTML = '';
      container.style.position='relative'; container.style.background='#0a0800';
      container.style.borderRadius='14px'; container.style.overflow='hidden';

      const W = container.offsetWidth||500, H = container.offsetHeight||300;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#0a0800');

      const camera = new THREE.PerspectiveCamera(50, W/H, 0.1, 50);
      camera.position.set(0, 7, 5.5); camera.lookAt(0,0,0);

      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(W,H); renderer.setPixelRatio(window.devicePixelRatio);
      renderer.shadowMap.enabled=true;
      container.appendChild(renderer.domElement);

      const ambient = new THREE.AmbientLight(0xffffff,0.4); scene.add(ambient);
      const dir = new THREE.DirectionalLight(0xfff0c0,1.0);
      dir.position.set(5,12,5); dir.castShadow=true; scene.add(dir);
      const under = new THREE.PointLight(0xf5c518,0.6,15);
      under.position.set(0,-2,0); scene.add(under);

      // Wheel
      const wheelGeo = new THREE.CylinderGeometry(4,4,0.3,64,1,false);
      const wheelTex = makeRouletteWheelTex();
      const wheelMat = new THREE.MeshPhongMaterial({ map: wheelTex, shininess: 100 });
      const wheel = new THREE.Mesh(wheelGeo, [
        new THREE.MeshPhongMaterial({color:0x2a1800}),
        wheelMat,
        new THREE.MeshPhongMaterial({color:0x1a0e00})
      ]);
      wheel.position.y = 0; wheel.receiveShadow=true; scene.add(wheel);

      // Rim
      const rimGeo = new THREE.TorusGeometry(4.05,0.2,16,64);
      const rimMat = new THREE.MeshPhongMaterial({color:0xf5c518,shininess:200});
      const rim = new THREE.Mesh(rimGeo,rimMat);
      rim.rotation.x = Math.PI/2; scene.add(rim);

      // Ball track groove
      const trackGeo = new THREE.TorusGeometry(3.4,0.08,8,128);
      const trackMat = new THREE.MeshPhongMaterial({color:0x444,shininess:50});
      const track = new THREE.Mesh(trackGeo,trackMat);
      track.rotation.x=Math.PI/2; track.position.y=0.25; scene.add(track);

      // Ball
      const ballGeo = new THREE.SphereGeometry(0.13,16,16);
      const ballMat = new THREE.MeshPhongMaterial({color:0xeeeeee,shininess:300});
      const ball = new THREE.Mesh(ballGeo,ballMat);
      ball.castShadow=true; scene.add(ball);

      this._scene=scene; this._camera=camera; this._renderer=renderer;
      this._wheel=wheel; this._ball=ball;
      this._ballAngle=0; this._wheelAngle=0; this._spinSpeed=0.12;
      this._state='idle';
      this._ORDER=[0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];

      const loop=()=>{
        requestAnimationFrame(loop);
        this._tick();
        renderer.render(scene,camera);
      };
      loop();
    },

    _tick() {
      if (!this._wheel) return;
      // Wheel always slowly rotates
      this._wheelAngle += 0.004;
      this._wheel.rotation.y = this._wheelAngle;

      if (this._state==='idle') {
        this._ballAngle -= 0.02;
        const bx=Math.cos(this._ballAngle)*this._ballRadius;
        const bz=Math.sin(this._ballAngle)*this._ballRadius;
        this._ball.position.set(bx, this._ballHeight, bz);
      } else if (this._state==='spinning') {
        this._ballAngle -= this._spinSpeed;
        this._spinSpeed *= 0.9985;
        const bx=Math.cos(this._ballAngle)*this._ballRadius;
        const bz=Math.sin(this._ballAngle)*this._ballRadius;
        this._ball.position.set(bx, this._ballHeight, bz);
        if (this._spinSpeed < 0.018) {
          this._state='settling';
          this._settleProgress=0;
          this._startBallAngle = this._ballAngle;
        }
      } else if (this._state==='settling') {
        this._settleProgress += 0.012;
        const t=Math.min(this._settleProgress,1);
        const ease=1-Math.pow(1-t,4);
        const ang = lerpAngle(this._startBallAngle, this._targetBallAngle, ease);
        const r = lerp(this._ballRadius, 3.3, ease);
        const h = lerp(this._ballHeight, 0.08, ease);
        this._ball.position.set(Math.cos(ang)*r, h, Math.sin(ang)*r);
        if (t>=1) {
          this._state='done';
          if (this._onDone) { this._onDone(); this._onDone=null; }
        }
      }
    },

    spin(number, onDone) {
      if (!this._wheel) return;
      this._spinSpeed = 0.25;
      this._state = 'spinning';
      this._onDone = onDone;
      // Calculate target ball angle based on where this number sits on the wheel
      const idx = this._ORDER.indexOf(number);
      const slotAngle = -(idx/37)*Math.PI*2;
      // Add several full rotations so it spins nicely before settling
      this._targetBallAngle = slotAngle - Math.floor(Math.random()*4+6)*Math.PI*2;
      this._startBallAngle = this._ballAngle;
    }
  };

  /* ═══════════════════════════════════════════════════════════════
     SLOTS 3D
  ═══════════════════════════════════════════════════════════════ */
  function makeReelTex(symbols) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256 * symbols.length;
    const ctx = c.getContext('2d');
    symbols.forEach((sym,i) => {
      const y = i*256;
      ctx.fillStyle = '#1a0a2a';
      ctx.fillRect(0,y,256,256);
      ctx.strokeStyle='#5a1a8a'; ctx.lineWidth=3;
      ctx.strokeRect(3,y+3,250,250);
      ctx.font='110px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(sym,128,y+140);
    });
    return new THREE.CanvasTexture(c);
  }

  window.Slots3D = {
    _state:'idle', _spinning:[false,false,false],
    _spinSpeeds:[0,0,0], _offsets:[0,0,0],
    _targets:[0,0,0], _reels:[], _onDone:null,
    _doneCount:0, _resultSymbols:[],

    init(containerId) {
      const container = document.getElementById(containerId);
      if (!container) return;
      container.innerHTML='';
      container.style.position='relative'; container.style.background='#0d0015';
      container.style.borderRadius='14px'; container.style.overflow='hidden';

      const W = container.offsetWidth||500, H = container.offsetHeight||260;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#0d0015');

      const camera = new THREE.PerspectiveCamera(50, W/H, 0.1, 50);
      camera.position.set(0,0,8); camera.lookAt(0,0,0);

      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(W,H); renderer.setPixelRatio(window.devicePixelRatio);
      renderer.shadowMap.enabled=true;
      container.appendChild(renderer.domElement);

      const ambient = new THREE.AmbientLight(0xffffff,0.5); scene.add(ambient);
      const dir = new THREE.DirectionalLight(0xffffff,0.8);
      dir.position.set(3,8,5); scene.add(dir);
      const pt = new THREE.PointLight(0xaa44ff,1.2,20);
      pt.position.set(0,3,5); scene.add(pt);

      // Machine frame
      const frameGeo = new THREE.BoxGeometry(9.5,5.5,0.3);
      const frameMat = new THREE.MeshPhongMaterial({color:0x2a0050,shininess:60});
      const frame = new THREE.Mesh(frameGeo,frameMat);
      frame.position.z=-0.3; scene.add(frame);

      // Frame border glow strip
      const borderGeo = new THREE.BoxGeometry(9.6,5.6,0.1);
      const borderMat = new THREE.MeshPhongMaterial({color:0xf5c518,emissive:0xf5c518,emissiveIntensity:0.3});
      const border = new THREE.Mesh(borderGeo,borderMat);
      border.position.z=-0.35; scene.add(border);

      // Separator lines
      for (let i=-1;i<=1;i+=2) {
        const sepGeo = new THREE.BoxGeometry(0.08,4.2,0.5);
        const sepMat = new THREE.MeshPhongMaterial({color:0x8800cc,emissive:0x4400aa,emissiveIntensity:0.5});
        const sep = new THREE.Mesh(sepGeo,sepMat);
        sep.position.set(i*2.6,0,0); scene.add(sep);
      }

      // Payline indicator
      const lineGeo = new THREE.BoxGeometry(7.8,0.06,0.6);
      const lineMat = new THREE.MeshPhongMaterial({color:0xff4444,emissive:0xff2222,emissiveIntensity:0.8});
      const payline = new THREE.Mesh(lineGeo,lineMat);
      payline.position.set(0,0,0.1); scene.add(payline);

      // Build reels as cylinder geometry
      const reelSymCount = 16;
      const reelSymbols = Array.from({length:reelSymCount},(_,i)=>SLOT_SYM[i%SLOT_SYM.length]);
      const reels = [];
      for (let i=0;i<3;i++) {
        const radius = 1.2;
        const height = 1.6;
        const geo = new THREE.CylinderGeometry(radius,radius,height,32,1,true);
        const tex = makeReelTex(reelSymbols);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(1,1);
        const mat = new THREE.MeshPhongMaterial({ map: tex, side: THREE.FrontSide, shininess:30 });
        const reel = new THREE.Mesh(geo,mat);
        reel.position.set((i-1)*2.6, 0, 0);
        reel.rotation.x = Math.PI/2; // lay cylinder on side so it scrolls correctly
        scene.add(reel);
        reels.push({ mesh:reel, offset:0, symbols:reelSymbols, tex });
      }

      this._scene=scene; this._camera=camera; this._renderer=renderer;
      this._reels=reels; this._spinning=[false,false,false];
      this._spinSpeeds=[0,0,0]; this._offsets=[0,0,0]; this._state='idle';

      // Window mask (black bars top/bottom)
      for (const yPos of [2.3,-2.3]) {
        const maskGeo = new THREE.BoxGeometry(9.5,1.5,0.6);
        const maskMat = new THREE.MeshPhongMaterial({color:0x1a0035});
        const mask = new THREE.Mesh(maskGeo,maskMat);
        mask.position.set(0,yPos,0); scene.add(mask);
      }

      const loop=()=>{
        requestAnimationFrame(loop);
        this._tick();
        renderer.render(scene,camera);
      };
      loop();
    },

    _tick() {
      if (!this._reels.length) return;
      this._reels.forEach((reel,i)=>{
        if (this._spinning[i]) {
          this._offsets[i] += this._spinSpeeds[i];
          reel.mesh.rotation.z = this._offsets[i];
          if (this._spinSpeeds[i] > 0.01) {
            this._spinSpeeds[i] *= 0.998;
          }
        }
      });
    },

    spin(symbols, onDone) {
      if (!this._reels.length) return;
      this._state='spinning';
      this._doneCount=0;
      this._onDone=onDone;
      this._resultSymbols=symbols;

      this._reels.forEach((reel,i)=>{
        this._spinning[i]=true;
        this._spinSpeeds[i]=0.35 + Math.random()*0.1;
        // Stop reels one by one
        const delay = 1800 + i*700;
        setTimeout(()=>{
          this._spinning[i]=false;
          reel.mesh.rotation.z = this._offsets[i]; // snap
          this._doneCount++;
          if (this._doneCount===3) {
            this._state='done';
            if (this._onDone) { this._onDone(); this._onDone=null; }
          }
        }, delay);
      });
    },

    reset() {
      this._state='idle';
      this._spinning=[false,false,false];
    }
  };

  /* ─── Shared helper: roundRect polyfill ─────────────────────── */
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x+r,y);
    ctx.lineTo(x+w-r,y);
    ctx.quadraticCurveTo(x+w,y,x+w,y+r);
    ctx.lineTo(x+w,y+h-r);
    ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
    ctx.lineTo(x+r,y+h);
    ctx.quadraticCurveTo(x,y+h,x,y+h-r);
    ctx.lineTo(x,y+r);
    ctx.quadraticCurveTo(x,y,x+r,y);
    ctx.closePath();
  }

})();
