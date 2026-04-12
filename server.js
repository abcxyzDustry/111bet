const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));
app.get('/',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/payment', (req, res) => res.sendFile(path.join(__dirname, 'public', 'payment.html')));

const MONGO_URI       = process.env.MONGO_URI       || 'mongodb://localhost:27017/gambling_research';
const JWT_SECRET      = process.env.JWT_SECRET      || 'gambling_secret_2024';
const ADMIN_USERNAME  = process.env.ADMIN_USERNAME  || 'admin';
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD  || 'Admin@2024!';

mongoose.connect(MONGO_URI)
  .then(() => { console.log('✅ MongoDB connected'); ensureAdmin(); })
  .catch(err => console.error('MongoDB error:', err));

async function ensureAdmin() {
  try {
    const exists = await User.findOne({ username: ADMIN_USERNAME, isAdmin: true });
    if (!exists) {
      const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
      await User.create({ username: ADMIN_USERNAME, password: hash, isAdmin: true });
      console.log(`✅ Admin: ${ADMIN_USERNAME}`);
    }
  } catch {}
}

// ==================== SCHEMAS ====================
const userSchema = new mongoose.Schema({
  username:      { type: String, unique: true, required: true },
  uuid:          { type: String, unique: true, sparse: true },
  password:      String,
  balance:       { type: Number, default: 0 },
  totalDeposit:  { type: Number, default: 0 },
  totalWin:      { type: Number, default: 0 },
  totalLoss:     { type: Number, default: 0 },
  totalBets:     { type: Number, default: 0 },
  createdAt:     { type: Date, default: Date.now },
  isAdmin:       { type: Boolean, default: false },
  status:        { type: String, default: 'active' },
  isGameAccount: { type: Boolean, default: false }
});

const transactionSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  username:  String,
  uuid:      String,
  type:      String, // deposit | withdraw
  amount:    Number,
  note:      String,
  adminId:   String,
  createdAt: { type: Date, default: Date.now }
});

const depositRequestSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  username:     String,
  amount:       Number,
  transferCode: String,
  status:       { type: String, default: 'pending' },
  note:         String,
  adminNote:    String,
  reviewedBy:   String,
  reviewedAt:   Date,
  createdAt:    { type: Date, default: Date.now }
});

const withdrawRequestSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  username:    String,
  amount:      Number,
  bankName:    String,
  bankAccount: String,
  status:      { type: String, default: 'pending' },
  adminNote:   String,
  reviewedBy:  String,
  reviewedAt:  Date,
  createdAt:   { type: Date, default: Date.now }
});

const sessionSchema = new mongoose.Schema({
  sessionId:      { type: String, default: uuidv4 },
  gameType:       String,
  result:         mongoose.Schema.Types.Mixed,
  bets:           [mongoose.Schema.Types.Mixed],
  totalBetAmount: { type: Number, default: 0 },
  totalPayout:    { type: Number, default: 0 },
  houseProfit:    { type: Number, default: 0 },
  createdAt:      { type: Date, default: Date.now }
});

const betSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  username:  String,
  uuid:      String,
  gameType:  String,
  sessionId: String,
  betChoice: mongoose.Schema.Types.Mixed,
  betAmount: Number,
  result:    mongoose.Schema.Types.Mixed,
  payout:    Number,
  isWin:     Boolean,
  createdAt: { type: Date, default: Date.now }
});

const bannerSchema = new mongoose.Schema({
  key:       { type: String, unique: true },
  label:     String,
  value:     String,
  updatedAt: { type: Date, default: Date.now }
});

const User            = mongoose.model('User',            userSchema);
const Transaction     = mongoose.model('Transaction',     transactionSchema);
const DepositRequest  = mongoose.model('DepositRequest',  depositRequestSchema);
const WithdrawRequest = mongoose.model('WithdrawRequest', withdrawRequestSchema);
const GameSession     = mongoose.model('GameSession',     sessionSchema);
const Bet             = mongoose.model('Bet',             betSchema);
const Banner          = mongoose.model('Banner',          bannerSchema);

