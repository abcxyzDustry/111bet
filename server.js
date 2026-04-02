const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

// ─── MongoDB Connection ───────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/gambling_research';
mongoose.connect(MONGO_URI).then(() => console.log('✅ MongoDB connected')).catch(err => console.error('MongoDB error:', err));

const JWT_SECRET = process.env.JWT_SECRET || 'gambling_research_secret_2024';

// ─── Schemas ──────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: String,
  balance: { type: Number, default: 0 },
  totalDeposit: { type: Number, default: 0 },
  totalWin: { type: Number, default: 0 },
  totalLoss: { type: Number, default: 0 },
  totalBets: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  isAdmin: { type: Boolean, default: false },
  status: { type: String, default: 'active' } // active | banned
});

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  username: String,
  type: String, // deposit | withdraw | bet_win | bet_loss
  amount: Number,
  note: String,
  adminId: String,
  createdAt: { type: Date, default: Date.now }
});

const sessionSchema = new mongoose.Schema({
  sessionId: { type: String, default: uuidv4 },
  gameType: String, // taixiu | baucua | xocdia
  result: mongoose.Schema.Types.Mixed,
  bets: [mongoose.Schema.Types.Mixed],
  totalBetAmount: { type: Number, default: 0 },
  totalPayout: { type: Number, default: 0 },
  houseProfit: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const betSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  username: String,
  gameType: String,
  sessionId: String,
  betChoice: mongoose.Schema.Types.Mixed,
  betAmount: Number,
  result: mongoose.Schema.Types.Mixed,
  payout: Number,
  isWin: Boolean,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const GameSession = mongoose.model('GameSession', sessionSchema);
const Bet = mongoose.model('Bet', betSchema);

// ─── Auth Middleware ──────────────────────────────────────────────────────────
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

const adminAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    req.user = decoded;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

// ─── Auth Routes ─────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    const exists = await User.findOne({ username });
    if (exists) return res.status(400).json({ error: 'Username đã tồn tại' });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hash });
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, balance: user.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ error: 'Sai tài khoản hoặc mật khẩu' });
    if (user.status === 'banned') return res.status(403).json({ error: 'Tài khoản đã bị khóa' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Sai tài khoản hoặc mật khẩu' });
    const token = jwt.sign({ id: user._id, username: user.username, isAdmin: user.isAdmin }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, balance: user.balance, isAdmin: user.isAdmin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', auth, async (req, res) => {
  const user = await User.findById(req.user.id).select('-password');
  res.json(user);
});

// ─── Admin Routes ─────────────────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username, isAdmin: true });
    if (!user) return res.status(400).json({ error: 'Không tìm thấy admin' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Sai mật khẩu' });
    const token = jwt.sign({ id: user._id, username: user.username, isAdmin: true }, JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, username: user.username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create admin (internal use)
app.post('/api/admin/create', async (req, res) => {
  try {
    const { username, password, secret } = req.body;
    if (secret !== 'ADMIN_SETUP_2024') return res.status(403).json({ error: 'Forbidden' });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.findOneAndUpdate({ username }, { password: hash, isAdmin: true }, { upsert: true, new: true });
    res.json({ success: true, username: user.username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
  const users = await User.find({}).select('-password').sort({ createdAt: -1 });
  res.json(users);
});

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  const [userCount, totalDeposits, sessions, bets] = await Promise.all([
    User.countDocuments({ isAdmin: false }),
    Transaction.aggregate([{ $match: { type: 'deposit' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    GameSession.find({}).sort({ createdAt: -1 }).limit(50),
    Bet.aggregate([
      { $group: { _id: null, totalBet: { $sum: '$betAmount' }, totalPayout: { $sum: '$payout' }, count: { $sum: 1 } } }
    ])
  ]);
  const betStats = bets[0] || { totalBet: 0, totalPayout: 0, count: 0 };
  res.json({
    userCount,
    totalDeposited: totalDeposits[0]?.total || 0,
    totalBetAmount: betStats.totalBet,
    totalPayout: betStats.totalPayout,
    houseProfit: betStats.totalBet - betStats.totalPayout,
    betCount: betStats.count,
    recentSessions: sessions
  });
});

app.post('/api/admin/deposit', adminAuth, async (req, res) => {
  try {
    const { userId, amount, note } = req.body;
    if (!userId || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid data' });
    const user = await User.findByIdAndUpdate(userId, { $inc: { balance: amount, totalDeposit: amount } }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    await Transaction.create({ userId, username: user.username, type: 'deposit', amount, note, adminId: req.user.id });
    io.to(userId.toString()).emit('balance_update', { balance: user.balance });
    res.json({ success: true, balance: user.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdraw', adminAuth, async (req, res) => {
  try {
    const { userId, amount, note } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < amount) return res.status(400).json({ error: 'Số dư không đủ' });
    user.balance -= amount;
    await user.save();
    await Transaction.create({ userId, username: user.username, type: 'withdraw', amount, note, adminId: req.user.id });
    io.to(userId.toString()).emit('balance_update', { balance: user.balance });
    res.json({ success: true, balance: user.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/set-balance', adminAuth, async (req, res) => {
  try {
    const { userId, balance } = req.body;
    const user = await User.findByIdAndUpdate(userId, { balance }, { new: true });
    io.to(userId.toString()).emit('balance_update', { balance: user.balance });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/ban', adminAuth, async (req, res) => {
  try {
    const { userId, status } = req.body;
    await User.findByIdAndUpdate(userId, { status });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/transactions', adminAuth, async (req, res) => {
  const txs = await Transaction.find({}).sort({ createdAt: -1 }).limit(100);
  res.json(txs);
});

app.get('/api/admin/bets', adminAuth, async (req, res) => {
  const bets = await Bet.find({}).sort({ createdAt: -1 }).limit(200);
  res.json(bets);
});

app.get('/api/admin/sessions', adminAuth, async (req, res) => {
  const sessions = await GameSession.find({}).sort({ createdAt: -1 }).limit(100);
  res.json(sessions);
});

// ─── Game State ───────────────────────────────────────────────────────────────
// Each game runs in a loop with phases: BETTING (15s) → ROLLING (3s) → RESULT (5s)
const games = {
  taixiu:  { phase: 'BETTING', countdown: 15, result: null, bets: {}, sessionId: uuidv4() },
  baucua:  { phase: 'BETTING', countdown: 15, result: null, bets: {}, sessionId: uuidv4() },
  xocdia:  { phase: 'BETTING', countdown: 15, result: null, bets: {}, sessionId: uuidv4() }
};

// HOUSE EDGE: Tài xỉu 70% house (biased RNG), others natural
function rollTaixiu() {
  // House advantage: manipulate result 70% of the time to favor house
  // Collect bets data to determine most popular side, then set opposite
  const dice = [
    Math.floor(Math.random() * 6) + 1,
    Math.floor(Math.random() * 6) + 1,
    Math.floor(Math.random() * 6) + 1
  ];
  const sum = dice.reduce((a, b) => a + b, 0);
  const isTriple = dice[0] === dice[1] && dice[1] === dice[2];
  let side;
  if (isTriple) { side = 'triple'; }
  else if (sum >= 11) { side = 'tai'; }
  else { side = 'xiu'; }
  return { dice, sum, side, isTriple };
}

function rollTaixiuBiased(bets) {
  // 70% house edge: pick the result that loses for most bettors
  const rand = Math.random();
  if (rand < 0.70) {
    // Biased: favor house
    const taiTotal = Object.values(bets).reduce((s, b) => s + (b.tai || 0), 0);
    const xiuTotal = Object.values(bets).reduce((s, b) => s + (b.xiu || 0), 0);
    // Roll until we get the less-bet side OR triple (triple = all lose)
    for (let attempt = 0; attempt < 20; attempt++) {
      const r = rollTaixiu();
      if (r.isTriple) return r; // triple = house wins all
      if (taiTotal > xiuTotal && r.side === 'xiu') return r;
      if (xiuTotal > taiTotal && r.side === 'tai') return r;
      if (taiTotal === xiuTotal) return r; // equal, any result
    }
  }
  return rollTaixiu();
}

const BAU_CUA_ICONS = ['bau', 'cua', 'tom', 'ca', 'ga', 'nai'];
function rollBaucua() {
  return {
    dice: [
      BAU_CUA_ICONS[Math.floor(Math.random() * 6)],
      BAU_CUA_ICONS[Math.floor(Math.random() * 6)],
      BAU_CUA_ICONS[Math.floor(Math.random() * 6)]
    ]
  };
}

function rollXocdia() {
  // 4 coins: red (đỏ) or white (trắng)
  const coins = Array.from({ length: 4 }, () => Math.random() > 0.5 ? 'do' : 'trang');
  const redCount = coins.filter(c => c === 'do').length;
  const whiteCount = 4 - redCount;
  let side;
  if (redCount === 4) side = 'chan'; // 4 đỏ = chẵn
  else if (whiteCount === 4) side = 'chan'; // 4 trắng = chẵn
  else if (redCount === 2 && whiteCount === 2) side = 'chan'; // 2-2 = chẵn
  else side = 'le'; // 3-1 or 1-3 = lẻ
  // chan = 2 giống nhau pairs or 4 same
  // Actually xoc dia: chan = even number of reds (0,2,4), le = odd (1,3)
  const evenRed = redCount % 2 === 0;
  return { coins, redCount, whiteCount, side: evenRed ? 'chan' : 'le' };
}

// ─── Payout Calculators ────────────────────────────────────────────────────────
function calcTaixiuPayout(betChoice, betAmount, result) {
  if (result.isTriple) return 0; // triple = all lose (house wins)
  if (betChoice === result.side) return betAmount * 2; // 1:1 → return bet + win
  return 0;
}

function calcBaucuaPayout(betChoice, betAmount, result) {
  const count = result.dice.filter(d => d === betChoice).length;
  if (count === 0) return 0;
  return betAmount + betAmount * count; // 1 trúng = 1:1, 2 trúng = 1:2, 3 trúng = 1:3
}

function calcXocdiaPayout(betChoice, betAmount, result) {
  if (betChoice === 'bongtrang' && result.whiteCount === 4) return betAmount * 13; // 4 trắng = 1:12
  if (betChoice === 'bondo' && result.redCount === 4) return betAmount * 13;       // 4 đỏ = 1:12
  if ((betChoice === 'chan' || betChoice === 'le') && betChoice === result.side) return betAmount * 2;
  return 0;
}

// ─── Game Loop ─────────────────────────────────────────────────────────────────
function startGameLoop(gameType) {
  const state = games[gameType];

  const tick = async () => {
    if (state.phase === 'BETTING') {
      state.countdown--;
      io.emit(`${gameType}:tick`, { countdown: state.countdown, phase: 'BETTING' });
      if (state.countdown <= 0) {
        state.phase = 'ROLLING';
        state.countdown = 3;
        io.emit(`${gameType}:rolling`, {});
      }
    } else if (state.phase === 'ROLLING') {
      state.countdown--;
      if (state.countdown <= 0) {
        // Determine result
        if (gameType === 'taixiu') state.result = rollTaixiuBiased(state.bets);
        else if (gameType === 'baucua') state.result = rollBaucua();
        else state.result = rollXocdia();

        state.phase = 'RESULT';
        state.countdown = 6;

        // Process bets
        const sessionBets = [];
        let totalBet = 0, totalPayout = 0;

        for (const [userId, userBets] of Object.entries(state.bets)) {
          for (const [choice, amount] of Object.entries(userBets)) {
            if (amount <= 0) continue;
            let payout = 0;
            if (gameType === 'taixiu') payout = calcTaixiuPayout(choice, amount, state.result);
            else if (gameType === 'baucua') payout = calcBaucuaPayout(choice, amount, state.result);
            else payout = calcXocdiaPayout(choice, amount, state.result);

            const isWin = payout > amount;
            const user = await User.findById(userId);
            if (user) {
              const profit = payout - amount;
              user.balance += payout;
              user.totalBets += 1;
              if (isWin) user.totalWin += profit;
              else user.totalLoss += amount;
              await user.save();

              const betDoc = await Bet.create({
                userId, username: user.username, gameType,
                sessionId: state.sessionId, betChoice: choice,
                betAmount: amount, result: state.result, payout, isWin
              });
              sessionBets.push(betDoc);
              totalBet += amount;
              totalPayout += payout;

              io.to(userId).emit('balance_update', { balance: user.balance });
              io.to(userId).emit(`${gameType}:bet_result`, {
                choice, amount, payout, isWin, result: state.result, balance: user.balance
              });
            }
          }
        }

        // Save session
        await GameSession.create({
          sessionId: state.sessionId, gameType, result: state.result,
          bets: sessionBets, totalBetAmount: totalBet, totalPayout,
          houseProfit: totalBet - totalPayout
        });

        io.emit(`${gameType}:result`, { result: state.result, sessionId: state.sessionId });
        state.bets = {};
      }
    } else if (state.phase === 'RESULT') {
      state.countdown--;
      if (state.countdown <= 0) {
        state.phase = 'BETTING';
        state.countdown = 15;
        state.result = null;
        state.sessionId = uuidv4();
        io.emit(`${gameType}:new_round`, { sessionId: state.sessionId });
      }
    }
  };

  setInterval(tick, 1000);
}

startGameLoop('taixiu');
startGameLoop('baucua');
startGameLoop('xocdia');

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('auth', (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.userId = decoded.id;
      socket.join(decoded.id);
      // Send current game states
      for (const [gameType, state] of Object.entries(games)) {
        socket.emit(`${gameType}:state`, {
          phase: state.phase,
          countdown: state.countdown,
          result: state.result,
          sessionId: state.sessionId
        });
      }
    } catch {}
  });

  socket.on('place_bet', async ({ gameType, bets, token }) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.id;
      const state = games[gameType];
      if (state.phase !== 'BETTING') {
        return socket.emit('bet_error', { error: 'Phiên cược đã đóng' });
      }

      // Validate bet amounts
      const user = await User.findById(userId);
      if (!user) return socket.emit('bet_error', { error: 'User not found' });
      if (user.status === 'banned') return socket.emit('bet_error', { error: 'Tài khoản bị khóa' });

      const totalBet = Object.values(bets).reduce((s, v) => s + v, 0);
      if (totalBet <= 0) return socket.emit('bet_error', { error: 'Số tiền cược không hợp lệ' });
      if (user.balance < totalBet) return socket.emit('bet_error', { error: 'Số dư không đủ' });
      if (totalBet > 50000000) return socket.emit('bet_error', { error: 'Vượt hạn mức cược tối đa' });

      // Deduct balance
      user.balance -= totalBet;
      await user.save();

      // Accumulate bets
      if (!state.bets[userId]) state.bets[userId] = {};
      for (const [choice, amount] of Object.entries(bets)) {
        state.bets[userId][choice] = (state.bets[userId][choice] || 0) + amount;
      }

      socket.emit('bet_accepted', { balance: user.balance, bets: state.bets[userId] });
      io.to(userId).emit('balance_update', { balance: user.balance });
    } catch (e) {
      socket.emit('bet_error', { error: 'Lỗi đặt cược: ' + e.message });
    }
  });

  socket.on('get_history', async ({ gameType, token }) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const bets = await Bet.find({ userId: decoded.id, gameType }).sort({ createdAt: -1 }).limit(20);
      socket.emit('history', { gameType, bets });
    } catch {}
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
  });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.get('/api/game-state/:gameType', (req, res) => {
  const state = games[req.params.gameType];
  if (!state) return res.status(404).json({ error: 'Game not found' });
  res.json({ phase: state.phase, countdown: state.countdown, result: state.result, sessionId: state.sessionId });
});

app.get('/api/history/:gameType', auth, async (req, res) => {
  const bets = await Bet.find({ userId: req.user.id, gameType: req.params.gameType }).sort({ createdAt: -1 }).limit(30);
  res.json(bets);
});

app.get('/api/recent-results/:gameType', async (req, res) => {
  const sessions = await GameSession.find({ gameType: req.params.gameType }).sort({ createdAt: -1 }).limit(20);
  res.json(sessions.map(s => s.result));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
