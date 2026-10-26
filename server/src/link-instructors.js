import 'dotenv/config';
import mongoose from 'mongoose';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { Instructor, User } from './models.js';
import { demoSeedAllowed } from './seed-policy.js';

const scrypt = promisify(scryptCallback);
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/campus_scheduler';
if (!demoSeedAllowed(process.env.NODE_ENV, mongoUri)) throw new Error('Instructor account linking is restricted to local development databases and cannot run in production.');

async function createSetupHash() {
  const salt = randomBytes(16).toString('hex');
  const oneTimeUnknownSecret = randomBytes(48).toString('base64url');
  return `scrypt:${salt}:${(await scrypt(oneTimeUnknownSecret, salt, 64)).toString('hex')}`;
}
const cleanName = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

const summary = { linkedExisting: [], createdSetupAccounts: [], alreadyLinked: [], manualReview: [] };
try {
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
  const instructors = await Instructor.find().sort({ name: 1 });
  for (const instructor of instructors) {
    const linked = await User.find({ instructor: instructor._id });
    if (linked.length > 1) {
      summary.manualReview.push({ instructor: instructor.name, reason: 'Multiple accounts already reference this instructor.' });
      continue;
    }
    if (linked.length === 1) {
      if (linked[0].role === 'Instructor') summary.alreadyLinked.push({ instructor: instructor.name, account: linked[0].email });
      else summary.manualReview.push({ instructor: instructor.name, account: linked[0].email, reason: 'The linked account does not have the Instructor role.' });
      continue;
    }
    const email = String(instructor.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      summary.manualReview.push({ instructor: instructor.name, reason: 'A valid email must be added to the instructor record first.' });
      continue;
    }
    const matches = await User.find({ $or: [{ email }, { username: email }] });
    if (matches.length > 1) {
      summary.manualReview.push({ instructor: instructor.name, email, reason: 'Email matches multiple account login identifiers.' });
      continue;
    }
    if (matches.length === 1) {
      const user = matches[0];
      if (user.role !== 'Instructor' || user.email !== email || (user.instructor && String(user.instructor) !== String(instructor._id))) {
        summary.manualReview.push({ instructor: instructor.name, email, reason: 'Matching account is not an unlinked Instructor account.' });
        continue;
      }
      if (cleanName(user.name) !== cleanName(instructor.name)) {
        summary.manualReview.push({ instructor: instructor.name, email, reason: 'Email matches an Instructor account but the names differ; confirm identity manually.' });
        continue;
      }
      const previousUserStatus = user.status;
      const previousInstructorStatus = instructor.status;
      user.instructor = instructor._id;
      user.status = user.status === 'Active' && instructor.status === 'Active' ? 'Active' : 'Inactive';
      try {
        await user.save();
        instructor.status = user.status;
        await instructor.save();
      } catch (error) {
        user.instructor = undefined;
        user.status = previousUserStatus;
        await user.save().catch(() => {});
        instructor.status = previousInstructorStatus;
        await instructor.save().catch(() => {});
        throw error;
      }
      summary.linkedExisting.push({ instructor: instructor.name, account: email });
      continue;
    }
    const user = await User.create({
      name: instructor.name,
      email,
      role: 'Instructor',
      instructor: instructor._id,
      status: 'Inactive',
      setupRequired: true,
      passwordHash: await createSetupHash()
    });
    summary.createdSetupAccounts.push({ instructor: instructor.name, account: user.email, setupRequired: true });
  }
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await mongoose.disconnect();
}