let houseEdgeRate = 0.70;

// ==================== MIDDLEWARE ====================
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
};

const adminAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    req.user = decoded; next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

// ==================== GAME ENGINE ====================
const games = {
  taixiu: {
    phase: 'BETTING', countdown: 15, result: null, bets: {},
    sessionId: uuidv4(), startTime: Date.now()
  }
};

// Broadcast trang thai game realtime (cho plugin poll)
function broadcastGameState(gameType) {
  const s = games[gameType];
  if (!s) return;
  io.emit(`${gameType}:state`, {
    phase:     s.phase,
    countdown: s.countdown,
    result:    s.result,
    sessionId: s.sessionId,
    serverTime: Date.now()
  });
}

function rollTx() {
  const dice = Array.from({ length: 3 }, () => Math.floor(Math.random() * 6) + 1);
  const sum  = dice.reduce((a, b) => a + b, 0);
  const isTriple = dice[0] === dice[1] && dice[1] === dice[2];
  return { dice, sum, side: isTriple ? 'triple' : sum >= 11 ? 'tai' : 'xiu', isTriple };
}

function rollTxBiased(bets) {
  if (Math.random() < houseEdgeRate) {
    const tT = Object.values(bets).reduce((s, b) => s + (b.tai || 0), 0);
    const xT = Object.values(bets).reduce((s, b) => s + (b.xiu || 0), 0);
    for (let i = 0; i < 20; i++) {
      const r = rollTx();
      if (r.isTriple) return r;
      if (tT > xT && r.side === 'xiu') return r;
      if (xT > tT && r.side === 'tai') return r;
      if (tT === xT) return r;
    }
  }
  return rollTx();
}

function startLoop() {
  const s = games.taixiu;
  setInterval(async () => {
    if (s.phase === 'BETTING') {
      s.countdown--;
      io.emit('taixiu:tick', { countdown: s.countdown, serverTime: Date.now() });
      if (s.countdown <= 0) {
        s.phase = 'ROLLING'; s.countdown = 3;
        io.emit('taixiu:rolling', { serverTime: Date.now() });
      }
    } else if (s.phase === 'ROLLING') {
      s.countdown--;
      if (s.countdown <= 0) {
        s.result = rollTxBiased(s.bets);
        s.phase  = 'RESULT'; s.countdown = 6;

        let tb = 0, tp = 0;
        const sb = [];

        for (const [uid, ubets] of Object.entries(s.bets)) {
          for (const [choice, amt] of Object.entries(ubets)) {
            if (!amt) continue;
            let pay = 0;
            if (!s.result.isTriple && choice === s.result.side) pay = amt + amt * 1.5;
            const isWin = pay > 0;
            const user  = await User.findById(uid);
            if (user) {
              user.balance   = user.balance - amt + pay;
              user.totalBets += 1;
              if (isWin) user.totalWin  += (pay - amt);
              else        user.totalLoss += amt;
              await user.save();

              const betDoc = await Bet.create({
                userId: uid, username: user.username, uuid: user.uuid,
                gameType: 'taixiu', sessionId: s.sessionId,
                betChoice: choice, betAmount: amt,
                result: s.result, payout: pay, isWin
              });
              sb.push(betDoc);
              tb += amt; tp += pay;

              // Push realtime balance update
              io.to(uid).emit('balance_update',    { balance: user.balance });
              io.to(uid).emit('taixiu:bet_result', {
                choice, amount: amt, payout: pay, isWin,
                result: s.result, balance: user.balance
              });
            }
          }
        }

        await GameSession.create({
          sessionId: s.sessionId, gameType: 'taixiu',
          result: s.result, bets: sb,
          totalBetAmount: tb, totalPayout: tp, houseProfit: tb - tp
        });

        io.emit('taixiu:result',    { result: s.result, sessionId: s.sessionId, serverTime: Date.now() });
        io.emit('leaderboard:update', {}); // notify clients to refresh leaderboard
        s.bets = {};
      }
    } else {
      s.countdown--;
      if (s.countdown <= 0) {
        s.phase = 'BETTING'; s.countdown = 15;
        s.result = null; s.sessionId = uuidv4();
        io.emit('taixiu:new_round', { sessionId: s.sessionId, serverTime: Date.now() });
      }
    }
  }, 1000);
}

