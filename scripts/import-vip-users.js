#!/usr/bin/env node
/**
 * 把 main.py 导出的付费用户 JSON 幂等迁移到 MongoDB。
 *
 * 用法：
 *   MONGODB_URI=... node scripts/import-vip-users.js <paid-users.json> [选项]
 *
 * 选项：
 *   --dry-run                 只统计，不写入
 *   --mark-email-verified     对迁移用户标记邮箱已验证（默认不标记）
 *   --overwrite-passwords     覆盖已有用户的考勤密码（默认只在为空时填充）
 *
 * 安全原则：
 * - 不删除任何用户/集合；
 * - 已有用户的到期时间更晚时保留更晚的时间（不缩短会员）；
 * - 已有用户的邮箱/密码/姓名默认不覆盖，只在为空时补全；
 * - 输出只打印数量，不打印学号、邮箱、密码。
 */

const fs = require('fs');
const mongoose = require('mongoose');

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('❌ 未设置 MONGODB_URI');
  process.exit(1);
}

const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('用法：node scripts/import-vip-users.js <paid-users.json> [--dry-run] [--mark-email-verified] [--overwrite-passwords]');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const markEmailVerified = process.argv.includes('--mark-email-verified');
const overwritePasswords = process.argv.includes('--overwrite-passwords');

const TIERS = ['FREE', 'VIP', 'SVIP', 'YEARLY', 'TERM', 'LEGACY'];
const RANK = { FREE: 0, VIP: 1, TERM: 2, YEARLY: 3, SVIP: 4, LEGACY: 4 };
const DEFAULT_PASSWORD = 'Ahgydx@920';

const userSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true },
  name: String,
  email: String,
  emailVerified: Boolean,
  isVip: Boolean,
  vipExpireAt: Date,
  vipTier: String,
  vipStartAt: Date,
  attendancePassword: String,
  role: String,
  isActive: Boolean,
  isGuest: Boolean,
  source: String,
  createdAt: Date
}, { strict: false, collection: 'users' });

const User = mongoose.models.User || mongoose.model('User', userSchema);

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function laterDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

async function main() {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(entries)) {
    throw new Error('JSON 顶层必须是数组');
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  console.log(`📄 待处理记录：${entries.length}`);
  console.log(`🧪 dry-run：${dryRun ? '是' : '否'} | 标记邮箱已验证：${markEmailVerified ? '是' : '否'}`);

  const now = new Date();
  const stats = {
    created: 0, updated: 0, skipped: 0, errors: 0,
    wouldCreate: 0, wouldUpdate: 0,
    activeVip: 0, expiredVip: 0,
    emailFilled: 0, emailMismatch: 0,
    passwordFilled: 0, nameFilled: 0
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] || {};
    const studentId = String(entry.studentId || '').trim();
    const tier = String(entry.tier || 'TERM').toUpperCase();

    if (!studentId || !TIERS.includes(tier)) {
      stats.skipped++;
      continue;
    }

    const importedExpire = parseDate(entry.vipExpireAt);
    const importedStart = parseDate(entry.startDate);

    try {
      const existing = await User.findOne({ studentId }).lean();

      if (!existing) {
        const finalExpire = importedExpire;
        const isVip = Boolean(finalExpire && finalExpire > now);
        if (isVip) stats.activeVip++; else if (finalExpire) stats.expiredVip++;

        if (dryRun) {
          stats.wouldCreate++;
          continue;
        }

        await User.create({
          studentId,
          name: entry.name || studentId,
          email: entry.email || '',
          emailVerified: Boolean(markEmailVerified && entry.email),
          isVip,
          vipExpireAt: finalExpire,
          vipTier: tier,
          vipStartAt: importedStart,
          attendancePassword: entry.attendancePassword || DEFAULT_PASSWORD,
          role: 'user',
          isActive: true,
          isGuest: false,
          source: 'attendance',
          createdAt: new Date()
        });
        stats.created++;
        continue;
      }

      // 只在导入的到期时间更晚时替换，绝不缩短已有会员
      const existingExpire = parseDate(existing.vipExpireAt);
      const finalExpire = laterDate(existingExpire, importedExpire);
      const importedIsNewer = importedExpire && (!existingExpire || importedExpire > existingExpire);

      let finalTier = existing.vipTier || 'FREE';
      if (importedIsNewer) {
        finalTier = tier;
      } else if ((!finalTier || finalTier === 'FREE') && finalExpire && finalExpire > now) {
        finalTier = tier;
      } else if (RANK[tier] > RANK[finalTier]) {
        finalTier = tier;
      }

      const isVip = Boolean(finalExpire && finalExpire > now);
      if (isVip) stats.activeVip++; else if (finalExpire) stats.expiredVip++;

      const set = {
        isVip,
        vipExpireAt: finalExpire,
        vipTier: finalTier
      };

      if (!existing.vipStartAt && importedStart) set.vipStartAt = importedStart;

      // 只在为空时补全，避免覆盖站点上更新的资料
      if (!existing.email && entry.email) {
        set.email = entry.email;
        stats.emailFilled++;
      } else if (existing.email && entry.email && existing.email.toLowerCase() !== entry.email.toLowerCase()) {
        stats.emailMismatch++;
      }

      if (!existing.name || existing.name === existing.studentId) {
        if (entry.name) {
          set.name = entry.name;
          stats.nameFilled++;
        }
      }

      const shouldSetPassword = overwritePasswords || !existing.attendancePassword;
      if (entry.attendancePassword && shouldSetPassword) {
        set.attendancePassword = entry.attendancePassword;
        stats.passwordFilled++;
      }

      if (markEmailVerified && entry.email && (!existing.email || existing.email.toLowerCase() === entry.email.toLowerCase())) {
        set.emailVerified = true;
      }

      if (dryRun) {
        stats.wouldUpdate++;
        continue;
      }

      await User.updateOne({ studentId }, { $set: set });
      stats.updated++;
    } catch (err) {
      stats.errors++;
      console.error(`❌ 第 ${i + 1} 条处理失败：${err.message}`);
    }
  }

  console.log('\n===== 迁移结果 =====');
  if (dryRun) {
    console.log(`将新建：${stats.wouldCreate}`);
    console.log(`将更新：${stats.wouldUpdate}`);
  } else {
    console.log(`新建：${stats.created}`);
    console.log(`更新：${stats.updated}`);
  }
  console.log(`跳过（字段不合法）：${stats.skipped}`);
  console.log(`错误：${stats.errors}`);
  console.log(`当前有效 VIP：${stats.activeVip} | 已过期但保留标签：${stats.expiredVip}`);
  console.log(`补全邮箱：${stats.emailFilled} | 邮箱与现有记录不一致：${stats.emailMismatch}`);
  console.log(`补全密码：${stats.passwordFilled} | 补全姓名：${stats.nameFilled}`);
  console.log('未删除任何用户或集合。');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌ 迁移失败：', err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
