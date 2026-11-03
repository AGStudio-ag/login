// ============ 智能考勤系统 API v3.5.1 ============
// 功能：学号登录、考勤密码保存、 自动签到订阅、邮箱VIP（Resend）、卡密系统、管理员后台
// 包含：邀请功能、系统通知配置、邮件宣传信息、时区修复、管理员删除用户、管理员代签到
// 新增：用户留言反馈系统

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const wxpusher = require('./wxpusherService');
const fs = require('fs');
const http = require('http');
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);

// ============ 微信回调限流（公开接口，防恶意刷库 / 微信轰炸）============
// 按「客户端 IP」限流 + 全局限流兜底；IP 优先取 Cloudflare / 代理头，取不到再退回 socket IP。
function callbackClientIp(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xff) return xff;
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}
const WX_CALLBACK_PER_IP_LIMIT = Math.max(1, parseInt(process.env.WX_CALLBACK_RATE_LIMIT || '60', 10) || 60);
const WX_CALLBACK_GLOBAL_LIMIT = Math.max(1, parseInt(process.env.WX_CALLBACK_GLOBAL_LIMIT || '240', 10) || 240);
function callbackLimitHandler(label) {
  return (req, res) => {
    console.warn(`[wxpusher-callback] 触发限流(${label}) ip=${callbackClientIp(req)}`);
    res.status(429).json({ success: false, message: '请求过于频繁，请稍后再试' });
  };
}
const wxCallbackIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: WX_CALLBACK_PER_IP_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  validate: false,
  keyGenerator: callbackClientIp,
  handler: callbackLimitHandler('per-ip')
});
const wxCallbackGlobalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: WX_CALLBACK_GLOBAL_LIMIT,
  standardHeaders: false,
  legacyHeaders: false,
  validate: false,
  keyGenerator: () => 'global',
  handler: callbackLimitHandler('global')
});

const PlantData = require('./PlantData');//zhiwu
const ControlCmd = require('./ControlCmd');
const membership = require('./membership');
const notifyPrefs = require('./notificationPrefs');
const replyService = require('./replyService');
const { isSubscriptionDueToday } = require('./autoSignSchedule');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const AUTO_SIGN_DRY_RUN = process.env.AUTO_SIGN_DRY_RUN === 'true';
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// ============ WebSocket 用户映射 ============
const userSockets = new Map();

io.on('connection', (socket) => {
  console.log('🔌 WebSocket 客户端已连接:', socket.id);
  
  socket.on('bindUser', (userId) => {
    if (userId) {
      userSockets.set(userId, socket.id);
      console.log(`👤 用户 ${userId} 绑定 WebSocket: ${socket.id}`);
    }
  });

  socket.on('disconnect', () => {
    for (const [uid, sid] of userSockets.entries()) {
      if (sid === socket.id) {
        userSockets.delete(uid);
        console.log(`👤 用户 ${uid} 断开 WebSocket`);
      }
    }
  });
});

// ============ CORS 配置 ============
const allowedOrigins = [
  'https://login.agai.online',
  'https://api.agai.online',
  'https://attendance-frontend.ag985211ag.workers.dev',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  'http://localhost:5500'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log('❌ CORS 拒绝的域名:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200
}));

app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use('/uploads', express.static(uploadsDir));

// ============ 数据库连接 ============
const MONGODB_URI = process.env.MONGODB_URI;
let mongoRetryTimer = null;

async function connectMongo() {
  if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI 未设置！');
    return;
  }
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
    console.log('✅ MongoDB 连接成功');
  } catch (err) {
    console.error('❌ MongoDB 连接失败:', err.message);
    if (mongoRetryTimer) clearTimeout(mongoRetryTimer);
    mongoRetryTimer = setTimeout(connectMongo, 15000);
  }
}
connectMongo();

// ============ 时区辅助函数 ============
function getBeijingTime(date = new Date()) {
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

// ============ 生成邀请码 ============
function generateInviteCode(length = 8) {
  return crypto.randomBytes(length).toString('hex').substring(0, length).toUpperCase();
}

// ============ 数据模型 ============

const userSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true },
  name: { type: String, default: '' },
  email: { type: String, default: '' },
  emailVerified: { type: Boolean, default: false },
  isVip: { type: Boolean, default: false },
  vipExpireAt: { type: Date, default: null },
  vipTier: { type: String, enum: membership.TIER_VALUES, default: 'FREE' },
  vipStartAt: { type: Date, default: null },
  signCredits: { type: Number, default: 0 },
  signCreditsExpireAt: { type: Date, default: null },
  checkinStreak: { type: Number, default: 0 },
  lastCheckinDate: { type: String, default: '' },
  checkinTotal: { type: Number, default: 0 },
  // 新手引导是否已完成/跳过（存在账号上，换设备也不会反复弹）
  onboardingDone: { type: Boolean, default: false },
  onboardingDoneAt: { type: Date, default: null },
  lastRenewalReminderDays: { type: Number, default: 0 },
  lastRenewalReminderAt: { type: Date, default: null },
  // 管理员留下的站内通知：用户下次登录/打开仪表盘时弹一次（不消耗邮件额度）
  notices: [{
    title: { type: String, default: '' },
    content: { type: String, default: '' },
    level: { type: String, default: 'warning' },
    createdAt: { type: Date, default: Date.now }
  }],
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  // 微信通知绑定（WxPusher 服务号，无需装 App）
  wxpusherUid: { type: String, default: '' },
  wxpusherBindTime: { type: Date, default: null },
  // 本次绑定会话的开始时间：扫码后靠它识别「刚刚出现的订阅者」
  wxpusherBindSession: { type: Date, default: null },
  // 签到结果通知偏好（HANDOFF §16）
  // notifyChannels 未设置（undefined）= 沿用旧默认；显式数组（含 []）= 用户自己选过
  notifyChannels: { type: [String], default: undefined, enum: ['wechat', 'email'] },
  notifyLevel: { type: String, enum: ['failure_only', 'always'], default: 'failure_only' },
  notifyUpdatedAt: { type: Date, default: null },
  isActive: { type: Boolean, default: true },
  attendancePassword: { type: String, default: 'Ahgydx@920' },
  createdAt: { type: Date, default: Date.now },
  lastLogin: Date,
  totalSignCount: { type: Number, default: 0 },
  successSignCount: { type: Number, default: 0 },
  // 邀请功能字段
  inviteCode: { type: String, unique: true, sparse: true },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  inviteCount: { type: Number, default: 0 },
  // 二手市场收款码
  payQR: {
    wechat: { type: String, default: '' },
    alipay: { type: String, default: '' }
  },
  isGuest: { type: Boolean, default: false },
  source: { type: String, enum: ['attendance', 'market'], default: 'attendance' }
});



const subscriptionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, default: '晚寝签到' },
  enabled: { type: Boolean, default: true },
  scheduleType: { type: String, enum: ['daily', 'weekdays', 'custom'], default: 'weekdays' },
  customDays: { type: [Number], default: [1, 2, 3, 4, 5] },
  signTime: { type: String, default: '21:35' },
  maxRetries: { type: Number, default: 3 },
  notifyOnSuccess: { type: Boolean, default: true },
  notifyOnFailure: { type: Boolean, default: true },
  // 因会员到期/权益撤销被系统自动关闭（重新有权限时会自动恢复）
  autoDisabledBySystem: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const signLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription' },
  subscriptionName: { type: String, default: '手动签到' },
  status: { type: String, enum: ['success', 'failed', 'pending'] },
  message: { type: String, default: '' },
  signTime: { type: Date, default: Date.now },
  executedAt: { type: Date, default: Date.now }
});

const emailCodeSchema = new mongoose.Schema({
  email: { type: String, required: true },
  code: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  used: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now }
});

const cardSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  days: { type: Number, default: 30 },
  type: { type: String, default: 'vip_30d' },
  vipTier: { type: String, enum: membership.TIER_VALUES, default: 'MONTHLY' },
  status: { type: String, enum: ['unused', 'used'], default: 'unused' },
  usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  usedAt: Date,
  createdAt: { type: Date, default: Date.now }
});

// 系统配置模型
const systemConfigSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: mongoose.Schema.Types.Mixed,
  updatedAt: { type: Date, default: Date.now }
});

// 邀请记录模型
const inviteLogSchema = new mongoose.Schema({
  inviterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  inviteeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  rewardDays: { type: Number, default: 10 },
  createdAt: { type: Date, default: Date.now }
});

// ============ 二手市场模型 ============
const marketItemSchema = new mongoose.Schema({
  productNo: { type: String, unique: true, sparse: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  description: { type: String, required: true },
  price: { type: Number, required: true },
  category: { type: String, enum: ['book', 'electronic', 'life', 'other'], default: 'other' },
  images: { type: [String], default: [] },
  paymentQR: { type: String, default: '' },
  contact: {
    qq: { type: String, default: '' },
    wechat: { type: String, default: '' }
  },
  status: { type: String, enum: ['active', 'reserved', 'sold', 'removed'], default: 'active' },
  views: { type: Number, default: 0 },
  contactViews: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
marketItemSchema.index({ status: 1, category: 1, createdAt: -1 });
marketItemSchema.index({ title: 'text', description: 'text', productNo: 'text' });

const favoriteSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketItem', required: true },
  createdAt: { type: Date, default: Date.now }
});
favoriteSchema.index({ userId: 1, productId: 1 }, { unique: true });

const chatRoomSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketItem' },
  buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  lastMessage: String,
  lastMessageAt: Date,
  createdAt: { type: Date, default: Date.now }
});
chatRoomSchema.index({ productId: 1, buyerId: 1 }, { unique: true });

const messageSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatRoom', required: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const MarketItem = mongoose.models.MarketItem || mongoose.model('MarketItem', marketItemSchema);
const Favorite = mongoose.models.Favorite || mongoose.model('Favorite', favoriteSchema);
const ChatRoom = mongoose.models.ChatRoom || mongoose.model('ChatRoom', chatRoomSchema);
const Message = mongoose.models.Message || mongoose.model('Message', messageSchema); 

// ============ 举报和拉黑模型 ============
const reportSchema = new mongoose.Schema({
  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketItem' },
  reason: { type: String, required: true },
  status: { type: String, enum: ['pending', 'handled', 'dismissed'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const blockSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  blockedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now }
});
blockSchema.index({ userId: 1, blockedUserId: 1 }, { unique: true });

const Report = mongoose.models.Report || mongoose.model('Report', reportSchema);
const Block = mongoose.models.Block || mongoose.model('Block', blockSchema);
// ============ 购物车模型 ============
const cartSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketItem', required: true },
  createdAt: { type: Date, default: Date.now }
});
cartSchema.index({ userId: 1, productId: 1 }, { unique: true });

// ============ 二手市场订单模型 ============
const marketOrderSchema = new mongoose.Schema({
  orderNo: { type: String, required: true, unique: true },
  buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketItem', required: true },
  productNo: String,
  title: String,
  price: Number,
  address: {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    detail: { type: String, required: true }
  },
  status: { type: String, enum: ['pending', 'confirmed', 'shipped', 'completed', 'cancelled'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Cart = mongoose.models.Cart || mongoose.model('Cart', cartSchema);
const MarketOrder = mongoose.models.MarketOrder || mongoose.model('MarketOrder', marketOrderSchema);

const MARKET_CATEGORIES = ['book', 'electronic', 'life', 'other'];
const MARKET_ORDER_STATUS = ['pending', 'confirmed', 'shipped', 'completed', 'cancelled'];

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeMarketText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeMarketPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0 || price > 99999) return null;
  return Math.round(price * 100) / 100;
}

function normalizeMarketImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter(img => typeof img === 'string' && img.length <= 2 * 1024 * 1024 && /^data:image\/(png|jpe?g|webp);base64,/i.test(img))
    .slice(0, 5);
}

function normalizeMarketContact(contact = {}) {
  return {
    qq: normalizeMarketText(contact.qq, 40),
    wechat: normalizeMarketText(contact.wechat, 80)
  };
}

function normalizeQrImage(value) {
  if (value === '') return '';
  if (typeof value !== 'string') return null;
  if (value.length > 1024 * 1024) return null;
  return /^data:image\/(png|jpe?g|webp);base64,/i.test(value) ? value : null;
}

async function hasMarketBlockBetween(userA, userB) {
  if (!userA || !userB) return false;
  return !!(await Block.exists({
    $or: [
      { userId: userA, blockedUserId: userB },
      { userId: userB, blockedUserId: userA }
    ]
  }));
}

async function releaseMarketItemIfNoOpenOrders(productId) {
  const openOrder = await MarketOrder.exists({
    productId,
    status: { $in: ['pending', 'confirmed', 'shipped'] }
  });
  if (!openOrder) {
    await MarketItem.updateOne({ _id: productId, status: 'reserved' }, { status: 'active', updatedAt: new Date() });
  }
}


// 留言/反馈模型
const feedbackSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  content: { type: String, required: true },
  type: { type: String, enum: ['bug', 'suggestion', 'question', 'other'], default: 'other' },
  status: { type: String, enum: ['pending', 'read', 'replied', 'closed'], default: 'pending' },
  adminReply: { type: String, default: '' },
  repliedAt: { type: Date },
  repliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// ============ 支付订单模型 ============
const paymentOrderSchema = new mongoose.Schema({
  orderNo: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // 下单时冻结的用户快照：用户被物理删除后，后台仍能看到是谁下的单（TD-13，绝不显示空白）
  userStudentId: { type: String, default: '' },
  userName: { type: String, default: '' },
  userEmail: { type: String, default: '' },
  packageId: { type: String, default: '' },
  planCode: { type: String, default: '' },
  packageName: { type: String, default: '' },
  durationLabel: { type: String, default: '' },
  tier: { type: String, enum: membership.TIER_VALUES.concat(['COUNTS']), default: 'MONTHLY' },
  packageType: { type: String, enum: ['days', 'counts'], default: 'days' },
  amount: { type: Number, required: true },
  couponCode: { type: String, default: '' },
  couponDiscount: { type: Number, default: 0 },
  originalAmount: { type: Number, default: 0 },
  days: { type: Number, default: 0 },
  counts: { type: Number, default: 0 },
  times: { type: Number, default: 0 },
  cardCategory: { type: String, enum: ['days', 'times'], default: 'days' },
  payMethod: { type: String, enum: ['wechat', 'alipay'], default: 'wechat' },
  status: { type: String, enum: ['pending', 'claimed', 'paid', 'granted', 'expired', 'rejected'], default: 'pending' },
  reviewStatus: { type: String, enum: ['unreviewed', 'confirmed', 'rejected'], default: 'unreviewed' },
  paymentRef: { type: String, default: '' },
  claimNote: { type: String, default: '' },
  claimAt: Date,
  provider: { type: String, default: '' },
  mark: { type: String, default: '' },
  payCode: { type: String, default: '' },
  cardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Card' },
  expireAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  paidAt: Date,
  grantedAt: Date,
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  reviewNote: { type: String, default: '' },
  // 实收金额与订单金额不一致时的记录（按实际支付金额发放）
  actualAmount: { type: Number, default: 0 },
  amountMismatch: { type: Boolean, default: false },
  grantedPlanCode: { type: String, default: '' },
  // 实际开通的套餐快照（与下单时的套餐区分，后台表格按这个展示真实天数）
  grantedPackageName: { type: String, default: '' },
  grantedDays: { type: Number, default: 0 },
  grantedDurationLabel: { type: String, default: '' },
  revokedAt: Date
});

const PaymentOrder = mongoose.models.PaymentOrder || mongoose.model('PaymentOrder', paymentOrderSchema);

// 优惠码（管理后台可增删改/停用/限时/限次）
const couponSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  discount: { type: Number, required: true, default: 0 },
  label: { type: String, default: '' },
  active: { type: Boolean, default: true },
  validFrom: { type: Date, default: null },
  validUntil: { type: Date, default: null },
  maxUses: { type: Number, default: 0 },
  perUserLimit: { type: Number, default: 0 },
  note: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const Coupon = mongoose.models.Coupon || mongoose.model('Coupon', couponSchema);

const sponsorPackageSchema = new mongoose.Schema({
  packageId: { type: String, required: true, unique: true },
  planCode: { type: String, default: '' },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  pricePerYear: { type: Number, default: null },
  description: { type: String, default: '' },
  badge: { type: String, default: '' },
  type: { type: String, enum: ['days', 'counts'], default: 'days' },
  kind: { type: String, enum: ['days', 'grade'], default: 'days' },
  group: { type: String, enum: ['basic', 'pro', 'grade'], default: 'basic' },
  tier: { type: String, default: 'MONTHLY' },
  days: { type: Number, default: 0 },
  years: { type: Number, default: 0 },
  counts: { type: Number, default: 0 },
  audience: { type: String, default: '不限' },
  customTime: { type: Boolean, default: false },
  durationLabel: { type: String, default: '' },
  active: { type: Boolean, default: true },
  sort: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const SponsorPackage = mongoose.models.SponsorPackage || mongoose.model('SponsorPackage', sponsorPackageSchema);

const User = mongoose.models.User || mongoose.model('User', userSchema);
const Subscription = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);
const SignLog = mongoose.models.SignLog || mongoose.model('SignLog', signLogSchema);
const EmailCode = mongoose.models.EmailCode || mongoose.model('EmailCode', emailCodeSchema);
const Card = mongoose.models.Card || mongoose.model('Card', cardSchema);
const SystemConfig = mongoose.models.SystemConfig || mongoose.model('SystemConfig', systemConfigSchema);
const InviteLog = mongoose.models.InviteLog || mongoose.model('InviteLog', inviteLogSchema);
const Feedback = mongoose.models.Feedback || mongoose.model('Feedback', feedbackSchema);

// 微信上行消息反馈（用户在 WxPusher 公众号里发 "#145060 内容"）
const userFeedbackSchema = new mongoose.Schema({
  uid: { type: String, default: '', index: true },
  studentId: { type: String, default: '', index: true },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  source: { type: String, enum: ['wechat'], default: 'wechat' },
  // 管理端回复 / 延迟自动回复
  replied: { type: Boolean, default: false },
  replyContent: { type: String, default: '' },
  repliedAt: { type: Date, default: null },
  repliedBy: { type: String, default: '' },
  autoReplyDueAt: { type: Date, default: null },
  autoReplied: { type: Boolean, default: false },
  autoRepliedAt: { type: Date, default: null }
});
const UserFeedback = mongoose.models.UserFeedback || mongoose.model('UserFeedback', userFeedbackSchema);

const AUTO_SIGN_NAME = '自动签到';
const AUTO_SIGN_TIME = '21:35';
const AUTO_SIGN_CRON = '35 21 * * *';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'ag985211ag@qq.com';
const WXPUSHER_APP_ID = String(process.env.WXPUSHER_APP_ID || '145060').trim();
const DEFAULT_AUTO_SIGN_DAYS = [0, 1, 2, 3, 4, 5, 6];
const VIP_TIER_RANK = membership.TIER_RANK;

function applyVipTier(user, tier) {
  const normalized = membership.normalizeTier(tier);
  if (!membership.TIER_VALUES.includes(normalized)) return;
  if (membership.tierRank(normalized) >= membership.tierRank(user.vipTier)) {
    user.vipTier = normalized;
  }
  if (!user.vipStartAt) user.vipStartAt = new Date();
}

function addVipDays(user, days) {
  const now = new Date();
  const base = user.isVip && user.vipExpireAt && user.vipExpireAt > now ? new Date(user.vipExpireAt) : now;
  base.setDate(base.getDate() + Number(days || 0));
  user.isVip = true;
  user.vipExpireAt = base;
  if (!user.vipStartAt) user.vipStartAt = now;
  user.lastRenewalReminderDays = 0;
  user.lastRenewalReminderAt = null;
  return base;
}

function getGraduationDate(studentId) {
  return membership.graduationDate(studentId);
}

/** 兼容历史订单的套餐解析：优先用订单里快照的天数 */
function planForOrder(order) {
  if (!order) return null;
  const plan = membership.planForCode(order.packageId) || membership.planForTier(order.tier);
  if (!plan) return null;
  if (plan.kind === 'days' && Number(order.days) > 0 && Number(order.days) !== Number(plan.days)) {
    return { ...plan, days: Number(order.days) };
  }
  return plan;
}

/** 订单实际开通的套餐（金额不符改过套餐时以 grantedPlanCode 为准） */
function effectivePlanForOrder(order) {
  if (!order) return null;
  if (order.grantedPlanCode) {
    const p = membership.planForCode(order.grantedPlanCode) || membership.planForTier(order.grantedPlanCode);
    if (p) return p;
  }
  return planForOrder(order);
}

/** 该用户其它有效订单的贡献：最晚到期时间 + 最高等级（改套餐/撤销后重算时用作基点） */
async function computeOtherOrdersContribution(user, excludeOrderId) {
  const out = { expiry: null, bestTier: '' };
  try {
    const others = await PaymentOrder.find({
      userId: user._id,
      _id: { $ne: excludeOrderId },
      status: 'granted',
      revokedAt: null,
      reviewStatus: { $ne: 'rejected' }
    }).lean();
    for (const o of others) {
      const p = effectivePlanForOrder(o);
      if (!p) continue;
      const g = new Date(o.grantedAt || o.paidAt || o.createdAt || Date.now());
      const e = p.kind === 'grade'
        ? membership.computeExpireAt(p, user, g)
        : new Date(g.getTime() + Number(p.days || 0) * membership.DAY_MS);
      if (!out.expiry || e.getTime() > out.expiry.getTime()) out.expiry = e;
      if (!out.bestTier || membership.tierRank(p.tier) > membership.tierRank(out.bestTier)) out.bestTier = p.tier;
    }
  } catch (e) { /* ignore */ }
  return out;
}

/** 兼容旧调用 */
async function computeOtherOrdersExpiry(user, excludeOrderId) {
  const c = await computeOtherOrdersContribution(user, excludeOrderId);
  return c.expiry;
}

/**
 * 统一发放会员权益。
 * planOrTier 可以是套餐对象、套餐 code、或会员等级。
 * opts.expireAt 用于管理员自定义到期时间（仅支持自定义时间的套餐使用）。
 * opts.stack === false 可强制从当前时间重新计算（默认叠加：未到期会员的剩余天数不清零）。
 */
async function grantMembership(user, planOrTier, opts = {}) {
  const now = new Date();
  const plan = planOrTier && typeof planOrTier === 'object'
    ? planOrTier
    : (membership.planForCode(planOrTier) || membership.planForTier(planOrTier));

  // 体验会员升级/续费：剩余天数保留（叠加），身份标签改为实际购买的套餐
  const wasTrial = membership.isTrialMembership(user, now);
  const stackBase = (opts.stack === false)
    ? null
    : (user.isVip && user.vipExpireAt && new Date(user.vipExpireAt) > now ? new Date(user.vipExpireAt) : null);

  let expireAt;
  if (opts.expireAt) {
    expireAt = new Date(opts.expireAt);
  } else if (plan) {
    expireAt = membership.computeExpireAt(plan, user, now, stackBase);
  } else {
    const days = Number(opts.days || 0);
    const origin = stackBase || now;
    const grad = membership.graduationDate(user.studentId);
    expireAt = days > 0
      ? new Date(origin.getTime() + days * membership.DAY_MS)
      : (grad && grad > origin ? grad : new Date(origin.getTime() + 365 * membership.DAY_MS));
  }

  user.isVip = true;
  user.vipExpireAt = expireAt;
  if (!user.vipStartAt || wasTrial) user.vipStartAt = now;
  user.lastRenewalReminderDays = 0;
  user.lastRenewalReminderAt = null;
  if (wasTrial && plan && plan.tier) {
    user.vipTier = membership.normalizeTier(plan.tier); // 体验卡（学年卡 Pro 3 天）不再粘着标签
  } else {
    applyVipTier(user, plan ? plan.tier : planOrTier);
  }
  await user.save();
  await reconcileUserSignAccess(user).catch(() => {});
  return expireAt;
}

async function grantSponsorTier(user, tier, days) {
  const plan = membership.planForTier(tier);
  return grantMembership(user, plan || tier, { days });
}

async function revokeSponsorTier(user) {
  user.isVip = false;
  user.vipExpireAt = new Date(0);
  user.vipTier = 'FREE';
  user.lastRenewalReminderDays = 0;
  user.lastRenewalReminderAt = null;
  await user.save();
  await reconcileUserSignAccess(user).catch(() => {});
}

/** 给用户留一条站内通知（不发邮件），下次登录/打开仪表盘时弹出一次 */
function queueUserNotice(user, title, content, level = 'warning') {
  if (!user) return;
  if (!Array.isArray(user.notices)) user.notices = [];
  user.notices.push({
    title: String(title || '系统通知').slice(0, 120),
    content: String(content || '').slice(0, 800),
    level: String(level || 'warning'),
    createdAt: new Date()
  });
  if (user.notices.length > 20) user.notices = user.notices.slice(-20);
}

function userNoticeList(user) {
  if (!user || !Array.isArray(user.notices)) return [];
  return user.notices.slice(-20).map(n => ({
    title: n.title || '系统通知',
    content: n.content || '',
    level: n.level || 'warning',
    createdAt: n.createdAt || new Date()
  }));
}

function normalizeAutoSignDays(days) {
  const source = Array.isArray(days) && days.length > 0 ? days : DEFAULT_AUTO_SIGN_DAYS;
  const normalized = [...new Set(
    source
      .map(day => Number(day))
      .filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
  )].sort((a, b) => a - b);

  return normalized.length > 0 ? normalized : DEFAULT_AUTO_SIGN_DAYS;
}

function formatAutoSignSetting(setting) {
  return {
    id: setting?._id || null,
    _id: setting?._id || null,
    name: AUTO_SIGN_NAME,
    enabled: !!setting?.enabled,
    scheduleType: 'custom',
    customDays: setting ? normalizeAutoSignDays(setting.customDays) : DEFAULT_AUTO_SIGN_DAYS,
    signTime: setting?.signTime || AUTO_SIGN_TIME,
    maxRetries: 3,
    notifyOnSuccess: setting ? setting.notifyOnSuccess !== false : true,
    notifyOnFailure: setting ? setting.notifyOnFailure !== false : true,
    createdAt: setting?.createdAt || null,
    updatedAt: setting?.updatedAt || null
  };
}

async function getAutoSignSetting(userId) {
  return Subscription.findOne({ userId }).sort({ createdAt: 1 });
}

function isWithinSignWindow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const hour = Number((parts.find(p => p.type === 'hour') || {}).value);
  const minute = Number((parts.find(p => p.type === 'minute') || {}).value);
  return hour * 60 + minute >= 21 * 60 + 30;
}

function isSignTimeInWindow(value) {
  const t = normalizeSignTime(value);
  if (!t) return false;
  const [hour, minute] = t.split(':').map(Number);
  return hour * 60 + minute >= 21 * 60 + 30;
}

function normalizeSignTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
}