startLoop();

// ==================== SOCKET.IO ====================
io.on('connection', socket => {
  socket.on('auth', token => {
    try {
      const d = jwt.verify(token, JWT_SECRET);
      socket.userId = d.id;
      socket.join(d.id);
      const s = games.taixiu;
      socket.emit('taixiu:state', {
        phase: s.phase, countdown: s.countdown,
        result: s.result, sessionId: s.sessionId, serverTime: Date.now()
      });
    } catch {}
  });

  socket.on('join_guest', () => {
    const s = games.taixiu;
    socket.emit('taixiu:state', {
      phase: s.phase, countdown: s.countdown,
      result: s.result, sessionId: s.sessionId, serverTime: Date.now()
    });
  });

  socket.on('place_bet', async ({ gameType, bets, token }) => {
    try {
      const d = jwt.verify(token, JWT_SECRET);
      const s = games[gameType];
      if (!s || s.phase !== 'BETTING') return socket.emit('bet_error', { error: 'Phien cuoc da dong' });
      const user = await User.findById(d.id);
      if (!user)                   return socket.emit('bet_error', { error: 'User not found' });
      if (user.status === 'banned') return socket.emit('bet_error', { error: 'Tai khoan bi khoa' });
      const total = Object.values(bets).reduce((s, v) => s + v, 0);
      if (total <= 0)       return socket.emit('bet_error', { error: 'So tien khong hop le' });
      if (user.balance < total) return socket.emit('bet_error', { error: 'So du khong du!' });
      user.balance -= total;
      await user.save();
      if (!s.bets[d.id]) s.bets[d.id] = {};
      for (const [c, a] of Object.entries(bets)) {
        s.bets[d.id][c] = (s.bets[d.id][c] || 0) + a;
      }
      socket.emit('bet_accepted', { balance: user.balance });
      io.to(d.id).emit('balance_update', { balance: user.balance });
    } catch(e) { socket.emit('bet_error', { error: e.message }); }
  });
});

// ==================== GAME API ENDPOINTS (cho Plugin) ====================

