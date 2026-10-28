#!/usr/bin/env node
/**
 * 在迁移/部署前做一次全量 JSON 备份。
 * 用法：MONGODB_URI=... node scripts/backup-mongo.js [输出目录]
 * 输出目录默认：<repo>/backups/<时间戳>/
 *
 * 注意：备份包含用户邮箱、考勤密码等敏感数据，只保存在本机，
 * 不要提交到 GitHub，也不要上传到公开位置。
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// 不依赖顶层 bson 版本，统一转成 EJSON 兼容的 JSON 结构。
// 这样 Mongoose/MongoDB 驱动升级后备份脚本不会因 BSON 版本冲突而失败。
function toBackupJson(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Buffer.isBuffer(value)) {
    return { $binary: { base64: value.toString('base64'), subType: '00' } };
  }
  if (Array.isArray(value)) return value.map(toBackupJson);
  if (typeof value === 'object') {
    if (value._bsontype === 'ObjectId' || value.constructor?.name === 'ObjectId') {
      return { $oid: value.toHexString() };
    }
    if (value._bsontype === 'Long') return { $numberLong: String(value) };
    if (value._bsontype === 'Decimal128') return { $numberDecimal: String(value) };
    if (value._bsontype === 'Binary') {
      return { $binary: { base64: value.buffer.toString('base64'), subType: value.sub_type } };
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toBackupJson(v);
    return out;
  }
  return value;
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('❌ 未设置 MONGODB_URI');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'backups', stamp);

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const collections = await db.listCollections().toArray();
  const manifest = {
    createdAt: new Date().toISOString(),
    database: db.databaseName,
    collections: {}
  };

  for (const info of collections.sort((a, b) => a.name.localeCompare(b.name))) {
    if (info.name.startsWith('system.')) continue;
    const docs = await db.collection(info.name).find({}).toArray();
    const file = path.join(outDir, `${info.name}.json`);
    fs.writeFileSync(file, JSON.stringify(toBackupJson(docs), null, 2), 'utf8');
    manifest.collections[info.name] = docs.length;
    console.log(`✅ ${info.name}: ${docs.length} 条`);
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\n📦 备份完成：${outDir}`);
  console.log('⚠️ 备份含敏感数据，请仅保存在本机。');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌ 备份失败：', err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
