import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { User } from './models.js';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });
const uri = process.env.MONGODB_URI;
const email = String(process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
const username = String(process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin').trim();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
if (!uri) throw new Error('Set MONGODB_URI for the intended database.');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Set a valid BOOTSTRAP_ADMIN_EMAIL.');
if (username.length < 3 || username.length > 40) throw new Error('BOOTSTRAP_ADMIN_USERNAME must be 3 to 40 characters.');
if (password.length < 16) throw new Error('Set a strong BOOTSTRAP_ADMIN_PASSWORD of at least 16 characters.');

try {
  await mongoose.connect(uri);
  if (await User.countDocuments() !== 0) throw new Error('Bootstrap only creates the first administrator when the users collection is empty; no records were changed.');
  const salt = randomBytes(16).toString('hex');
  const hash = (await promisify(scryptCallback)(password, salt, 64)).toString('hex');
  await User.create({ name: 'System Administrator', username, email, role: 'Administrator', passwordHash: `scrypt:${salt}:${hash}` });
  console.log('First administrator created. Sign in and rotate credentials according to your deployment policy.');
} finally {
  await mongoose.disconnect();
}