// 北京时间日期键（YYYY-MM-DD），用于每日打卡去重
function beijingDateKey(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => (parts.find(p => p.type === t) || {}).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// 每日打卡规则
const SIGN_CREDITS_CAP = 99;
const CHECKIN_BONUS_EVERY = 7;
const CHECKIN_BONUS_CREDITS = 2;

function canCustomSignTime(user) {
  return hasActiveVip(user) && membership.tierAllowsCustomTime(user && user.vipTier);
}

// ===== 会员权益变化时，同步自动签到订阅（开关 + 签到时间）=====
// 无签到权限 → 关闭自动签到（并记 autoDisabledBySystem，重新有权限时自动恢复）
// 无自定义时间权限 → 签到时间回落到默认 21:35
async function reconcileUserSignAccess(user) {
  const out = { disabled: 0, restored: 0, timeReset: 0 };
  if (!user || !user._id) return out;
  try {
    const access = hasAutoSignAccess(user);
    const canCustom = canCustomSignTime(user);
    const subs = await Subscription.find({ userId: user._id });
    for (const sub of subs) {
      let changed = false;
      if (!access) {
        if (sub.enabled) {
          sub.enabled = false;
          sub.autoDisabledBySystem = true;
          out.disabled++;
          changed = true;
        }
      } else if (!sub.enabled && sub.autoDisabledBySystem) {
        sub.enabled = true;
        sub.autoDisabledBySystem = false;
        out.restored++;
        changed = true;
      }
      if (!canCustom) {
        const t = normalizeSignTime(sub.signTime) || AUTO_SIGN_TIME;
        if (t !== AUTO_SIGN_TIME) {
          sub.signTime = AUTO_SIGN_TIME;
          out.timeReset++;
          changed = true;
        }
      }
      if (changed) { sub.updatedAt = new Date(); await sub.save(); }
    }
  } catch (e) { console.error('同步自动签到权限失败:', e.message); }
  return out;
}

// 批量校准（自然到期/历史遗留数据）：把没权限却还开着的自动签到关掉、把自定义时间打回默认
async function reconcileAllSignAccess() {
  const summary = { checked: 0, disabled: 0, restored: 0, timeReset: 0 };
  try {
    const subs = await Subscription.find({}).populate('userId');
    const seen = new Set();
    for (const sub of subs) {
      const user = sub.userId;
      if (!user || seen.has(String(user._id))) continue;
      seen.add(String(user._id));
      summary.checked++;
      const r = await reconcileUserSignAccess(user);
      summary.disabled += r.disabled;
      summary.restored += r.restored;
      summary.timeReset += r.timeReset;
    }
  } catch (e) { console.error('批量校准自动签到失败:', e.message); }
  return summary;
}

async function saveAutoSignSetting(userId, options = {}, targetId = null) {
  const query = targetId ? { _id: targetId, userId } : { userId };
  let setting = await Subscription.findOne(query).sort({ createdAt: 1 });

  if (!setting) {
    setting = new Subscription({ userId });
  }

  const user = await User.findById(userId).select('vipTier isVip vipExpireAt');
  const requestedTime = normalizeSignTime(options.signTime);
  const allowedCustom = canCustomSignTime(user) && isSignTimeInWindow(requestedTime);

  setting.name = AUTO_SIGN_NAME;
  setting.enabled = options.enabled !== false;
  setting.autoDisabledBySystem = false;
  setting.scheduleType = 'custom';
  setting.customDays = normalizeAutoSignDays(options.customDays);
  setting.signTime = allowedCustom ? requestedTime : AUTO_SIGN_TIME;
  setting.maxRetries = 3;
  setting.notifyOnSuccess = options.notifyOnSuccess !== false;
  setting.notifyOnFailure = options.notifyOnFailure !== false;
  setting.updatedAt = new Date();

  await setting.save();
  await Subscription.deleteMany({ userId, _id: { $ne: setting._id } });

  return setting;
}

// ============ 初始化系统配置 ============
async function initSystemConfig() {
  const defaults = [
    { 
      key: 'dashboard_notice', 
      value: { 
        enabled: true, 
        title: '📢 系统公告', 
        content: '欢迎使用智能考勤系统！邀请好友注册，双方各得 10 天会员！', 
        style: 'info' 
      } 
    },
    { key: 'email_template', value: { footer: 'AG工作室 · 智能考勤系统', website: 'https://login.agai.online' } },
    { key: 'invite_reward_days', value: 10 }
  ];
  
  for (const cfg of defaults) {
    const exists = await SystemConfig.findOne({ key: cfg.key });
    if (!exists) {
      await SystemConfig.create(cfg);
      console.log(`✅ 初始化配置: ${cfg.key}`);
    }
  }
  console.log('✅ 系统配置初始化完成');
}

// ============ JWT 配置 ============
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET 环境变量未设置！');
  process.exit(1);
}
const JWT_EXPIRE = '30d';
const ADMIN_CREDENTIALS = parseAdminCredentials(process.env.ADMIN_CREDENTIALS || '111:0101');

function parseAdminCredentials(rawValue) {
  return String(rawValue)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .reduce((credentials, item) => {
      const separatorIndex = item.indexOf(':');
      if (separatorIndex <= 0) return credentials;

      const account = item.slice(0, separatorIndex).trim();
      const password = item.slice(separatorIndex + 1);
      if (account && password) credentials.set(account, password);
      return credentials;
    }, new Map());
}

function timingSafeTextEqual(actual, expected) {
  const actualHash = crypto.createHash('sha256').update(String(actual || '')).digest();
  const expectedHash = crypto.createHash('sha256').update(String(expected || '')).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function isConfiguredAdminAccount(studentId) {
  return ADMIN_CREDENTIALS.has(String(studentId));
}

function validateAdminLogin(studentId, password) {
  const expectedPassword = ADMIN_CREDENTIALS.get(String(studentId));
  return Boolean(expectedPassword) && timingSafeTextEqual(password, expectedPassword);
}

// ============ 认证中间件 ============
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, message: '未登录' });
    }
    
    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, message: '令牌格式错误' });
    }
    
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId);
    
    if (!user) {
      return res.status(401).json({ success: false, message: '用户不存在' });
    }
    
    req.user = user;
    // 游客只能访问市场相关API，禁止访问签到系统
    if (user.studentId && user.studentId.startsWith('guest_')) {
      const allowedPaths = [
        '/api/market', '/api/user/payqr', '/api/quick-login',
        '/api/user/profile', '/api/feedback'
      ];
      const isAllowed = allowedPaths.some(p => req.path.startsWith(p));
      if (!isAllowed) {
        return res.status(403).json({ success: false, message: '游客无权访问此功能，请使用市场账号' });
      }
    }
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: '登录已过期' });
  }
};

const adminMiddleware = async (req, res, next) => {
  try {
    await authMiddleware(req, res, async () => {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: '需要管理员权限' });
      }
      next();
    });
  } catch (error) {
    res.status(401).json({ success: false, message: '未授权' });
  }
};

// ============ 会员权限 ============
function hasActiveVip(user) {
  if (!user || user.isVip !== true) return false;
  // 兼容历史永久 VIP：没有过期时间视为长期有效
  if (!user.vipExpireAt) return true;
  return new Date(user.vipExpireAt).getTime() > Date.now();
}

function requireActiveVip(req, res, next) {
  if (!hasActiveVip(req.user)) {
    return res.status(403).json({
      success: false,
      message: '自动签到为付费会员功能，请先开通或续费会员'
    });
  }
  next();
}

function hasSignAccess(user) {
  const credits = Number((user && user.signCredits) || 0);
  const creditsValid = credits > 0 && (!user.signCreditsExpireAt || new Date(user.signCreditsExpireAt).getTime() > Date.now());
  return hasActiveVip(user) || creditsValid;
}

function requireSignAccess(req, res, next) {
  if (!hasSignAccess(req.user)) {
    return res.status(403).json({
      success: false,
      code: 'SIGN_ACCESS_REQUIRED',
      message: '自动签到需要会员或次数卡；免费用户请使用手动签到'
    });
  }
  next();
}

// 自动签到只对「有效会员」开放（次数卡/打卡次数只能用于手动签到）
function hasAutoSignAccess(user) {
  return hasActiveVip(user);
}

function requireAutoSignAccess(req, res, next) {
  if (!hasAutoSignAccess(req.user)) {
    return res.status(403).json({
      success: false,
      code: 'AUTO_SIGN_REQUIRES_VIP',
      message: '自动签到是会员权益：你的会员已过期或被撤销，打卡次数只能用于手动签到。开通会员即可恢复自动签到。'
    });
  }
  next();
}

// ============ 邮箱配置（Resend API）============
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

async function sendVerificationCode(email, code) {
  if (!RESEND_API_KEY) {
    console.log('📧 Resend 未配置，验证码:', code);
    return false;
  }
  
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'AG工作室 <noreply@agai.online>',
        to: email,
        subject: '邮箱验证码 - AG工作室',
        html: `
          <div style="max-width: 450px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h1 style="color: #667eea; margin: 0;">📋 AG工作室</h1>
              <p style="color: #888; margin: 5px 0 0;">AG工作室</p>
            </div>
            <p style="font-size: 16px;">您的邮箱验证码是：</p>
            <div style="font-size: 36px; font-weight: bold; color: #667eea; padding: 20px; background: #f5f7fa; text-align: center; border-radius: 12px; letter-spacing: 5px;">
              ${code}
            </div>
            <p style="margin-top: 20px; color: #666;">验证码 5 分钟内有效，请勿泄露给他人。</p>
            
            <div style="margin-top: 24px; padding: 16px; background: linear-gradient(135deg, #667eea10 0%, #764ba210 100%); border-radius: 12px; text-align: center;">
              <p style="margin: 0 0 8px 0; font-weight: 600; color: #667eea;">🎉 邀请好友注册，双方各得 10 天会员</p>
              <p style="margin: 0 0 12px 0; font-size: 13px; color: #666;">享受签到邮件通知 · 邀请好友再送会员天数</p>
              <a href="https://login.agai.online" style="display: inline-block; padding: 8px 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; text-decoration: none; border-radius: 20px; font-size: 14px; font-weight: 500;">立即体验</a>
            </div>
            
            <hr style="margin: 24px 0; border: none; border-top: 1px solid #eee;">
            <p style="color: #999; font-size: 12px; text-align: center;">
              AG工作室 · 智能考勤系统<br>
              🌐 https://login.agai.online
            </p>
          </div>
        `
      })
    });
    
    if (response.ok) {
      console.log('✅ 验证码邮件发送成功:', email);
      return true;
    } else {
      const error = await response.text();
      console.error('❌ Resend 发送失败:', error);
      return false;
    }
  } catch (error) {
    console.error('❌ 发送邮件异常:', error);
    return false;
  }
}

// ============ 发送 VIP 到账邮件 ============
async function sendVipGrantEmail(user, addedDays, newExpireAt) {
  if (!RESEND_API_KEY) {
    console.log('📧 Resend 未配置，跳过 VIP 邮件');
    return false;
  }
  const p = getTierProfile(user);
  const expireDate = newExpireAt ? new Date(newExpireAt).toLocaleDateString('zh-CN') : '永久';
  return sendTierEmail(user, `🎉 ${p.label} 已到账 - AG工作室`, {
    title: '会员权益已到账',
    bodyHtml: `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:16px;color:#166534;font-size:14px;line-height:1.9;">
      <p style="margin:0 0 8px;">当前等级：<strong>${p.label}</strong></p>
      <p style="margin:0 0 8px;">增加天数：<strong>${addedDays} 天</strong></p>
      <p style="margin:0;">有效期至：<strong>${expireDate}</strong></p>
    </div>`,
    ctaText: '进入仪表盘',
    ctaUrl: 'https://login.agai.online',
    footerNote: '感谢你对 AG工作室 的信任与支持。'
  });
}

// 省 Resend 额度：只对管理员提醒省邮件；用户侧通知（成功/失败/权益变更）照常发邮件
const SIGN_SUCCESS_MAIL_ENABLED = String(process.env.SIGN_SUCCESS_MAIL_ENABLED || 'true') === 'true';

async function sendSignNotification(email, studentId, result, subscriptionName, signTime = null) {
  if (result && result.success && !SIGN_SUCCESS_MAIL_ENABLED) {
    console.log(`📧 签到成功通知已按省额度策略跳过: ${studentId}`);
    return false;
  }
  console.log(`📧 准备发送通知: email=${email}, studentId=${studentId}, success=${result.success}`);
  if (!RESEND_API_KEY) {
    console.log('📧 Resend 未配置，跳过通知');
    return false;
  }

  try {
    const user = await User.findOne({
      $or: [{ email: String(email || '') }, { studentId: String(studentId || '') }]
    }).select('studentId name email emailVerified vipTier isVip inviteCode');
    if (!user) {
      console.log('📧 未找到对应用户，跳过通知:', email, studentId);
      return false;
    }

    const p = getTierProfile(user);
    const statusText = result.success ? '成功' : '失败';
    const displayTime = signTime
      ? signTime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      : getBeijingTime();
    const color = result.success ? '#166534' : '#991b1b';
    const bg = result.success ? '#f0fdf4' : '#fef2f2';
    const border = result.success ? '#bbf7d0' : '#fecaca';

    return await sendTierEmail(user, `${result.success ? '✅' : '❌'} 签到${statusText}通知 - ${subscriptionName}`, {
      title: `签到${statusText}`,
      bodyHtml: `<div style="background:${bg};border:1px solid ${border};border-radius:12px;padding:16px;color:${color};font-size:14px;line-height:1.9;">
        <p style="margin:0 0 8px;">学号：<strong>${user.studentId || studentId}</strong></p>
        <p style="margin:0 0 8px;">任务：<strong>${subscriptionName}</strong></p>
        <p style="margin:0 0 8px;">时间：<strong>${displayTime}</strong></p>
        <p style="margin:0;">结果：<strong>${result.message || statusText}</strong></p>
      </div>`,
      ctaText: '查看签到记录',
      ctaUrl: 'https://login.agai.online',
      footerNote: '这是一封自动发送的签到通知邮件。'
    });
  } catch (error) {
    console.error('❌ 发送通知异常:', error.message);
    return false;
  }
}

// ============ 发送赞助者通知邮件（供管理员调用） ============
async function sendWelcomeEmail(user) {
  const p = getTierProfile(user);
  return sendTierEmail(user, '🎉 欢迎使用 AG 智能考勤', {
    title: '欢迎加入 AG 智能考勤',
    bodyHtml: `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;color:#334155;font-size:14px;line-height:1.9;">
      <p style="margin:0 0 8px;">你的账号已创建，当前等级：<strong>${p.label}</strong></p>
      <p style="margin:0 0 8px;">登录后可以手动签到、查看记录、设置自动签到和邮件提醒。</p>
      <p style="margin:0;">默认签到时间 21:35；学年卡 Pro 与大一/大二/大三学年卡可在自动签到页自定义时间。</p>
    </div>`,
    ctaText: '进入仪表盘',
    ctaUrl: 'https://login.agai.online/dashboard.html',
    footerNote: '如果这不是你本人操作，请忽略本邮件。'
  });
}

async function sendRenewalEmail(user, daysLeft) {
  const p = getTierProfile(user);
  const expireText = user.vipExpireAt ? new Date(user.vipExpireAt).toLocaleDateString('zh-CN') : '';
  return sendTierEmail(user, `⏰ ${p.label} ${daysLeft} 天后到期提醒`, {
    title: '续费提醒',
    bodyHtml: `<div style="background:#fff8e1;border:1px solid #fde68a;border-radius:12px;padding:16px;color:#92400e;font-size:14px;line-height:1.9;">
      <p style="margin:0 0 8px;">当前等级：<strong>${p.label}</strong></p>
      <p style="margin:0 0 8px;">到期日期：<strong>${expireText}</strong></p>
      <p style="margin:0;">还剩 <strong>${daysLeft}</strong> 天。续费后有效期按付款日重新计算，假期暂停不叠加。</p>
    </div>`,
    ctaText: '去续费',
    ctaUrl: 'https://login.agai.online/dashboard.html',
    footerNote: '续费提醒会在到期前 7 天和 1 天各发送一次。'
  });
}

async function checkRenewalReminders() {
  const now = new Date();
  const summary = { sent: 0, failed: 0, details: [] };
  for (const days of [7, 1]) {
    const start = new Date(now.getTime() + days * 24 * 3600 * 1000);
    const end = new Date(start.getTime() + 24 * 3600 * 1000);
    const users = await User.find({
      isVip: true,
      isGuest: { $ne: true },
      email: { $nin: [null, ''] },
      vipExpireAt: { $gte: start, $lt: end },
      lastRenewalReminderDays: { $ne: days }
    });
    for (const user of users) {
      try {
        const ok = await sendRenewalEmail(user, days);
        if (ok) {
          user.lastRenewalReminderDays = days;
          user.lastRenewalReminderAt = new Date();
          await user.save();
          summary.sent++;
          summary.details.push({ studentId: user.studentId, email: user.email, days, sent: true });
          console.log(`📧 续费提醒已发: ${user.studentId} (${days} 天)`);
        } else {
          summary.failed++;
          summary.details.push({ studentId: user.studentId, email: user.email, days, sent: false });
          console.error(`续费提醒发送失败 ${user.studentId} (${days} 天)`);
        }
      } catch (e) {
        summary.failed++;
        console.error(`续费提醒失败 ${user.studentId}:`, e.message);
      }
    }
  }
  return summary;
}
async function sendSponsorEmailToAllVips(notice) {
  if (!RESEND_API_KEY) {
    console.log('📧 Resend 未配置，跳过邮件群发');
    return;
  }
  const users = await User.find({ email: { $ne: '' }, isVip: true, isGuest: { $ne: true } })
    .select('email studentId name emailVerified vipTier isVip inviteCode');
  if (users.length === 0) {
    console.log('📧 没有符合条件的VIP用户');
    return;
  }

  const subject = `🎉 ${notice.title || 'AG工作室感谢您的赞助！'}`;
  const content = notice.content || '感谢您的支持，我们将继续努力！';

  let successCount = 0, failCount = 0;
  for (const user of users) {
    const sent = await sendTierEmail(user, subject, {
      title: notice.title || 'AG工作室感谢您的赞助',
      bodyHtml: `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;color:#334155;font-size:14px;line-height:1.9;">${String(content).replace(/\n/g, '<br>')}</div>`,
      ctaText: '登录官网',
      ctaUrl: 'https://login.agai.online',
      footerNote: '此邮件由管理员发送，感谢您的支持！'
    });
    if (sent) successCount++; else failCount++;
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`📧 赞助邮件群发完成：成功 ${successCount}，失败 ${failCount}`);
}

// ============ 调用 Python 签到脚本 ============
async function realSign(studentId, password, maxRetries = 3) {
  return new Promise((resolve) => {
    const pythonScript = path.join(__dirname, 'attendance_runner.py');
    const pythonProcess = spawn(PYTHON_BIN, [pythonScript], {
      cwd: __dirname,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      timeout: 60000  // 60秒超时
    });
    
    let output = '';
    let errorOutput = '';
    let isResolved = false;
    
    // 超时处理
    const timeout = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        pythonProcess.kill();
        console.error('⏰ Python 脚本执行超时');
        resolve({ success: false, message: '签到脚本执行超时', errors: ['执行超时'] });
      }
    }, 55000);  // 55秒超时
    
    pythonProcess.stdout.on('data', (data) => { 
      output += data.toString(); 
      console.log('Python stdout:', data.toString().substring(0, 200));
    });
    
    pythonProcess.stderr.on('data', (data) => { 
      errorOutput += data.toString();
      console.error('Python stderr:', data.toString());
    });
    
    pythonProcess.on('close', (code) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeout);
      
      console.log(`Python 进程退出，代码: ${code}`);
      console.log('Python stdout 长度:', output.length);
      console.log('Python stderr 长度:', errorOutput.length);
      
      if (code !== 0) {
        resolve({ success: false, message: '脚本执行失败', errors: [errorOutput || '未知错误'] });
        return;
      }
      try {
        const result = JSON.parse(output);
        resolve(result);
      } catch (e) {
        console.error('解析 Python 输出失败:', output.substring(0, 500));
        resolve({ success: false, message: '解析失败', errors: [output.substring(0, 200)] });
      }
    });
    
    pythonProcess.on('error', (err) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeout);
      console.error('Python 进程启动失败:', err);
      resolve({ success: false, message: '无法启动签到脚本', errors: [err.message] });
    });
    
    // 发送输入数据
    const inputData = JSON.stringify({
      action: 'sign_single',
      user: { studentId, password },
      maxRetries
    });
    
    console.log('发送给 Python 的数据:', inputData.substring(0, 100));
    pythonProcess.stdin.write(inputData);
    pythonProcess.stdin.end();
  });
}

// ============ 批量签到（新逻辑：一个进程处理一批用户，复用会话）============
const USE_SIGN_BATCH = process.env.SIGN_USE_BATCH !== 'false';

async function realSignBatch(users, maxRetries = 3) {
  return new Promise((resolve) => {
    const pythonScript = path.join(__dirname, 'attendance_runner.py');
    const pythonProcess = spawn(PYTHON_BIN, [pythonScript], {
      cwd: __dirname,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      timeout: 120000
    });
    let output = '';
    let errorOutput = '';
    let isResolved = false;
    const timeout = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        try { pythonProcess.kill(); } catch (e) {}
        resolve(users.map(u => ({ success: false, message: '批量签到脚本执行超时', studentId: u.studentId })));
      }
    }, 115000);
    pythonProcess.stdout.on('data', (data) => { output += data.toString(); });
    pythonProcess.stderr.on('data', (data) => { errorOutput += data.toString(); });
    pythonProcess.on('close', (code) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(output);
        if (parsed && parsed.success && Array.isArray(parsed.results)) resolve(parsed.results);
        else resolve(users.map(u => ({ success: false, message: parsed && parsed.message ? parsed.message : '批量签到无结果', studentId: u.studentId })));
      } catch (e) {
        console.error('解析批量签到输出失败:', output.substring(0, 300), errorOutput.substring(0, 300));
        resolve(users.map(u => ({ success: false, message: '批量签到解析失败', studentId: u.studentId })));
      }
    });
    pythonProcess.on('error', (err) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeout);
      resolve(users.map(u => ({ success: false, message: '无法启动签到脚本: ' + err.message, studentId: u.studentId })));
    });
    pythonProcess.stdin.write(JSON.stringify({ action: 'sign_batch', users, maxRetries, concurrency: 5 }));
    pythonProcess.stdin.end();
  });
}

// ============ 只验证密码（获取Token，不跑完整签到）============
async function verifyPassword(studentId, password) {
  return new Promise((resolve) => {
    const pythonScript = path.join(__dirname, 'attendance_runner.py');
    const pythonProcess = spawn(PYTHON_BIN, [pythonScript], {
      cwd: __dirname,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      timeout: 65000
    });
    
    let output = '';
    let errorOutput = '';
    let isResolved = false;
    
    const timeout = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        pythonProcess.kill();
        resolve({ success: false, message: '验证超时，请重试' });
      }
    }, 60000);
    
    pythonProcess.stdout.on('data', (data) => { output += data.toString(); });
    pythonProcess.stderr.on('data', (data) => { 
      errorOutput += data.toString();
      console.error('验证密码 stderr:', data.toString());
    });
    
    pythonProcess.on('close', (code) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeout);
      
      try {
        const result = JSON.parse(output);
        resolve({
          success: result.success === true,
          username: result.username || '',
          message: result.message || ''
        });
      } catch (e) {
        resolve({ success: false, message: '验证失败，请重试' });
      }
    });
    
    pythonProcess.on('error', (err) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeout);
      resolve({ success: false, message: '验证服务暂不可用' });
    });
    
    pythonProcess.stdin.write(JSON.stringify({
      action: 'verify',
      user: { studentId, password }
    }));
    pythonProcess.stdin.end();
  });
}

// ============ 自动签到执行函数 ============
// ============ 自动签到执行函数（并发优化版）============
async function sendAdminSignSummary(day = new Date()) {
  try {
    const dayDate = new Date(day);
    const start = new Date(dayDate); start.setHours(0, 0, 0, 0);
    const end = new Date(dayDate); end.setHours(23, 59, 59, 999);
    const autoUsers = await Subscription.countDocuments({ enabled: true });
    const autoTotal = await SignLog.countDocuments({ signTime: { $gte: start, $lte: end }, subscriptionName: AUTO_SIGN_NAME });
    const success = await SignLog.countDocuments({ signTime: { $gte: start, $lte: end }, subscriptionName: AUTO_SIGN_NAME, status: 'success' });
    const failed = await SignLog.countDocuments({ signTime: { $gte: start, $lte: end }, subscriptionName: AUTO_SIGN_NAME, status: 'failed' });
    const totalUsers = await User.countDocuments({ isGuest: { $ne: true } });
    const newUsers = await User.countDocuments({ isGuest: { $ne: true }, createdAt: { $gte: start, $lte: end } });
    const vipUsers = await User.countDocuments({ isGuest: { $ne: true }, isVip: true });
    const orders = await PaymentOrder.find({ createdAt: { $gte: start, $lte: end } }).lean();
    const orderRows = orders.length ? orders.map(o => '<p style="margin:2px 0;color:#334155;font-size:13px;">' + (o.payCode || o.orderNo || '') + ' · ' + (o.packageType === 'counts' ? ('次数卡 ' + (o.counts || 0) + ' 次') : ((o.tier || '') + ' ' + (o.days || 0) + ' 天')) + ' · ¥' + Number(o.amount || 0) + ' · ' + (o.status || '') + '</p>').join('') : '<p style="margin:0;color:#64748b;font-size:13px;">今日无赞助订单</p>';
    const failedLogs = await SignLog.find({ signTime: { $gte: start, $lte: end }, subscriptionName: AUTO_SIGN_NAME, status: 'failed' }).populate('userId').lean();
    const failRows = failedLogs.map(f => '<p style="margin:2px 0;color:#b42318;font-size:13px;">' + ((f.userId && f.userId.studentId) || '') + ' ' + ((f.userId && f.userId.name) || '') + '：' + (f.message || '未知原因') + '</p>').join('');
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(dayDate); d.setDate(d.getDate() - i);
      const ds = new Date(d); ds.setHours(0, 0, 0, 0);
      const de = new Date(d); de.setHours(23, 59, 59, 999);
      const s = await SignLog.countDocuments({ signTime: { $gte: ds, $lte: de }, subscriptionName: AUTO_SIGN_NAME, status: 'success' });
      const f = await SignLog.countDocuments({ signTime: { $gte: ds, $lte: de }, subscriptionName: AUTO_SIGN_NAME, status: 'failed' });
      trend.push({ label: d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }), s, f });
    }
    const trendRows = trend.map(x => '<p style="margin:2px 0;font-size:13px;color:#334155;">' + x.label + '　成功 ' + x.s + ' / 失败 ' + x.f + '</p>').join('');    const dateText = dayDate.toLocaleDateString('zh-CN');
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:20px;background:#f4f6f8;font-family:'Microsoft YaHei',Arial,sans-serif;"><div style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;"><div style="background:linear-gradient(135deg,#173b36,#245a52);padding:24px;color:#fff;"><h1 style="margin:0;font-size:20px;">${dateText} 今日签到汇总</h1><p style="margin:6px 0 0;opacity:.85;font-size:13px;">AG 智能考勤 · 管理员汇总</p></div><div style="padding:24px;color:#334155;font-size:14px;line-height:2;"><p style="margin:0;">自动签到用户：<strong>${autoUsers}</strong></p><p style="margin:0;">今日签到次数：<strong>${autoTotal}</strong></p><p style="margin:0;">成功：<strong style="color:#166534;">${success}</strong>　失败：<strong style="color:#b42318;">${failed}</strong></p><p style="margin:12px 0 0;color:#64748b;font-size:13px;">用户总数：<strong>${totalUsers}</strong>　今日新增：<strong>${newUsers}</strong>　付费用户：<strong>${vipUsers}</strong></p></div><div style="padding:16px 24px;border-top:1px solid #e2e8f0;"><h3 style="margin:0 0 8px;font-size:14px;color:#173b36;">今日赞助订单（${orders.length} 笔）</h3>${orderRows}</div><div style="padding:16px 24px;border-top:1px solid #e2e8f0;"><h3 style="margin:0 0 8px;font-size:14px;color:#173b36;">近 7 天趋势</h3>${trendRows}</div><div style="padding:16px 24px;border-top:1px solid #e2e8f0;"><h3 style="margin:0 0 8px;font-size:14px;color:#173b36;">签到失败明细</h3>${failRows || '<p style="margin:0;color:#64748b;font-size:13px;">无失败记录</p>'}</div></div></body></html>`;
    const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'AG工作室 <noreply@agai.online>', to: ADMIN_EMAIL, subject: `📊 ${dateText} 今日签到汇总 · 成功 ${success} / 失败 ${failed}`, html }) });
    console.log(`📊 管理员汇总邮件: ${res.ok ? '已发送' : '发送失败'} (成功 ${success} / 失败 ${failed})`);
    // 同步推送到微信/Webhook 渠道（邮件已单独发送，这里不再重复发邮件）
    try {
      const topFails = failedLogs.slice(0, 8).map(f => `· ${(f.userId && f.userId.studentId) || ''} ${(f.userId && f.userId.name) || ''}：${(f.message || '').slice(0, 60)}`).join('\n');
      const plain = [
        `${dateText} 签到汇总`,
        `自动签到用户：${autoUsers} 人`,
        `签到次数：${autoTotal} 次（成功 ${success} / 失败 ${failed}）`,
        `用户总数：${totalUsers}（今日新增 ${newUsers}，付费 ${vipUsers}）`,
        `赞助订单：${orders.length} 笔`,
        failed ? `失败明细：\n${topFails}` : '失败明细：无'
      ].join('\n');
      await notifyAdmin(`📊 ${dateText} 签到汇总 · 成功 ${success} / 失败 ${failed}`,
        html, plain, { email: false }).catch(() => {});
    } catch (e) { console.error('汇总推送失败:', e.message); }
    return res.ok === true;
  } catch (e) { console.error('管理员汇总邮件失败:', e.message); return false; }
}
async function maybeSendAdminSignSummary(day = new Date(), opts = {}) {
  const force = !!(opts && opts.force);
  try {
    const dayKey = day.toLocaleDateString('zh-CN');
    const sentCfg = await SystemConfig.findOne({ key: 'admin_summary_sent_date' });
    if (sentCfg && sentCfg.value === dayKey) return;
    const start = new Date(day); start.setHours(0, 0, 0, 0);
    const end = new Date(day); end.setHours(23, 59, 59, 999);
    const subs = await Subscription.find({ enabled: true }).select('userId').lean();
    const uniqueIds = [...new Set(subs.map(s => String(s.userId)))];
    if (!uniqueIds.length) return;
    const logs = await SignLog.find({
      userId: { $in: uniqueIds.map(id => new mongoose.Types.ObjectId(id)) },
      signTime: { $gte: start, $lte: end }
    }).select('userId').lean();
    const done = new Set(logs.map(l => String(l.userId)));
    const allDone = uniqueIds.every(id => done.has(id));
    if (!allDone && !force) return;
    const ok = await sendAdminSignSummary(day);
    if (ok === false) { console.error('管理员汇总发送失败，未写去重标记'); return; }
    let cfg = await SystemConfig.findOne({ key: 'admin_summary_sent_date' });
    if (!cfg) cfg = new SystemConfig({ key: 'admin_summary_sent_date', value: dayKey });
    else { cfg.value = dayKey; cfg.updatedAt = new Date(); }
    await cfg.save();
    console.log('📊 管理员汇总已发送（所有人已完成）: ' + dayKey);
  } catch (e) { console.error('管理员汇总判断失败:', e.message); }
}
// ============ 单个用户签到结果 → 微信通知（仅绑定了 WxPusher 的用户）============
// 原则：发送失败只记日志，绝不影响签到主流程
// 失败原因分类：给用户「可执行的下一步」，不要只丢一句"签到失败"
function classifySignFailure(reason) {
  const r = String(reason || '');
  if (/密码|口令|学号或密码|账号不正确|password|auth|unauthor|登录失败|未登录/i.test(r)) {
    return {
      summary: '签到失败 · 账号或密码错误',
      content: '❌ 签到失败：学号或密码不正确。\n请到 AG 考勤后台「设置」检查并修改签到密码，改好后会自动重试。'
    };
  }
  if (/超时|timeout|网络|ECONN|ETIMEDOUT|ENOTFOUND|socket|学校|502|503|504|网关|服务不可用|连接/i.test(r)) {
    return {
      summary: '签到失败 · 学校系统异常',
      content: '❌ 签到失败：学校系统暂时无法访问（不是你的问题）。\n系统会自动重试；如果仍然失败，请手动签到一次。'
    };
  }
  return {
    summary: '签到失败 · 系统异常',
    content: '❌ 签到失败：系统处理异常，已记录日志并通知管理员。\n你可以稍后重试或手动签到。'
  };
}

