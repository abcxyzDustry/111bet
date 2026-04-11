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

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/payment', (req, res) => res.sendFile(path.join(__dirname, 'public', 'payment.html')));

// MongoDB
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/gambling_research';
mongoose.connect(MONGO_URI)
  .then(() => { console.log('✅ MongoDB connected'); ensureAdmin(); })
  .catch(err => console.error('MongoDB error:', err));

const JWT_SECRET = process.env.JWT_SECRET || 'gambling_secret_2024';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@2024!';

async function ensureAdmin() {
  try {
    const exists = await User.findOne({ username: ADMIN_USERNAME, isAdmin: true });
    if (!exists) {
      const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
      await User.create({ username: ADMIN_USERNAME, password: hash, isAdmin: true });
      console.log(`✅ Admin: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
    }
  } catch {}
}

// Schemas
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  uuid: { type: String, unique: true, sparse: true }, // UUID từ Mindustry
  password: String,
  balance: { type: Number, default: 0 },
  totalDeposit: { type: Number, default: 0 },
  totalWin: { type: Number, default: 0 },
  totalLoss: { type: Number, default: 0 },
  totalBets: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  isAdmin: { type: Boolean, default: false },
  status: { type: String, default: 'active' },
  isGameAccount: { type: Boolean, default: false } // Đánh dấu tài khoản từ game
});

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  username: String,
  type: String,
  amount: Number,
  note: String,
  adminId: String,
  createdAt: { type: Date, default: Date.now }
});

const depositRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  username: String,
  amount: Number,
  transferCode: String,
  status: { type: String, default: 'pending' },
  note: String,
  adminNote: String,
  reviewedBy: String,
  reviewedAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const withdrawRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  username: String,
  amount: Number,
  bankName: String,
  bankAccount: String,
  status: { type: String, default: 'pending' },
  adminNote: String,
  reviewedBy: String,
  reviewedAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const sessionSchema = new mongoose.Schema({
  sessionId: { type: String, default: uuidv4 },
  gameType: String,
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
  uuid: String,
  gameType: String,
  sessionId: String,
  betChoice: mongoose.Schema.Types.Mixed,
  betAmount: Number,
  result: mongoose.Schema.Types.Mixed,
  payout: Number,
  isWin: Boolean,
  createdAt: { type: Date, default: Date.now }
});

const bannerSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  label: String,
  value: String,
  updatedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const DepositRequest = mongoose.model('DepositRequest', depositRequestSchema);
const WithdrawRequest = mongoose.model('WithdrawRequest', withdrawRequestSchema);
const GameSession = mongoose.model('GameSession', sessionSchema);
const Bet = mongoose.model('Bet', betSchema);
const Banner = mongoose.model('Banner', bannerSchema);

// House Edge Rate
let houseEdgeRate = 0.70;

// ==================== API CHO MINDUSTRY PLUGIN ====================

// Đăng ký tài khoản từ game
app.post('/api/game/register', async (req, res) => {
  try {
    const { uuid, username } = req.body;
    if (!uuid || !username) {
      return res.status(400).json({ error: 'Thiếu uuid hoặc username' });
    }
    
    let user = await User.findOne({ uuid });
    if (!user) {
      // Tạo tài khoản mới
      user = await User.create({
        username: username,
        uuid: uuid,
        balance: 0,
        isGameAccount: true,
        password: await bcrypt.hash(uuid, 10) // Mật khẩu mặc định là uuid
      });
      console.log(`✅ Tạo tài khoản game: ${username} (${uuid})`);
    }
    
    res.json({ success: true, balance: user.balance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Đồng bộ số dư từ game lên web (cập nhật balance)
app.post('/api/game/update-balance', async (req, res) => {
  try {
    const { uuid, username, balance } = req.body;
    if (!uuid) return res.status(400).json({ error: 'Thiếu uuid' });
    
    let user = await User.findOne({ uuid });
    if (!user) {
      user = await User.create({
        username: username || uuid.substring(0, 8),
        uuid: uuid,
        balance: balance || 0,
        isGameAccount: true,
        password: await bcrypt.hash(uuid, 10)
      });
    } else {
      user.balance = balance;
      await user.save();
    }
    
    res.json({ success: true, balance: user.balance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lấy số dư từ web về game
app.get('/api/game/sync', async (req, res) => {
  try {
    const { uuid } = req.query;
    if (!uuid) return res.status(400).json({ error: 'Thiếu uuid' });
    
    const user = await User.findOne({ uuid });
    if (!user) {
      return res.json({ balance: 0, exists: false });
    }
    
    res.json({ balance: user.balance, username: user.username, exists: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Middleware
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
    req.user = decoded;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

// Auth Routes
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Thiếu thông tin' });
    if (username.length < 3) return res.status(400).json({ error: 'Username tối thiểu 3 ký tự' });
    if (password.length < 6) return res.status(400).json({ error: 'Mật khẩu tối thiểu 6 ký tự' });
    
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

app.get('/api/me', auth, async (req, res) => {
  const user = await User.findById(req.user.id).select('-password');
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

// Banner
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

// Deposit Requests
app.post('/api/deposit-request', auth, async (req, res) => {
  try {
    const { amount, transferCode, note } = req.body;
    const validAmounts = [10000, 20000, 50000, 100000, 200000, 500000];
    if (!validAmounts.includes(Number(amount))) return res.status(400).json({ error: 'Mệnh giá không hợp lệ' });
    
    const pending = await DepositRequest.countDocuments({ userId: req.user.id, status: 'pending' });
    if (pending >= 3) return res.status(400).json({ error: 'Đang có yêu cầu chờ duyệt, vui lòng chờ' });
    
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
  const reqs = await DepositRequest.find({}).sort({ createdAt: -1 }).limit(200);
  res.json(reqs);
});

app.post('/api/admin/deposit-request/approve', adminAuth, async (req, res) => {
  try {
    const { requestId, adminNote } = req.body;
    const dr = await DepositRequest.findById(requestId);
    if (!dr) return res.status(404).json({ error: 'Not found' });
    if (dr.status !== 'pending') return res.status(400).json({ error: 'Đã xử lý' });
    
    dr.status = 'approved'; dr.adminNote = adminNote || 'Đã duyệt';
    dr.reviewedBy = req.user.username; dr.reviewedAt = new Date();
    await dr.save();
    
    const user = await User.findByIdAndUpdate(dr.userId, { $inc: { balance: dr.amount, totalDeposit: dr.amount } }, { new: true });
    await Transaction.create({ userId: dr.userId, username: dr.username, type: 'deposit', amount: dr.amount, note: `Nạp tiền - ${adminNote || 'Duyệt'}`, adminId: req.user.id });
    
    io.to(dr.userId.toString()).emit('balance_update', { balance: user.balance });
    io.to(dr.userId.toString()).emit('deposit_approved', { amount: dr.amount, balance: user.balance });
    io.emit('banner_update', {});
    res.json({ success: true, balance: user.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/deposit-request/reject', adminAuth, async (req, res) => {
  try {
    const { requestId, adminNote } = req.body;
    const dr = await DepositRequest.findById(requestId);
    if (!dr) return res.status(404).json({ error: 'Not found' });
    if (dr.status !== 'pending') return res.status(400).json({ error: 'Đã xử lý' });
    
    dr.status = 'rejected'; dr.adminNote = adminNote || 'Từ chối';
    dr.reviewedBy = req.user.username; dr.reviewedAt = new Date();
    await dr.save();
    io.to(dr.userId.toString()).emit('deposit_rejected', { adminNote: dr.adminNote });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Withdraw Requests
app.post('/api/withdraw-request', auth, async (req, res) => {
  try {
    const { amount, bankName, bankAccount } = req.body;
    const amt = Number(amount);
    if (!amt || amt < 50000) return res.status(400).json({ error: 'Số tiền tối thiểu 50,000đ' });
    if (!bankName || !bankAccount) return res.status(400).json({ error: 'Vui lòng nhập tên ngân hàng và số tài khoản' });
    
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
    if (user.status === 'banned') return res.status(403).json({ error: 'Tài khoản bị khóa' });
    if (user.balance < amt) return res.status(400).json({ error: 'Số dư không đủ' });
    
    const pending = await WithdrawRequest.countDocuments({ userId: req.user.id, status: 'pending' });
    if (pending >= 2) return res.status(400).json({ error: 'Đang có yêu cầu chờ xử lý, vui lòng chờ' });
    
    const wr = await WithdrawRequest.create({
      userId: req.user.id, username: req.user.username,
      amount: amt, bankName: bankName.trim(), bankAccount: bankAccount.trim()
    });
    io.emit('admin:new_withdraw_request', { id: wr._id, username: req.user.username, amount: amt, bankName: bankName.trim() });
    res.json({ success: true, requestId: wr._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/my-withdraw-requests', auth, async (req, res) => {
  const reqs = await WithdrawRequest.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(10);
  res.json(reqs);
});

app.get('/api/admin/withdraw-requests', adminAuth, async (req, res) => {
  const reqs = await WithdrawRequest.find({}).sort({ createdAt: -1 }).limit(200);
  res.json(reqs);
});

app.post('/api/admin/withdraw-request/approve', adminAuth, async (req, res) => {
  try {
    const { requestId, adminNote } = req.body;
    const wr = await WithdrawRequest.findById(requestId);
    if (!wr) return res.status(404).json({ error: 'Not found' });
    if (wr.status !== 'pending') return res.status(400).json({ error: 'Đã xử lý' });
    
    const user = await User.findById(wr.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < wr.amount) return res.status(400).json({ error: 'Số dư không đủ' });
    
    user.balance -= wr.amount; await user.save();
    wr.status = 'approved'; wr.adminNote = adminNote || 'Đã duyệt';
    wr.reviewedBy = req.user.username; wr.reviewedAt = new Date();
    await wr.save();
    await Transaction.create({ userId: wr.userId, username: wr.username, type: 'withdraw', amount: wr.amount, note: `Rút qua ${wr.bankName} - ${adminNote || 'Đã duyệt'}`, adminId: req.user.id });
    
    io.to(wr.userId.toString()).emit('balance_update', { balance: user.balance });
    io.to(wr.userId.toString()).emit('withdraw_approved', { amount: wr.amount, balance: user.balance, bankName: wr.bankName });
    io.emit('banner_update', {});
    res.json({ success: true, balance: user.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdraw-request/reject', adminAuth, async (req, res) => {
  try {
    const { requestId, adminNote } = req.body;
    const wr = await WithdrawRequest.findById(requestId);
    if (!wr) return res.status(404).json({ error: 'Not found' });
    if (wr.status !== 'pending') return res.status(400).json({ error: 'Đã xử lý' });
    
    wr.status = 'rejected'; wr.adminNote = adminNote || 'Từ chối';
    wr.reviewedBy = req.user.username; wr.reviewedAt = new Date();
    await wr.save();
    io.to(wr.userId.toString()).emit('withdraw_rejected', { adminNote: wr.adminNote });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin General
app.get('/api/admin/users', adminAuth, async (req, res) => {
  const users = await User.find({}).select('-password').sort({ createdAt: -1 });
  res.json(users);
});

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  const [userCount, depAgg, wdAgg, sessions, bets, pendingCount] = await Promise.all([
    User.countDocuments({ isAdmin: false }),
    Transaction.aggregate([{ $match: { type: 'deposit' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Transaction.aggregate([{ $match: { type: 'withdraw' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    GameSession.find({}).sort({ createdAt: -1 }).limit(50),
    Bet.aggregate([{ $group: { _id: null, totalBet: { $sum: '$betAmount' }, totalPayout: { $sum: '$payout' }, count: { $sum: 1 } } }]),
    DepositRequest.countDocuments({ status: 'pending' })
  ]);
  const betStats = bets[0] || { totalBet: 0, totalPayout: 0, count: 0 };
  res.json({ userCount, totalDeposited: depAgg[0]?.total || 0, totalWithdrawn: wdAgg[0]?.total || 0, totalBetAmount: betStats.totalBet, totalPayout: betStats.totalPayout, houseProfit: betStats.totalBet - betStats.totalPayout, betCount: betStats.count, pendingDepositCount: pendingCount, recentSessions: sessions });
});

app.post('/api/admin/deposit', adminAuth, async (req, res) => {
  try {
    const { userId, amount, note } = req.body;
    if (!userId || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid' });
    const user = await User.findByIdAndUpdate(userId, { $inc: { balance: amount, totalDeposit: amount } }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    await Transaction.create({ userId, username: user.username, type: 'deposit', amount, note, adminId: req.user.id });
    io.to(userId.toString()).emit('balance_update', { balance: user.balance });
    io.emit('banner_update', {});
    res.json({ success: true, balance: user.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdraw', adminAuth, async (req, res) => {
  try {
    const { userId, amount, note } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (user.balance < amount) return res.status(400).json({ error: 'Số dư không đủ' });
    user.balance -= amount; await user.save();
    await Transaction.create({ userId, username: user.username, type: 'withdraw', amount, note, adminId: req.user.id });
    io.to(userId.toString()).emit('balance_update', { balance: user.balance });
    io.emit('banner_update', {});
    res.json({ success: true, balance: user.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/ban', adminAuth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.body.userId, { status: req.body.status });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/transactions', adminAuth, async (req, res) => {
  const txs = await Transaction.find({}).sort({ createdAt: -1 }).limit(200);
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

// House Edge
app.get('/api/admin/house-edge', adminAuth, (req, res) => {
  res.json({ rate: houseEdgeRate, percent: Math.round(houseEdgeRate * 100) });
});

app.post('/api/admin/house-edge', adminAuth, (req, res) => {
  const { rate } = req.body;
  const r = parseFloat(rate);
  if (isNaN(r) || r < 0.70 || r > 0.90) return res.status(400).json({ error: 'Tỷ lệ phải từ 70% đến 90%' });
  houseEdgeRate = r;
  res.json({ success: true, rate: houseEdgeRate, percent: Math.round(houseEdgeRate * 100) });
});

// ==================== GAME ENGINE (GIỐNG PLUGIN) ====================
const games = {
  taixiu: { phase: 'BETTING', countdown: 15, result: null, bets: {}, sessionId: uuidv4() }
};

function rollTx() {
  const dice = Array.from({length:3}, () => Math.floor(Math.random()*6)+1);
  const sum = dice.reduce((a,b)=>a+b,0);
  const isTriple = dice[0]===dice[1] && dice[1]===dice[2];
  return { dice, sum, side: isTriple?'triple':sum>=11?'tai':'xiu', isTriple };
}

function rollTxBiased(bets) {
  if (Math.random() < houseEdgeRate) {
    const tT = Object.values(bets).reduce((s,b)=>s+(b.tai||0),0);
    const xT = Object.values(bets).reduce((s,b)=>s+(b.xiu||0),0);
    for (let i=0;i<20;i++) {
      const r = rollTx();
      if (r.isTriple) return r;
      if (tT>xT && r.side==='xiu') return r;
      if (xT>tT && r.side==='tai') return r;
      if (tT===xT) return r;
    }
  }
  return rollTx();
}

function startLoop() {
  const s = games.taixiu;
  setInterval(async () => {
    if (s.phase === 'BETTING') {
      s.countdown--;
      io.emit('taixiu:tick', { countdown: s.countdown });
      if (s.countdown <= 0) {
        s.phase = 'ROLLING';
        s.countdown = 3;
        io.emit('taixiu:rolling', {});
      }
    } else if (s.phase === 'ROLLING') {
      s.countdown--;
      if (s.countdown <= 0) {
        s.result = rollTxBiased(s.bets);
        s.phase = 'RESULT';
        s.countdown = 6;
        
        let tb = 0, tp = 0;
        const sb = [];
        
        for (const [uid, ubets] of Object.entries(s.bets)) {
          for (const [choice, amt] of Object.entries(ubets)) {
            if (!amt) continue;
            let pay = 0;
            if (!s.result.isTriple && choice === s.result.side) {
              pay = amt + amt * 1.5;
            }
            const isWin = pay > 0;
            const user = await User.findById(uid);
            if (user) {
              user.balance = user.balance - amt + pay;
              user.totalBets += 1;
              if (isWin) user.totalWin += (pay - amt);
              else user.totalLoss += amt;
              await user.save();
              
              sb.push(await Bet.create({
                userId: uid, username: user.username, gameType: 'taixiu',
                sessionId: s.sessionId, betChoice: choice, betAmount: amt,
                result: s.result, payout: pay, isWin
              }));
              tb += amt; tp += pay;
              io.to(uid).emit('balance_update', { balance: user.balance });
              io.to(uid).emit('taixiu:bet_result', { choice, amount: amt, payout: pay, isWin, result: s.result, balance: user.balance });
            }
          }
        }
        
        await GameSession.create({
          sessionId: s.sessionId, gameType: 'taixiu', result: s.result,
          bets: sb, totalBetAmount: tb, totalPayout: tp, houseProfit: tb - tp
        });
        
        io.emit('taixiu:result', { result: s.result, sessionId: s.sessionId });
        s.bets = {};
      }
    } else {
      s.countdown--;
      if (s.countdown <= 0) {
        s.phase = 'BETTING';
        s.countdown = 15;
        s.result = null;
        s.sessionId = uuidv4();
        io.emit('taixiu:new_round', { sessionId: s.sessionId });
      }
    }
  }, 1000);
}

startLoop();

// Socket.IO
io.on('connection', socket => {
  socket.on('auth', token => {
    try {
      const d = jwt.verify(token, JWT_SECRET);
      socket.userId = d.id;
      socket.join(d.id);
      const s = games.taixiu;
      socket.emit('taixiu:state', { phase: s.phase, countdown: s.countdown, result: s.result, sessionId: s.sessionId });
    } catch {}
  });

  socket.on('join_guest', () => {
    const s = games.taixiu;
    socket.emit('taixiu:state', { phase: s.phase, countdown: s.countdown, result: s.result, sessionId: s.sessionId });
  });

  socket.on('place_bet', async ({ gameType, bets, token }) => {
    try {
      const d = jwt.verify(token, JWT_SECRET);
      const s = games[gameType];
      if (!s || s.phase !== 'BETTING') return socket.emit('bet_error', { error: 'Phiên cược đã đóng' });
      
      const user = await User.findById(d.id);
      if (!user) return socket.emit('bet_error', { error: 'User not found' });
      if (user.status === 'banned') return socket.emit('bet_error', { error: 'Tài khoản bị khóa' });
      
      const total = Object.values(bets).reduce((s,v)=>s+v,0);
      if (total <= 0) return socket.emit('bet_error', { error: 'Số tiền không hợp lệ' });
      if (user.balance < total) return socket.emit('bet_error', { error: 'Số dư không đủ! Vui lòng nạp tiền.' });
      
      user.balance -= total;
      await user.save();
      
      if (!s.bets[d.id]) s.bets[d.id] = {};
      for (const [c, a] of Object.entries(bets)) {
        s.bets[d.id][c] = (s.bets[d.id][c] || 0) + a;
      }
      
      socket.emit('bet_accepted', { balance: user.balance });
      io.to(d.id).emit('balance_update', { balance: user.balance });
    } catch(e) {
      socket.emit('bet_error', { error: e.message });
    }
  });
});

// Public APIs
app.get('/api/game-state/:gt', (req, res) => {
  const s = games[req.params.gt];
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ phase: s.phase, countdown: s.countdown, result: s.result, sessionId: s.sessionId });
});

app.get('/api/history/:gt', auth, async (req, res) => {
  const bets = await Bet.find({ userId: req.user.id, gameType: req.params.gt }).sort({ createdAt: -1 }).limit(30);
  res.json(bets);
});

app.get('/api/recent-results/:gt', async (req, res) => {
  const sessions = await GameSession.find({ gameType: req.params.gt }).sort({ createdAt: -1 }).limit(20);
  res.json(sessions.map(s => s.result));
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on :${PORT}`));
