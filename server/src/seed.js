import 'dotenv/config';
import mongoose from 'mongoose';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { User } from './models.js';
import { demoSeedAllowed } from './seed-policy.js';

const scrypt = promisify(scryptCallback);
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/campus_scheduler';
if (!demoSeedAllowed(process.env.NODE_ENV, mongoUri)) throw new Error('Development setup is restricted to local development databases and cannot run in production.');
const hashPassword = async password => {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
};

try {
  await mongoose.connect(mongoUri);
  // No fictional operational records are created. Ensure the local demo admin
  // is present with the requested credentials, without touching other accounts.
  const username = 'admin';
  const email = (process.env.SEED_ADMIN_EMAIL || 'admin@gmail.com').trim().toLowerCase();
  const matches = await User.find({ $or: [{ username }, { email }] }).select('+passwordHash');
  if (matches.length > 1) throw new Error('Conflicting admin login identifiers exist; resolve them manually.');
  if (matches.length === 1) {
    if (matches[0].role !== 'Administrator') throw new Error('The admin identifier belongs to a non-administrator; resolve it manually.');
    matches[0].username = username;
    matches[0].email = email;
    matches[0].status = 'Active';
    matches[0].passwordHash = await hashPassword('admin');
    await matches[0].save();
    console.log('Local development administrator credentials synchronized. Change the demo password before deployment.');
  } else {
    await User.create({ name: 'ACLC System Administrator', username, email, role: 'Administrator', passwordHash: await hashPassword('admin') });
    console.log('Local development administrator created. Change its password before deployment.');
  }
} finally {
  await mongoose.disconnect();
}