// ============ 单个用户签到结果 → 按用户偏好分发（微信优先，邮件兜底）============
// 矩阵见 notificationPrefs.buildNotificationPlan：
//   failure_only + 成功 → 不发；always + 成功 → 按渠道发；失败 → 按渠道发
// 原则：发送失败只记日志，绝不影响签到主流程
async function dispatchSignResultNotification(user, success, reason, opts = {}) {
  const out = { plan: null, description: '', sent: [], skipped: null, dryRun: !!opts.dryRun };
  try {
    if (!user) { out.skipped = 'no_user'; return out; }
    out.plan = notifyPrefs.buildNotificationPlan(user, success, opts.overrides);
    out.description = notifyPrefs.describePlan(out.plan);
    if (!out.plan.send) { out.skipped = out.plan.reason; return out; }

    const label = opts.label || '自动签到';
    const signTime = opts.signTime || new Date();
    const msg = success
      ? wxpusher.signResultMessage({ studentId: user.studentId, success: true })
      : classifySignFailure(reason);
    out.message = msg;

    if (opts.dryRun) {
      out.wouldSend = out.plan.channels.map(channel => ({ channel, summary: msg.summary, content: msg.content }));
      return out;
    }

    // 1) 微信（有就先用，免费且即时）
    let wechatOk = false;
    if (out.plan.channels.includes('wechat')) {
      try {
        const cfg = await getWxpusherConfig();
        if (!cfg.appToken) {
          out.sent.push({ channel: 'wechat', ok: false, message: '服务端未配置 WxPusher AppToken' });
        } else {
          const r = await wxpusher.sendToUid(cfg.appToken, user.wxpusherUid, msg.summary, msg.content);
          wechatOk = !!r.ok;
          out.sent.push({ channel: 'wechat', ok: wechatOk, message: r.ok ? 'ok' : (r.message || '发送失败') });
          if (!r.ok) console.error(`WxPusher 通知失败 ${user.studentId}: ${r.message}`);
        }
      } catch (e) {
        console.error('WxPusher 通知异常:', e.message);
        out.sent.push({ channel: 'wechat', ok: false, message: e.message });
      }
    }

    // 2) 邮件：只在微信没成功（未开微信 / 未配置 / 发送失败）时兜底，省 Resend 额度
    if (out.plan.channels.includes('email') && !wechatOk) {
      try {
        const emailResult = success
          ? { success: true, message: '签到成功' }
          : { success: false, message: msg.summary };
        const ok = await sendSignNotification(user.email, user.studentId, emailResult, label, signTime);
        out.sent.push({ channel: 'email', ok: !!ok, message: ok ? 'ok' : '邮件未发送（未配置 Resend / 发送失败 / 省额度策略）' });
        if (!ok) console.error(`邮件通知未送达 ${user.studentId}`);
      } catch (e) {
        console.error('邮件通知异常:', e.message);
        out.sent.push({ channel: 'email', ok: false, message: e.message });
      }
    }
  } catch (e) {
    console.error('签到结果通知异常:', e.message);
    out.skipped = 'dispatch_error';
  }
  return out;
}

// ============ 单个用户签到失败 → 立刻推送管理员（带防刷屏保护）============
const SIGN_FAIL_PUSH = { limit: 15, count: 0, bulkSent: false };
function resetSignFailPush() { SIGN_FAIL_PUSH.count = 0; SIGN_FAIL_PUSH.bulkSent = false; }

async function notifySignFailure(user, reason, label = '自动签到') {
  try {
    if (!user) return;
    if (SIGN_FAIL_PUSH.bulkSent) return;
    SIGN_FAIL_PUSH.count++;
    if (SIGN_FAIL_PUSH.count > SIGN_FAIL_PUSH.limit) {
      SIGN_FAIL_PUSH.bulkSent = true;
      const plain = `已有超过 ${SIGN_FAIL_PUSH.limit} 人签到失败，可能是学校系统或网络异常。\n后续单人提醒已暂停，请到后台「签到管理」查看明细。`;
      await notifyAdmin(`⚠️ 批量签到失败（>${SIGN_FAIL_PUSH.limit} 人）`,
        `<div style="font-family:sans-serif;line-height:1.9;color:#334155"><p>${plain.replace(/\n/g, '<br>')}</p></div>`,
        plain, { email: true, emailFallback: false });
      return;
    }
    const timeText = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const plain = `学号：${user.studentId}\n姓名：${user.name || ''}\n场景：${label}\n原因：${reason || '未知'}\n时间：${timeText}`;
    await notifyAdmin(`❌ 签到失败 · ${user.name || user.studentId} ${user.studentId}`,
      `<div style="font-family:sans-serif;line-height:1.9;color:#334155"><p>学号：<strong>${user.studentId}</strong>　姓名：${user.name || ''}</p><p>场景：${label}</p><p>原因：<strong>${reason || '未知'}</strong></p><p>时间：${timeText}</p><p><a href="https://login.agai.online/admin.html">打开后台处理</a></p></div>`,
      plain, {});
  } catch (e) { console.error('签到失败推送异常:', e.message); }
}

async function executeAutoSign(options = {}) {
  const paused = await SystemConfig.findOne({ key: 'auto_sign_paused' });
  if (paused && paused.value === true) { console.log('⏸️ 假期暂停自动签到'); return; }
  const targetTime = normalizeSignTime(options.targetTime);
  const planTime = targetTime || AUTO_SIGN_TIME;
  console.log('⏰ 自动签到任务开始:', getBeijingTime());
  resetSignFailPush();
  
  if (!MONGODB_URI) {
    console.log('⚠️ 数据库未连接');
    return;
  }
  
  try {
    const today = new Date();
    const dayOfWeek = today.getDay();
    
    const subscriptions = await Subscription.find({ enabled: true }).populate('userId');
    
    // 区分「默认 21:35 批次」和「自定义时间批次」：
    // 旧的 targetTime 判断会把无自定义时间权限的月卡/学期卡/学年卡/LEGACY 全部排除，
    // 导致 21:35 主批次只剩 Pro/年级卡用户（2026-11-03 的 43→3 事故）。
    const isCustomTimeRun = !!targetTime && targetTime !== AUTO_SIGN_TIME;
    // 筛选今天需要签到的订阅
    const todaySubscriptions = subscriptions.filter(sub => {
      const subTime = normalizeSignTime(sub.signTime) || AUTO_SIGN_TIME;
      return isSubscriptionDueToday({
        subTime,
        planTime,
        scheduleType: sub.scheduleType,
        customDays: sub.customDays,
        dayOfWeek,
        isCustomTimeRun,
        canCustomTime: isCustomTimeRun ? canCustomSignTime(sub.userId) : true
      });
    });
    
    // 按用户分组
    const userMap = new Map();
    let skippedNonVip = 0;
    for (const sub of todaySubscriptions) {
      const user = sub.userId;
      if (user && user.isActive !== false) {
        // 自动签到仅对有效付费会员开放；手动签到不受此限制
        if (!hasAutoSignAccess(user)) {
          skippedNonVip++;
          continue;
        }
        if (!userMap.has(user._id.toString())) {
          userMap.set(user._id.toString(), { user, subscriptions: [] });
        }
        userMap.get(user._id.toString()).subscriptions.push(sub);
      }
    }
    
    if (skippedNonVip > 0) {
      console.log(`⏭️ 跳过 ${skippedNonVip} 个非有效VIP用户`);
    }
    const userArray = Array.from(userMap.entries());
    console.log(`📊 今天需要签到: ${userArray.length} 个用户`);

    if (AUTO_SIGN_DRY_RUN) {
      console.log(`🧪 dry-run: 命中 ${userArray.length} 个有效VIP用户，跳过实际签到`);
      return;
    }
    
    // 并发处理：每批 5 个用户同时签到
    const CONCURRENCY = 5;
    
    for (let i = 0; i < userArray.length; i += CONCURRENCY) {
      const batch = userArray.slice(i, i + CONCURRENCY);
      
      console.log(`🔄 处理第 ${Math.floor(i / CONCURRENCY) + 1} 批，共 ${batch.length} 人`);
      
        // 先排除今天已成功的用户，再整批交给新 runner 处理
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);
        const batchUserIds = batch.map(([userId]) => userId);
        const existingBatch = await SignLog.find({
          userId: { $in: batchUserIds },
          status: 'success',
          signTime: { $gte: todayStart, $lte: todayEnd }
        }).select('userId').lean();
        const alreadySigned = new Set(existingBatch.map(e => String(e.userId)));
        const pendingBatch = batch.filter(([userId]) => !alreadySigned.has(String(userId)));
        let batchResults = new Map();
        if (pendingBatch.length > 0) {
          const batchInput = pendingBatch.map(([userId, data]) => ({
            studentId: data.user.studentId,
            password: data.user.attendancePassword || 'Ahgydx@920'
          }));
          const results = USE_SIGN_BATCH
            ? await realSignBatch(batchInput, 3)
            : await Promise.all(batchInput.map(u => realSign(u.studentId, u.password, 3)));
          results.forEach((r, i) => {
            const sid = String((r && r.studentId) || batchInput[i].studentId);
            batchResults.set(sid, r);
          });
        }

        await Promise.allSettled(
      batch.map(async ([userId, data]) => {
        const { user, subscriptions } = data;
        
        try {
          const existingLog = await SignLog.findOne({
            userId: user._id,
            status: 'success',
            signTime: { $gte: todayStart, $lte: todayEnd }
          });
    
          if (existingLog) {
            console.log(`⏭️ ${user.studentId} 今天已签到，跳过`);
            return;
          }
    
          console.log(`🔄 签到: ${user.studentId}`);
          
          const signTime = new Date();
          const signResult = batchResults.get(String(user.studentId)) || { success: false, message: '未执行签到' };
          
          // 更新用户统计
          user.totalSignCount = (user.totalSignCount || 0) + 1;
          if (signResult.success) {
            user.successSignCount = (user.successSignCount || 0) + 1;
            if (!hasActiveVip(user) && Number(user.signCredits || 0) > 0) {
              user.signCredits = Math.max(0, Number(user.signCredits) - 1);
            }
          }
          await user.save();
          
          // 记录签到日志
          for (const sub of subscriptions) {
            const log = new SignLog({
              userId: user._id,
              subscriptionId: sub._id,
              subscriptionName: sub.name,
              status: signResult.success ? 'success' : 'failed',
              message: signResult.message || '',
              signTime: signTime
            });
            await log.save();
          }
          
          // 会员到期自动降级（保留重构前的副作用；通知统一由下面分发）
          const now = new Date();
          if ((user.isVip || Number(user.signCredits || 0) > 0) && user.emailVerified && user.email
              && user.isVip && !(user.vipExpireAt && user.vipExpireAt > now)) {
            user.isVip = false;
            await user.save();
          }
          
          console.log(`✅ ${user.studentId}: ${signResult.success ? '成功' : '失败'}`);
          if (!signResult.success) {
            await notifySignFailure(user, signResult.message || '签到接口返回失败', '自动签到');
          }
          // 签到结果通知：按用户偏好矩阵分发（微信优先、邮件兜底），不 await，绝不拖慢/拖垮签到
          dispatchSignResultNotification(user, signResult.success, signResult.message, {
            label: subscriptions.map(s => s.name).join(', ') || '自动签到',
            signTime
          }).catch(() => {});
          
        } catch (error) {
          console.error(`❌ ${data.user.studentId}:`, error.message);
        }
      })
    );
      
      // 每批之间间隔 3 秒，避免服务器压力过大
      if (i + CONCURRENCY < userArray.length) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
    
    console.log('✅ 自动签到任务完成');
    
  } catch (error) {
    console.error('❌ 定时任务错误:', error);
  }
  await maybeSendAdminSignSummary();
}

// ============ 自动签到失败兜底：自动补签 + 原因分类 + 通知 ============
function beijingMinutesNow() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const h = Number((parts.find(p => p.type === 'hour') || {}).value || 0);
  const m = Number((parts.find(p => p.type === 'minute') || {}).value || 0);
  return h * 60 + m;
}

async function retryMissingSigns(label = '补签') {
  const result = { label, checked: 0, recovered: 0, failed: 0, passwordIssues: [], details: [], skipped: null };
  try {
    if (!isWithinSignWindow()) { result.skipped = '不在签到窗口内（21:30–24:00）'; return result; }
    resetSignFailPush();
    const nowMin = beijingMinutesNow();
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);
    const subs = await Subscription.find({ enabled: true }).populate('userId');
    const seen = new Set();
    for (const sub of subs) {
      const user = sub.userId;
      if (!user || user.isActive === false) continue;
      if (seen.has(String(user._id))) continue;
      seen.add(String(user._id));
      if (!hasAutoSignAccess(user)) continue;
      const subTime = normalizeSignTime(sub.signTime) || AUTO_SIGN_TIME;
      const [h, m] = subTime.split(':').map(Number);
      if (h * 60 + m > nowMin) continue; // 还没到他的签到时间，先不补
      const okLog = await SignLog.findOne({ userId: user._id, signTime: { $gte: start, $lte: end }, status: 'success' });
      if (okLog) continue;
      result.checked++;
      let attempt = null;
      for (let i = 0; i < 3; i++) {
        try { attempt = await realSign(user.studentId, user.attendancePassword || 'Ahgydx@920', 2); }
        catch (e) { attempt = { success: false, message: e.message }; }
        if (attempt && attempt.success) break;
        await new Promise(r => setTimeout(r, 1500));
      }
      const success = !!(attempt && attempt.success);
      const msg = (attempt && attempt.message) || '补签未返回结果';
      try {
        await SignLog.create({ userId: user._id, subscriptionName: AUTO_SIGN_NAME, status: success ? 'success' : 'failed', message: `补签(${label}): ${msg}`, signTime: new Date() });
      } catch (e) { console.error('补签日志写入失败:', e.message); }
      user.totalSignCount = Number(user.totalSignCount || 0) + 1;
      if (success) user.successSignCount = Number(user.successSignCount || 0) + 1;
      try { await user.save(); } catch (e) {}
      if (success) { result.recovered++; continue; }
      result.failed++;
      const passwordIssue = /密码|password|错误/i.test(msg);
      if (passwordIssue) result.passwordIssues.push(user.studentId);
      result.details.push({ studentId: user.studentId, name: user.name || '', message: msg, passwordIssue });
      await notifySignFailure(user, msg, `补签(${label})`);
      if (user.email) {
        try {
          await sendTierEmail(user, `⚠️ 今晚自动签到未成功${passwordIssue ? '（考勤密码可能错误）' : ''}`, {
            title: '自动签到未成功',
            bodyHtml: `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:16px;color:#991b1b;font-size:14px;line-height:1.9;">
              <p style="margin:0 0 8px;">学号：<strong>${user.studentId}</strong></p>
              <p style="margin:0 0 8px;">原因：<strong>${msg}</strong></p>
              <p style="margin:0;">${passwordIssue ? '你的考勤密码可能不正确：请登录学校考勤系统确认密码，在网站更新后手动签到补签。' : '请稍后手动签到补签，或联系管理员处理。'}</p>
            </div>`,
            ctaText: '去手动补签',
            ctaUrl: 'https://login.agai.online/dashboard.html',
            footerNote: '该邮件由系统自动发送（自动签到失败兜底提醒）。'
          });
        } catch (e) {}
      }
    }
    if (result.failed > 0) {
      const rows = result.details.map(d => `<li>${d.studentId} ${d.name}：${d.message}${d.passwordIssue ? '（密码问题）' : ''}</li>`).join('');
      const plain = result.details.map(d => `${d.studentId} ${d.name}：${d.message}${d.passwordIssue ? '（密码问题）' : ''}`).join('\n');
      await notifyAdmin(`【补签提醒】${result.failed} 人自动签到未成功（${label}）`,
        `<div style="font-family:sans-serif;font-size:14px;color:#334155;line-height:1.9;"><p>补签时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（${label}）</p><p>检查 ${result.checked} 人，补签成功 ${result.recovered} 人，仍失败 ${result.failed} 人。</p><ul>${rows}</ul></div>`,
        `检查 ${result.checked} 人，补签成功 ${result.recovered} 人，仍失败 ${result.failed} 人\n` + plain);
    }
    console.log(`🔁 自动签到兜底(${label}): 检查 ${result.checked}，补回 ${result.recovered}，失败 ${result.failed}`);
  } catch (e) { console.error('补签任务失败:', e.message); }
  return result;
}

// ============ API 路由 ============
// ========== 植物工厂数据接口 ==========