// Dang ky tai khoan tu game
app.post('/api/game/register', async (req, res) => {
  try {
    const { uuid, username } = req.body;
    if (!uuid || !username) return res.status(400).json({ error: 'Missing uuid/username' });
    let user = await User.findOne({ uuid });
    if (!user) {
      let finalUsername = username;
      const exists = await User.findOne({ username });
      if (exists) finalUsername = username + '_' + uuid.substring(0, 6);
      user = await User.create({
        username: finalUsername, uuid,
        balance: 0, isGameAccount: true,
        password: await bcrypt.hash(uuid, 10)
      });
    }
    res.json({ success: true, balance: user.balance, username: user.username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Login bang UUID (tu game mo web)
app.post('/api/game/login', async (req, res) => {
  try {
    const { uuid } = req.body;
    if (!uuid) return res.status(400).json({ error: 'Missing uuid' });
    const user = await User.findOne({ uuid });
    if (!user)                   return res.status(404).json({ error: 'Chua co tai khoan. Join game truoc!' });
    if (user.status === 'banned') return res.status(403).json({ error: 'Tai khoan bi khoa' });
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, balance: user.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lay trang thai game hien tai (plugin poll de dong bo)
app.get('/api/game/state', (req, res) => {
  const s = games.taixiu;
  res.json({
    phase:      s.phase,
    countdown:  s.countdown,
    result:     s.result,
    sessionId:  s.sessionId,
    serverTime: Date.now()
  });
});

// Dat cuoc tu plugin (khong qua socket)
app.post('/api/game/bet', async (req, res) => {
  try {
    const { uuid, choice, amount } = req.body;
    if (!uuid || !choice || !amount) return res.status(400).json({ error: 'Missing params' });
    const s = games.taixiu;
    if (s.phase !== 'BETTING') return res.status(400).json({ error: 'Phien cuoc da dong', phase: s.phase, countdown: s.countdown });
    const user = await User.findOne({ uuid });
    if (!user)                   return res.status(404).json({ error: 'Khong tim thay tai khoan' });
    if (user.status === 'banned') return res.status(403).json({ error: 'Tai khoan bi khoa' });
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0)  return res.status(400).json({ error: 'So tien khong hop le' });
    if (user.balance < amt)      return res.status(400).json({ error: 'So du khong du', balance: user.balance });

    user.balance -= amt;
    await user.save();

    const uid = user._id.toString();
    if (!s.bets[uid]) s.bets[uid] = {};
    s.bets[uid][choice] = (s.bets[uid][choice] || 0) + amt;

    // Notify web clients
    io.to(uid).emit('balance_update', { balance: user.balance });
    io.to(uid).emit('bet_accepted',   { balance: user.balance });

    res.json({ success: true, balance: user.balance, bets: s.bets[uid] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dong bo so du len web (plugin push)
app.post('/api/game/update-balance', async (req, res) => {
  try {
    const { uuid, username, balance } = req.body;
    if (!uuid) return res.status(400).json({ error: 'Missing uuid' });
    let user = await User.findOne({ uuid });
    if (!user) {
      let finalUsername = username || uuid.substring(0, 8);
      const exists = await User.findOne({ username: finalUsername });
      if (exists) finalUsername += '_' + uuid.substring(0, 6);
      user = await User.create({
        username: finalUsername, uuid,
        balance: balance || 0,
        isGameAccount: true,
        password: await bcrypt.hash(uuid, 10)
      });
    } else {
      // Chi cap nhat neu khac biet de tranh ghi de sai
      if (typeof balance === 'number' && balance !== user.balance) {
        user.balance = balance;
        await user.save();
        io.to(user._id.toString()).emit('balance_update', { balance: user.balance });
      }
    }
    res.json({ success: true, balance: user.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lay so du tu web (plugin pull)
app.get('/api/game/sync', async (req, res) => {
  try {
    const { uuid } = req.query;
    if (!uuid) return res.status(400).json({ error: 'Missing uuid' });
    const user = await User.findOne({ uuid });
    if (!user) return res.json({ balance: 0, exists: false });
    res.json({ balance: user.balance, username: user.username, exists: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== LEADERBOARD API ====================
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const users = await User.find({ isAdmin: false, status: 'active' })
      .select('username balance totalWin totalLoss totalBets uuid isGameAccount')
      .sort({ balance: -1 })
      .limit(limit);
    res.json(users.map((u, i) => ({
      rank:          i + 1,
      username:      u.username,
      balance:       u.balance,
      totalWin:      u.totalWin,
      totalLoss:     u.totalLoss,
      totalBets:     u.totalBets,
      isGameAccount: u.isGameAccount,
      uuid:          u.uuid
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lay leaderboard cho plugin (theo uuid, tra ve rank)
app.get('/api/leaderboard/game', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const users = await User.find({ isAdmin: false, isGameAccount: true, status: 'active' })
      .select('username balance totalWin totalBets uuid')
      .sort({ balance: -1 })
      .limit(limit);
    res.json(users.map((u, i) => ({
      rank:      i + 1,
      username:  u.username,
      balance:   u.balance,
      totalWin:  u.totalWin,
      totalBets: u.totalBets,
      uuid:      u.uuid
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lay rank cua 1 player
app.get('/api/leaderboard/rank', async (req, res) => {
  try {
    const { uuid } = req.query;
    if (!uuid) return res.status(400).json({ error: 'Missing uuid' });
    const user = await User.findOne({ uuid });
    if (!user) return res.json({ rank: -1 });
    const rank = await User.countDocuments({
      isAdmin: false, status: 'active',
      balance: { $gt: user.balance }
    }) + 1;
    res.json({ rank, balance: user.balance, username: user.username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== BET HISTORY API ====================
// Lich su cuoc theo uuid (cho plugin)
app.get('/api/game/bet-history', async (req, res) => {
  try {
    const { uuid } = req.query;
    const limit = parseInt(req.query.limit) || 30;
    if (!uuid) return res.status(400).json({ error: 'Missing uuid' });
    const user = await User.findOne({ uuid });
    if (!user) return res.json([]);
    const bets = await Bet.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('gameType betChoice betAmount payout isWin createdAt sessionId');
    res.json(bets);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lich su cuoc (web - auth)
app.get('/api/history/:gt', auth, async (req, res) => {
  const bets = await Bet.find({ userId: req.user.id, gameType: req.params.gt })
    .sort({ createdAt: -1 }).limit(30);
  res.json(bets);
});

// ==================== TRANSACTION HISTORY API ====================
// Lich su nap rut theo uuid (cho plugin)
app.get('/api/game/transactions', async (req, res) => {
  try {
    const { uuid } = req.query;
    const limit = parseInt(req.query.limit) || 20;
    if (!uuid) return res.status(400).json({ error: 'Missing uuid' });
    const user = await User.findOne({ uuid });
    if (!user) return res.json([]);
    const txs = await Transaction.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('type amount note createdAt');
    res.json(txs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== AUTH ROUTES ====================
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing info' });
    if (username.length < 3)    return res.status(400).json({ error: 'Username >= 3 ky tu' });
    if (password.length < 6)    return res.status(400).json({ error: 'Password >= 6 ky tu' });
    if (await User.findOne({ username })) return res.status(400).json({ error: 'Username da ton tai' });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hash });
    const token = jwt.sign({ id: user._id, username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username, balance: user.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user)                    return res.status(400).json({ error: 'Sai tai khoan/mat khau' });
    if (user.status === 'banned') return res.status(403).json({ error: 'Tai khoan bi khoa' });
    if (!await bcrypt.compare(password, user.password)) return res.status(400).json({ error: 'Sai mat khau' });
    const token = jwt.sign({ id: user._id, username, isAdmin: user.isAdmin }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username, balance: user.balance, isAdmin: user.isAdmin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username, isAdmin: true });
    if (!user) return res.status(400).json({ error: 'Khong tim thay admin' });
    if (!await bcrypt.compare(password, user.password)) return res.status(400).json({ error: 'Sai mat khau' });
    const token = jwt.sign({ id: user._id, username, isAdmin: true }, JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', auth, async (req, res) => {
  const user = await User.findById(req.user.id).select('-password');
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

// ==================== BANNER ====================
app.get('/api/banners', async (req, res) => {
  try {
    const [depAgg, wdAgg, custom] = await Promise.all([
      Transaction.aggregate([{ $match: { type: 'deposit' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Transaction.aggregate([{ $match: { type: 'withdraw' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Banner.find({})
    ]);
    res.json({ totalDeposit: depAgg[0]?.total || 0, totalWithdraw: wdAgg[0]?.total || 0, custom });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/banner', adminAuth, async (req, res) => {
  try {
    const { key, label, value } = req.body;
    await Banner.findOneAndUpdate({ key }, { label, value, updatedAt: new Date() }, { upsert: true, new: true });
    io.emit('banner_update', {});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/banner/:key', adminAuth, async (req, res) => {
  await Banner.deleteOne({ key: req.params.key });
  io.emit('banner_update', {});
  res.json({ success: true });
});

// ==================== DEPOSIT REQUESTS ====================
app.post('/api/deposit-request', auth, async (req, res) => {
  try {
    const { amount, transferCode, note } = req.body;
    const validAmounts = [10000, 20000, 50000, 100000, 200000, 500000];
    if (!validAmounts.includes(Number(amount))) return res.status(400).json({ error: 'Menh gia khong hop le' });
    const pending = await DepositRequest.countDocuments({ userId: req.user.id, status: 'pending' });
    if (pending >= 3) return res.status(400).json({ error: 'Co yeu cau cho duyet, vui long cho' });
    const dr = await DepositRequest.create({
      userId: req.user.id, username: req.user.username,
      amount: Number(amount), transferCode: transferCode || '', note: note || ''
    });
    io.emit('admin:new_deposit_request', { id: dr._id, username: req.user.username, amount: Number(amount) });
    res.json({ success: true, requestId: dr._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/my-deposit-requests', auth, async (req, res) => {
  const reqs = await DepositRequest.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(10);
  res.json(reqs);
});

app.get('/api/admin/deposit-requests', adminAuth, async (req, res) => {
  res.json(await DepositRequest.find({}).sort({ createdAt: -1 }).limit(200));
});

app.post('/api/admin/deposit-request/approve', adminAuth, async (req, res) => {
  try {
    const { requestId, adminNote } = req.body;
    const dr = await DepositRequest.findById(requestId);
    if (!dr)                    return res.status(404).json({ error: 'Not found' });
    if (dr.status !== 'pending') return res.status(400).json({ error: 'Da xu ly' });
    dr.status = 'approved'; dr.adminNote = adminNote || 'Da duyet';
    dr.reviewedBy = req.user.username; dr.reviewedAt = new Date();
    await dr.save();
    const user = await User.findByIdAndUpdate(dr.userId,
      { $inc: { balance: dr.amount, totalDeposit: dr.amount } }, { new: true });
    await Transaction.create({
      userId: dr.userId, username: dr.username, uuid: user?.uuid,
      type: 'deposit', amount: dr.amount, note: adminNote || 'Duyet nap tien', adminId: req.user.id
    });
    io.to(dr.userId.toString()).emit('balance_update',   { balance: user.balance });
    io.to(dr.userId.toString()).emit('deposit_approved', { amount: dr.amount, balance: user.balance });
    io.emit('banner_update', {});
    res.json({ success: true, balance: user.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/deposit-request/reject', adminAuth, async (req, res) => {
  try {
    const { requestId, adminNote } = req.body;
    const dr = await DepositRequest.findById(requestId);
    if (!dr || dr.status !== 'pending') return res.status(400).json({ error: 'Khong hop le' });
    dr.status = 'rejected'; dr.adminNote = adminNote || 'Tu choi';
    dr.reviewedBy = req.user.username; dr.reviewedAt = new Date();
    await dr.save();
    io.to(dr.userId.toString()).emit('deposit_rejected', { adminNote: dr.adminNote });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== WITHDRAW REQUESTS ====================
app.post('/api/withdraw-request', auth, async (req, res) => {
  try {
    const { amount, bankName, bankAccount } = req.body;
    const amt = Number(amount);
    if (!amt || amt < 50000)       return res.status(400).json({ error: 'Toi thieu 50,000d' });
    if (!bankName || !bankAccount)  return res.status(400).json({ error: 'Thieu thong tin ngan hang' });
    const user = await User.findById(req.user.id);
    if (!user)                      return res.status(404).json({ error: 'Khong tim thay' });
    if (user.status === 'banned')   return res.status(403).json({ error: 'Bi khoa' });
    if (user.balance < amt)         return res.status(400).json({ error: 'So du khong du' });
    const pending = await WithdrawRequest.countDocuments({ userId: req.user.id, status: 'pending' });
    if (pending >= 2) return res.status(400).json({ error: 'Co yeu cau cho xu ly' });
    const wr = await WithdrawRequest.create({
      userId: req.user.id, username: req.user.username,
      amount: amt, bankName: bankName.trim(), bankAccount: bankAccount.trim()
    });
    io.emit('admin:new_withdraw_request', { id: wr._id, username: req.user.username, amount: amt, bankName });
    res.json({ success: true, requestId: wr._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/my-withdraw-requests', auth, async (req, res) => {
  res.json(await WithdrawRequest.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(10));
});

app.get('/api/admin/withdraw-requests', adminAuth, async (req, res) => {
  res.json(await WithdrawRequest.find({}).sort({ createdAt: -1 }).limit(200));
});

app.post('/api/admin/withdraw-request/approve', adminAuth, async (req, res) => {
  try {
    const { requestId, adminNote } = req.body;
    const wr = await WithdrawRequest.findById(requestId);
    if (!wr || wr.status !== 'pending') return res.status(400).json({ error: 'Khong hop le' });
    const user = await User.findById(wr.userId);
    if (!user || user.balance < wr.amount) return res.status(400).json({ error: 'So du khong du' });
    user.balance -= wr.amount; await user.save();
    wr.status = 'approved'; wr.adminNote = adminNote || 'Da duyet';
    wr.reviewedBy = req.user.username; wr.reviewedAt = new Date();
    await wr.save();
    await Transaction.create({
      userId: wr.userId, username: wr.username, uuid: user?.uuid,
      type: 'withdraw', amount: wr.amount,
      note: `Rut qua ${wr.bankName} - ${adminNote || 'Da duyet'}`, adminId: req.user.id
    });
    io.to(wr.userId.toString()).emit('balance_update',    { balance: user.balance });
    io.to(wr.userId.toString()).emit('withdraw_approved', { amount: wr.amount, balance: user.balance, bankName: wr.bankName });
    io.emit('banner_update', {});
    res.json({ success: true, balance: user.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdraw-request/reject', adminAuth, async (req, res) => {
  try {
    const { requestId, adminNote } = req.body;
    const wr = await WithdrawRequest.findById(requestId);
    if (!wr || wr.status !== 'pending') return res.status(400).json({ error: 'Khong hop le' });
    wr.status = 'rejected'; wr.adminNote = adminNote || 'Tu choi';
    wr.reviewedBy = req.user.username; wr.reviewedAt = new Date();
    await wr.save();
    io.to(wr.userId.toString()).emit('withdraw_rejected', { adminNote: wr.adminNote });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== ADMIN ====================
app.get('/api/admin/users', adminAuth, async (req, res) => {
  res.json(await User.find({}).select('-password').sort({ createdAt: -1 }));
});

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  const [userCount, depAgg, wdAgg, sessions, bets, pendingCount] = await Promise.all([
    User.countDocuments({ isAdmin: false }),
    Transaction.aggregate([{ $match: { type: 'deposit' } },  { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Transaction.aggregate([{ $match: { type: 'withdraw' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    GameSession.find({}).sort({ createdAt: -1 }).limit(50),
    Bet.aggregate([{ $group: { _id: null, totalBet: { $sum: '$betAmount' }, totalPayout: { $sum: '$payout' }, count: { $sum: 1 } } }]),
    DepositRequest.countDocuments({ status: 'pending' })
  ]);
  const bs = bets[0] || { totalBet: 0, totalPayout: 0, count: 0 };
  res.json({
    userCount,
    totalDeposited: depAgg[0]?.total || 0,
    totalWithdrawn: wdAgg[0]?.total || 0,
    houseProfit: bs.totalBet - bs.totalPayout,
    betCount: bs.count,
    pendingDepositCount: pendingCount,
    recentSessions: sessions
  });
});

app.post('/api/admin/deposit', adminAuth, async (req, res) => {
  try {
    const { userId, amount, note } = req.body;
    if (!userId || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid' });
    const user = await User.findByIdAndUpdate(userId,
      { $inc: { balance: amount, totalDeposit: amount } }, { new: true });
    if (!user) return res.status(404).json({ error: 'Not found' });
    await Transaction.create({ userId, username: user.username, uuid: user.uuid, type: 'deposit', amount, note, adminId: req.user.id });
    io.to(userId.toString()).emit('balance_update', { balance: user.balance });
    io.emit('banner_update', {});
    res.json({ success: true, balance: user.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdraw', adminAuth, async (req, res) => {
  try {
    const { userId, amount, note } = req.body;
    const user = await User.findById(userId);
    if (!user || user.balance < amount) return res.status(400).json({ error: 'So du khong du' });
    user.balance -= amount; await user.save();
    await Transaction.create({ userId, username: user.username, uuid: user.uuid, type: 'withdraw', amount, note, adminId: req.user.id });
    io.to(userId.toString()).emit('balance_update', { balance: user.balance });
    res.json({ success: true, balance: user.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/ban', adminAuth, async (req, res) => {
  try { await User.findByIdAndUpdate(req.body.userId, { status: req.body.status }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/transactions', adminAuth, async (req, res) => {
  res.json(await Transaction.find({}).sort({ createdAt: -1 }).limit(200));
});

app.get('/api/admin/bets', adminAuth, async (req, res) => {
  res.json(await Bet.find({}).sort({ createdAt: -1 }).limit(200));
});

app.get('/api/admin/sessions', adminAuth, async (req, res) => {
  res.json(await GameSession.find({}).sort({ createdAt: -1 }).limit(100));
});

app.get('/api/admin/house-edge', adminAuth, (req, res) => {
  res.json({ rate: houseEdgeRate, percent: Math.round(houseEdgeRate * 100) });
});

app.post('/api/admin/house-edge', adminAuth, (req, res) => {
  const r = parseFloat(req.body.rate);
  if (isNaN(r) || r < 0.70 || r > 0.90) return res.status(400).json({ error: 'Ty le phai tu 70-90%' });
  houseEdgeRate = r;
  res.json({ success: true, rate: houseEdgeRate, percent: Math.round(houseEdgeRate * 100) });
});

// ==================== PUBLIC APIS ====================
app.get('/api/game-state/:gt', (req, res) => {
  const s = games[req.params.gt];
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ phase: s.phase, countdown: s.countdown, result: s.result, sessionId: s.sessionId, serverTime: Date.now() });
});

app.get('/api/recent-results/:gt', async (req, res) => {
  const sessions = await GameSession.find({ gameType: req.params.gt }).sort({ createdAt: -1 }).limit(20);
  res.json(sessions.map(s => s.result));
});

app.post('/api/slots/spin', auth, async (req, res) => {
  try {
    const { amount } = req.body;
    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
    const user = await User.findById(req.user.id);
    if (!user || user.balance < amt) return res.status(400).json({ error: 'So du khong du' });
    const SYMBOLS = ['7', 'diamond', 'star', 'bell', 'grapes', 'orange', 'lemon', 'cherry'];
    const PAYOUTS = { '7': 50, diamond: 25, star: 15, bell: 10, grapes: 8 };
    const spin = () => SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
    const symbols = [spin(), spin(), spin()];
    let payout = 0, isWin = false;
    if (symbols[0] === symbols[1] && symbols[1] === symbols[2]) {
      payout = amt * (PAYOUTS[symbols[0]] || 5); isWin = true;
    } else if (symbols[0] === 'cherry' && symbols[1] === 'cherry') {
      payout = Math.floor(amt * 1.5); isWin = true;
    }
    user.balance = user.balance - amt + payout;
    user.totalBets += 1;
    if (isWin) user.totalWin  += (payout - amt);
    else        user.totalLoss += amt;
    await user.save();
    res.json({ symbols, payout, isWin, balance: user.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on :${PORT}`));
