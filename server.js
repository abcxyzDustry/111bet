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
const io = new Server(server, { 
    cors: { 
        origin: '*', 
        methods: ['GET', 'POST'] 
    } 
});

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
    .then(() => { 
        console.log('✅ MongoDB connected'); 
        ensureAdmin(); 
    })
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
            console.log(`✅ Admin created: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
        }
    } catch (err) {
        console.error('Admin creation error:', err);
    }
}

// ==================== SCHEMAS ====================
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    uuid: { type: String, unique: true, sparse: true },
    password: String,
    balance: { type: Number, default: 0 },
    totalDeposit: { type: Number, default: 0 },
    totalWin: { type: Number, default: 0 },
    totalLoss: { type: Number, default: 0 },
    totalBets: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    isAdmin: { type: Boolean, default: false },
    status: { type: String, default: 'active' },
    isGameAccount: { type: Boolean, default: false }
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

// ==================== CONFIGURATION ====================
let houseEdgeRate = 0.70; // 70% house edge

// ==================== MINDUSTRY WEBSOCKET CONNECTIONS ====================
const mindustryConnections = new Map(); // uuid -> { socket, user, serverId }

// ==================== GAME ENGINE ====================
const games = {
    taixiu: { 
        phase: 'BETTING', 
        countdown: 15, 
        result: null, 
        bets: {}, 
        sessionId: uuidv4() 
    }
};

function rollTx() {
    const dice = Array.from({length: 3}, () => Math.floor(Math.random() * 6) + 1);
    const sum = dice.reduce((a, b) => a + b, 0);
    const isTriple = dice[0] === dice[1] && dice[1] === dice[2];
    return { dice, sum, side: isTriple ? 'triple' : (sum >= 11 ? 'tai' : 'xiu'), isTriple };
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

// ==================== WEBSOCKET HANDLERS ====================
function broadcastGameTick() {
    const s = games.taixiu;
    const gameState = {
        phase: s.phase,
        countdown: s.countdown,
        result: s.result,
        sessionId: s.sessionId,
        timestamp: Date.now()
    };
    
    // Send to all Mindustry clients
    for (const [uuid, conn] of mindustryConnections.entries()) {
        if (conn.socket && conn.socket.readyState === 1) {
            conn.socket.send(JSON.stringify({
                event: 'mindustry_game_tick',
                data: gameState
            }));
        }
    }
    
    // Send to web clients
    io.emit('taixiu:tick', { countdown: s.countdown });
}

async function processGameResult() {
    const s = games.taixiu;
    s.result = rollTxBiased(s.bets);
    s.phase = 'RESULT';
    s.countdown = 6;

    let tb = 0, tp = 0;
    const sb = [];

    for (const [uid, ubets] of Object.entries(s.bets)) {
        let userTotalPayout = 0;
        let userTotalBet = 0;
        const betResults = [];
        
        for (const [choice, amt] of Object.entries(ubets)) {
            if (!amt) continue;
            let pay = 0;
            let isWin = false;
            
            if (!s.result.isTriple && choice === s.result.side) {
                pay = amt + amt * 1.5;
                isWin = true;
            }
            
            userTotalBet += amt;
            userTotalPayout += pay;
            tb += amt;
            tp += pay;
            
            betResults.push({ choice, amount: amt, payout: pay, isWin });
            
            // Save bet to database
            const user = await User.findById(uid);
            if (user) {
                sb.push(await Bet.create({
                    userId: uid,
                    username: user.username,
                    gameType: 'taixiu',
                    sessionId: s.sessionId,
                    betChoice: choice,
                    betAmount: amt,
                    result: s.result,
                    payout: pay,
                    isWin: isWin
                }));
            }
        }
        
        // Update user balance and stats
        const user = await User.findById(uid);
        if (user) {
            // Balance already deducted at bet time, now add winnings
            if (userTotalPayout > 0) {
                user.balance += userTotalPayout;
            }
            user.totalBets += betResults.length;
            for (const br of betResults) {
                if (br.isWin) {
                    user.totalWin += (br.payout - br.amount);
                } else {
                    user.totalLoss += br.amount;
                }
            }
            await user.save();
            
            // Send result to Mindustry client
            for (const [uuid, conn] of mindustryConnections.entries()) {
                if (conn.user && conn.user._id.toString() === uid && conn.socket.readyState === 1) {
                    conn.socket.send(JSON.stringify({
                        event: 'mindustry_bet_result',
                        data: {
                            uuid: uuid,
                            results: betResults,
                            totalPayout: userTotalPayout,
                            newBalance: user.balance,
                            result: s.result,
                            sessionId: s.sessionId
                        }
                    }));
                }
            }
            
            // Send balance update to web client
            io.to(uid).emit('balance_update', { balance: user.balance });
        }
    }

    // Save game session
    await GameSession.create({
        sessionId: s.sessionId,
        gameType: 'taixiu',
        result: s.result,
        bets: sb,
        totalBetAmount: tb,
        totalPayout: tp,
        houseProfit: tb - tp
    });

    // Broadcast result to all
    io.emit('taixiu:result', { result: s.result, sessionId: s.sessionId });
    
    // Send result to Mindustry clients
    for (const [uuid, conn] of mindustryConnections.entries()) {
        if (conn.socket && conn.socket.readyState === 1) {
            conn.socket.send(JSON.stringify({
                event: 'mindustry_game_result',
                data: {
                    result: s.result,
                    sessionId: s.sessionId,
                    totalBet: tb,
                    totalPayout: tp
                }
            }));
        }
    }
    
    s.bets = {};
}

// Game loop
setInterval(async () => {
    const s = games.taixiu;
    
    try {
        if (s.phase === 'BETTING') {
            s.countdown--;
            broadcastGameTick();
            
            if (s.countdown <= 0) {
                s.phase = 'ROLLING';
                s.countdown = 3;
                io.emit('taixiu:rolling', {});
                broadcastGameTick();
            }
        } else if (s.phase === 'ROLLING') {
            s.countdown--;
            broadcastGameTick();
            
            if (s.countdown <= 0) {
                await processGameResult();
                broadcastGameTick();
            }
        } else if (s.phase === 'RESULT') {
            s.countdown--;
            broadcastGameTick();
            
            if (s.countdown <= 0) {
                s.phase = 'BETTING';
                s.countdown = 15;
                s.result = null;
                s.sessionId = uuidv4();
                io.emit('taixiu:new_round', { sessionId: s.sessionId });
                broadcastGameTick();
            }
        }
    } catch (error) {
        console.error('Game loop error:', error);
    }
}, 1000);

// ==================== SOCKET.IO HANDLERS ====================
io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    
    // Web client authentication
    socket.on('auth', async (token) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await User.findById(decoded.id);
            if (user && user.status !== 'banned') {
                socket.userId = decoded.id;
                socket.join(decoded.id);
                
                const s = games.taixiu;
                socket.emit('taixiu:state', {
                    phase: s.phase,
                    countdown: s.countdown,
                    result: s.result,
                    sessionId: s.sessionId
                });
                socket.emit('balance_update', { balance: user.balance });
                console.log(`Web client authenticated: ${user.username}`);
            }
        } catch (error) {
            socket.emit('auth_error', { error: 'Invalid token' });
        }
    });
    
    // Guest join
    socket.on('join_guest', () => {
        const s = games.taixiu;
        socket.emit('taixiu:state', {
            phase: s.phase,
            countdown: s.countdown,
            result: s.result,
            sessionId: s.sessionId
        });
    });
    
    // Place bet from web
    socket.on('place_bet', async ({ gameType, bets, token }) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const s = games[gameType];
            
            if (!s || s.phase !== 'BETTING') {
                socket.emit('bet_error', { error: 'Betting phase closed' });
                return;
            }
            
            const user = await User.findById(decoded.id);
            if (!user || user.status === 'banned') {
                socket.emit('bet_error', { error: 'User not found or banned' });
                return;
            }
            
            const totalBet = Object.values(bets).reduce((s, v) => s + v, 0);
            if (totalBet <= 0) {
                socket.emit('bet_error', { error: 'Invalid bet amount' });
                return;
            }
            
            if (user.balance < totalBet) {
                socket.emit('bet_error', { error: 'Insufficient balance', balance: user.balance });
                return;
            }
            
            // Deduct balance
            user.balance -= totalBet;
            await user.save();
            
            // Store bet
            if (!s.bets[user._id.toString()]) {
                s.bets[user._id.toString()] = {};
            }
            for (const [choice, amount] of Object.entries(bets)) {
                s.bets[user._id.toString()][choice] = (s.bets[user._id.toString()][choice] || 0) + amount;
            }
            
            socket.emit('bet_accepted', { balance: user.balance, betAmount: totalBet });
            io.to(user._id.toString()).emit('balance_update', { balance: user.balance });
            
            console.log(`Web bet: ${user.username} bet ${totalBet} on ${gameType}`);
        } catch (error) {
            socket.emit('bet_error', { error: error.message });
        }
    });
    
    // ==================== MINDUSTRY PLUGIN HANDLERS ====================
    socket.on('mindustry_auth', async (data) => {
        try {
            const { uuid, serverId } = data;
            if (!uuid) {
                socket.emit('mindustry_error', { error: 'Missing UUID' });
                return;
            }
            
            let user = await User.findOne({ uuid });
            if (!user) {
                const tempUsername = `game_${uuid.substring(0, 8)}`;
                user = await User.create({
                    username: tempUsername,
                    uuid: uuid,
                    balance: 0,
                    isGameAccount: true,
                    password: await bcrypt.hash(uuid, 10)
                });
                console.log(`✅ [Mindustry] New player: ${tempUsername} (${uuid})`);
            }
            
            if (user.status === 'banned') {
                socket.emit('mindustry_error', { error: 'Account banned' });
                return;
            }
            
            mindustryConnections.set(uuid, { socket, user, serverId });
            socket.mindustryUuid = uuid;
            
            const s = games.taixiu;
            socket.emit('mindustry_ready', {
                balance: user.balance,
                username: user.username,
                gameState: {
                    phase: s.phase,
                    countdown: s.countdown,
                    result: s.result,
                    sessionId: s.sessionId
                }
            });
            
            console.log(`✅ [Mindustry] Connected: ${user.username} | Balance: ${user.balance}`);
        } catch (error) {
            console.error('[Mindustry] Auth error:', error);
            socket.emit('mindustry_error', { error: error.message });
        }
    });
    
    socket.on('mindustry_place_bet', async (data) => {
        try {
            const { uuid, choice, amount, gameType = 'taixiu' } = data;
            
            if (!uuid || !choice || !amount) {
                socket.emit('mindustry_bet_error', { error: 'Invalid bet data' });
                return;
            }
            
            const user = await User.findOne({ uuid });
            if (!user) {
                socket.emit('mindustry_bet_error', { error: 'User not found' });
                return;
            }
            
            const s = games[gameType];
            if (!s || s.phase !== 'BETTING') {
                socket.emit('mindustry_bet_error', { error: 'Betting phase closed' });
                return;
            }
            
            const betAmount = Number(amount);
            if (betAmount <= 0) {
                socket.emit('mindustry_bet_error', { error: 'Invalid amount' });
                return;
            }
            
            if (user.balance < betAmount) {
                socket.emit('mindustry_bet_error', { 
                    error: 'Insufficient balance',
                    currentBalance: user.balance
                });
                return;
            }
            
            // Deduct balance immediately
            user.balance -= betAmount;
            await user.save();
            
            // Store bet
            const uid = user._id.toString();
            if (!s.bets[uid]) {
                s.bets[uid] = {};
            }
            s.bets[uid][choice] = (s.bets[uid][choice] || 0) + betAmount;
            
            socket.emit('mindustry_bet_accepted', {
                choice,
                amount: betAmount,
                newBalance: user.balance,
                remainingTime: s.countdown
            });
            
            console.log(`🎲 [Mindustry] ${user.username} bet ${betAmount} on ${choice} | New balance: ${user.balance}`);
        } catch (error) {
            console.error('[Mindustry] Bet error:', error);
            socket.emit('mindustry_bet_error', { error: error.message });
        }
    });
    
    socket.on('mindustry_sync_balance', async (data) => {
        try {
            const { uuid } = data;
            const user = await User.findOne({ uuid });
            if (user) {
                socket.emit('mindustry_balance_sync', {
                    balance: user.balance,
                    username: user.username,
                    timestamp: Date.now()
                });
            } else {
                socket.emit('mindustry_balance_sync', { balance: 0, exists: false });
            }
        } catch (error) {
            socket.emit('mindustry_error', { error: error.message });
        }
    });
    
    socket.on('disconnect', () => {
        if (socket.mindustryUuid) {
            mindustryConnections.delete(socket.mindustryUuid);
            console.log(`🔌 [Mindustry] Disconnected: ${socket.mindustryUuid}`);
        }
        console.log('Client disconnected:', socket.id);
    });
});

// ==================== API ROUTES ====================

// Middleware
const auth = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
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
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// ==================== MINDUSTRY API ROUTES ====================
app.post('/api/game/register', async (req, res) => {
    try {
        const { uuid, username } = req.body;
        if (!uuid || !username) {
            return res.status(400).json({ error: 'Missing uuid or username' });
        }
        
        let user = await User.findOne({ uuid });
        if (!user) {
            let finalUsername = username;
            const existing = await User.findOne({ username });
            if (existing) {
                finalUsername = username + '_' + uuid.substring(0, 6);
            }
            
            user = await User.create({
                username: finalUsername,
                uuid: uuid,
                balance: 0,
                isGameAccount: true,
                password: await bcrypt.hash(uuid, 10)
            });
            console.log(`✅ API Register: ${finalUsername} (${uuid})`);
        }
        
        res.json({ success: true, balance: user.balance });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/game/update-balance', async (req, res) => {
    try {
        const { uuid, username, balance } = req.body;
        if (!uuid) return res.status(400).json({ error: 'Missing uuid' });
        
        let user = await User.findOne({ uuid });
        if (!user) {
            let finalUsername = username || uuid.substring(0, 8);
            const existing = await User.findOne({ username: finalUsername });
            if (existing) finalUsername = finalUsername + '_' + uuid.substring(0, 6);
            
            user = await User.create({
                username: finalUsername,
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
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/game/sync', async (req, res) => {
    try {
        const { uuid } = req.query;
        if (!uuid) return res.status(400).json({ error: 'Missing uuid' });
        
        const user = await User.findOne({ uuid });
        if (!user) {
            return res.json({ balance: 0, exists: false });
        }
        
        res.json({ balance: user.balance, username: user.username, exists: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/game-state/:gt', async (req, res) => {
    const s = games[req.params.gt];
    if (!s) return res.status(404).json({ error: 'Game not found' });
    res.json({
        phase: s.phase,
        countdown: s.countdown,
        result: s.result,
        sessionId: s.sessionId
    });
});

// ==================== WEB AUTH ROUTES ====================
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Missing info' });
        if (username.length < 3) return res.status(400).json({ error: 'Username min 3 chars' });
        if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
        
        const exists = await User.findOne({ username });
        if (exists) return res.status(400).json({ error: 'Username exists' });
        
        const hash = await bcrypt.hash(password, 10);
        const user = await User.create({ username, password: hash });
        const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, username: user.username, balance: user.balance });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user) return res.status(400).json({ error: 'Invalid credentials' });
        if (user.status === 'banned') return res.status(403).json({ error: 'Account banned' });
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(400).json({ error: 'Invalid credentials' });
        
        const token = jwt.sign({ id: user._id, username: user.username, isAdmin: user.isAdmin }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, username: user.username, balance: user.balance, isAdmin: user.isAdmin });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username, isAdmin: true });
        if (!user) return res.status(400).json({ error: 'Admin not found' });
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(400).json({ error: 'Invalid password' });
        
        const token = jwt.sign({ id: user._id, username: user.username, isAdmin: true }, JWT_SECRET, { expiresIn: '1d' });
        res.json({ token, username: user.username });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/me', auth, async (req, res) => {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json(user);
});

// ==================== BANNER ROUTES ====================
app.get('/api/banners', async (req, res) => {
    try {
        const [depAgg, wdAgg, custom] = await Promise.all([
            Transaction.aggregate([{ $match: { type: 'deposit' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
            Transaction.aggregate([{ $match: { type: 'withdraw' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
            Banner.find({})
        ]);
        res.json({
            totalDeposit: depAgg[0]?.total || 0,
            totalWithdraw: wdAgg[0]?.total || 0,
            custom
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/banner', adminAuth, async (req, res) => {
    try {
        const { key, label, value } = req.body;
        await Banner.findOneAndUpdate({ key }, { label, value, updatedAt: new Date() }, { upsert: true, new: true });
        io.emit('banner_update', {});
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/admin/banner/:key', adminAuth, async (req, res) => {
    await Banner.deleteOne({ key: req.params.key });
    io.emit('banner_update', {});
    res.json({ success: true });
});

// ==================== DEPOSIT REQUEST ROUTES ====================
app.post('/api/deposit-request', auth, async (req, res) => {
    try {
        const { amount, transferCode, note } = req.body;
        const validAmounts = [10000, 20000, 50000, 100000, 200000, 500000];
        if (!validAmounts.includes(Number(amount))) {
            return res.status(400).json({ error: 'Invalid amount' });
        }
        
        const pending = await DepositRequest.countDocuments({ userId: req.user.id, status: 'pending' });
        if (pending >= 3) return res.status(400).json({ error: 'You have pending requests' });
        
        const dr = await DepositRequest.create({
            userId: req.user.id,
            username: req.user.username,
            amount: Number(amount),
            transferCode: transferCode || '',
            note: note || ''
        });
        
        io.emit('admin:new_deposit_request', {
            id: dr._id,
            username: req.user.username,
            amount: Number(amount)
        });
        
        res.json({ success: true, requestId: dr._id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/my-deposit-requests', auth, async (req, res) => {
    const requests = await DepositRequest.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(10);
    res.json(requests);
});

app.get('/api/admin/deposit-requests', adminAuth, async (req, res) => {
    const requests = await DepositRequest.find({}).sort({ createdAt: -1 }).limit(200);
    res.json(requests);
});

app.post('/api/admin/deposit-request/approve', adminAuth, async (req, res) => {
    try {
        const { requestId, adminNote } = req.body;
        const dr = await DepositRequest.findById(requestId);
        if (!dr) return res.status(404).json({ error: 'Not found' });
        if (dr.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
        
        dr.status = 'approved';
        dr.adminNote = adminNote || 'Approved';
        dr.reviewedBy = req.user.username;
        dr.reviewedAt = new Date();
        await dr.save();
        
        const user = await User.findByIdAndUpdate(dr.userId, {
            $inc: { balance: dr.amount, totalDeposit: dr.amount }
        }, { new: true });
        
        await Transaction.create({
            userId: dr.userId,
            username: dr.username,
            type: 'deposit',
            amount: dr.amount,
            note: `Deposit - ${adminNote || 'Approved'}`,
            adminId: req.user.id
        });
        
        io.to(dr.userId.toString()).emit('balance_update', { balance: user.balance });
        io.to(dr.userId.toString()).emit('deposit_approved', { amount: dr.amount, balance: user.balance });
        io.emit('banner_update', {});
        
        res.json({ success: true, balance: user.balance });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/deposit-request/reject', adminAuth, async (req, res) => {
    try {
        const { requestId, adminNote } = req.body;
        const dr = await DepositRequest.findById(requestId);
        if (!dr) return res.status(404).json({ error: 'Not found' });
        if (dr.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
        
        dr.status = 'rejected';
        dr.adminNote = adminNote || 'Rejected';
        dr.reviewedBy = req.user.username;
        dr.reviewedAt = new Date();
        await dr.save();
        
        io.to(dr.userId.toString()).emit('deposit_rejected', { adminNote: dr.adminNote });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== WITHDRAW REQUEST ROUTES ====================
app.post('/api/withdraw-request', auth, async (req, res) => {
    try {
        const { amount, bankName, bankAccount } = req.body;
        const amt = Number(amount);
        
        if (!amt || amt < 50000) return res.status(400).json({ error: 'Minimum 50,000 VND' });
        if (!bankName || !bankAccount) return res.status(400).json({ error: 'Bank info required' });
        
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.status === 'banned') return res.status(403).json({ error: 'Account banned' });
        if (user.balance < amt) return res.status(400).json({ error: 'Insufficient balance' });
        
        const pending = await WithdrawRequest.countDocuments({ userId: req.user.id, status: 'pending' });
        if (pending >= 2) return res.status(400).json({ error: 'You have pending requests' });
        
        const wr = await WithdrawRequest.create({
            userId: req.user.id,
            username: req.user.username,
            amount: amt,
            bankName: bankName.trim(),
            bankAccount: bankAccount.trim()
        });
        
        io.emit('admin:new_withdraw_request', {
            id: wr._id,
            username: req.user.username,
            amount: amt,
            bankName: bankName.trim()
        });
        
        res.json({ success: true, requestId: wr._id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/my-withdraw-requests', auth, async (req, res) => {
    const requests = await WithdrawRequest.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(10);
    res.json(requests);
});

app.get('/api/admin/withdraw-requests', adminAuth, async (req, res) => {
    const requests = await WithdrawRequest.find({}).sort({ createdAt: -1 }).limit(200);
    res.json(requests);
});

app.post('/api/admin/withdraw-request/approve', adminAuth, async (req, res) => {
    try {
        const { requestId, adminNote } = req.body;
        const wr = await WithdrawRequest.findById(requestId);
        if (!wr) return res.status(404).json({ error: 'Not found' });
        if (wr.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
        
        const user = await User.findById(wr.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.balance < wr.amount) return res.status(400).json({ error: 'Insufficient balance' });
        
        user.balance -= wr.amount;
        await user.save();
        
        wr.status = 'approved';
        wr.adminNote = adminNote || 'Approved';
        wr.reviewedBy = req.user.username;
        wr.reviewedAt = new Date();
        await wr.save();
        
        await Transaction.create({
            userId: wr.userId,
            username: wr.username,
            type: 'withdraw',
            amount: wr.amount,
            note: `Withdraw to ${wr.bankName} - ${adminNote || 'Approved'}`,
            adminId: req.user.id
        });
        
        io.to(wr.userId.toString()).emit('balance_update', { balance: user.balance });
        io.to(wr.userId.toString()).emit('withdraw_approved', {
            amount: wr.amount,
            balance: user.balance,
            bankName: wr.bankName
        });
        io.emit('banner_update', {});
        
        res.json({ success: true, balance: user.balance });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/withdraw-request/reject', adminAuth, async (req, res) => {
    try {
        const { requestId, adminNote } = req.body;
        const wr = await WithdrawRequest.findById(requestId);
        if (!wr) return res.status(404).json({ error: 'Not found' });
        if (wr.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
        
        wr.status = 'rejected';
        wr.adminNote = adminNote || 'Rejected';
        wr.reviewedBy = req.user.username;
        wr.reviewedAt = new Date();
        await wr.save();
        
        io.to(wr.userId.toString()).emit('withdraw_rejected', { adminNote: wr.adminNote });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== ADMIN ROUTES ====================
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
    
    res.json({
        userCount,
        totalDeposited: depAgg[0]?.total || 0,
        totalWithdrawn: wdAgg[0]?.total || 0,
        totalBetAmount: betStats.totalBet,
        totalPayout: betStats.totalPayout,
        houseProfit: betStats.totalBet - betStats.totalPayout,
        betCount: betStats.count,
        pendingDepositCount: pendingCount,
        recentSessions: sessions
    });
});

app.post('/api/admin/deposit', adminAuth, async (req, res) => {
    try {
        const { userId, amount, note } = req.body;
        if (!userId || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid' });
        
        const user = await User.findByIdAndUpdate(userId, {
            $inc: { balance: amount, totalDeposit: amount }
        }, { new: true });
        
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        await Transaction.create({
            userId,
            username: user.username,
            type: 'deposit',
            amount,
            note,
            adminId: req.user.id
        });
        
        io.to(userId.toString()).emit('balance_update', { balance: user.balance });
        io.emit('banner_update', {});
        
        res.json({ success: true, balance: user.balance });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/withdraw', adminAuth, async (req, res) => {
    try {
        const { userId, amount, note } = req.body;
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });
        
        user.balance -= amount;
        await user.save();
        
        await Transaction.create({
            userId,
            username: user.username,
            type: 'withdraw',
            amount,
            note,
            adminId: req.user.id
        });
        
        io.to(userId.toString()).emit('balance_update', { balance: user.balance });
        io.emit('banner_update', {});
        
        res.json({ success: true, balance: user.balance });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/ban', adminAuth, async (req, res) => {
    try {
        const { userId, status } = req.body;
        await User.findByIdAndUpdate(userId, { status });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/transactions', adminAuth, async (req, res) => {
    const transactions = await Transaction.find({}).sort({ createdAt: -1 }).limit(200);
    res.json(transactions);
});

app.get('/api/admin/bets', adminAuth, async (req, res) => {
    const bets = await Bet.find({}).sort({ createdAt: -1 }).limit(200);
    res.json(bets);
});

app.get('/api/admin/sessions', adminAuth, async (req, res) => {
    const sessions = await GameSession.find({}).sort({ createdAt: -1 }).limit(100);
    res.json(sessions);
});

// ==================== HOUSE EDGE ROUTES ====================
app.get('/api/admin/house-edge', adminAuth, (req, res) => {
    res.json({ rate: houseEdgeRate, percent: Math.round(houseEdgeRate * 100) });
});

app.post('/api/admin/house-edge', adminAuth, (req, res) => {
    const { rate } = req.body;
    const r = parseFloat(rate);
    if (isNaN(r) || r < 0.70 || r > 0.90) {
        return res.status(400).json({ error: 'Rate must be between 70% and 90%' });
    }
    houseEdgeRate = r;
    res.json({ success: true, rate: houseEdgeRate, percent: Math.round(houseEdgeRate * 100) });
});

// ==================== HISTORY ROUTES ====================
app.get('/api/history/:gt', auth, async (req, res) => {
    const bets = await Bet.find({ userId: req.user.id, gameType: req.params.gt })
        .sort({ createdAt: -1 })
        .limit(30);
    res.json(bets);
});

app.get('/api/recent-results/:gt', async (req, res) => {
    const sessions = await GameSession.find({ gameType: req.params.gt })
        .sort({ createdAt: -1 })
        .limit(20);
    res.json(sessions.map(s => s.result));
});

// ==================== SLOTS ROUTE ====================
app.post('/api/slots/spin', auth, async (req, res) => {
    try {
        const { amount } = req.body;
        const amt = Number(amount);
        if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
        
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.balance < amt) return res.status(400).json({ error: 'Insufficient balance' });
        
        const SYMBOLS = ['7', 'diamond', 'star', 'bell', 'grapes', 'orange', 'lemon', 'cherry'];
        const PAYOUTS = { '7': 50, 'diamond': 25, 'star': 15, 'bell': 10, 'grapes': 8 };
        const spin = () => SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
        const symbols = [spin(), spin(), spin()];
        
        let payout = 0;
        let isWin = false;
        
        if (symbols[0] === symbols[1] && symbols[1] === symbols[2]) {
            const mult = PAYOUTS[symbols[0]] || 5;
            payout = amt * mult;
            isWin = true;
        } else if (symbols[0] === 'cherry' && symbols[1] === 'cherry') {
            payout = Math.floor(amt * 1.5);
            isWin = true;
        }
        
        user.balance = user.balance - amt + payout;
        user.totalBets += 1;
        if (isWin) user.totalWin += (payout - amt);
        else user.totalLoss += amt;
        await user.save();
        
        res.json({ symbols, payout, isWin, balance: user.balance });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`========================================`);
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 WebSocket: ws://localhost:${PORT}`);
    console.log(`🌐 Web: http://localhost:${PORT}`);
    console.log(`========================================`);
});