// 1. ESP8266 上传传感器数据 + AI 结果
app.post('/api/plant/data', async (req, res) => {
    try {
        const data = await PlantData.create(req.body);
        console.log('✅ 收到植物数据:', req.body.temperature + '°C');
        res.json({ success: true, id: data._id });
    } catch (err) {
        console.error('❌ 存储失败:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. 前端拉取最新一条数据
app.get('/api/plant/data', async (req, res) => {
    try {
        const data = await PlantData.findOne().sort({ createdAt: -1 });
        if (!data) return res.json({ error: '暂无数据' });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. 前端拉取历史数据（图表用，默认最近100条）
app.get('/api/plant/data/history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const data = await PlantData.find()
            .sort({ createdAt: -1 })
            .limit(limit)
            .select('temperature humidity light air_quality health_score createdAt');
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



// 5. ESP8266 轮询拉取待执行的控制指令
app.get('/api/plant/control/pending', async (req, res) => {
    try {
        const cmd = await ControlCmd.findOneAndUpdate(
            { status: 'pending' },
            { status: 'executed' },
            { sort: { createdAt: 1 }, new: true }
        );
        if (!cmd) return res.json({ hasCommand: false });
        res.json({ hasCommand: true, command: cmd });
    } catch (err) {
        res.status(500).json({ hasCommand: false, error: err.message });
    }
});


app.get('/health', (req, res) => {
  const dbStates = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  const db = dbStates[mongoose.connection.readyState] || 'unknown';
  const ok = mongoose.connection.readyState === 1;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'healthy' : 'degraded',
    db,
    autoSignTime: AUTO_SIGN_TIME,
    version: '3.6.0',
    time: getBeijingTime()
  });
});

app.get('/', (req, res) => {
  // 根路径：官网域名（agai.online / www）返回 AG 工作室页面；其它域名（login 等）返回登录页
  const host = String(req.hostname || '').toLowerCase();
  const studioFile = path.join(__dirname, 'public', 'studio.html');
  if ((host === 'agai.online' || host === 'www.agai.online') && fs.existsSync(studioFile)) {
    return res.sendFile(studioFile);
  }
  const indexFile = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  res.json({ status: 'running', version: '3.5.0', emailService: RESEND_API_KEY ? 'Resend' : '未配置' });
});

// 3. 接收Web端控制指令，暂存后由ESP8266轮询拉取（或直接透传）
app.post('/api/plant/control', async (req, res) => {
    try {
        // 这里先返回成功，后续可对接ESP8266
        console.log('🔧 收到控制指令:', JSON.stringify(req.body));
        res.json({ success: true, message: '指令已收到' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. 接收模式切换指令
app.post('/api/plant/mode', async (req, res) => {
    try {
        console.log('🔧 收到模式切换:', JSON.stringify(req.body));
        res.json({ success: true, message: '模式已切换' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// ============ 快速登录（无需考勤系统）============
app.post('/api/quick-login', async (req, res) => {
  try {
    const { nickname } = req.body;
    
    if (!nickname || nickname.trim().length < 2) {
      return res.status(400).json({ success: false, message: '昵称至少2个字符' });
    }
    
    if (!MONGODB_URI) {
      return res.status(503).json({ success: false, message: '数据库未配置' });
    }
    
    // 生成一个虚拟学号
    let guestId = 'guest_' + crypto.randomBytes(6).toString('hex');
    
    // 确保不重复
    let user = await User.findOne({ studentId: guestId });
    while (user) {
      guestId = 'guest_' + crypto.randomBytes(6).toString('hex');
      user = await User.findOne({ studentId: guestId });
    }
    
    // 生成邀请码
    let inviteCode;
    let isUnique = false;
    while (!isUnique) {
      inviteCode = generateInviteCode(8);
      const existing = await User.findOne({ inviteCode });
      if (!existing) isUnique = true;
    }
    
    user = new User({
      studentId: guestId,
      name: nickname.trim(),
      role: 'user',
      isGuest: true,
      source: 'market',
      inviteCode,
      lastLogin: new Date()
    });
    await user.save();
    
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: JWT_EXPIRE });
    
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        studentId: user.studentId,
        name: user.name,
        email: '',
        emailVerified: false,
        isVip: false,
        vipExpireAt: null,
        vipTier: 'FREE',
        vipStartAt: null,
        role: 'user',
        inviteCode: user.inviteCode,
        totalSignCount: 0,
        successSignCount: 0
      }
    });
  } catch (error) {
    console.error('快速登录错误:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
// ============ 登录 ============
app.post('/api/login', async (req, res) => {
  try {
    const { studentId, attendancePassword } = req.body;
    if (studentId && studentId.startsWith('guest_')) {
      return res.status(403).json({ success: false, message: '市场游客请通过二手市场登录' });
    }
    if (!studentId) {
      return res.status(400).json({ success: false, message: '请输入学号' });
    }
    
    if (!MONGODB_URI) {
      return res.status(503).json({ success: false, message: '数据库未配置' });
    }
    let verifyResult = null;
    const isAdminAccount = isConfiguredAdminAccount(studentId);

    if (isAdminAccount) {
      if (!attendancePassword) {
        return res.status(400).json({
          success: false,
          message: '请输入管理员密码'
        });
      }

      if (!validateAdminLogin(studentId, attendancePassword)) {
        return res.status(401).json({
          success: false,
          message: '管理员账号或密码错误'
        });
      }
    } else {
      // ========== 普通用户验证 ==========
      
      // 密码必填
      if (!attendancePassword) {
        return res.status(400).json({ 
          success: false, 
          message: '请输入考勤密码' 
        });
      }
      
      // 只验证密码是否正确（不跑完整签到流程）
       verifyResult = await verifyPassword(studentId, attendancePassword);
      
      console.log('密码验证结果:', JSON.stringify(verifyResult));
      
      if (!verifyResult.success) {
        return res.status(401).json({ 
          success: false, 
          message: verifyResult.message || '学号或密码错误' 
        });
      }
    }
    
    // ========== 验证通过，继续登录 ==========
    let user = await User.findOne({ studentId });
    
    if (!user) {
      let inviteCode;
      let isUnique = false;
      while (!isUnique) {
        inviteCode = generateInviteCode(8);
        const existing = await User.findOne({ inviteCode });
        if (!existing) isUnique = true;
      }
      
      // 获取 Python 验证返回的真实姓名（verifyResult 在普通用户验证时已赋值）
      const realName = (verifyResult?.username) || studentId;
      
      const userData = { 
        studentId,
        name: realName,
        inviteCode,
        lastLogin: new Date(),
        isVip: true,
        vipTier: 'YEARLY_PRO',
        vipStartAt: new Date(),
        vipExpireAt: new Date(Date.now() + 3 * 24 * 3600 * 1000)
      };

      if (isAdminAccount) {
        userData.role = 'admin';
      } else {
        userData.attendancePassword = attendancePassword || 'Ahgydx@920';
      }
      user = new User(userData);
      await user.save();
    } else {
      // 老用户：如果之前没存真实姓名，现在补上
      if (verifyResult?.username && (!user.name || user.name === user.studentId)) {
        user.name = verifyResult.username;
      }
      user.lastLogin = new Date();
      if (isAdminAccount) {
        user.role = 'admin';
      } else if (attendancePassword) {
        user.attendancePassword = attendancePassword;
      }
      if (!user.inviteCode) {
        let inviteCode;
        let isUnique = false;
        while (!isUnique) {
          inviteCode = generateInviteCode(8);
          const existing = await User.findOne({ inviteCode });
          if (!existing) isUnique = true;
        }
        user.inviteCode = inviteCode;
      }
      await user.save();
    }
    
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: JWT_EXPIRE });
    
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        studentId: user.studentId,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        isVip: user.isVip,
        vipExpireAt: user.vipExpireAt,
        signCredits: user.signCredits || 0,
        checkinStreak: user.checkinStreak || 0,
        lastCheckinDate: user.lastCheckinDate || '',
        vipTier: user.vipTier || (user.isVip ? 'YEARLY_PRO' : 'FREE'),
        vipStartAt: user.vipStartAt || null,
        canCustomTime: hasActiveVip(user) && membership.tierAllowsCustomTime(user.vipTier),
        membership: membership.membershipView(user),
        role: user.role,
        inviteCode: user.inviteCode,
        invitedBy: user.invitedBy,
        inviteCount: user.inviteCount,
        totalSignCount: user.totalSignCount,

        onboardingDone: !!user.onboardingDone,
        successSignCount: user.successSignCount
      }
    });
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
    
// 获取用户信息
app.get('/api/user/profile', authMiddleware, async (req, res) => {
  const user = req.user;
  res.json({
    success: true,
    user: {
      id: user._id,
      studentId: user.studentId,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      isVip: user.isVip,
      vipExpireAt: user.vipExpireAt,
      signCredits: user.signCredits || 0,
      checkinStreak: user.checkinStreak || 0,
      lastCheckinDate: user.lastCheckinDate || '',
      vipTier: user.vipTier || (user.isVip ? 'YEARLY_PRO' : 'FREE'),
      vipStartAt: user.vipStartAt || null,
      canCustomTime: hasActiveVip(user) && membership.tierAllowsCustomTime(user.vipTier),
      membership: membership.membershipView(user),
      role: user.role,
      inviteCode: user.inviteCode,
      invitedBy: user.invitedBy,
      inviteCount: user.inviteCount,
      totalSignCount: user.totalSignCount,

      onboardingDone: !!user.onboardingDone,
      successSignCount: user.successSignCount,
      createdAt: user.createdAt,
      payQR: user.payQR || { wechat: '', alipay: '' }
    }
  });
});

// 更新用户信息
app.put('/api/user/profile', authMiddleware, async (req, res) => {
  try {
    const { name, attendancePassword } = req.body;
    const user = req.user;
    if (name) user.name = name;
    if (attendancePassword) user.attendancePassword = attendancePassword;
    await user.save();
    res.json({ success: true, user: { name: user.name } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 新手引导：完成后在账号上打标记（跨设备只显示一次）
app.post('/api/user/onboarding', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    user.onboardingDone = true;
    user.onboardingDoneAt = new Date();
    await user.save();
    res.json({ success: true, onboardingDone: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 系统通知 ============
app.get('/api/notice', authMiddleware, async (req, res) => {
  try {
    const config = await SystemConfig.findOne({ key: 'dashboard_notice' });
    res.json({ 
      success: true, 
      notice: config?.value || { enabled: false, title: '', content: '', style: 'info' } 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// VIP 专属通知（仅VIP用户可见）
app.get('/api/notice/vip', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    if (!user.isVip) {
      return res.json({ success: true, notice: { enabled: false } });
    }
    const config = await SystemConfig.findOne({ key: 'sponsor_notice' });
    res.json({
      success: true,
      notice: config?.value || { enabled: false, title: '', content: '', style: 'info' }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 邮箱绑定 ============
app.post('/api/email/send-code', authMiddleware, async (req, res) => {
  try {
    const { email } = req.body;
    const user = req.user;
    
    if (!email) {
      return res.status(400).json({ success: false, message: '请输入邮箱' });
    }
    
    const existingUser = await User.findOne({ email, _id: { $ne: user._id } });
    if (existingUser) {
      return res.status(400).json({ success: false, message: '该邮箱已被绑定' });
    }
    
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    
    await EmailCode.deleteMany({ email, used: false });
    const emailCode = new EmailCode({
      email,
      code,
      userId: user._id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000)
    });
    await emailCode.save();
    
    const sent = await sendVerificationCode(email, code);
    
    res.json({ 
      success: true, 
      message: sent ? '验证码已发送' : '验证码已生成（邮件服务暂不可用）',
      debugCode: sent ? undefined : code
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/email/verify', authMiddleware, async (req, res) => {
  try {
    const { email, code } = req.body;
    const user = req.user;
    
    const emailCode = await EmailCode.findOne({ email, code, used: false });
    
    if (!emailCode) {
      return res.status(400).json({ success: false, message: '验证码错误' });
    }
    
    if (emailCode.expiresAt < new Date()) {
      return res.status(400).json({ success: false, message: '验证码已过期' });
    }
    
    emailCode.used = true;
    await emailCode.save();
    
    user.email = email;
    user.emailVerified = true;

    await user.save();
    
    res.json({
      success: true,
      user: {
        email: user.email,
        emailVerified: user.emailVerified,
        isVip: user.isVip,
        vipExpireAt: user.vipExpireAt,
        signCredits: user.signCredits || 0,
        vipTier: user.vipTier || 'FREE'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 换绑邮箱 ============
app.post('/api/email/rebind', authMiddleware, async (req, res) => {
  try {
    const { email, code } = req.body;
    const user = req.user;
    
    // 检查是否已绑定邮箱
    if (!user.emailVerified) {
      return res.status(400).json({ success: false, message: '您还没有绑定邮箱，请先绑定' });
    }
    
    if (!email || !code) {
      return res.status(400).json({ success: false, message: '请填写新邮箱和验证码' });
    }
    
    // 不能换绑成同一个邮箱
    if (email === user.email) {
      return res.status(400).json({ success: false, message: '新邮箱不能和当前邮箱相同' });
    }
    
    // 检查新邮箱是否已被其他人绑定
    const existingUser = await User.findOne({ email, _id: { $ne: user._id } });
    if (existingUser) {
      return res.status(400).json({ success: false, message: '该邮箱已被其他用户绑定' });
    }
    
    // 验证验证码
    const emailCode = await EmailCode.findOne({ email, code, used: false });
    if (!emailCode) {
      return res.status(400).json({ success: false, message: '验证码错误' });
    }
    
    if (emailCode.expiresAt < new Date()) {
      return res.status(400).json({ success: false, message: '验证码已过期' });
    }
    
    // 标记验证码已使用
    emailCode.used = true;
    await emailCode.save();
    
    // 更新邮箱
    const oldEmail = user.email;
    user.email = email;
    await user.save();
    
    console.log(`📧 用户 ${user.studentId} 换绑邮箱: ${oldEmail} → ${email}`);
    
    // 发送通知邮件到新邮箱
    if (RESEND_API_KEY) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'AG工作室 <noreply@agai.online>',
            to: email,
            subject: '邮箱换绑成功 - AG工作室',
            html: `
              <div style="max-width: 450px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
                <div style="text-align: center; margin-bottom: 24px;">
                  <h1 style="color: #667eea; margin: 0;">📋 AG工作室</h1>
                </div>
                <p>您的绑定邮箱已成功更换为：<strong>${email}</strong></p>
                <p>原邮箱 <strong>${oldEmail}</strong> 将不再接收签到通知。</p>
                <hr style="margin: 24px 0;">
                <p style="color: #999; font-size: 12px; text-align: center;">
                  如果这不是您本人的操作，请联系管理员
                </p>
              </div>
            `
          })
        });
      } catch (e) {
        console.error('发送换绑通知失败:', e);
      }
    }
    
    res.json({
      success: true,
      message: '邮箱换绑成功',
      user: {
        email: user.email,
        emailVerified: user.emailVerified
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 卡密兑换 ============
app.post('/api/vip/redeem', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    const user = req.user;
    
    if (!code) {
      return res.status(400).json({ success: false, message: '请输入卡密' });
    }
    
    const card = await Card.findOne({ code: code.toUpperCase(), status: 'unused' });
    if (!card) {
      return res.status(400).json({ success: false, message: '卡密无效或已被使用' });
    }
    
    const cardTier = card.vipTier || (card.days >= 365 ? 'YEARLY' : card.days >= 120 ? 'TERM' : 'MONTHLY');
    const cardPlan = membership.planForTier(cardTier)
      || (card.days >= 365 ? membership.planForCode('yearly') : card.days >= 120 ? membership.planForCode('term') : membership.planForCode('monthly'));
    let expireAt;
    if (cardPlan) {
      expireAt = await grantMembership(user, cardPlan);
    } else {
      expireAt = addVipDays(user, card.days);
      applyVipTier(user, cardTier);
      await user.save();
    }

    card.status = 'used';
    card.usedBy = user._id;
    card.usedAt = new Date();
    await card.save();

    res.json({
      success: true,
      message: `兑换成功！${membership.tierLabel(user.vipTier)} 有效期至 ${expireAt.toLocaleDateString('zh-CN')}`,
      vipExpireAt: expireAt,
      signCredits: user.signCredits || 0,
      vipTier: user.vipTier || 'FREE',
      membership: membership.membershipView(user)
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 邀请功能 ============
app.get('/api/invite/info', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    
    const invitedUsers = await User.find({ invitedBy: user._id }).select('studentId name createdAt');
    const rewardConfig = await SystemConfig.findOne({ key: 'invite_reward_days' });
    
    res.json({
      success: true,
      inviteCode: user.inviteCode,
      inviteCount: user.inviteCount || 0,
      inviteUrl: `https://login.agai.online?invite=${user.inviteCode}`,
      rewardDays: rewardConfig?.value || 10,
      invitedUsers
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/invite/apply', authMiddleware, async (req, res) => {
  try {
    const { inviteCode } = req.body;
    const user = req.user;
    
    if (user.invitedBy) {
      return res.status(400).json({ success: false, message: '您已经绑定过邀请人了' });
    }
    
    const inviter = await User.findOne({ inviteCode: inviteCode.toUpperCase() });
    if (!inviter) {
      return res.status(400).json({ success: false, message: '邀请码无效' });
    }
    
    if (inviter._id.toString() === user._id.toString()) {
      return res.status(400).json({ success: false, message: '不能邀请自己' });
    }
    
    const rewardConfig = await SystemConfig.findOne({ key: 'invite_reward_days' });
    const rewardDays = rewardConfig?.value || 10;
    
    user.invitedBy = inviter._id;
    
    const now = new Date();
    let expireAt = user.vipExpireAt && user.vipExpireAt > now ? new Date(user.vipExpireAt) : now;
    expireAt.setDate(expireAt.getDate() + rewardDays);
    user.isVip = true;
    user.vipExpireAt = expireAt;
    applyVipTier(user, 'YEARLY_PRO');
    await user.save();
    
    let inviterExpireAt = inviter.vipExpireAt && inviter.vipExpireAt > now ? new Date(inviter.vipExpireAt) : now;
    inviterExpireAt.setDate(inviterExpireAt.getDate() + rewardDays);
    inviter.isVip = true;
    inviter.vipExpireAt = inviterExpireAt;
    applyVipTier(inviter, 'YEARLY_PRO');
    inviter.inviteCount = (inviter.inviteCount || 0) + 1;
    await inviter.save();
    
    const log = new InviteLog({
      inviterId: inviter._id,
      inviteeId: user._id,
      rewardDays
    });
    await log.save();
    
    res.json({
      success: true,
      message: `成功绑定邀请人！您和邀请人各获得 ${rewardDays} 天会员`,
      rewardDays
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 订阅管理 ============
app.get('/api/subscriptions', authMiddleware, async (req, res) => {
  try {
    const setting = await getAutoSignSetting(req.user._id);
    res.json({ success: true, subscriptions: setting ? [formatAutoSignSetting(setting)] : [] });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/subscriptions', authMiddleware, requireAutoSignAccess, async (req, res) => {
  try {
    const savedSubscription = await saveAutoSignSetting(req.user._id, req.body);
    res.json({ success: true, subscription: formatAutoSignSetting(savedSubscription) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/auto-sign', authMiddleware, async (req, res) => {
  try {
    const setting = await getAutoSignSetting(req.user._id);
    res.json({ success: true, setting: formatAutoSignSetting(setting) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/auto-sign', authMiddleware, requireAutoSignAccess, async (req, res) => {
  try {
    const setting = await saveAutoSignSetting(req.user._id, req.body);
    res.json({ success: true, setting: formatAutoSignSetting(setting) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/auto-sign', authMiddleware, requireAutoSignAccess, async (req, res) => {
  try {
    const setting = await saveAutoSignSetting(req.user._id, req.body);
    res.json({ success: true, setting: formatAutoSignSetting(setting) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/subscriptions/:id', authMiddleware, requireAutoSignAccess, async (req, res) => {
  try {
    const subscription = await Subscription.findOne({ _id: req.params.id, userId: req.user._id });
    if (!subscription) {
      return res.status(404).json({ success: false, message: '订阅不存在' });
    }
    
    const savedSubscription = await saveAutoSignSetting(req.user._id, req.body, req.params.id);
    res.json({ success: true, subscription: formatAutoSignSetting(savedSubscription) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/subscriptions/:id', authMiddleware, async (req, res) => {
  try {
    await Subscription.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/subscriptions/:id/toggle', authMiddleware, requireAutoSignAccess, async (req, res) => {
  try {
    const subscription = await Subscription.findOne({ _id: req.params.id, userId: req.user._id });
    if (!subscription) {
      return res.status(404).json({ success: false, message: '订阅不存在' });
    }
    
    subscription.name = AUTO_SIGN_NAME;
    subscription.enabled = !subscription.enabled;
    subscription.autoDisabledBySystem = false;
    subscription.scheduleType = 'custom';
    subscription.customDays = normalizeAutoSignDays(subscription.customDays);
    subscription.signTime = AUTO_SIGN_TIME;
    subscription.maxRetries = 3;
    subscription.updatedAt = new Date();
    await subscription.save();
    
    res.json({ success: true, enabled: subscription.enabled });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 站内通知（管理员留的提示，用户下次打开仪表盘时弹窗，不发邮件）============
app.get('/api/notices', authMiddleware, async (req, res) => {
  try {
    const list = userNoticeList(req.user);
    res.json({ success: true, notices: list });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/notices/clear', authMiddleware, async (req, res) => {
  try {
    req.user.notices = [];
    await req.user.save();
    res.json({ success: true, message: '已读' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 管理员：给指定用户（或自己）发一条站内通知，用于测试弹窗
app.post('/api/admin/notice-test', adminMiddleware, async (req, res) => {
  try {
    const studentId = String((req.body && req.body.studentId) || req.user.studentId).trim();
    const target = studentId === req.user.studentId ? req.user : await User.findOne({ studentId });
    if (!target) return res.status(404).json({ success: false, message: '用户不存在' });
    queueUserNotice(target,
      (req.body && req.body.title) || '测试通知',
      (req.body && req.body.content) || '这是一条测试弹窗：管理员发的站内通知会在这个用户下次打开仪表盘时弹出，不消耗邮件额度。',
      'info');
    await target.save();
    res.json({ success: true, message: `已给 ${studentId} 留了一条站内通知，下次打开仪表盘会弹窗` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 手动签到 ============
// 每日打卡：每天一次，获得 1 次手动签到机会（连续 7 天额外 +2，上限 99）
app.post('/api/checkin', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const today = beijingDateKey();
    if (user.lastCheckinDate === today) {
      return res.json({ success: true, already: true, credits: Number(user.signCredits || 0), streak: Number(user.checkinStreak || 0), message: '今天已经打过卡啦，明天再来' });
    }
    const yesterday = beijingDateKey(new Date(Date.now() - 24 * 3600 * 1000));
    const streak = user.lastCheckinDate === yesterday ? Number(user.checkinStreak || 0) + 1 : 1;
    const bonus = streak % CHECKIN_BONUS_EVERY === 0 ? CHECKIN_BONUS_CREDITS : 0;
    const after = Math.min(SIGN_CREDITS_CAP, Number(user.signCredits || 0) + 1 + bonus);
    user.signCredits = after;
    user.checkinStreak = streak;
    user.lastCheckinDate = today;
    user.checkinTotal = Number(user.checkinTotal || 0) + 1;
    await user.save();
    console.log(`📅 每日打卡: ${user.studentId} 连续${streak}天 +${1 + bonus}次 余额${after}`);
    res.json({ success: true, already: false, credits: after, streak, bonus, message: `打卡成功：+${1 + bonus} 次签到机会${bonus ? `（连续 ${streak} 天奖励）` : ''}` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/sign/manual', authMiddleware, async (req, res) => {
  try {
    const { attendancePassword } = req.body;
    const user = req.user;
    // 检查今天是否已签到成功
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    
    const existingLog = await SignLog.findOne({
      userId: user._id,
      status: 'success',
      signTime: { $gte: todayStart, $lte: todayEnd }
    });
    
    if (existingLog) {
      return res.json({
        success: true,
        result: { success: true, message: '今天已签到，无需重复操作' }
      });
    }

    
    if (!isWithinSignWindow()) {
      return res.status(400).json({ success: false, message: '未到签到时间，签到时间为每天 21:30–24:00' });
    }

    // 手动签到权限：有效会员免次数；非会员每次消耗 1 次签到机会（每日打卡获得）
    const isMember = hasActiveVip(user);
    const creditsValid = Number(user.signCredits || 0) > 0 && (!user.signCreditsExpireAt || new Date(user.signCreditsExpireAt).getTime() > Date.now());
    if (!isMember && !creditsValid) {
      return res.status(403).json({
        success: false,
        code: 'SIGN_CREDITS_REQUIRED',
        message: '今天的签到机会用完了：去首页「每日打卡」可免费获得签到次数，或开通会员（每天自动签到）'
      });
    }

    const signPassword = attendancePassword || user.attendancePassword || 'Ahgydx@920';
    const signTime = new Date();
    
    console.log(`🚀 手动签到: ${user.studentId}`);
    
    const signResult = await realSign(user.studentId, signPassword, 3);
    
    // 只有签到成功才扣次数（失败不扣，下次可以继续尝试）
    if (signResult.success && !isMember && creditsValid) {
      user.signCredits = Math.max(0, Number(user.signCredits) - 1);
      console.log(`🎟️ 手动签到成功，扣 1 次: ${user.studentId} 剩余 ${user.signCredits}`);
    }
    
    user.totalSignCount = (user.totalSignCount || 0) + 1;
    if (signResult.success) {
      user.successSignCount = (user.successSignCount || 0) + 1;
    }
    await user.save();
    
    const log = new SignLog({
      userId: user._id,
      subscriptionName: '手动签到',
      status: signResult.success ? 'success' : 'failed',
      message: signResult.message || JSON.stringify(signResult.errors || []),
      signTime: signTime
    });
    await log.save();
    
    if (user.isVip && user.emailVerified && user.email) {
      const now = new Date();
      if (user.vipExpireAt && user.vipExpireAt > now) {
        await sendSignNotification(user.email, user.studentId, signResult, '手动签到', signTime);
      }
    }
    
    res.json({
      success: true,
      result: {
        success: signResult.success,
        message: signResult.message,
        errors: signResult.errors || []
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 签到日志 ============
app.get('/api/sign/logs', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const logs = await SignLog.find({ userId: req.user._id })
      .sort({ executedAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await SignLog.countDocuments({ userId: req.user._id });
    res.json({ success: true, logs, total, page: parseInt(page) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 统计信息 ============
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todaySigns = await SignLog.countDocuments({ userId: user._id, executedAt: { $gte: today } });
    const todaySuccess = await SignLog.countDocuments({ userId: user._id, status: 'success', executedAt: { $gte: today } });
    const autoSignSetting = await Subscription.exists({ userId: user._id, enabled: true });
    const autoSignEnabled = !!autoSignSetting;
    
    res.json({
      success: true,
      stats: {
        totalSigns: user.totalSignCount || 0,
        successSigns: user.successSignCount || 0,
        todaySigns,
        todaySuccess,
        activeSubscriptions: autoSignEnabled ? 1 : 0,
        autoSignEnabled,
        isVip: user.isVip,
        vipExpireAt: user.vipExpireAt,
        vipTier: user.vipTier || (user.isVip ? 'YEARLY_PRO' : 'FREE')
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 留言反馈 API ============

// 提交留言
app.post('/api/feedback', authMiddleware, async (req, res) => {
  try {
    const { title, content, type } = req.body;
    const user = req.user;
    
    if (!title || !content) {
      return res.status(400).json({ success: false, message: '请填写标题和内容' });
    }
    
    const feedback = new Feedback({
      userId: user._id,
      title,
      content,
      type: type || 'other',
      status: 'pending'
    });
    
    await feedback.save();

    // 即时提醒管理员：WebSocket 实时推送 + 邮件/Webhook
    try {
      const adminIds = await User.find({ studentId: { $in: [...ADMIN_CREDENTIALS.keys()] } }).select('_id studentId').lean();
      for (const a of adminIds) {
        const sid = userSockets.get(String(a._id));
        if (sid) io.to(sid).emit('feedback:new', {
          studentId: user.studentId,
          name: user.name || '',
          title,
          type: feedback.type,
          createdAt: feedback.createdAt
        });
      }
      const plain = `用户 ${user.studentId}（${user.name || ''}）提交了留言\n类型：${feedback.type}\n标题：${title}\n内容：${String(content).slice(0, 500)}`;
      notifyAdmin(`【新留言】${title} · ${user.studentId}`,
        `<div style="font-family:sans-serif;line-height:1.9;color:#334155"><p>用户：<strong>${user.studentId} ${user.name || ''}</strong></p><p>类型：${feedback.type}</p><p>标题：<strong>${title}</strong></p><pre style="white-space:pre-wrap;background:#f8fafc;padding:12px;border-radius:8px">${String(content).slice(0, 1500)}</pre><p><a href="https://login.agai.online/admin.html">打开管理后台处理</a></p></div>`,
        plain).catch(() => {});
    } catch (e) { console.error('新留言提醒失败:', e.message); }

    res.json({ success: true, feedback, message: '留言提交成功，我们会尽快回复！' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取用户的留言列表
app.get('/api/feedback/my', authMiddleware, async (req, res) => {
  try {
    const feedbacks = await Feedback.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50);
    
    res.json({ success: true, feedbacks });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取单条留言详情
app.get('/api/feedback/:id', authMiddleware, async (req, res) => {
  try {
    const feedback = await Feedback.findById(req.params.id);
    
    if (!feedback) {
      return res.status(404).json({ success: false, message: '留言不存在' });
    }
    
    // 检查权限：只能看自己的，管理员可以看所有
    if (feedback.userId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '无权查看' });
    }
    
    res.json({ success: true, feedback });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 管理员 API ============

// 系统统计
app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
  try {
    const attendanceUserQuery = { isGuest: { $ne: true }, source: { $ne: 'market' }, studentId: { $not: /^guest_/ } };
    const marketUserQuery = {
      $or: [
        { source: 'market' },
        { isGuest: true },
        { studentId: /^guest_/ }
      ]
    };
    const totalUsers = await User.countDocuments(attendanceUserQuery);
    const vipUsers = await User.countDocuments({ isVip: true, isGuest: { $ne: true }, source: { $ne: 'market' } });
    const marketUsers = await User.countDocuments(marketUserQuery);
    const todayUsers = await User.countDocuments({
      ...attendanceUserQuery,
      createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
    });
    
    const totalSigns = await SignLog.countDocuments();
    const todaySigns = await SignLog.countDocuments({ executedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } });
    const successSigns = await SignLog.countDocuments({ status: 'success' });
    const todaySuccessSigns = await SignLog.countDocuments({ status: 'success', executedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } });
    const successRate = todaySigns > 0 ? ((todaySuccessSigns / todaySigns) * 100).toFixed(1) : 0;
    
    const activeAutoSignUserIds = await Subscription.distinct('userId', { enabled: true });
    const activeAutoSignUsers = activeAutoSignUserIds.length;
    const totalInvites = await InviteLog.countDocuments();
    
    res.json({
      success: true,
      stats: {
        users: { total: totalUsers, attendance: totalUsers, market: marketUsers, vip: vipUsers, today: todayUsers },
        signs: { total: totalSigns, today: todaySigns, success: successSigns, successRate },
        subscriptions: { active: activeAutoSignUsers },
        autoSign: { users: activeAutoSignUsers },
        invites: { total: totalInvites }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 自动签到今日报告：谁签了、谁没签（管理员）
app.get('/api/admin/autosign-report', adminMiddleware, async (req, res) => {
  try {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);
    const subs = await Subscription.find({ enabled: true }).populate('userId');
    const users = subs.map(s => s.userId).filter(u => u && typeof u === 'object');
    const ids = users.map(u => u._id);
    const logs = await SignLog.find({ userId: { $in: ids }, signTime: { $gte: start, $lte: end } }).select('userId status message').lean();
    const signed = new Map();
    for (const l of logs) { const k = String(l.userId); if (!signed.has(k)) signed.set(k, []); signed.get(k).push(l.status); }
    const rows = users.map(u => ({
      studentId: u.studentId,
      name: u.name || '',
      isVip: u.isVip === true,
      vipTier: u.vipTier || '',
      vipExpireAt: u.vipExpireAt || null,
      signed: signed.has(String(u._id)),
      statuses: signed.get(String(u._id)) || []
    }));
    const signedCount = rows.filter(r => r.signed).length;
    res.json({ success: true, total: rows.length, signed: signedCount, missing: rows.filter(r => !r.signed) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 手动执行续费提醒检查（管理员，返回发送明细）
app.post('/api/admin/check-renewal', adminMiddleware, async (req, res) => {
  try {
    const summary = await checkRenewalReminders();
    res.json({ success: true, ...summary });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 手动校准「自动签到开关 / 签到时间」与会员权益是否一致（管理员）
app.post('/api/admin/reconcile-sign', adminMiddleware, async (req, res) => {
  try {
    const target = String((req.body && req.body.studentId) || '').trim();
    if (target) {
      const user = await User.findOne({ studentId: target });
      if (!user) return res.status(404).json({ success: false, message: '用户不存在' });
      const r = await reconcileUserSignAccess(user);
      const subs = await Subscription.find({ userId: user._id }).lean();
      return res.json({
        success: true,
        studentId: target,
        ...r,
        hasSignAccess: hasSignAccess(user),
        hasAutoSignAccess: hasAutoSignAccess(user),
        subscriptions: subs.map(s => ({ _id: s._id, enabled: s.enabled, signTime: s.signTime, scheduleType: s.scheduleType, customDays: s.customDays, autoDisabledBySystem: !!s.autoDisabledBySystem }))
      });
    }
    const summary = await reconcileAllSignAccess();
    res.json({ success: true, ...summary });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 手动执行自动签到补签兜底（管理员）
app.post('/api/admin/retry-missing', adminMiddleware, async (req, res) => {
  try {
    const result = await retryMissingSigns('手动');
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 手动触发今日管理员签到汇总（管理员）
app.post('/api/admin/send-summary', adminMiddleware, async (req, res) => {
  try {
    const ok = await sendAdminSignSummary(new Date());
    if (!ok) return res.status(502).json({ success: false, message: '邮件发送失败（Resend 返回错误），请查看服务日志' });
    let cfg = await SystemConfig.findOne({ key: 'admin_summary_sent_date' });
    const dayKey = new Date().toLocaleDateString('zh-CN');
    if (!cfg) cfg = new SystemConfig({ key: 'admin_summary_sent_date', value: dayKey });
    else { cfg.value = dayKey; cfg.updatedAt = new Date(); }
    await cfg.save();
    res.json({ success: true, message: '今日汇总邮件已发送' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===== 管理员提醒：WxPusher 微信推送配置 =====
app.get('/api/admin/alert-channels', adminMiddleware, async (req, res) => {
  try {
    const view = await getWxpusherView();
    res.json({ success: true, channels: view, email: { to: ADMIN_EMAIL, enabled: !!RESEND_API_KEY } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/admin/alert-channels', adminMiddleware, async (req, res) => {
  try {
    const src = (req.body && req.body.channels) || {};
    const prev = await getWxpusherConfig();
    const next = Object.assign({}, prev);
    if (typeof src.enabled === 'boolean') next.enabled = src.enabled;
    for (const f of ['spt', 'appToken', 'uids', 'topicIds']) {
      if (!(f in src)) continue;
      const val = String(src[f] == null ? '' : src[f]).trim();
      if (val.includes('•')) continue; // 前端回显的掩码值，保持原样
      next[f] = val;                   // 空字符串 = 清除
    }
    await SystemConfig.findOneAndUpdate(
      { key: 'admin_wxpusher' },
      { key: 'admin_wxpusher', value: next, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    const view = await getWxpusherView();
    res.json({ success: true, message: '提醒设置已保存', channels: view });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/admin/alert-test', adminMiddleware, async (req, res) => {
  try {
    const nowText = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const plain = `这是一条测试消息，手机上收到即说明提醒通道正常。\n发送时间：${nowText}`;
    const out = await notifyAdmin('【测试提醒】AG 智能考勤消息推送',
      `<div style="font-family:sans-serif;line-height:1.9;color:#334155"><p>这是一条<strong>测试提醒</strong>，收到即说明提醒通道正常。</p><p>发送时间：${nowText}</p></div>`,
      plain, { email: !!(req.body && req.body.email === true), emailFallback: false });
    res.json({
      success: true,
      email: out.email,
      push: out.push,
      message: `微信推送：${out.push ? (out.push.ok ? '成功' : (out.push.message || '失败')) : '未执行'}；邮件：${out.email === null ? '未发送（省额度策略：日常不用邮件）' : (out.email ? '已发送' : '失败')}`
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取系统配置
app.get('/api/admin/config', adminMiddleware, async (req, res) => {
  try {
    const configs = await SystemConfig.find();
    const configMap = {};
    configs.forEach(c => { configMap[c.key] = c.value; });
    res.json({ success: true, configs: configMap });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新系统配置
app.put('/api/admin/config/:key', adminMiddleware, async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    let config = await SystemConfig.findOne({ key });
    if (!config) {
      config = new SystemConfig({ key, value });
    } else {
      config.value = value;
      config.updatedAt = new Date();
    }
    await config.save();

    // 🆕 如果更新的是 sponsor_notice，异步发送邮件给所有VIP
    if (key === 'sponsor_notice' && value && value.enabled) {
      // 异步执行，不阻塞响应
      sendSponsorEmailToAllVips(value).catch(err => console.error('群发赞助邮件失败:', err));
    }

    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 用户列表
app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', showGuests = 'false', showMarket = 'false', scope = '', wx = '' } = req.query;

    const conditions = [];
    // 微信通知绑定筛选（运营用来捞「交了钱但没绑微信」的人）
    if (wx === 'unbound') conditions.push({ $or: [{ wxpusherUid: '' }, { wxpusherUid: { $exists: false } }, { wxpusherUid: null }] });
    else if (wx === 'bound') conditions.push({ wxpusherUid: { $nin: ['', null] } });
    if (scope === 'attendance') {
      conditions.push(
        { isGuest: { $ne: true } },
        { source: { $ne: 'market' } },
        { studentId: { $not: /^guest_/ } }
      );
    } else if (scope === 'market') {
      conditions.push({
        $or: [
          { source: 'market' },
          { isGuest: true },
          { studentId: /^guest_/ }
        ]
      });
    } else {
      if (showGuests !== 'true') {
        conditions.push({ isGuest: { $ne: true } });
      }
      if (showMarket !== 'true') {
        conditions.push({ source: { $ne: 'market' } });
      }
    }

    if (search) {
      conditions.push({
        $or: [
          { studentId: { $regex: search, $options: 'i' } },
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ]
      });
    }
    const query = conditions.length > 0 ? { $and: conditions } : {};
    
    
    const users = await User.find(query)
      .select('-__v -attendancePassword')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await User.countDocuments(query);
    
    // 通知偏好：后台统一看解析后的结果（未设置的老用户走旧默认）
    res.json({
      success: true,
      users: users.map(u => ({ ...u.toObject(), notify: notifyPrefs.resolveNotifySettings(u) })),
      total,
      page: parseInt(page)
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 用户详情
app.get('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
        // 从返回对象中删除敏感字段
    if (user) {
      user.attendancePassword = undefined;
    }
    if (!user) {
      return res.status(404).json({ success: false, message: '用户不存在' });
    }
    
    const autoSignSetting = await getAutoSignSetting(user._id);
    const subscriptions = autoSignSetting ? [formatAutoSignSetting(autoSignSetting)] : [];
    const logs = await SignLog.find({ userId: user._id }).sort({ executedAt: -1 }).limit(20);
    
    res.json({
      success: true,
      user: { ...user.toObject(), notify: notifyPrefs.resolveNotifySettings(user) },
      subscriptions,
      logs
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新用户（管理员）
app.put('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  try {
    const { name, email, emailVerified, attendancePassword, isVip, vipExpireAt, vipStartAt, vipTier, role, isActive } = req.body;
    // silent: 管理员修正资料时静默保存，不发「会员到账」邮件（用于恢复被误删用户等场景）
    const silent = req.body.silent === true;

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: '用户不存在' });
    }

    // 记录旧的 VIP 状态和过期时间，用于判断是否需要发邮件
    const oldIsVip = user.isVip;
    const oldVipExpireAt = user.vipExpireAt ? new Date(user.vipExpireAt) : null;

    if (name !== undefined) user.name = name;
    if (email !== undefined) {
      // 管理员在后台填写邮箱 = 代为绑定：直接视为已验证，否则用户主页会一直显示「未绑定」。
      // 清空邮箱时同步取消验证状态。
      const nextEmail = String(email || '').trim();
      user.email = nextEmail;
      user.emailVerified = !!nextEmail;
    }
    if (emailVerified !== undefined) user.emailVerified = !!emailVerified;
    if (attendancePassword !== undefined) user.attendancePassword = attendancePassword;
    if (isVip !== undefined) user.isVip = isVip;
    if (vipExpireAt) { user.vipExpireAt = new Date(vipExpireAt); user.lastRenewalReminderDays = 0; user.lastRenewalReminderAt = null; }
    if (vipStartAt) user.vipStartAt = new Date(vipStartAt);
    if (vipTier !== undefined) {
      const normalizedTier = membership.normalizeTier(vipTier);
      if (membership.TIER_VALUES.includes(normalizedTier)) user.vipTier = normalizedTier;
    }
    // 管理员直接开通会员但未指定套餐时，默认按学年卡 Pro 处理
    if (user.isVip && (!user.vipTier || user.vipTier === 'FREE')) {
      user.vipTier = 'YEARLY_PRO';
    }
    if (user.vipExpireAt && !user.vipStartAt) user.vipStartAt = new Date();
    if (role) user.role = role;
    if (isActive !== undefined) user.isActive = isActive;

    await user.save();
    // 管理员改了会员等级/到期时间：自动签到开关与签到时间跟着变
    if (isVip !== undefined || vipExpireAt || vipTier !== undefined) {
      await reconcileUserSignAccess(user).catch(() => {});
    }
    // 条件：当前是 VIP 且（之前不是 VIP，或者过期时间比旧的时间更晚）
    const now = new Date();    const newExpireAt = user.vipExpireAt ? new Date(user.vipExpireAt) : null;
    const isVipNow = user.isVip && newExpireAt && newExpireAt > now;

    let shouldSendEmail = false;
    let addedDays = 0;

    if (isVipNow) {
      if (!oldIsVip) {
        // 从非 VIP 变为 VIP
        shouldSendEmail = true;
        addedDays = Math.ceil((newExpireAt - now) / (1000 * 60 * 60 * 24));
      } else if (oldVipExpireAt && newExpireAt > oldVipExpireAt) {
        // VIP 天数增加（过期时间延后）
        shouldSendEmail = true;
        addedDays = Math.ceil((newExpireAt - oldVipExpireAt) / (1000 * 60 * 60 * 24));
      }
    }

    // 异步发送邮件，不阻塞响应（silent 用于管理员静默修正资料）
    if (shouldSendEmail && addedDays > 0 && !silent) {
      sendVipGrantEmail(user, addedDays, user.vipExpireAt)
        .catch(err => console.error('发送 VIP 邮件失败:', err));
    }

    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 删除用户
app.delete('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  try {
    const userId = req.params.id;
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: '用户不存在' });
    }
    
    if (user._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: '不能删除自己的账号' });
    }
    
    await Subscription.deleteMany({ userId: user._id });
    await SignLog.deleteMany({ userId: user._id });
    await EmailCode.deleteMany({ userId: user._id });
    await InviteLog.deleteMany({ $or: [{ inviterId: user._id }, { inviteeId: user._id }] });
    await Feedback.deleteMany({ userId: user._id });
    
    await Card.updateMany(
      { usedBy: user._id }, 
      { $unset: { usedBy: '', usedAt: '' }, status: 'unused' }
    );
    
    await User.deleteOne({ _id: user._id });
    
    console.log(`✅ 管理员 ${req.user.studentId} 删除了用户 ${user.studentId}`);
    
    res.json({ success: true, message: '用户已删除' });
  } catch (error) {
    console.error('删除用户错误:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 管理员代签到
app.post('/api/admin/sign/:userId', adminMiddleware, async (req, res) => {
  try {
    const targetUserId = req.params.userId;
    const { attendancePassword } = req.body;
    
    const targetUser = await User.findById(targetUserId);
    if (!targetUser) {
      return res.status(404).json({ success: false, message: '用户不存在' });
    }
    
    const signPassword = attendancePassword || targetUser.attendancePassword || 'Ahgydx@920';
    const signTime = new Date();
    
    console.log(`🚀 管理员 ${req.user.studentId} 为 ${targetUser.studentId} 执行签到`);
    
    const signResult = await realSign(targetUser.studentId, signPassword, 3);
    
    targetUser.totalSignCount = (targetUser.totalSignCount || 0) + 1;
    if (signResult.success) {
      targetUser.successSignCount = (targetUser.successSignCount || 0) + 1;
    }
    await targetUser.save();
    
    const log = new SignLog({
      userId: targetUser._id,
      subscriptionName: `管理员代签 (by ${req.user.studentId})`,
      status: signResult.success ? 'success' : 'failed',
      message: signResult.message || '',
      signTime: signTime
    });
    await log.save();
    
    if (targetUser.isVip && targetUser.emailVerified && targetUser.email) {
      const now = new Date();
      if (targetUser.vipExpireAt && targetUser.vipExpireAt > now) {
        await sendSignNotification(
          targetUser.email, 
          targetUser.studentId, 
          signResult, 
          '管理员代签',
          signTime
        );
      }
    }
    
    res.json({
      success: true,
      result: {
        success: signResult.success,
        message: signResult.message,
        errors: signResult.errors || []
      }
    });
  } catch (error) {
    console.error('代签错误:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 支付 API ============
// 收款码图片地址
// ============ 赞助/支付系统 ============
const PAY_QR_URLS = {
  wechat: 'https://login.agai.online/vxcode.png',
  alipay: 'https://login.agai.online/zfbcode.png'
};
const PAY_QR_URL = PAY_QR_URLS.wechat;

// 优惠码（价格立减）。服务端校验，前端只做展示
// 已改为数据库管理（Coupon），aggzsnb 作为历史优惠码在启动时幂等迁移。
const COUPON_ERRORS = {
  empty: '请输入优惠码',
  not_found: '优惠码无效',
  inactive: '优惠码已停用',
  not_started: '优惠码尚未开始',
  expired: '优惠码已过期',
  used_up: '优惠码已被领完',
  user_limit: '你已使用过该优惠码'
};

function normalizeCouponCode(input) {
  return String(input || '').trim().toLowerCase();
}
function couponLabel(discount) {
  const n = Number(discount) || 0;
  return '立减 ' + (Number.isInteger(n) ? String(n) : n.toFixed(2)) + ' 元';
}
function couponErrorMessage(reason) {
  return COUPON_ERRORS[reason] || '优惠码无效';
}
async function couponUsedCount(code) {
  return PaymentOrder.countDocuments({ couponCode: code, status: { $in: ['granted', 'paid'] } });
}
async function resolveCoupon(input, userId) {
  const code = normalizeCouponCode(input);
  if (!code) return { ok: false, reason: 'empty' };
  const doc = await Coupon.findOne({ code });
  if (!doc) return { ok: false, reason: 'not_found' };
  if (doc.active === false) return { ok: false, reason: 'inactive' };
  const now = new Date();
  if (doc.validFrom && now < new Date(doc.validFrom)) return { ok: false, reason: 'not_started' };
  if (doc.validUntil && now > new Date(doc.validUntil)) return { ok: false, reason: 'expired' };
  if (Number(doc.maxUses) > 0) {
    const used = await couponUsedCount(code);
    if (used >= Number(doc.maxUses)) return { ok: false, reason: 'used_up', used };
  }
  if (userId && Number(doc.perUserLimit) > 0) {
    const mine = await PaymentOrder.countDocuments({ couponCode: code, userId, status: { $in: ['granted', 'paid'] } });
    if (mine >= Number(doc.perUserLimit)) return { ok: false, reason: 'user_limit' };
  }
  return { ok: true, coupon: doc };
}

let couponSeedPromise = null;
function ensureCouponsSeeded() {
  if (!couponSeedPromise) {
    couponSeedPromise = (async () => {
      try {
        const exists = await Coupon.findOne({ code: 'aggzsnb' });
        if (!exists) {
          await Coupon.create({
            code: 'aggzsnb', discount: 5.88, label: couponLabel(5.88),
            active: true, maxUses: 0, perUserLimit: 0, note: '历史优惠码（启动时迁移）'
          });
          console.log('✅ 优惠码迁移：aggzsnb 已写入数据库');
        }
      } catch (e) {
        console.error('优惠码初始化失败:', e.message);
      }
    })();
  }
  return couponSeedPromise;
}

function couponStatus(coupon, usedCount) {
  if (!coupon) return 'unknown';
  if (coupon.active === false) return 'inactive';
  const now = Date.now();
  if (coupon.validFrom && now < new Date(coupon.validFrom).getTime()) return 'not_started';
  if (coupon.validUntil && now > new Date(coupon.validUntil).getTime()) return 'expired';
  if (Number(coupon.maxUses) > 0 && Number(usedCount || 0) >= Number(coupon.maxUses)) return 'used_up';
  return 'active';
}

function sanitizeCouponPayload(body) {
  const b = body || {};
  const code = normalizeCouponCode(b.code);
  if (!/^[a-z0-9_-]{2,32}$/.test(code)) {
    return { ok: false, message: '优惠码只能包含字母/数字/_/-，长度 2-32' };
  }
  const discount = Number(b.discount);
  if (!Number.isFinite(discount) || discount <= 0 || discount > 1000) {
    return { ok: false, message: '立减金额需大于 0 且不超过 1000 元' };
  }
  const maxUses = Math.max(0, parseInt(b.maxUses, 10) || 0);
  const perUserLimit = Math.max(0, parseInt(b.perUserLimit, 10) || 0);
  let validFrom = null, validUntil = null;
  if (b.validFrom) {
    validFrom = new Date(b.validFrom);
    if (Number.isNaN(validFrom.getTime())) return { ok: false, message: '生效时间格式不对' };
  }
  if (b.validUntil) {
    validUntil = new Date(b.validUntil);
    if (Number.isNaN(validUntil.getTime())) return { ok: false, message: '失效时间格式不对' };
  }
  if (validFrom && validUntil && validUntil < validFrom) {
    return { ok: false, message: '失效时间不能早于生效时间' };
  }
  return {
    ok: true,
    data: {
      code,
      discount: Number(discount.toFixed(2)),
      label: couponLabel(discount),
      active: b.active !== false,
      validFrom,
      validUntil,
      maxUses,
      perUserLimit,
      note: String(b.note || '').slice(0, 200)
    }
  };
}

// 七种在售套餐：以 membership.js 为唯一配置源
const SPONSOR_PACKAGES = membership.PLANS.map((plan) => ({
  packageId: plan.packageId,
  planCode: plan.code,
  tier: plan.tier,
  type: 'days',
  kind: plan.kind,
  group: plan.group,
  days: plan.kind === 'days' ? plan.days : 0,
  years: plan.years || 0,
  counts: 0,
  price: plan.price,
  pricePerYear: plan.pricePerYear,
  name: plan.name,
  description: plan.description,
  badge: plan.badge,
  audience: plan.audience,
  customTime: !!plan.customTime,
  durationLabel: plan.durationLabel,
  sort: plan.sort,
  active: true
}));

// 卡密后台仍可生成，作为线下/手动备用（按七套餐生成，不含次数卡）
const CARD_PACKAGES = membership.PLANS.map((plan) => ({
  days: plan.kind === 'days' ? plan.days : 0,
  times: 0,
  cardCategory: 'days',
  price: plan.price,
  name: plan.name,
  description: plan.description,
  vipTier: plan.tier
}));

const TIER_EMAIL_PROFILES = {
  FREE:       { label: '免费用户',        emoji: '🌱', gradient: 'linear-gradient(135deg,#64748b,#94a3b8)', accent: '#475569' },
  MONTHLY:    { label: '月卡会员',        emoji: '🌙', gradient: 'linear-gradient(135deg,#0f766e,#14b8a6)', accent: '#0f766e' },
  TERM:       { label: '学期卡会员',      emoji: '📚', gradient: 'linear-gradient(135deg,#1d4ed8,#3b82f6)', accent: '#1d4ed8' },
  YEARLY:     { label: '学年卡会员',      emoji: '🏆', gradient: 'linear-gradient(135deg,#7c3aed,#a855f7)', accent: '#7c3aed' },
  YEARLY_PRO: { label: '学年卡 Pro 会员', emoji: '👑', gradient: 'linear-gradient(135deg,#b45309,#f59e0b)', accent: '#b45309' },
  FRESHMAN:   { label: '大一学年卡会员',  emoji: '🚀', gradient: 'linear-gradient(135deg,#0f766e,#22c55e)', accent: '#0f766e' },
  SOPHOMORE:  { label: '大二学年卡会员',  emoji: '⛵', gradient: 'linear-gradient(135deg,#1d4ed8,#0ea5e9)', accent: '#1d4ed8' },
  JUNIOR:     { label: '大三学年卡会员',  emoji: '🎯', gradient: 'linear-gradient(135deg,#7c3aed,#d946ef)', accent: '#7c3aed' },
  VIP:        { label: '学年卡 Pro 会员', emoji: '👑', gradient: 'linear-gradient(135deg,#b45309,#f59e0b)', accent: '#b45309' },
  SVIP:       { label: '长期会员',        emoji: '💎', gradient: 'linear-gradient(135deg,#be123c,#fb7185)', accent: '#be123c' },
  LEGACY:     { label: '元老会员',        emoji: '🏛️', gradient: 'linear-gradient(135deg,#111827,#4b5563)', accent: '#111827' }
};

function getTierProfile(user) {
  const tier = membership.normalizeTier(user && user.vipTier);
  return TIER_EMAIL_PROFILES[tier]
    || (user && user.isVip ? TIER_EMAIL_PROFILES.YEARLY_PRO : TIER_EMAIL_PROFILES.FREE);
}

function renderTierEmail(user, opts) {
  const p = getTierProfile(user);
  const name = (user && (user.name || user.studentId)) || '同学';
  const inviteCode = (user && user.inviteCode) || '';
  const inviteUrl = inviteCode ? `https://login.agai.online?invite=${inviteCode}` : 'https://login.agai.online';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px;background:#f4f6f8;font-family:'Microsoft YaHei',Arial,sans-serif;">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.08);">
  <div style="background:${p.gradient};padding:28px 26px;color:#fff;">
    <div style="font-size:12px;letter-spacing:.12em;opacity:.85;font-weight:700;">AG ATTENDANCE</div>
    <h1 style="margin:10px 0 6px;font-size:24px;line-height:1.3;">${opts.title || 'AG 智能考勤'}</h1>
    <div style="display:inline-block;margin-top:6px;padding:5px 12px;border-radius:999px;background:rgba(255,255,255,.18);font-size:12px;font-weight:700;">${p.emoji} ${p.label}</div>
  </div>
  <div style="padding:26px;">
    <p style="margin:0 0 14px;color:#334155;font-size:14px;">${name}，你好：</p>
    ${opts.bodyHtml || ''}
    <div style="text-align:center;margin:26px 0;">
      <a href="${opts.ctaUrl || 'https://login.agai.online'}" style="display:inline-block;padding:13px 28px;border-radius:999px;background:${p.accent};color:#fff;text-decoration:none;font-weight:800;font-size:14px;">${opts.ctaText || '打开官网'}</a>
    </div>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px;font-size:13px;color:#475569;line-height:1.8;">
      <strong>官网：</strong><a href="https://login.agai.online" style="color:${p.accent};">https://login.agai.online</a><br>
      <strong>你的专属邀请链接：</strong><a href="${inviteUrl}" style="color:${p.accent};">${inviteUrl}</a><br>
      <span style="color:#64748b;">把链接分享给同学，双方都有奖励。</span>
    </div>
    ${opts.footerNote ? `<p style="margin:18px 0 0;color:#64748b;font-size:12px;line-height:1.8;">${opts.footerNote}</p>` : ''}
  </div>
  <div style="padding:18px 26px;background:#0f172a;color:#94a3b8;font-size:12px;line-height:1.8;">
    AG工作室 · 智能考勤系统<br>
    自动签到 · 手动签到 · 邮件提醒 · 记录查询<br>
    客服邮箱：support@agai.online
  </div>
</div></body></html>`;
}

async function sendTierEmail(user, subject, opts) {
  if (!RESEND_API_KEY || !user || !user.email) return false;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'AG工作室 <noreply@agai.online>',
        to: user.email,
        subject,
        html: renderTierEmail(user, opts)
      })
    });
    if (!response.ok) console.error('❌ 等级邮件发送失败:', await response.text());
    return response.ok;
  } catch (e) {
    console.error('❌ 等级邮件异常:', e.message);
    return false;
  }
}

// ============ 管理员即时提醒（邮件 + WxPusher 微信推送）============
// 唯一推送通道：WxPusher（SPT 极简推送 / appToken 标准推送），免费、手机实时提醒
const WXPUSHER_SIMPLE_API = 'https://wxpusher.zjiecode.com/api/send/message/simple-push';
const WXPUSHER_STD_API = 'https://wxpusher.zjiecode.com/api/send/message';

function maskAlertSecret(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 8) return '••••';
  return s.slice(0, 4) + '••••••' + s.slice(-4);
}

async function getWxpusherConfig() {
  const cfg = {
    enabled: !!(process.env.WXPUSHER_SPT || process.env.WXPUSHER_APP_TOKEN),
    spt: process.env.WXPUSHER_SPT || '',
    appToken: process.env.WXPUSHER_APP_TOKEN || '',
    uids: process.env.WXPUSHER_UIDS || '',
    topicIds: process.env.WXPUSHER_TOPIC_IDS || ''
  };
  try {
    const doc = await SystemConfig.findOne({ key: 'admin_wxpusher' });
    if (doc && doc.value && typeof doc.value === 'object' && Object.keys(doc.value).length) {
      return Object.assign(cfg, doc.value);
    }
  } catch (e) {}
  return cfg;
}

async function getWxpusherView() {
  const cfg = await getWxpusherConfig();
  return {
    enabled: cfg.enabled !== false,
    configured: !!(cfg.spt || cfg.appToken),
    spt: maskAlertSecret(cfg.spt),
    appToken: maskAlertSecret(cfg.appToken),
    uids: String(cfg.uids || ''),
    topicIds: String(cfg.topicIds || '')
  };
}

// ===== 管理端回复 / 延迟自动回复 配置 =====
// 优先级：SystemConfig('admin_reply') > 环境变量 > 默认
async function getReplyConfig() {
  const cfg = {
    enabled: process.env.USER_REPLY_ENABLED !== 'false',
    adminUid: String(process.env.ADMIN_WXPUSHER_UID || '').trim(),
    autoReplyEnabled: process.env.AUTO_REPLY_ENABLED !== 'false',
    autoReplyDelayMinutes: replyService.normalizeDelayMinutes(process.env.AUTO_REPLY_DELAY_MINUTES || 10),
    autoReplyTemplate: process.env.AUTO_REPLY_TEMPLATE || replyService.DEFAULT_AUTO_REPLY_TEMPLATE
  };
  try {
    const doc = await SystemConfig.findOne({ key: 'admin_reply' });
    const v = doc && doc.value;
    if (v && typeof v === 'object') {
      if (v.enabled !== undefined) cfg.enabled = v.enabled !== false;
      if (v.adminUid !== undefined) cfg.adminUid = String(v.adminUid || '').trim();
      if (v.autoReplyEnabled !== undefined) cfg.autoReplyEnabled = v.autoReplyEnabled !== false;
      if (v.autoReplyDelayMinutes !== undefined) cfg.autoReplyDelayMinutes = replyService.normalizeDelayMinutes(v.autoReplyDelayMinutes);
      if (v.autoReplyTemplate) cfg.autoReplyTemplate = String(v.autoReplyTemplate).slice(0, 1000);
    }
  } catch (e) { /* 配置表不可用时用 env */ }
  // 管理员 UID 兜底：取 admin_wxpusher 里配置的 UID
  if (!cfg.adminUid) {
    try {
      const wx = await getWxpusherConfig();
      const uids = String(wx.uids || '').split(/[\s,;，]+/).filter(x => x && !/^\d+$/.test(x));
      if (uids.length) cfg.adminUid = uids[0];
    } catch (e) {}
  }
  return cfg;
}

function replySettingsView(cfg, wx) {
  return {
    enabled: cfg.enabled !== false,
    autoReplyEnabled: cfg.autoReplyEnabled !== false,
    delayMinutes: cfg.autoReplyDelayMinutes,
    template: cfg.autoReplyTemplate,
    adminUid: maskAlertSecret(cfg.adminUid),
    adminUidConfigured: !!cfg.adminUid,
    appTokenConfigured: !!(wx && wx.appToken),
    sptConfigured: !!(wx && wx.spt)
  };
}

// 发送 WxPusher 推送：配了 SPT 用极简推送，否则用 appToken + UID/Topic
async function pushWxpusher(subject, plainText) {
  const cfg = await getWxpusherConfig();
  if (cfg.enabled === false) return { ok: false, skipped: true, message: '未启用推送' };
  const summary = String(subject || '').slice(0, 40);
  const content = (String(subject || '') + '\n' + String(plainText || '')).trim().slice(0, 1500);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    let url, body;
    if (cfg.spt) {
      url = WXPUSHER_SIMPLE_API;
      body = { spt: String(cfg.spt).trim(), content, summary, contentType: 1 };
    } else if (cfg.appToken) {
      const raw = String(cfg.uids || '').split(/[\s,;，]+/).filter(Boolean);
      const rawTopics = String(cfg.topicIds || '').split(/[\s,;，]+/).filter(Boolean);
      const uids = raw.filter(v => !/^\d+$/.test(v));
      const topicIds = raw.filter(v => /^\d+$/.test(v)).concat(rawTopics).map(Number).filter(n => !Number.isNaN(n));
      if (!uids.length && !topicIds.length) return { ok: false, message: '缺少 UID 或 Topic ID' };
      url = WXPUSHER_STD_API;
      body = { appToken: String(cfg.appToken).trim(), content, summary, contentType: 1 };
      if (uids.length) body.uids = uids;
      if (topicIds.length) body.topicIds = topicIds;
    } else {
      return { ok: false, message: '未配置 SPT / appToken' };
    }
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) {}
    const ok = !!(res.ok && data && (data.success === true || Number(data.code) === 1000));
    const msg = String((data && (data.msg || data.message)) || text || ('HTTP ' + res.status)).slice(0, 160);
    if (!ok) console.error('⚠️ WxPusher 推送失败:', msg);
    return { ok, message: msg };
  } catch (e) {
    console.error('⚠️ WxPusher 推送异常:', e.message);
    return { ok: false, message: e.message };
  } finally { clearTimeout(timer); }
}

// 统一管理员提醒：WxPusher 推送为主，邮件只在"重要 / 推送失败兜底 / 显式要求"时发送（Resend 额度有限）
async function notifyAdmin(subject, html, plainText, opts = {}) {
  const out = { email: null, push: null };
  try {
    if (opts.push !== false) {
      out.push = await pushWxpusher(subject, plainText);
      if (out.push && out.push.ok) console.log('📲 WxPusher 已推送到手机');
    }
    const pushOk = !!(out.push && out.push.ok);
    const pushSkipped = !!(out.push && out.push.skipped);
    const wantEmail = opts.email === true;                                   // 重要事件：明确要求邮件
    const fallbackEmail = opts.emailFallback !== false && !pushOk && !pushSkipped; // 推送失败兜底
    if (RESEND_API_KEY && (wantEmail || fallbackEmail)) {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'AG工作室 <noreply@agai.online>', to: ADMIN_EMAIL, subject, html: html || subject })
        });
        out.email = res.ok === true;
        if (!res.ok) console.error('管理员提醒邮件失败:', (await res.text()).slice(0, 200));
      } catch (e) { out.email = false; console.error('管理员提醒邮件失败:', e.message); }
    }
  } catch (e) { console.error('notifyAdmin 异常:', e.message); }
  return out;
}

// 用户微信上行反馈 → 立刻推给管理员（失败只记日志，绝不影响入库）
async function notifyAdminWechatFeedback({ uid, studentId, content }) {
  try {
    const who = studentId ? `学号 ${studentId}` : `UID ${String(uid || '').slice(0, 12)}…`;
    const text = `📩 收到用户 ${who} 的反馈：${String(content || '').slice(0, 500)}`;
    const r = await pushWxpusher('📩 用户反馈', text);
    if (!r || !r.ok) console.error('反馈推送未送达:', (r && r.message) || 'unknown');
    return r;
  } catch (e) {
    console.error('反馈推送异常:', e.message);
    return { ok: false, message: e.message };
  }
}

async function sendSponsorMail(user, order, kind) {
  const tier = getTierProfile(user);
  const orderPkg = await SponsorPackage.findOne({ packageId: order.packageId }).catch(() => null);
  const planName = order.packageName || (orderPkg ? orderPkg.name : membership.tierLabel(order.tier));
  const durationText = order.durationLabel || (order.days ? `${order.days} 天` : '');
  if (kind === 'revoked') {
    return sendTierEmail(user, '⚠️ 赞助权益已取消', {
      title: '赞助权益已取消',
      bodyHtml: `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:16px;color:#991b1b;font-size:14px;line-height:1.9;">
        <p style="margin:0 0 8px;">订单：<strong>${order.orderNo}</strong></p>
        <p style="margin:0 0 8px;">原套餐：<strong>${planName}${durationText ? ' · ' + durationText : ''}</strong></p>
        <p style="margin:0;">经核对未匹配到对应付款，权益已取消。如有疑问，请通过客服邮箱联系。</p>
      </div>`,
      ctaText: '联系客服',
      ctaUrl: 'mailto:support@agai.online',
      footerNote: '如你确实已完成支付，请把支付截图和订单号发到 support@agai.online，我们会人工补发。'
    });
  }
  const isCounts = order.packageType === 'counts' || order.tier === 'COUNTS';
  const packageText = isCounts ? `次数卡 · ${order.counts} 次（永久有效）` : `${planName}${durationText ? ' · ' + durationText : ''}`;
  return sendTierEmail(user, kind === 'confirmed' ? '✅ 赞助已核对到账' : '🎉 赞助已到账', {
    title: kind === 'confirmed' ? '赞助已核对到账' : '赞助已到账',
    bodyHtml: `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:16px;color:#166534;font-size:14px;line-height:1.9;">
      <p style="margin:0 0 8px;">订单：<strong>${order.orderNo}</strong></p>
      <p style="margin:0 0 8px;">套餐：<strong>${packageText}</strong></p>
      <p style="margin:0 0 8px;">金额：<strong>¥${Number(order.amount).toFixed(2)}</strong></p>
      <p style="margin:0;">权益已发放${isCounts ? '，剩余次数可在仪表盘查看。' : `，当前套餐：<strong>${planName}</strong>。`}</p>
    </div>`,
    ctaText: '登录查看权益',
    ctaUrl: 'https://login.agai.online',
    footerNote: '本次赞助为自愿支持。若为“我已支付”提交，后台会进行核对；未匹配到付款的订单可能被取消并邮件通知。'
  });
}

async function generateUniqueAmount(basePrice) {
  for (let i = 0; i < 10; i++) {
    // 随机分尾固定在 0.01~0.09（整数分）：原实现 random*0.09+0.01 再 toFixed(2)，
    // 在 [0.095,0.10) 区间会被四舍五入成 0.10，与"最多 9 分"的约定不符，导致对账/断言边界错。
    const offset = (Math.floor(Math.random() * 9) + 1) / 100;
    const amount = parseFloat((basePrice + offset).toFixed(2));
    const exists = await PaymentOrder.findOne({
      amount,
      status: { $in: ['pending', 'claimed'] },
      createdAt: { $gt: new Date(Date.now() - 30 * 60 * 1000) }
    });
    if (!exists) return amount;
  }
  return parseFloat((basePrice + 0.09).toFixed(2));
}

async function ensureSponsorPackages() {
  const count = await SponsorPackage.countDocuments();
  if (count === 0) {
    await SponsorPackage.insertMany(SPONSOR_PACKAGES.map(p => ({ ...p, active: true })));
  }
}

// 把七套餐写入数据库（只在迁移时执行一次，避免覆盖后台手工修改）
async function syncMembershipPlans() {
  for (const pkg of SPONSOR_PACKAGES) {
    await SponsorPackage.updateOne(
      { packageId: pkg.packageId },
      { $set: { ...pkg, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
  }
  // 旧套餐下架，但保留记录供历史订单查看
  await SponsorPackage.updateMany(
    { packageId: { $in: ['vip', 'svip', 'trial', 'standard', 'value', 'counts', 'times'] } },
    { $set: { active: false, updatedAt: new Date() } }
  );
}

let autoSignDailyMigrationPromise = null;
// 一次性迁移：所有订阅改为每天自动签到（含周末），老用户无需重新设置
function migrateAutoSignDaily() {
  if (!autoSignDailyMigrationPromise) {
    autoSignDailyMigrationPromise = (async () => {
      try {
        const flag = await SystemConfig.findOne({ key: 'autosign_daily_migrated_v1' });
        if (flag) return;
        await Subscription.updateMany({}, {
          $set: { scheduleType: 'daily', customDays: [0, 1, 2, 3, 4, 5, 6], updatedAt: new Date() }
        });
        await SystemConfig.create({ key: 'autosign_daily_migrated_v1', value: true });
        console.log('🤖 自动签到已迁移为每天（含周末）');
      } catch (e) { console.error('自动签到每日迁移失败:', e.message); }
    })();
  }
  return autoSignDailyMigrationPromise;
}

let membershipMigrationPromise = null;
function migrateMembershipV2() {
  if (!membershipMigrationPromise) {
    membershipMigrationPromise = (async () => {
      try {
        const flag = await SystemConfig.findOne({ key: 'membership_v2_migrated' });
        if (flag) return;

        await ensureSponsorPackages();
        await syncMembershipPlans();

        // 旧 VIP 用户 → 学年卡 Pro（到期时间与自定义时间权益保持不变）
        const legacyVip = await User.countDocuments({ vipTier: 'VIP' });
        if (legacyVip > 0) {
          await User.updateMany({ vipTier: 'VIP' }, { $set: { vipTier: 'YEARLY_PRO' } });
        }
        const legacySvip = await User.countDocuments({ vipTier: 'SVIP' });

        await SystemConfig.create({
          key: 'membership_v2_migrated',
          value: { at: new Date(), legacyVipMigrated: legacyVip, legacySvipKept: legacySvip }
        });
        console.log(`✅ 会员套餐 v2 迁移完成：VIP→学年卡Pro ${legacyVip} 人，保留 SVIP ${legacySvip} 人`);
      } catch (error) {
        console.error('❌ 会员套餐 v2 迁移失败:', error.message);
      }
    })();
  }
  return membershipMigrationPromise;
}

app.get('/api/payment/packages', authMiddleware, async (req, res) => {
  try {
    await migrateMembershipV2();
    await ensureSponsorPackages();
    // 次数卡不再在前台展示，只保留时间套餐
    const packages = await SponsorPackage.find({ active: true, type: 'days' }).sort({ sort: 1, price: 1 });
    const user = req.user;
    const planMeta = membership.membershipView(user);
    res.json({
      success: true,
      membership: planMeta,
      packages: packages.map(p => ({
        id: p.packageId,
        packageId: p.packageId,
        planCode: p.planCode || p.packageId,
        name: p.name,
        price: p.price,
        pricePerYear: p.pricePerYear,
        description: p.description,
        badge: p.badge,
        type: p.type,
        kind: p.kind || 'days',
        group: p.group || 'basic',
        tier: p.tier,
        days: p.days,
        years: p.years || 0,
        counts: p.counts,
        audience: p.audience || '不限',
        customTime: !!p.customTime,
        durationLabel: p.durationLabel || ''
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 管理员：会员等级元数据（前端 admin.html 不再硬编码 TIER_LABELS / CUSTOM_TIME_TIERS）
// 字段直接取 membership.js 的导出，前端不做映射；legacyTiers = 不在售的历史等级（VIP/SVIP/LEGACY）
// ===== 微信通知绑定（WxPusher 服务号，普通用户；无需装 App）=====
app.get('/api/user/wxpusher/qrcode', authMiddleware, async (req, res) => {
  try {
    const cfg = await getWxpusherConfig();
    if (!cfg.appToken) return res.status(503).json({ success: false, message: '服务端未配置微信通知（AppToken）' });
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: '用户不存在' });
    const qr = await wxpusher.createQrcode(cfg.appToken, user.studentId, 600);
    if (!qr.ok) return res.status(502).json({ success: false, message: qr.message || '生成二维码失败' });
    user.wxpusherBindSession = new Date();
    await user.save();
    res.json({ success: true, url: qr.url, shortUrl: qr.shortUrl, expires: qr.expires, extra: qr.extra });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/user/wxpusher/status', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: '用户不存在' });
    if (user.wxpusherUid) {
      return res.json({ success: true, bound: true, uid: user.wxpusherUid, bindTime: user.wxpusherBindTime });
    }
    const cfg = await getWxpusherConfig();
    if (!cfg.appToken) return res.status(503).json({ success: false, bound: false, message: '服务端未配置微信通知（AppToken）' });
    const sessionStart = user.wxpusherBindSession ? new Date(user.wxpusherBindSession).getTime() : 0;
    if (!sessionStart) return res.json({ success: true, bound: false, waiting: false, message: '请先获取二维码' });
    if (Date.now() - sessionStart > 15 * 60 * 1000) return res.json({ success: true, bound: false, expired: true, message: '二维码已过期，请重新获取' });
    // 安全阀：同时有别人在绑定会话中时，绝不做「按时间猜人」，避免把别人的微信绑到你账号上
    const others = await User.countDocuments({ _id: { $ne: user._id }, wxpusherBindSession: { $gt: new Date(Date.now() - 15 * 60 * 1000) } });
    if (others > 0) return res.json({ success: true, bound: false, waiting: true, message: '有其他用户正在绑定，请稍后再试' });
    const list = await wxpusher.listUsers(cfg.appToken, 1, 100);
    if (!list.ok) return res.status(502).json({ success: false, bound: false, message: list.message || '查询订阅者失败' });
    const boundUids = new Set((await User.find({ wxpusherUid: { $ne: '' } }).select('wxpusherUid').lean()).map(u => u.wxpusherUid));
    const fresh = list.records.filter(r => !boundUids.has(r.uid) && Number(r.createTime || 0) >= sessionStart - 60 * 1000);
    if (fresh.length === 1) {
      user.wxpusherUid = fresh[0].uid;
      user.wxpusherBindTime = new Date();
      user.wxpusherBindSession = null;
      await user.save();
      return res.json({ success: true, bound: true, uid: user.wxpusherUid, bindTime: user.wxpusherBindTime, via: 'poll' });
    }
    res.json({ success: true, bound: false, waiting: true, candidates: fresh.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/user/wxpusher/unbind', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: '用户不存在' });
    user.wxpusherUid = '';
    user.wxpusherBindTime = null;
    user.wxpusherBindSession = null;
    await user.save();
    res.json({ success: true, message: '已解除微信绑定' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===== 签到结果通知偏好（HANDOFF §16：微信/邮件双通道 + 仅失败/总是双时机）=====
function notifySettingsPayload(user) {
  const s = notifyPrefs.resolveNotifySettings(user);
  return {
    success: true,
    settings: { channels: s.channels, level: s.level, configured: s.configured, updatedAt: s.updatedAt },
    available: s.available,
    email: s.email,
    emailVerified: s.emailVerified,
    wxpusherBound: s.wxpusherBound
  };
}

app.get('/api/user/notify-settings', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: '用户不存在' });
    res.json(notifySettingsPayload(user));
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/user/notify-settings', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: '用户不存在' });
    const body = req.body || {};
    const check = notifyPrefs.validateSettingsPayload(body, user);
    if (!check.ok) return res.status(400).json({ success: false, message: check.message });
    // channels 不传 = 只改时机，保留原渠道（含「未设置」状态）；传了才落库成显式选择
    if (body.channels !== undefined) user.notifyChannels = check.channels;
    user.notifyLevel = check.level;
    user.notifyUpdatedAt = new Date();
    await user.save();
    res.json({ ...notifySettingsPayload(user), message: '通知设置已保存' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 浏览器直接打开回调地址时给个友好提示（WxPusher 实际是 POST 回推）
app.get('/api/wxpusher/callback', (req, res) => {
  res.json({ success: true, message: 'WxPusher Callback Endpoint Ready' });
});

// 管理员专用：按「通知偏好矩阵」发一条模拟通知（验证 渠道 × 时机 的组合）
// body: { studentId | userId, category: 'password'|'school'|'internal'|'success',
//         level?: 'failure_only'|'always', channels?: ['wechat','email'], dryRun?: boolean }
// - level/channels 只覆盖这一次测试，不写回用户偏好
// - dryRun=true 只返回矩阵判定，不真发（验证用，避免消耗微信/邮件额度）
app.post('/api/admin/wx-test', adminMiddleware, async (req, res) => {
  try {
    const body = req.body || {};
    const { studentId, userId, category = 'internal' } = body;
    const dryRun = body.dryRun === true;
    if (body.level !== undefined && !notifyPrefs.LEVELS.includes(String(body.level))) {
      return res.status(400).json({ success: false, message: 'level 只能是 failure_only / always' });
    }
    if (body.channels !== undefined && !Array.isArray(body.channels)) {
      return res.status(400).json({ success: false, message: 'channels 需要数组，例如 ["wechat","email"]' });
    }
    const user = studentId ? await User.findOne({ studentId: String(studentId) }) : (userId ? await User.findById(userId) : null);
    if (!user) return res.status(404).json({ success: false, message: '用户不存在' });

    const success = category === 'success';
    const samples = {
      password: '模拟：账号或密码不正确',
      school: '模拟：学校系统超时',
      internal: '模拟：内部处理异常'
    };
    const reason = success ? '' : (samples[category] || samples.internal);
    const overrides = {};
    if (body.level !== undefined) overrides.level = body.level;
    if (body.channels !== undefined) overrides.channels = body.channels;

    const result = await dispatchSignResultNotification(user, success, reason, {
      label: '管理员测试', dryRun, overrides
    });
    const plan = result.plan || notifyPrefs.buildNotificationPlan(user, success, overrides);
    const allOk = result.sent.length > 0 && result.sent.every(s => s.ok);

    res.json({
      success: dryRun ? true : allOk,
      dryRun,
      category,
      studentId: user.studentId,
      simulation: { success, reason },
      prefs: notifyPrefs.resolveNotifySettings(user),
      matrix: {
        level: plan.level,
        channels: plan.requestedChannels,
        success,
        send: plan.send,
        reason: plan.reason,
        deliverTo: plan.channels,
        emailFallback: plan.emailFallback,
        description: notifyPrefs.describePlan(plan)
      },
      message: dryRun ? '预演完成（未真实发送）' : (allOk ? '已发送测试通知' : '没有发出任何通知'),
      sent: result.sent,
      wouldSend: result.wouldSend || [],
      summary: result.message ? result.message.summary : '',
      content: result.message ? result.message.content : ''
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===== 延迟自动回复：扫描到期且管理员未回复的消息 =====
async function runAutoReplies({ limit = 20 } = {}) {
  const out = { disabled: false, skipped: false, checked: 0, sent: 0, failed: 0, message: '' };
  try {
    const cfg = await getReplyConfig();
    if (cfg.enabled === false || cfg.autoReplyEnabled === false) {
      out.disabled = true;
      out.message = '自动回复已关闭';
      return out;
    }
    const wx = await getWxpusherConfig();
    if (!wx.appToken) {
      out.skipped = true;
      out.message = '未配置 WxPusher AppToken，无法自动回复';
      return out;
    }
    const due = await UserFeedback.find({
      replied: { $ne: true },
      autoReplied: { $ne: true },
      autoReplyDueAt: { $ne: null, $lte: new Date() }
    }).sort({ autoReplyDueAt: 1 }).limit(limit);
    out.checked = due.length;
    for (const fb of due) {
      try {
        const text = replyService.renderAutoReply(cfg.autoReplyTemplate, fb);
        const r = await wxpusher.sendToUid(wx.appToken, fb.uid, '反馈跟进', text);
        if (r.ok) {
          fb.autoReplied = true;
          fb.autoRepliedAt = new Date();
          await fb.save();
          out.sent++;
        } else {
          out.failed++;
          console.error('自动回复发送失败:', fb.studentId || fb.uid, r.message);
        }
      } catch (e) {
        out.failed++;
        console.error('自动回复异常:', e.message);
      }
    }
  } catch (e) {
    out.failed++;
    console.error('自动回复任务异常:', e.message);
  }
  return out;
}

// ===== 管理端：微信用户消息列表 =====
app.get('/api/admin/user-feedbacks', adminMiddleware, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10) || 20));
    const status = String(req.query.status || '');
    const filter = {};
    if (status === 'pending') filter.replied = { $ne: true };
    if (status === 'replied') filter.replied = true;
    const [feedbacks, total, pending, autoCfg] = await Promise.all([
      UserFeedback.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      UserFeedback.countDocuments(filter),
      UserFeedback.countDocuments({ replied: { $ne: true } }),
      getReplyConfig()
    ]);
    res.json({
      success: true, feedbacks, total, pending, page, limit,
      autoReply: {
        enabled: autoCfg.enabled !== false && autoCfg.autoReplyEnabled !== false,
        delayMinutes: autoCfg.autoReplyDelayMinutes
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===== 管理端：实时回复某条微信反馈（推送给用户）=====
app.post('/api/admin/reply-user', adminMiddleware, async (req, res) => {
  try {
    const body = req.body || {};
    const content = replyService.sanitizeReplyContent(body.content);
    if (!content) return res.status(400).json({ success: false, message: '请输入回复内容' });
    const cfg = await getReplyConfig();
    if (cfg.enabled === false) return res.status(503).json({ success: false, message: '管理员回复功能已关闭' });
    const wx = await getWxpusherConfig();
    if (!wx.appToken) return res.status(503).json({ success: false, message: '服务端未配置 WxPusher AppToken' });

    let feedback = null;
    if (body.feedbackId) {
      feedback = await UserFeedback.findById(body.feedbackId).catch(() => null);
      if (!feedback) return res.status(404).json({ success: false, message: '消息不存在' });
    }
    const targetUid = String((feedback && feedback.uid) || body.uid || '').trim();
    if (!targetUid) return res.status(400).json({ success: false, message: '缺少用户 UID' });

    const who = feedback && feedback.studentId ? `学号 ${feedback.studentId}` : `UID ${targetUid.slice(0, 10)}…`;
    const r = await wxpusher.sendToUid(wx.appToken, targetUid, '📬 管理员回复', `📬 管理员回复（${who}）：\n${content}`);
    if (!r.ok) return res.status(502).json({ success: false, message: r.message || '发送失败' });

    if (feedback) {
      feedback.replied = true;
      feedback.replyContent = content;
      feedback.repliedAt = new Date();
      feedback.repliedBy = cfg.adminUid || req.user.studentId || 'admin';
      await feedback.save();
    }
    res.json({
      success: true,
      message: '已回复并推送到用户微信',
      sentTo: targetUid.slice(0, 10) + '…',
      adminUid: maskAlertSecret(cfg.adminUid || req.user.studentId),
      reply: feedback ? {
        id: String(feedback._id), content, repliedAt: feedback.repliedAt,
        repliedBy: maskAlertSecret(feedback.repliedBy)
      } : null
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===== 管理端：回复/自动回复配置（开关 + 延迟 + 文案 + 管理员 UID）=====
app.get('/api/admin/reply-settings', adminMiddleware, async (req, res) => {
  try {
    const cfg = await getReplyConfig();
    const wx = await getWxpusherConfig();
    res.json({ success: true, settings: replySettingsView(cfg, wx) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/admin/reply-settings', adminMiddleware, async (req, res) => {
  try {
    const body = req.body || {};
    let doc = await SystemConfig.findOne({ key: 'admin_reply' });
    const value = Object.assign({}, doc && doc.value && typeof doc.value === 'object' ? doc.value : {});
    if (body.enabled !== undefined) value.enabled = !!body.enabled;
    if (body.autoReplyEnabled !== undefined) value.autoReplyEnabled = !!body.autoReplyEnabled;
    if (body.delayMinutes !== undefined) value.autoReplyDelayMinutes = replyService.normalizeDelayMinutes(body.delayMinutes);
    if (body.template !== undefined) {
      const t = String(body.template || '').trim();
      if (t.length > 1000) return res.status(400).json({ success: false, message: '文案不能超过 1000 字' });
      value.autoReplyTemplate = t || replyService.DEFAULT_AUTO_REPLY_TEMPLATE;
    }
    if (body.adminUid !== undefined) value.adminUid = String(body.adminUid || '').trim().slice(0, 64);
    if (!doc) doc = new SystemConfig({ key: 'admin_reply', value });
    else { doc.value = value; doc.updatedAt = new Date(); }
    await doc.save();
    const cfg = await getReplyConfig();
    const wx = await getWxpusherConfig();
    res.json({ success: true, settings: replySettingsView(cfg, wx), message: '已保存' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===== 管理端：手动触发一次延迟自动回复扫描（运维/测试用）=====
app.post('/api/admin/run-auto-reply', adminMiddleware, async (req, res) => {
  try {
    const result = await runAutoReplies({ limit: 50 });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===== 管理端：检查某个 UID 是否在当前 AppToken 的订阅者列表中（排障用）=====
app.get('/api/admin/wx-user-check', adminMiddleware, async (req, res) => {
  try {
    const uid = String(req.query.uid || '').trim();
    if (!uid) return res.status(400).json({ success: false, message: '缺少 uid' });
    const cfg = await getWxpusherConfig();
    if (!cfg.appToken) return res.status(503).json({ success: false, message: '未配置 WxPusher AppToken' });
    let found = null, total = 0, pages = 0;
    for (let page = 1; page <= 10; page++) {
      const r = await wxpusher.listUsers(cfg.appToken, page, 100);
      if (!r.ok) return res.status(502).json({ success: false, message: r.message || '查询订阅者失败' });
      pages = page;
      total = Math.max(total, r.total || 0);
      const hit = (r.records || []).find(x => String(x.uid || '') === uid);
      if (hit) { found = hit; break; }
      if ((r.records || []).length < 100) break;
    }
    res.json({
      success: true,
      uid: uid.slice(0, 10) + '…',
      found: !!found,
      total,
      pages,
      record: found ? { uid: String(found.uid || '').slice(0, 10) + '…', createTime: found.createTime || null, nickName: found.nickName || '' } : null,
      message: found
        ? '该 UID 在当前应用订阅者列表中（发送应能送达）'
        : '该 UID 不在当前应用订阅者列表中：可能没关注该应用，或数据库里存的是别的应用的 UID'
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===== 管理端：列出当前应用订阅者（脱敏），用于确认用户是否真的还在服务号里 =====
app.get('/api/admin/wx-subscribers', adminMiddleware, async (req, res) => {
  try {
    const cfg = await getWxpusherConfig();
    if (!cfg.appToken) return res.status(503).json({ success: false, message: '未配置 WxPusher AppToken' });
    const r = await wxpusher.listUsers(cfg.appToken, 1, 100);
    if (!r.ok) return res.status(502).json({ success: false, message: r.message || '查询订阅者失败' });
    const records = r.records || [];
    const uids = records.map(x => String(x.uid || '')).filter(Boolean);
    const users = await User.find({ wxpusherUid: { $in: uids } }).select('studentId name wxpusherUid').lean();
    const map = new Map(users.map(u => [u.wxpusherUid, u]));
    res.json({
      success: true,
      total: r.total || records.length,
      subscribers: records.map(x => {
        const bound = map.get(String(x.uid || ''));
        return {
          uid: String(x.uid || '').slice(0, 10) + '…',
          createTime: x.createTime || null,
          nickName: x.nickName || '',
          studentId: bound ? bound.studentId : '',
          name: bound ? bound.name : '',
          boundToUser: !!bound
        };
      })
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===== 管理端：真实发送一条并返回 WxPusher 原始响应（排查“受理但没送达”）=====
app.post('/api/admin/wx-send-debug', adminMiddleware, async (req, res) => {
  try {
    const uid = String((req.body && req.body.uid) || '').trim();
    if (!uid) return res.status(400).json({ success: false, message: '缺少 uid' });
    const cfg = await getWxpusherConfig();
    if (!cfg.appToken) return res.status(503).json({ success: false, message: '未配置 WxPusher AppToken' });
    const started = Date.now();
    const content = '🔧 送达诊断测试 ' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const r = await wxpusher.sendToUid(cfg.appToken, uid, '送达诊断', content);
    res.json({
      success: r.ok,
      uid: uid.slice(0, 10) + '…',
      latencyMs: Date.now() - started,
      message: r.message || '',
      raw: r.raw || null
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// WxPusher 事件回调（公开接口）：
// - 关注事件：data.extra 是学号 → 绑定 wxpusherUid（原有逻辑）
// - 上行消息（send_up_cmd）：用户在公众号发 "#145060 内容" → 存 UserFeedback + 通知管理员
app.post('/api/wxpusher/callback', wxCallbackIpLimiter, wxCallbackGlobalLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const evt = wxpusher.parseCallback(body, WXPUSHER_APP_ID);
    console.log('[wxpusher-callback]', evt.action || '(no-action)',
      evt.uid ? evt.uid.slice(0, 12) + '…' : '', evt.extra || '', evt.isUplink ? 'uplink' : '');

    // 1) 上行消息：先入库，再尝试通知管理员（通知失败不影响入库）
    if (evt.isUplink && evt.uid && evt.content) {
      const user = await User.findOne({ wxpusherUid: evt.uid }).catch(() => null);
      const studentId = user ? user.studentId : (evt.extra || '');
      const content = String(evt.content).slice(0, 2000);
      // 延迟自动回复：只有开启时才写 autoReplyDueAt（旧消息不会被补发）
      let autoReplyDueAt = null;
      try {
        const rc = await getReplyConfig();
        autoReplyDueAt = replyService.buildAutoReplyDue(new Date(), rc.autoReplyDelayMinutes, rc.enabled !== false && rc.autoReplyEnabled !== false);
      } catch (e) {}
      await UserFeedback.create({ uid: evt.uid, studentId, content, source: 'wechat', autoReplyDueAt });
      try {
        await notifyAdminWechatFeedback({ uid: evt.uid, studentId, content });
      } catch (e) {
        console.error('[wxpusher-callback] 反馈通知失败（已入库）:', e.message);
      }
      console.log(`[wxpusher-callback] 上行反馈已入库 ${studentId || 'UID:' + evt.uid.slice(0, 8)}${autoReplyDueAt ? ' · 自动回复排队 ' + autoReplyDueAt.toISOString() : ''}`);
      return res.json({ success: true, stored: true, autoReplyScheduled: !!autoReplyDueAt });
    }

    // 2) 关注/绑定事件（保持原逻辑）
    if (evt.uid && evt.extra && !evt.isUplink) {
      const user = await User.findOne({ studentId: evt.extra });
      if (user) {
        user.wxpusherUid = evt.uid;
        user.wxpusherBindTime = new Date();
        user.wxpusherBindSession = null;
        await user.save();
        console.log(`[wxpusher-callback] 绑定成功 ${evt.extra} -> ${evt.uid.slice(0, 12)}…`);
      } else {
        console.log(`[wxpusher-callback] extra=${evt.extra} 没有对应用户`);
      }
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[wxpusher-callback] 异常:', error.message);
    res.json({ success: true });
  }
});

app.get('/api/admin/tier-meta', adminMiddleware, async (req, res) => {
  try {
    const tierLabels = membership.TIER_LABELS;
    const planTiers = new Set(membership.PLANS.map(p => p.tier));
    const legacyTiers = Object.keys(tierLabels).filter(t => t !== 'FREE' && !planTiers.has(t));
    res.json({
      success: true,
      tierLabels,
      customTimeTiers: membership.CUSTOM_TIME_TIERS,
      legacyTiers,
      tierOrder: Object.keys(tierLabels),
      // 套餐价格元数据：唯一真相在 membership.PLANS，管理后台不再硬编码（TD-2）
      planPrices: membership.planMetaList()
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/payment/coupon', authMiddleware, async (req, res) => {
  try {
    await ensureCouponsSeeded();
    const rc = await resolveCoupon(req.query.code, req.user._id);
    if (!rc.ok) {
      return res.json({ success: true, valid: false, message: couponErrorMessage(rc.reason) });
    }
    res.json({
      success: true,
      valid: true,
      code: rc.coupon.code,
      discount: Number(rc.coupon.discount),
      label: rc.coupon.label || couponLabel(rc.coupon.discount)
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** 下单 / 复用旧单的统一返回结构（购买页只认这个 order 对象） */
function sponsorOrderPayload(order) {
  return {
    orderNo: order.orderNo,
    amount: order.amount,
    originalAmount: order.originalAmount,
    couponCode: order.couponCode,
    couponDiscount: order.couponDiscount,
    tier: order.tier,
    planCode: order.planCode,
    packageName: order.packageName,
    durationLabel: order.durationLabel,
    packageType: order.packageType,
    days: order.days,
    counts: order.counts,
    packageId: order.packageId,
    payMethod: order.payMethod,
    status: order.status,
    mark: order.payCode || order.orderNo,
    payCode: order.payCode || '',
    expireAt: order.expireAt
  };
}

app.post('/api/payment/create-order', authMiddleware, async (req, res) => {
  try {
    const { packageId, payMethod, couponCode } = req.body;
    await migrateMembershipV2();
    await ensureSponsorPackages();
    await ensureCouponsSeeded();
    const pkg = await SponsorPackage.findOne({ packageId, active: true });
    if (!pkg) return res.status(400).json({ success: false, message: '无效的赞助档位' });

    let coupon = null;
    if (couponCode) {
      const rc = await resolveCoupon(couponCode, req.user._id);
      if (!rc.ok) {
        return res.status(400).json({ success: false, message: couponErrorMessage(rc.reason), reason: rc.reason });
      }
      coupon = rc.coupon;
    }

    // 幂等（TD-12）：同用户 + 同档位还有未过期的 pending 订单 → 复用旧单，不再新建
    const nowTs = Date.now();
    const pendingSame = await PaymentOrder.findOne({
      userId: req.user._id, packageId: pkg.packageId, status: 'pending'
    }).sort({ createdAt: -1 });
    if (pendingSame && (!pendingSame.expireAt || new Date(pendingSame.expireAt).getTime() > nowTs)) {
      return res.json({
        success: true,
        reused: true,
        message: '你有一笔未完成的同套餐订单，已为你恢复，请按原金额支付',
        order: sponsorOrderPayload(pendingSame),
        qrCodes: { wechat: PAY_QR_URLS.wechat, alipay: PAY_QR_URLS.alipay }
      });
    }
    if (pendingSame) { pendingSame.status = 'expired'; await pendingSame.save().catch(() => {}); }
    const originalPrice = Number(pkg.price);
    const discount = coupon ? Math.min(Number(coupon.discount), originalPrice) : 0;
    const discountedBase = Math.max(0.01, Number((originalPrice - discount).toFixed(2)));
    const amount = await generateUniqueAmount(discountedBase);
    let payCode = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = String(Math.floor(1000 + Math.random() * 9000));
      const exists = await PaymentOrder.findOne({ payCode: candidate, status: { $in: ['pending'] } });
      if (!exists) { payCode = candidate; break; }
    }
    if (!payCode) payCode = String(Date.now()).slice(-4);
    const orderNo = 'PAY' + Date.now() + Math.random().toString(36).substring(2, 8).toUpperCase();
    const order = new PaymentOrder({
      orderNo,
      userId: req.user._id,
      userStudentId: req.user.studentId || '',
      userName: req.user.name || '',
      userEmail: req.user.email || '',
      packageId: pkg.packageId,
      planCode: pkg.planCode || pkg.packageId,
      packageName: pkg.name,
      durationLabel: pkg.durationLabel || '',
      tier: pkg.tier,
      packageType: pkg.type,
      amount,
      couponCode: coupon ? coupon.code : '',
      couponDiscount: discount,
      originalAmount: originalPrice,
      days: pkg.days,
      counts: pkg.counts,
      payMethod: payMethod === 'alipay' ? 'alipay' : 'wechat',
      status: 'pending',
      mark: payCode,
      payCode,
      provider: 'self',
      expireAt: new Date(Date.now() + 30 * 60 * 1000)
    });
    await order.save();

    res.json({
      success: true,
      order: sponsorOrderPayload(order),
      qrCodes: { wechat: PAY_QR_URLS.wechat, alipay: PAY_QR_URLS.alipay }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/payment/claim', authMiddleware, async (req, res) => {
  try {
    const { orderNo, paymentRef, note } = req.body;
    if (!orderNo) return res.status(400).json({ success: false, message: '订单号不能为空' });
    if (!paymentRef || String(paymentRef).trim().length < 4) {
      return res.status(400).json({ success: false, message: '请填写支付备注或交易单号后 4 位，方便核对' });
    }

    const order = await PaymentOrder.findOne({ orderNo, userId: req.user._id });
    if (!order) return res.status(404).json({ success: false, message: '订单不存在' });

    if (order.status === 'granted') {
      return res.json({
        success: true,
        already: true,
        message: '该订单已发放权益，等待后台核对',
        order: {
          orderNo: order.orderNo,
          tier: order.tier,
          planCode: order.planCode || '',
          packageName: order.packageName || membership.tierLabel(order.tier),
          days: order.days,
          status: order.status,
          reviewStatus: order.reviewStatus
        },
        vipTier: req.user.vipTier,
        vipExpireAt: req.user.vipExpireAt,
        membership: membership.membershipView(req.user)
      });
    }
    if (order.status !== 'pending') return res.status(400).json({ success: false, message: '该订单当前不能提交' });
    if (order.expireAt && new Date(order.expireAt) < new Date()) {
      order.status = 'expired'; await order.save();
      return res.status(400).json({ success: false, message: '订单已过期，请重新创建' });
    }

    const user = await User.findById(order.userId);
    let expireAt = null;
    if (order.packageType === 'counts' || order.tier === 'COUNTS') {
      user.signCredits = Number(user.signCredits || 0) + Number(order.counts || 0);
      user.signCreditsExpireAt = getGraduationDate(user.studentId) || new Date(Date.now() + 4 * 365 * 24 * 3600 * 1000);
      await user.save();
    } else {
      const plan = planForOrder(order);
      expireAt = await grantMembership(user, plan || order.tier, { days: order.days });
    }

    order.status = 'granted';
    order.reviewStatus = 'unreviewed';
    order.paymentRef = String(paymentRef).trim().slice(0, 120);
    order.claimNote = String(note || '').trim().slice(0, 300);
    order.claimAt = new Date();
    order.grantedAt = new Date();
    order.paidAt = new Date();
    order.provider = 'self-claim';
    await order.save();

    sendSponsorMail(user, order, 'granted').catch(e => console.error('赞助邮件失败:', e.message));

    res.json({
      success: true,
      message: order.packageType === 'counts'
        ? `赞助已到账，已增加 ${order.counts} 次签到额度`
        : '赞助已到账，权益已发放（后台会核对付款）',
      order: {
        orderNo: order.orderNo,
        tier: order.tier,
        planCode: order.planCode || '',
        packageName: order.packageName || membership.tierLabel(order.tier),
        durationLabel: order.durationLabel || '',
        packageType: order.packageType,
        days: order.days,
        counts: order.counts,
        amount: order.amount,
        status: order.status,
        reviewStatus: order.reviewStatus
      },
      signCredits: user.signCredits,
      vipTier: user.vipTier,
      vipExpireAt: expireAt,
      membership: membership.membershipView(user)
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/payment/order/:orderNo', authMiddleware, async (req, res) => {
  try {
    const order = await PaymentOrder.findOne({ orderNo: req.params.orderNo, userId: req.user._id });
    if (!order) return res.status(404).json({ success: false, message: '订单不存在' });
    res.json({
      success: true,
      order: {
        orderNo: order.orderNo,
        amount: order.amount,
        tier: order.tier,
        planCode: order.planCode || '',
        packageName: order.packageName || membership.tierLabel(order.tier),
        durationLabel: order.durationLabel || '',
        packageType: order.packageType,
        days: order.days,
        counts: order.counts,
        amount: order.amount,
        status: order.status,
        reviewStatus: order.reviewStatus,
        expireAt: order.expireAt,
        grantedAt: order.grantedAt,
        claimAt: order.claimAt
      },
      signCredits: req.user.signCredits || 0,
      vipTier: req.user.vipTier,
      vipExpireAt: req.user.vipExpireAt,
      membership: membership.membershipView(req.user)
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/payment/notify', (req, res) => {
  res.json({ code: 1, msg: 'ok', data: { heartbeat: 'ok', time: new Date().toISOString() } });
});

// V免签回调已停用：按用户“我已支付”立即发放，后台核对
app.post('/api/payment/notify', (req, res) => {
  console.log('ℹ️ 收到已停用的免签回调，忽略');
  res.json({ code: 0, msg: 'V免签已停用，请使用“我已支付”' });
});
app.get('/api/admin/sponsor-orders', adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 30, status, reviewStatus } = req.query;
    const query = {};
    if (status) query.status = status;
    if (reviewStatus) query.reviewStatus = reviewStatus;
    const orders = await PaymentOrder.find(query)
      .populate('userId', 'studentId name email vipTier isVip vipExpireAt')
      .populate('reviewedBy', 'studentId name')
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean();
    const total = await PaymentOrder.countDocuments(query);

    // 每个用户当前有多少笔 pending（跨筛选统计，用来提示"该用户还有 N 笔待处理"，TD-12）
    const pendingAgg = await PaymentOrder.aggregate([
      { $match: { status: 'pending' } },
      { $group: { _id: '$userId', count: { $sum: 1 } } }
    ]);
    const pendingByUser = new Map(pendingAgg.map(x => [String(x._id), x.count]));

    for (const o of orders) {
      const uid = o.userId && (o.userId._id || o.userId);
      o.userPendingCount = uid ? (pendingByUser.get(String(uid)) || 0) : 0;
      // 用户被物理删除时 populate 为 null：用下单快照兜底，后台绝不显示空白（TD-13）
      if (!o.userId) {
        o.userDeleted = true;
        o.userId = {
          _id: null,
          deleted: true,
          studentId: o.userStudentId || '',
          name: o.userName || '',
          email: o.userEmail || ''
        };
      }
    }
    res.json({ success: true, orders, total, page: parseInt(page) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/admin/sponsor-orders/:id/confirm', adminMiddleware, async (req, res) => {
  try {
    const order = await PaymentOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: '订单不存在' });
    const user = await User.findById(order.userId);
    if (!user) return res.status(404).json({ success: false, message: '用户不存在' });

    const isCounts = order.packageType === 'counts' || order.tier === 'COUNTS';
    const wasConfirmed = order.reviewStatus === 'confirmed';
    const rawActual = Number(req.body && req.body.actualAmount);
    const hasActual = Number.isFinite(rawActual) && rawActual > 0;
    const paidAmount = hasActual ? Number(rawActual.toFixed(2)) : Number(order.amount || 0);
    // 订单金额带随机分尾（用于对账），容差 0.1 元内算"按订单金额付的"
    const amountDiff = hasActual && !isCounts && Math.abs(paidAmount - Number(order.amount || 0)) > 0.1;

    const orderedPlan = planForOrder(order);
    let effectivePlan = orderedPlan;
    let planChanged = false;

    if (!isCounts) {
      const wanted = String((req.body && req.body.grantPlanCode) || '').trim();
      if (wanted) {
        const picked = membership.planForCode(wanted) || membership.planForTier(wanted);
        if (!picked) return res.status(400).json({ success: false, message: '指定的套餐不存在' });
        effectivePlan = picked;
      } else if (amountDiff) {
        // 按实收金额匹配在售套餐（容差 ±1 元，吸收随机分尾/抹零）
        const hits = membership.PLANS
          .filter(p => p.kind === 'days' && Math.abs(Number(p.price) - paidAmount) <= 1.0)
          .sort((a, b) => Math.abs(Number(a.price) - paidAmount) - Math.abs(Number(b.price) - paidAmount));
        if (!hits.length) {
          return res.status(400).json({
            success: false,
            needPlan: true,
            message: `实收 ¥${paidAmount.toFixed(2)} 没匹配到在售套餐（可能用了优惠码），请手动选择要开通的套餐`,
            plans: membership.planMetaList()
          });
        }
        effectivePlan = hits[0];
      }
      planChanged = !!(effectivePlan && order.planCode && effectivePlan.code !== order.planCode);
    }

    const now = new Date();
    const mismatch = amountDiff || planChanged;

    if (planChanged) {
      // 改套餐 = 按新套餐重新计算时长（不再用"差额天数"，避免年级卡 days=0 导致算不动）
      const other = await computeOtherOrdersContribution(user, order._id);
      const base = (other.expiry && other.expiry.getTime() > now.getTime()) ? other.expiry : now;
      const expireAt = effectivePlan.kind === 'grade'
        ? membership.computeExpireAt(effectivePlan, user, base)
        : new Date(base.getTime() + Number(effectivePlan.days || 0) * membership.DAY_MS);
      user.isVip = true;
      user.vipExpireAt = expireAt;
      const keepHigher = other.bestTier && membership.tierRank(other.bestTier) > membership.tierRank(effectivePlan.tier);
      user.vipTier = membership.normalizeTier(keepHigher ? other.bestTier : effectivePlan.tier);
      if (!user.vipStartAt) user.vipStartAt = now;
      user.lastRenewalReminderDays = 0;
      user.lastRenewalReminderAt = null;
      await user.save();
      await reconcileUserSignAccess(user).catch(() => {});

      order.status = 'granted';
      order.grantedAt = order.grantedAt || now;
      order.grantedPlanCode = effectivePlan.code;
      order.grantedPackageName = effectivePlan.name;
      order.grantedDays = effectivePlan.kind === 'days' ? Number(effectivePlan.days || 0) : 0;
      order.grantedDurationLabel = effectivePlan.durationLabel || '';
    } else if (order.status !== 'granted') {
      await grantMembership(user, effectivePlan || order.tier, { days: order.days });
      order.status = 'granted';
      order.grantedAt = now;
      if (effectivePlan) {
        order.grantedPlanCode = effectivePlan.code;
        order.grantedPackageName = effectivePlan.name;
        order.grantedDays = effectivePlan.kind === 'days' ? Number(effectivePlan.days || 0) : 0;
        order.grantedDurationLabel = effectivePlan.durationLabel || '';
      }
    }

    if (mismatch) {
      order.actualAmount = paidAmount;
      order.amountMismatch = true;
      const orderedName = order.packageName || membership.tierLabel(order.tier);
      const grantText = `${effectivePlan.name}${effectivePlan.kind === 'days' ? '（' + effectivePlan.days + ' 天）' : ''}`;
      const expireText = user.vipExpireAt ? new Date(user.vipExpireAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
      queueUserNotice(user,
        '套餐已按实际支付金额开通',
        `你提交的订单是「${orderedName}」（¥${Number(order.amount || 0).toFixed(2)}），实际到账 ¥${paidAmount.toFixed(2)}。\n` +
        `已按实际支付金额为你开通：${grantText}${expireText ? '，会员到期 ' + expireText : ''}。\n` +
        `如果金额有误，请把支付截图和订单号发到 support@agai.online。`,
        'info');
      await user.save();
    }

    order.reviewStatus = 'confirmed';
    order.reviewedBy = req.user._id;
    order.reviewedAt = new Date();
    order.reviewNote = String((req.body && req.body.note) || '').slice(0, 300);
    await order.save();

    if (mismatch) {
      const expireText = user.vipExpireAt ? new Date(user.vipExpireAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
      return res.json({
        success: true,
        message: `已按实际到账 ¥${paidAmount.toFixed(2)} 开通「${effectivePlan.name}${effectivePlan.kind === 'days' ? '（' + effectivePlan.days + ' 天）' : ''}」${expireText ? '，到期 ' + expireText : ''}；用户下次登录会看到弹窗说明（未发邮件）`
      });
    }
    if (!wasConfirmed) {
      sendSponsorMail(user, order, 'confirmed').catch(e => console.error('赞助邮件失败:', e.message));
      return res.json({ success: true, message: '已确认到账并发送通知' });
    }
    res.json({ success: true, message: '订单已是确认状态，本次没做变更' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/admin/sponsor-orders/:id/revoke', adminMiddleware, async (req, res) => {
  try {
    const order = await PaymentOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: '订单不存在' });
    const user = await User.findById(order.userId);
    if (!user) return res.status(404).json({ success: false, message: '用户不存在' });

    // 撤销权益：优先只扣掉本订单实际开通的时长，保留该用户其它已付订单的会员时间
    const gPlan = effectivePlanForOrder(order);
    const orderDays = Number(order.grantedDays || (gPlan && gPlan.kind === 'days' ? gPlan.days : 0) || order.days || 0);
    const isGradeGrant = !!(gPlan && gPlan.kind === 'grade');
    let partialRevoke = false;
    if (isGradeGrant) {
      // 年级卡（到毕业）：撤销后回落到其它有效订单，没有就整体关闭
      const other = await computeOtherOrdersContribution(user, order._id);
      if (other.expiry && other.expiry.getTime() > Date.now()) {
        user.vipExpireAt = other.expiry;
        user.vipTier = membership.normalizeTier(other.bestTier || 'FREE');
        user.isVip = true;
        await user.save();
        await reconcileUserSignAccess(user).catch(() => {});
        partialRevoke = true;
      } else {
        await revokeSponsorTier(user);
      }
    } else if (orderDays > 0 && user.isVip && user.vipExpireAt) {
      const base = new Date(user.vipExpireAt);
      base.setDate(base.getDate() - orderDays);
      if (base.getTime() > Date.now()) {
        user.vipExpireAt = base;
        await user.save();
        await reconcileUserSignAccess(user).catch(() => {});
        partialRevoke = true;
      } else {
        await revokeSponsorTier(user);
      }
    } else {
      await revokeSponsorTier(user);
    }

    order.status = 'rejected';
    order.reviewStatus = 'rejected';
    order.reviewedBy = req.user._id;
    order.reviewedAt = new Date();
    order.revokedAt = new Date();
    order.reviewNote = String(req.body.note || '').slice(0, 300);
    await order.save();

    // 不发邮件：改为用户下次登录/打开站点时弹一条通知
    const planName = order.grantedPackageName || order.packageName || membership.tierLabel(order.tier);
    const grantedDaysText = order.grantedDays ? ' · ' + order.grantedDays + ' 天' : (order.days ? ' · ' + order.days + ' 天' : '');
    queueUserNotice(user,
      '会员权益已撤销',
      `订单 ${order.orderNo}（${planName}${grantedDaysText}）经核对未匹配到对应付款，会员权益已撤销。` +
      (order.reviewNote ? `\n原因：${order.reviewNote}` : '') +
      '\n如果你确实已完成支付，请把支付截图和订单号发到 support@agai.online，我们会人工补发。',
      'warning');
    await user.save();
    res.json({ success: true, message: partialRevoke
      ? `已取消该订单权益（已回落到其它已付订单的到期时间），用户下次登录会看到弹窗说明（未发邮件）`
      : '已取消该订单权益（会员权益已关闭），用户下次登录会看到弹窗说明（未发邮件）' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 管理员：赞助套餐增删改 ============
app.get('/api/admin/sponsor-packages', adminMiddleware, async (req, res) => {
  try {
    await migrateMembershipV2();
    await ensureSponsorPackages();
    const packages = await SponsorPackage.find({}).sort({ sort: 1, price: 1 });
    res.json({ success: true, packages });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/admin/sponsor-packages', adminMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || b.price === undefined || Number(b.price) < 0) {
      return res.status(400).json({ success: false, message: '请填写套餐名称和价格' });
    }
    const packageId = String(b.packageId || ('pkg_' + Date.now().toString(36))).trim();
    const exists = await SponsorPackage.findOne({ packageId });
    if (exists) return res.status(400).json({ success: false, message: '套餐 ID 已存在' });
    const type = b.type === 'counts' ? 'counts' : 'days';
    const kind = b.kind === 'grade' ? 'grade' : 'days';
    const pkg = await SponsorPackage.create({
      packageId,
      planCode: String(b.planCode || packageId).trim(),
      name: String(b.name).trim(),
      price: Number(Number(b.price).toFixed(2)),
      pricePerYear: b.pricePerYear !== undefined && b.pricePerYear !== '' ? Number(Number(b.pricePerYear).toFixed(2)) : null,
      description: String(b.description || '').trim(),
      badge: String(b.badge || '').trim(),
      type,
      kind,
      group: ['basic', 'pro', 'grade'].includes(b.group) ? b.group : (kind === 'grade' ? 'grade' : 'basic'),
      tier: type === 'counts' ? 'COUNTS' : String(b.tier || 'MONTHLY'),
      days: type === 'days' && kind === 'days' ? Math.max(0, parseInt(b.days, 10) || 0) : 0,
      years: kind === 'grade' ? Math.max(0, parseInt(b.years, 10) || 0) : 0,
      counts: type === 'counts' ? Math.max(0, parseInt(b.counts, 10) || 0) : 0,
      audience: String(b.audience || (kind === 'grade' ? '' : '不限')).trim() || '不限',
      customTime: !!b.customTime,
      durationLabel: String(b.durationLabel || '').trim(),
      active: b.active !== false,
      sort: Number.isFinite(Number(b.sort)) ? Number(b.sort) : 99,
      updatedAt: new Date()
    });
    res.json({ success: true, package: pkg });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/admin/sponsor-packages/:id', adminMiddleware, async (req, res) => {
  try {
    const pkg = await SponsorPackage.findById(req.params.id);
    if (!pkg) return res.status(404).json({ success: false, message: '套餐不存在' });
    const b = req.body || {};
    if (b.name !== undefined) pkg.name = String(b.name).trim();
    if (b.planCode !== undefined) pkg.planCode = String(b.planCode).trim();
    if (b.price !== undefined) pkg.price = Number(Number(b.price).toFixed(2));
    if (b.pricePerYear !== undefined) pkg.pricePerYear = b.pricePerYear === '' || b.pricePerYear === null ? null : Number(Number(b.pricePerYear).toFixed(2));
    if (b.description !== undefined) pkg.description = String(b.description).trim();
    if (b.badge !== undefined) pkg.badge = String(b.badge).trim();
    if (b.type !== undefined) pkg.type = b.type === 'counts' ? 'counts' : 'days';
    if (b.kind !== undefined) pkg.kind = b.kind === 'grade' ? 'grade' : 'days';
    if (b.group !== undefined && ['basic', 'pro', 'grade'].includes(b.group)) pkg.group = b.group;
    if (b.tier !== undefined) pkg.tier = String(b.tier);
    if (b.days !== undefined) pkg.days = Math.max(0, parseInt(b.days, 10) || 0);
    if (b.years !== undefined) pkg.years = Math.max(0, parseInt(b.years, 10) || 0);
    if (b.counts !== undefined) pkg.counts = Math.max(0, parseInt(b.counts, 10) || 0);
    if (b.audience !== undefined) pkg.audience = String(b.audience || '不限').trim() || '不限';
    if (b.customTime !== undefined) pkg.customTime = !!b.customTime;
    if (b.durationLabel !== undefined) pkg.durationLabel = String(b.durationLabel).trim();
    if (b.active !== undefined) pkg.active = !!b.active;
    if (b.sort !== undefined) pkg.sort = Number(b.sort) || 0;
    pkg.updatedAt = new Date();
    await pkg.save();
    res.json({ success: true, package: pkg });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/admin/sponsor-packages/:id', adminMiddleware, async (req, res) => {
  try {
    const pkg = await SponsorPackage.findByIdAndDelete(req.params.id);
    if (!pkg) return res.status(404).json({ success: false, message: '套餐不存在' });
    res.json({ success: true, message: '套餐已删除' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
// ============ 管理员：优惠码管理 ============
app.get('/api/admin/coupons', adminMiddleware, async (req, res) => {
  try {
    await ensureCouponsSeeded();
    const coupons = await Coupon.find({}).sort({ createdAt: 1 }).lean();
    const usage = await PaymentOrder.aggregate([
      { $match: { couponCode: { $nin: ['', null] }, status: { $in: ['granted', 'paid'] } } },
      { $group: { _id: '$couponCode', n: { $sum: 1 } } }
    ]);
    const usedMap = new Map(usage.map(u => [u._id, u.n]));
    res.json({
      success: true,
      coupons: coupons.map(c => {
        const usedCount = usedMap.get(c.code) || 0;
        return {
          ...c,
          label: c.label || couponLabel(c.discount),
          usedCount,
          status: couponStatus(c, usedCount)
        };
      })
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/admin/coupons', adminMiddleware, async (req, res) => {
  try {
    const clean = sanitizeCouponPayload(req.body);
    if (!clean.ok) return res.status(400).json({ success: false, message: clean.message });
    const exists = await Coupon.findOne({ code: clean.data.code });
    if (exists) return res.status(409).json({ success: false, message: '该优惠码已存在' });
    const coupon = await Coupon.create(clean.data);
    res.json({ success: true, coupon, message: '优惠码已创建' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/admin/coupons/:id', adminMiddleware, async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) return res.status(404).json({ success: false, message: '优惠码不存在' });
    const b = req.body || {};
    const merged = {
      code: b.code !== undefined ? b.code : coupon.code,
      discount: b.discount !== undefined ? b.discount : coupon.discount,
      active: b.active !== undefined ? b.active : coupon.active,
      validFrom: b.validFrom !== undefined ? b.validFrom : coupon.validFrom,
      validUntil: b.validUntil !== undefined ? b.validUntil : coupon.validUntil,
      maxUses: b.maxUses !== undefined ? b.maxUses : coupon.maxUses,
      perUserLimit: b.perUserLimit !== undefined ? b.perUserLimit : coupon.perUserLimit,
      note: b.note !== undefined ? b.note : coupon.note
    };
    const clean = sanitizeCouponPayload(merged);
    if (!clean.ok) return res.status(400).json({ success: false, message: clean.message });
    if (clean.data.code !== coupon.code) {
      const dup = await Coupon.findOne({ code: clean.data.code, _id: { $ne: coupon._id } });
      if (dup) return res.status(409).json({ success: false, message: '该优惠码已存在' });
    }
    Object.assign(coupon, clean.data, { updatedAt: new Date() });
    await coupon.save();
    res.json({ success: true, coupon, message: '优惠码已保存' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/admin/coupons/:id', adminMiddleware, async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    if (!coupon) return res.status(404).json({ success: false, message: '优惠码不存在' });
    res.json({ success: true, message: '优惠码已删除' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 管理员：假期暂停自动签到 ============
app.get('/api/admin/holiday', adminMiddleware, async (req, res) => {
  try {
    const cfg = await SystemConfig.findOne({ key: 'auto_sign_paused' });
    res.json({ success: true, paused: !!(cfg && cfg.value === true) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/admin/holiday', adminMiddleware, async (req, res) => {
  try {
    const paused = !!req.body.paused;
    let cfg = await SystemConfig.findOne({ key: 'auto_sign_paused' });
    if (!cfg) cfg = new SystemConfig({ key: 'auto_sign_paused', value: paused });
    else { cfg.value = paused; cfg.updatedAt = new Date(); }
    await cfg.save();
    res.json({ success: true, paused, message: paused ? '已暂停自动签到（不影响到期时间）' : '已恢复自动签到' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
app.post('/api/admin/announcement', adminMiddleware, async (req, res) => {
  try {
    const users = await User.find({ email: { $ne: '' }, isGuest: { $ne: true } });
    const title = 'AG 智能考勤已恢复运行';
    const bodyHtml = `<p style="margin:0 0 12px;color:#334155;font-size:14px;line-height:1.9;">同学们好：</p>
      <p style="margin:0 0 12px;color:#334155;font-size:14px;line-height:1.9;">AG 智能考勤网站已完成迁移和恢复，现在正常运行。</p>
      <p style="margin:0 0 12px;color:#334155;font-size:14px;line-height:1.9;">登录方式：<strong>学号 + 考勤密码</strong>（默认 Ahgydx@920，改过用新密码）。</p>
      <p style="margin:0 0 12px;color:#334155;font-size:14px;line-height:1.9;">自动签到每天 <strong>21:35</strong> 执行；手动签到免费。</p>
      <p style="margin:0 0 12px;color:#334155;font-size:14px;line-height:1.9;">欢迎把官网分享给同学：使用你的专属邀请链接注册，双方都有奖励。</p>`;

    let ok = 0, fail = 0;
    for (const user of users) {
      const sent = await sendTierEmail(user, '🎉 AG 智能考勤已恢复运行', {
        title,
        bodyHtml,
        ctaText: '立即登录',
        ctaUrl: 'https://login.agai.online',
        footerNote: '这是一封系统公告邮件。'
      });
      if (sent) ok++; else fail++;
    }
    res.json({ success: true, message: `公告发送完成：成功 ${ok}，失败 ${fail}`, ok, fail });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


// ============ 管理员一键签到 ============
app.post('/api/admin/trigger-sign', adminMiddleware, async (req, res) => {
  try {
    console.log(`🔔 管理员 ${req.user.studentId} 手动触发全员签到`);
    
    // 立即执行一次自动签到任务（异步，不阻塞响应）
    executeAutoSign().catch(err => console.error('手动签到任务错误:', err));
    
    res.json({
      success: true,
      message: '已触发全员签到任务，请查看日志了解执行情况'
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 管理员留言管理 API ============

// 获取所有留言（管理员）
app.get('/api/admin/feedback', adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, type } = req.query;
    
    const query = {};
    if (status) query.status = status;
    if (type) query.type = type;
    
    const feedbacks = await Feedback.find(query)
      .populate('userId', 'studentId name email')
      .populate('repliedBy', 'studentId name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await Feedback.countDocuments(query);
    
    const pendingCount = await Feedback.countDocuments({ status: 'pending' });
    const readCount = await Feedback.countDocuments({ status: 'read' });
    const repliedCount = await Feedback.countDocuments({ status: 'replied' });
    const closedCount = await Feedback.countDocuments({ status: 'closed' });
    
    res.json({ 
      success: true, 
      feedbacks, 
      total, 
      page: parseInt(page),
      stats: { pending: pendingCount, read: readCount, replied: repliedCount, closed: closedCount }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 回复留言（管理员）
app.put('/api/admin/feedback/:id/reply', adminMiddleware, async (req, res) => {
  try {
    const { reply } = req.body;
    const feedback = await Feedback.findById(req.params.id);
    
    if (!feedback) {
      return res.status(404).json({ success: false, message: '留言不存在' });
    }
    
    if (!reply) {
      return res.status(400).json({ success: false, message: '请输入回复内容' });
    }
    
    feedback.adminReply = reply;
    feedback.status = 'replied';
    feedback.repliedAt = new Date();
    feedback.repliedBy = req.user._id;
    feedback.updatedAt = new Date();
    
    await feedback.save();
    
    res.json({ success: true, feedback, message: '回复成功' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新留言状态（管理员）
app.put('/api/admin/feedback/:id/status', adminMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    const feedback = await Feedback.findById(req.params.id);
    
    if (!feedback) {
      return res.status(404).json({ success: false, message: '留言不存在' });
    }
    
    feedback.status = status;
    feedback.updatedAt = new Date();
    await feedback.save();
    
    res.json({ success: true, feedback });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 删除留言（管理员）
app.delete('/api/admin/feedback/:id', adminMiddleware, async (req, res) => {
  try {
    const feedback = await Feedback.findByIdAndDelete(req.params.id);
    
    if (!feedback) {
      return res.status(404).json({ success: false, message: '留言不存在' });
    }
    
    res.json({ success: true, message: '留言已删除' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 二手市场 API ============

// 获取商品列表
app.get('/api/market/items', async (req, res) => {
  try {
    const { page = 1, limit = 20, category, search, id, sort = 'latest', minPrice, maxPrice } = req.query;
    const safePage = clampNumber(page, 1, 100000, 1);
    const safeLimit = clampNumber(limit, 1, 50, 20);
    
    if (id) {
      const item = await MarketItem.findById(id).populate('userId', 'studentId name');
      if (!item || item.status === 'removed') return res.status(404).json({ success: false, message: '商品不存在' });
      item.views = (item.views || 0) + 1;
      await item.save();
      return res.json({ success: true, item, items: [item] });
    }
    
    const query = { status: 'active' };
    if (category && category !== 'all' && MARKET_CATEGORIES.includes(category)) query.category = category;
    const min = minPrice !== undefined ? normalizeMarketPrice(minPrice) : null;
    const max = maxPrice !== undefined ? normalizeMarketPrice(maxPrice) : null;
    if (min !== null || max !== null) {
      query.price = {};
      if (min !== null) query.price.$gte = min;
      if (max !== null) query.price.$lte = max;
    }
    if (search) {
      const regex = new RegExp(escapeRegExp(String(search).trim()).slice(0, 60), 'i');
      query.$or = [{ title: regex }, { description: regex }, { productNo: regex }];
    }
    const sortMap = {
      latest: { createdAt: -1 },
      priceAsc: { price: 1, createdAt: -1 },
      priceDesc: { price: -1, createdAt: -1 },
      popular: { views: -1, createdAt: -1 }
    };
    
    const items = await MarketItem.find(query)
      .select('-paymentQR')
      .populate('userId', 'studentId name')
      .sort(sortMap[sort] || sortMap.latest)
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit);
    
    const total = await MarketItem.countDocuments(query);
    res.json({ success: true, items, total, page: safePage, limit: safeLimit });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/market/stats', async (req, res) => {
  try {
    const [activeItems, soldItems, activeSellers, completedOrders] = await Promise.all([
      MarketItem.countDocuments({ status: 'active' }),
      MarketItem.countDocuments({ status: 'sold' }),
      MarketItem.distinct('userId', { status: { $in: ['active', 'reserved', 'sold'] } }),
      MarketOrder.countDocuments({ status: 'completed' })
    ]);
    res.json({
      success: true,
      stats: {
        activeItems,
        soldItems,
        sellers: activeSellers.length,
        completedOrders
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

//fa布商品
app.post('/api/market/items', authMiddleware, async (req, res) => {
  try {
    const { title, description, price, category, contact, images, paymentQR } = req.body;
    const cleanTitle = normalizeMarketText(title, 80);
    const cleanDescription = normalizeMarketText(description, 1000);
    const cleanPrice = normalizeMarketPrice(price);
    const cleanPaymentQR = normalizeQrImage(paymentQR || '');
    if (!cleanTitle || !cleanDescription || cleanPrice === null) {
      return res.status(400).json({ success: false, message: '请填写完整信息' });
    }
    // 生成商品专号：AG + 时间戳后6位 + 随机4位
    if (cleanPaymentQR === null) {
      return res.status(400).json({ success: false, message: '收款码图片无效或过大' });
    }
    const productNo = 'AG' + Date.now().toString(36).slice(-6).toUpperCase() + Math.random().toString(36).slice(2,6).toUpperCase();
    const item = new MarketItem({
      productNo,
      userId: req.user._id,
      title: cleanTitle,
      description: cleanDescription,
      price: cleanPrice,
      category: MARKET_CATEGORIES.includes(category) ? category : 'other',
      contact: normalizeMarketContact(contact),
      images: normalizeMarketImages(images),
      paymentQR: cleanPaymentQR,
      status: 'active'
    });
    await item.save();
    res.json({ success: true, item });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


// 获取联系方式
app.get('/api/market/contact/:id', authMiddleware, async (req, res) => {
  try {
    const item = await MarketItem.findById(req.params.id);
    if (!item || item.status === 'removed') return res.status(404).json({ success: false, message: '商品不存在' });
    if (await hasMarketBlockBetween(req.user._id, item.userId)) {
      return res.status(403).json({ success: false, message: '双方暂不可联系' });
    }
    item.contactViews = (item.contactViews || 0) + 1;
    await item.save();
    res.json({ success: true, contact: item.contact });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 我的商品
app.get('/api/market/my', authMiddleware, async (req, res) => {
  try {
    const items = await MarketItem.find({ userId: req.user._id, status: { $ne: 'removed' } })
      .select('-paymentQR')
      .sort({ createdAt: -1 });
    res.json({ success: true, items });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 下架商品
app.delete('/api/market/items/:id', authMiddleware, async (req, res) => {
  try {
    const item = await MarketItem.findOne({ _id: req.params.id, userId: req.user._id });
    if (!item) return res.status(404).json({ success: false, message: '商品不存在' });
    const openOrder = await MarketOrder.exists({
      productId: item._id,
      status: { $in: ['pending', 'confirmed', 'shipped'] }
    });
    if (openOrder) {
      return res.status(400).json({ success: false, message: '商品正在交易中，请先处理订单' });
    }
    item.status = 'removed';
    item.updatedAt = new Date();
    await item.save();
    await Promise.all([
      Cart.deleteMany({ productId: item._id }),
      Favorite.deleteMany({ productId: item._id })
    ]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 收藏功能 ============

// 收藏/取消收藏
app.post('/api/market/favorite', authMiddleware, async (req, res) => {
  try {
    const { productId } = req.body;
    const item = await MarketItem.findOne({ _id: productId, status: 'active' });
    if (!item) return res.status(404).json({ success: false, message: '商品不存在或已下架' });
    if (item.userId.toString() === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: '不能收藏自己的商品' });
    }
    const existing = await Favorite.findOne({ userId: req.user._id, productId });
    if (existing) {
      await Favorite.deleteOne({ _id: existing._id });
      return res.json({ success: true, favorited: false });
    }
    await Favorite.create({ userId: req.user._id, productId });
    res.json({ success: true, favorited: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取收藏列表
app.get('/api/market/favorite', authMiddleware, async (req, res) => {
  try {
    const favorites = await Favorite.find({ userId: req.user._id }).populate({
      path: 'productId',
      match: { status: 'active' },
      select: '-paymentQR',
      populate: { path: 'userId', select: 'studentId name' }
    });
    const items = favorites.filter(f => f.productId).map(f => f.productId);
    res.json({ success: true, items });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 聊天功能 ============

// 创建聊天室
app.post('/api/market/chat/create', authMiddleware, async (req, res) => {
  try {
    const { productId, sellerId: requestedSellerId, buyerId: requestedBuyerId } = req.body;
    const item = await MarketItem.findOne({ _id: productId, status: { $ne: 'removed' } });
    if (!item) return res.status(404).json({ success: false, message: '商品不存在或已下架' });
    const sellerId = item.userId;
    if (requestedSellerId && requestedSellerId !== sellerId.toString()) {
      return res.status(400).json({ success: false, message: '卖家信息与商品不匹配' });
    }
    let buyerId = req.user._id;

    if (sellerId.toString() === req.user._id.toString()) {
      if (!requestedBuyerId) return res.status(400).json({ success: false, message: '请指定买家' });
      const buyer = await User.findById(requestedBuyerId).select('_id');
      if (!buyer) return res.status(404).json({ success: false, message: '买家不存在' });
      buyerId = buyer._id;
    }

    if (buyerId.toString() === sellerId.toString()) return res.status(400).json({ success: false, message: '不能和自己聊天' });
    if (await hasMarketBlockBetween(buyerId, sellerId)) {
      return res.status(403).json({ success: false, message: '双方暂不可聊天' });
    }
    
    let room = await ChatRoom.findOne({ productId, buyerId, sellerId });
    if (!room) {
      room = await ChatRoom.create({ productId, buyerId, sellerId });
    }
    res.json({ success: true, roomId: room._id });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 聊天列表
app.get('/api/market/chat/list', authMiddleware, async (req, res) => {
  try {
    const rooms = await ChatRoom.find({
      $or: [{ buyerId: req.user._id }, { sellerId: req.user._id }]
    })
    .populate('productId', 'title')
    .populate('buyerId', 'studentId name')
    .populate('sellerId', 'studentId name')
    .sort({ lastMessageAt: -1 });
    
    const result = rooms.map(room => ({
      _id: room._id,
      productId: room.productId?._id,
      productTitle: room.productId?.title || '已删除',
      otherUser: room.buyerId._id.toString() === req.user._id.toString() ? room.sellerId : room.buyerId,
      lastMessage: room.lastMessage,
      lastMessageAt: room.lastMessageAt
    }));
    res.json({ success: true, rooms: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取消息
app.get('/api/market/chat/messages', authMiddleware, async (req, res) => {
  try {
    const { roomId } = req.query;
    const room = await ChatRoom.findById(roomId);
    if (!room || (room.buyerId.toString() !== req.user._id.toString() && room.sellerId.toString() !== req.user._id.toString())) {
      return res.status(403).json({ success: false, message: '无权查看该会话' });
    }
    const messages = await Message.find({ roomId }).sort({ createdAt: 1 }).limit(100);
    res.json({ success: true, messages });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 发送消息
app.post('/api/market/chat/send', authMiddleware, async (req, res) => {
  try {
    const { roomId, content } = req.body;
    const cleanContent = normalizeMarketText(content, 500);
    if (!cleanContent) return res.status(400).json({ success: false, message: '请输入内容' });
    const room = await ChatRoom.findById(roomId);
    if (!room || (room.buyerId.toString() !== req.user._id.toString() && room.sellerId.toString() !== req.user._id.toString())) {
      return res.status(403).json({ success: false, message: '无权发送消息' });
    }
    if (await hasMarketBlockBetween(room.buyerId, room.sellerId)) {
      return res.status(403).json({ success: false, message: '双方暂不可聊天' });
    }
    
    const message = await Message.create({
      roomId,
      senderId: req.user._id,
      content: cleanContent
    });
    
    await ChatRoom.findByIdAndUpdate(roomId, {
      lastMessage: cleanContent,
      lastMessageAt: new Date()
    });

    const receiverId = room.buyerId.toString() === req.user._id.toString() ? room.sellerId : room.buyerId;
    const receiverSocket = userSockets.get(receiverId.toString());
    if (receiverSocket) {
      io.to(receiverSocket).emit('newMessage', {
        roomId,
        _id: message._id,
        senderId: req.user._id,
        content: cleanContent,
        createdAt: message.createdAt
      });
    }
    
    res.json({ success: true, message });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


// ============ 举报与拉黑 API ============

// 举报用户
app.post('/api/market/report', authMiddleware, async (req, res) => {
  try {
    const { userId, reason, productId } = req.body;
    const cleanReason = normalizeMarketText(reason, 300);
    if (!userId || !cleanReason) {
      return res.status(400).json({ success: false, message: '请填写举报原因' });
    }
    if (userId === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: '不能举报自己' });
    }
    
    const targetUser = await User.findById(userId).select('_id');
    if (!targetUser) {
      return res.status(404).json({ success: false, message: '被举报用户不存在' });
    }

    const report = new Report({
      reporterId: req.user._id,
      targetUserId: userId,
      productId: productId || null,
      reason: cleanReason,
      status: 'pending'
    });
    await report.save();
    
    res.json({ success: true, message: '举报已提交，我们会尽快处理' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 拉黑用户
app.post('/api/market/block', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: '请指定用户' });
    if (userId === req.user._id.toString()) return res.status(400).json({ success: false, message: '不能拉黑自己' });
    
    const targetUser = await User.findById(userId).select('_id');
    if (!targetUser) return res.status(404).json({ success: false, message: '用户不存在' });

    const existing = await Block.findOne({ userId: req.user._id, blockedUserId: userId });
    if (existing) {
      await Block.deleteOne({ _id: existing._id });
      return res.json({ success: true, blocked: false, message: '已取消拉黑' });
    }
    
    await Block.create({ userId: req.user._id, blockedUserId: userId });
    res.json({ success: true, blocked: true, message: '已拉黑用户' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


// ============ 购物车 API ============
// 加入购物车
app.post('/api/market/cart', authMiddleware, async (req, res) => {
  try {
    const { productId } = req.body;
    const item = await MarketItem.findOne({ _id: productId, status: 'active' });
    if (!item) return res.status(404).json({ success: false, message: '商品不存在或已下架' });
    if (item.userId.toString() === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: '不能加购自己的商品' });
    }
    if (await hasMarketBlockBetween(req.user._id, item.userId)) {
      return res.status(403).json({ success: false, message: '双方暂不可交易' });
    }
    const existing = await Cart.findOne({ userId: req.user._id, productId });
    if (existing) return res.json({ success: false, message: '已在购物车中' });
    await Cart.create({ userId: req.user._id, productId });
    res.json({ success: true, message: '已加入购物车' });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 查看我的购物车
app.get('/api/market/cart', authMiddleware, async (req, res) => {
  try {
    const cartItems = await Cart.find({ userId: req.user._id })
      .populate({ path: 'productId', populate: { path: 'userId', select: 'studentId name' } });
    const items = cartItems.filter(c => c.productId && c.productId.status === 'active').map(c => c.productId);
    res.json({ success: true, items });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 从购物车移除
app.delete('/api/market/cart/:productId', authMiddleware, async (req, res) => {
  try {
    await Cart.deleteOne({ userId: req.user._id, productId: req.params.productId });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 卖家查看谁加购了自己的商品
app.get('/api/market/cart/seller', authMiddleware, async (req, res) => {
  try {
    const myProducts = await MarketItem.find({ userId: req.user._id, status: 'active' }).select('_id productNo title');
    const productIds = myProducts.map(p => p._id);
    const cartEntries = await Cart.find({ productId: { $in: productIds } })
      .populate('userId', 'studentId name')
      .populate('productId', 'productNo title price');
    res.json({ success: true, cartEntries });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ============ 二手订单 API ============
// 创建订单（含收货地址）
app.post('/api/market/orders', authMiddleware, async (req, res) => {
  try {
    const { productId, address } = req.body;
    const cleanAddress = {
      name: normalizeMarketText(address?.name, 40),
      phone: normalizeMarketText(address?.phone, 30),
      detail: normalizeMarketText(address?.detail, 300)
    };
    if (!cleanAddress.name || !cleanAddress.phone || !cleanAddress.detail) {
      return res.status(400).json({ success: false, message: '请填写完整收货信息' });
    }
    const item = await MarketItem.findOneAndUpdate(
      { _id: productId, status: 'active' },
      { status: 'reserved', updatedAt: new Date() },
      { new: true }
    );
    if (!item) return res.status(404).json({ success: false, message: '商品不存在、已下架或正在交易中' });
    if (item.userId.toString() === req.user._id.toString()) {
      await MarketItem.updateOne({ _id: item._id }, { status: 'active', updatedAt: new Date() });
      return res.status(400).json({ success: false, message: '不能购买自己的商品' });
    }
    if (await hasMarketBlockBetween(req.user._id, item.userId)) {
      await MarketItem.updateOne({ _id: item._id }, { status: 'active', updatedAt: new Date() });
      return res.status(403).json({ success: false, message: '双方暂不可交易' });
    }
    const orderNo = 'ORD' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,6).toUpperCase();
    let order;
    try {
      order = await MarketOrder.create({
        orderNo, buyerId: req.user._id, sellerId: item.userId, productId,
        productNo: item.productNo, title: item.title, price: item.price,
        address: cleanAddress, status: 'pending'
      });
    } catch (error) {
      await MarketItem.updateOne({ _id: item._id }, { status: 'active', updatedAt: new Date() });
      throw error;
    }
    await Cart.deleteOne({ userId: req.user._id, productId });
    const sellerSocket = userSockets.get(item.userId.toString());
    if (sellerSocket) {
      io.to(sellerSocket).emit('marketOrderCreated', {
        orderId: order._id,
        orderNo: order.orderNo,
        title: order.title,
        price: order.price
      });
    }
    res.json({ success: true, order });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 买家查看我的订单
app.get('/api/market/orders/buyer', authMiddleware, async (req, res) => {
  try {
    const orders = await MarketOrder.find({ buyerId: req.user._id })
      .populate('sellerId', 'studentId name').sort({ createdAt: -1 });
    res.json({ success: true, orders });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 卖家查看订单
app.get('/api/market/orders/seller', authMiddleware, async (req, res) => {
  try {
    const orders = await MarketOrder.find({ sellerId: req.user._id })
      .populate('buyerId', 'studentId name').sort({ createdAt: -1 });
    res.json({ success: true, orders });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 买卖双方更新订单状态
app.put('/api/market/orders/:id', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    if (!MARKET_ORDER_STATUS.includes(status)) {
      return res.status(400).json({ success: false, message: '无效的订单状态' });
    }
    const order = await MarketOrder.findOne({
      _id: req.params.id,
      $or: [{ sellerId: req.user._id }, { buyerId: req.user._id }]
    });
    if (!order) return res.status(404).json({ success: false, message: '订单不存在' });
    const isSeller = order.sellerId.toString() === req.user._id.toString();
    const isBuyer = order.buyerId.toString() === req.user._id.toString();
    const sellerNext = {
      pending: ['confirmed', 'cancelled'],
      confirmed: ['shipped', 'cancelled']
    };
    const buyerNext = {
      pending: ['cancelled'],
      shipped: ['completed']
    };
    const allowed = isSeller ? sellerNext[order.status] : (isBuyer ? buyerNext[order.status] : []);
    if (!allowed?.includes(status)) {
      return res.status(400).json({ success: false, message: '当前订单状态不能这样变更' });
    }
    order.status = status;
    order.updatedAt = new Date();
    await order.save();
    if (status === 'cancelled') {
      await releaseMarketItemIfNoOpenOrders(order.productId);
    } else if (status === 'completed') {
      await MarketItem.updateOne({ _id: order.productId }, { status: 'sold', updatedAt: new Date() });
      await Cart.deleteMany({ productId: order.productId });
    }
    const notifyUserId = isSeller ? order.buyerId : order.sellerId;
    const notifySocket = userSockets.get(notifyUserId.toString());
    if (notifySocket) {
      io.to(notifySocket).emit('marketOrderUpdated', {
        orderId: order._id,
        orderNo: order.orderNo,
        status: order.status
      });
    }
    res.json({ success: true, order });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ============ 收款码 API ============
// 上传收款码
app.post('/api/user/payqr', authMiddleware, async (req, res) => {
  try {
    const { wechat, alipay } = req.body;
    const update = {};
    if (wechat !== undefined) {
      const normalized = normalizeQrImage(wechat);
      if (normalized === null) return res.status(400).json({ success: false, message: '微信收款码图片无效或过大' });
      update['payQR.wechat'] = normalized;
    }
    if (alipay !== undefined) {
      const normalized = normalizeQrImage(alipay);
      if (normalized === null) return res.status(400).json({ success: false, message: '支付宝收款码图片无效或过大' });
      update['payQR.alipay'] = normalized;
    }
    await User.findByIdAndUpdate(req.user._id, update);
    res.json({ success: true, message: '收款码已更新' });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 获取卖家收款码
app.get('/api/user/payqr/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('payQR name studentId');
    if (!user) return res.status(404).json({ success: false, message: '用户不存在' });
    res.json({ success: true, payQR: user.payQR || { wechat: '', alipay: '' }, name: user.name });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ============ 管理员订单管理 ============
app.get('/api/admin/orders', adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const query = {};
    if (status) query.status = status;
    const orders = await MarketOrder.find(query)
      .populate('buyerId', 'studentId name')
      .populate('sellerId', 'studentId name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    const total = await MarketOrder.countDocuments(query);
    res.json({ success: true, orders, total, page: parseInt(page) });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ============ 管理员商品管理 ============
app.get('/api/admin/market-items', adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, status = '' } = req.query;
    const query = {};
    if (status) query.status = status;
    const items = await MarketItem.find(query)
      .populate('userId', 'studentId name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    const total = await MarketItem.countDocuments(query);
    res.json({ success: true, items, total, page: parseInt(page) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/admin/market-items/:id', adminMiddleware, async (req, res) => {
  try {
    const item = await MarketItem.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: '商品不存在' });
    item.status = 'removed';
    await item.save();
    res.json({ success: true, message: '商品已下架' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 管理员获取举报列表
app.get('/api/admin/reports', adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const query = {};
    if (status) query.status = status;
    
    const reports = await Report.find(query)
      .populate('reporterId', 'studentId name')
      .populate('targetUserId', 'studentId name')
      .populate('productId', 'title')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await Report.countDocuments(query);
    const pendingCount = await Report.countDocuments({ status: 'pending' });
    
    res.json({ success: true, reports, total, page: parseInt(page), pendingCount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 管理员处理举报
app.put('/api/admin/reports/:id', adminMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['pending', 'handled', 'dismissed'].includes(status)) {
      return res.status(400).json({ success: false, message: '无效的举报状态' });
    }
    const report = await Report.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!report) return res.status(404).json({ success: false, message: '举报不存在' });
    res.json({ success: true, report });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 卡密管理 ============

app.post('/api/admin/cards/generate', adminMiddleware, async (req, res) => {
  try {
    const { count = 10, days = 30, tier, packageId } = req.body;
    const plan = membership.planForCode(packageId || '')
      || membership.planForTier(tier || '')
      || membership.planForCode(days >= 365 ? 'yearly' : days >= 120 ? 'term' : 'monthly');
    const vipTier = plan ? plan.tier : 'MONTHLY';
    const cardDays = plan && plan.kind === 'days' ? plan.days : days;

    const cards = [];
    for (let i = 0; i < count; i++) {
      const code = 'VIP' + crypto.randomBytes(6).toString('hex').toUpperCase();
      cards.push({ code, days: cardDays, type: `vip_${vipTier.toLowerCase()}`, vipTier });
    }

    await Card.insertMany(cards);

    res.json({ success: true, cards, message: `成功生成 ${count} 张卡密` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/admin/cards', adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 50, status } = req.query;
    
    const query = status ? { status } : {};
    
    const cards = await Card.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('usedBy', 'studentId name');
    
    const total = await Card.countDocuments(query);
    const unusedCount = await Card.countDocuments({ status: 'unused' });
    const usedCount = await Card.countDocuments({ status: 'used' });
    
    res.json({ success: true, cards, total, unusedCount, usedCount, page: parseInt(page) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/admin/cards/export', adminMiddleware, async (req, res) => {
  try {
    const cards = await Card.find({ status: 'unused' }).select('code days');
    const text = cards.map(c => `${c.code} - ${c.days}天`).join('\n');
    
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="vip_cards.txt"');
    res.send(text);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


// ============ 管理员群发邮件 ============
app.post('/api/admin/send-bulk-email', adminMiddleware, async (req, res) => {
  try {
    const { subject, content, recipients, filterGuest } = req.body;
    if (!RESEND_API_KEY) return res.status(400).json({ success: false, message: '邮件服务未配置' });
    if (!subject || !content) return res.status(400).json({ success: false, message: '请填写主题和内容' });

    let query = { email: { $ne: null, $ne: '' }, emailVerified: true };
    if (recipients === 'vip') query.isVip = true;
    else if (recipients === 'nonVip') query.isVip = { $ne: true };
    if (filterGuest === true) query.isGuest = { $ne: true };

    const users = await User.find(query).select('email studentId name');
    if (users.length === 0) return res.json({ success: false, message: '没有符合条件的收件人' });

    let successCount = 0, failCount = 0;
    for (const user of users) {
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'AG工作室 <noreply@agai.online>',
            to: user.email,
            subject: subject,
            html: `<div style="max-width:500px;margin:0 auto;padding:20px;font-family:Arial,sans-serif;"><h2 style="color:#667eea;">📋 AG工作室</h2><div style="background:#f8f9fc;padding:20px;border-radius:12px;">${content.replace(/\n/g, '<br>')}</div><p style="color:#888;margin-top:20px;text-align:center;">此邮件由管理员发送</p></div>`
          })
        });
        if (response.ok) successCount++; else failCount++;
      } catch (e) { failCount++; }
      await new Promise(r => setTimeout(r, 500));
    }
    res.json({ success: true, message: `发送完成：成功 ${successCount}，失败 ${failCount}` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/admin/email-recipients-count', adminMiddleware, async (req, res) => {
  try {
    const all = await User.countDocuments({ email: { $ne: null, $ne: '' }, emailVerified: true });
    const total = await User.countDocuments({ email: { $ne: null, $ne: '' }, emailVerified: true, isGuest: { $ne: true } });
    const vip = await User.countDocuments({ email: { $ne: null, $ne: '' }, emailVerified: true, isVip: true });
    res.json({ success: true, total, vip, all });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


// ============ 前端静态托管（login.agai.online 由 Railway 迁移至本服务） ============
const FRONTEND_DIR = path.join(__dirname, 'public');
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR, { index: 'index.html', maxAge: '1h' }));
  // 无扩展名单段路径 → 同名 .html；若是目录则跳转到带斜杠路径（兼容 /dashboard /admin /about /products）
  app.get(/^\/([^/]+)$/, (req, res, next) => {
    const seg = req.params[0];
    if (seg === 'api' || seg === 'health' || seg.includes('.')) return next();
    const file = path.join(FRONTEND_DIR, seg + '.html');
    if (fs.existsSync(file)) return res.sendFile(file);
    const dirIndex = path.join(FRONTEND_DIR, seg, 'index.html');
    if (fs.existsSync(dirIndex)) return res.redirect(301, '/' + seg + '/');
    next();
  });
}

// ============ 定时任务 ============
cron.schedule(AUTO_SIGN_CRON, () => executeAutoSign({ targetTime: AUTO_SIGN_TIME }), { timezone: "Asia/Shanghai" });

cron.schedule('0 10 * * *', () => { checkRenewalReminders().catch(err => console.error('续费提醒任务失败:', err.message)); }, { timezone: "Asia/Shanghai" });

// 每天 23:59 汇总当天（保证当天必发；已发过则跳过）
cron.schedule('59 23 * * *', () => { maybeSendAdminSignSummary(new Date(), { force: true }).catch(err => console.error('管理员汇总（当天 23:59）失败:', err.message)); }, { timezone: "Asia/Shanghai" });

// 自动签到失败兜底：22:00 与 23:30 各补签一次（只补当天该签未签成功的）
cron.schedule('0 22 * * *', () => { retryMissingSigns('22:00').catch(err => console.error('补签任务失败:', err.message)); }, { timezone: "Asia/Shanghai" });
cron.schedule('30 23 * * *', () => { retryMissingSigns('23:30').catch(err => console.error('补签任务失败:', err.message)); }, { timezone: "Asia/Shanghai" });

// 每天 00:05 兜底汇总前一天（若 23:59 因故失败）
cron.schedule('5 0 * * *', () => { const d = new Date(); d.setDate(d.getDate() - 1); maybeSendAdminSignSummary(d, { force: true }).catch(err => console.error('管理员汇总兜底失败:', err.message)); }, { timezone: "Asia/Shanghai" });

// 每天 21:00：签到前校准一次（会员到期的自动关掉自动签到、自定义时间打回 21:35）
cron.schedule('0 21 * * *', () => { reconcileAllSignAccess().then(s => { if (s.disabled || s.timeReset || s.restored) console.log('🧭 自动签到权限校准:', JSON.stringify(s)); }).catch(err => console.error('自动签到权限校准失败:', err.message)); }, { timezone: "Asia/Shanghai" });

cron.schedule('* * * * *', () => {
  const now = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  if (now === AUTO_SIGN_TIME) return;
  executeAutoSign({ targetTime: now }).catch(err => console.error('自定义时间签到失败:', err.message));
}, { timezone: "Asia/Shanghai" });

// 每分钟扫描：微信反馈的延迟自动回复（到期且管理员未回复才发；可用 AUTO_REPLY_CRON=false 关闭）
if (String(process.env.AUTO_REPLY_CRON || 'true') !== 'false') {
  cron.schedule('* * * * *', () => {
    runAutoReplies().then(r => {
      if (r.sent || r.failed) console.log('🤖 延迟自动回复:', JSON.stringify(r));
    }).catch(err => console.error('延迟自动回复任务失败:', err.message));
  });
}

// ============ 启动服务 ============
const PORT = process.env.PORT || 8080;

// 先启动 HTTP 服务，保证数据库暂时不可用时 /health 仍可返回真实状态
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 服务器运行在端口 ${PORT}`);
  console.log(`📍 版本: 3.6.0 (V免签升级 + WebSocket实时推送)`);
  console.log(`📧 邮件服务: ${RESEND_API_KEY ? 'Resend 已配置' : '未配置'}`);
  console.log(`🤖 自动签到已启用 (每天 ${AUTO_SIGN_TIME}, dry-run=${AUTO_SIGN_DRY_RUN})`);
  console.log(`🔌 WebSocket 已启用`);
});

initSystemConfig()
  .then(() => migrateMembershipV2())
  .then(() => migrateAutoSignDaily())
  .then(() => ensureCouponsSeeded())
  .catch(err => {
    console.error('❌ 系统配置初始化失败:', err.message);
  });

// 数据库稍后就绪时也补跑一次（迁移内部有幂等标记）
mongoose.connection.on('connected', () => {
  migrateMembershipV2().catch(err => console.error('会员套餐迁移失败:', err.message));
  migrateAutoSignDaily().catch(err => console.error('自动签到每日迁移失败:', err.message));
  ensureCouponsSeeded().catch(err => console.error('优惠码初始化失败:', err.message));
});
