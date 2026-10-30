import { randomBytes, scrypt, timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './store.mjs';
const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest();
export class AdminAuth {
  constructor(store) { this.store = store; this.settingUp = false; }
  async bootstrap() {
    if (this.store.state.admin) return;
    const file = path.join(this.store.directory, 'admin-setup-token');
    try { await writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  async setup(token, password) {
    if (this.store.state.admin || this.settingUp) throw new ApiError('ADMIN_EXISTS', '管理员密码已设置，请直接登录。', 409);
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw new ApiError('PASSWORD_INVALID', '密码须为 10–128 位。');
    const expected = await readFile(path.join(this.store.directory, 'admin-setup-token'), 'utf8');
    if (typeof token !== 'string' || !timingSafeEqual(digest(token), digest(expected))) throw new ApiError('FORBIDDEN', '设置链接无效。', 403);
    this.settingUp = true;
    try {
      const salt = randomBytes(16).toString('hex'); const hash = (await derive(password, salt, 64)).toString('hex');
      const id = randomUUID();
      this.store.state.users[id] = { id, name: '管理员', role: 'admin', quota: { budget: 0, used: 0 }, createdAt: new Date().toISOString() };
      this.store.state.admin = { userId: id, salt, hash };
      await this.store.persist();
      return this.session(id);
    } finally { this.settingUp = false; }
  }
  async login(password) {
    const admin = this.store.state.admin;
    if (!admin) throw new ApiError('ADMIN_NOT_CONFIGURED', '管理员密码尚未设置。', 409);
    const failure = this.store.state.adminFailure || { count: 0, until: 0 };
    if (failure.until > Date.now()) throw new ApiError('RATE_LIMITED', '尝试过于频繁，请 15 分钟后重试。', 429);
    if (typeof password !== 'string' || password.length > 128) throw new ApiError('PASSWORD_INVALID', '密码不正确。', 401);
    const value = await derive(password, admin.salt, 64);
    if (!timingSafeEqual(value, Buffer.from(admin.hash, 'hex'))) {
      // Re-read after hashing to account for concurrent attempts.
      const count = (this.store.state.adminFailure?.count || 0) + 1;
      this.store.state.adminFailure = { count, until: count >= 5 ? Date.now() + 15 * 60_000 : 0 };
      await this.store.persist();
      throw new ApiError('PASSWORD_INVALID', '密码不正确。', 401);
    }
    this.store.state.adminFailure = { count: 0, until: 0 };
    return this.session(admin.userId);
  }
  async session(userId) {
    const token = randomBytes(32).toString('hex');
    this.store.state.sessions[token] = { userId, expiresAt: Date.now() + 7 * 86400_000 };
    await this.store.persist();
    return { sessionToken: token, user: { id: userId, name: '管理员', role: 'admin' } };
  }
}
