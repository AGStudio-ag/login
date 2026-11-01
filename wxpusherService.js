'use strict';
/**
 * WxPusher 封装（普通用户的微信绑定 + 签到结果通知）
 * - 与管理员推送共用同一个 AppToken，但完全独立：任何失败只返回结果/记日志，绝不抛异常给调用方
 * - 接口文档：https://wxpusher.zjiecode.com/docs
 */
const BASE = 'https://wxpusher.zjiecode.com/api';
const API_QRCODE = `${BASE}/fun/create/qrcode`;
const API_USERS = `${BASE}/fun/wxuser/v2`;
const API_SEND = `${BASE}/send/message`;

async function callJson(url, { method = 'GET', body = null, timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    return { ok: res.ok && !!data && Number(data.code) === 1000, status: res.status, data, text };
  } catch (e) {
    return { ok: false, status: 0, data: null, text: '', error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 生成带参二维码；extra 会在用户扫码关注后由 WxPusher 记到 uid 上（回调时带回） */
async function createQrcode(appToken, extra, validTime = 600) {
  const token = String(appToken || '').trim();
  if (!token) return { ok: false, message: '未配置 WxPusher AppToken' };
  const r = await callJson(API_QRCODE, { method: 'POST', body: { appToken: token, extra: String(extra || ''), validTime } });
  if (!r.ok) return { ok: false, message: (r.data && (r.data.msg || r.data.message)) || r.error || '生成二维码失败', raw: r.data };
  const d = r.data.data || {};
  return { ok: true, url: d.url || d.shortUrl || '', shortUrl: d.shortUrl || '', code: d.code || '', expires: d.expires || 0, extra: d.extra || extra };
}

/** 列出订阅者（用于「刚扫完还没回调」时的兜底绑定） */
async function listUsers(appToken, page = 1, pageSize = 50) {
  const token = String(appToken || '').trim();
  if (!token) return { ok: false, message: '未配置 WxPusher AppToken', records: [] };
  const r = await callJson(`${API_USERS}?appToken=${encodeURIComponent(token)}&page=${page}&pageSize=${pageSize}`);
  if (!r.ok) return { ok: false, message: (r.data && (r.data.msg || r.data.message)) || r.error || '查询订阅者失败', records: [] };
  const records = (r.data.data && r.data.data.records) || [];
  return { ok: true, total: (r.data.data && r.data.data.total) || records.length, records };
}

/** 推给单个 uid；失败只返回 ok:false，不抛 */
async function sendToUid(appToken, uid, summary, content, { timeout = 8000 } = {}) {
  const token = String(appToken || '').trim();
  const target = String(uid || '').trim();
  if (!token) return { ok: false, message: '未配置 WxPusher AppToken' };
  if (!target) return { ok: false, message: '缺少 uid' };
  const r = await callJson(API_SEND, {
    method: 'POST',
    timeout,
    body: {
      appToken: token,
      content: String(content || '').slice(0, 4000),
      summary: String(summary || '').slice(0, 40),
      contentType: 1,
      uids: [target]
    }
  });
  if (!r.ok) return { ok: false, message: (r.data && (r.data.msg || r.data.message)) || r.error || '发送失败', raw: r.data };
  return { ok: true, raw: r.data };
}

/** 签到结果文案（成功/失败统一口径） */
function signResultMessage({ studentId, success, reason }) {
  const sid = String(studentId || '');
  if (success) {
    return { summary: '签到成功', content: `✅ 学号${sid} 今日签到成功（${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）` };
  }
  return { summary: '签到失败', content: `❌ 学号${sid} 签到失败，原因：${reason || '未知原因'}\n可以打开 AG 考勤手动补签。` };
}

module.exports = { createQrcode, listUsers, sendToUid, signResultMessage };
