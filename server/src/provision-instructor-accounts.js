import 'dotenv/config';
import mongoose from 'mongoose';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { Instructor, User } from './models.js';
import { demoSeedAllowed } from './seed-policy.js';

const scrypt = promisify(scryptCallback);
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/campus_scheduler';
if (!demoSeedAllowed(process.env.NODE_ENV, mongoUri)) {
  throw new Error('Instructor account provisioning is restricted to local development databases and cannot run in production.');
}

// These are the three pre-made instructors shown in Academic Records.
const instructorsToProvision = [
  { name: 'Ellen M. Guinares', email: 'ell.g_1557@gmail.com', username: 'ellen.guinares' },
  { name: 'Jelzon Holasca', email: 'jz1557@gmail.com', username: 'jelzon.holasca' },
  { name: 'Richelle V. Gatchalian', email: 'jai1647@gmail.com', username: 'richelle.gatchalian' }
];
const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const newPassword = () => randomBytes(18).toString('base64url');
async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}

const createdIds = [];
const updatedSetupUsers = [];
const outcomes = [];
let completed = false;
try {
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });

  for (const specification of instructorsToProvision) {
    const email = specification.email.toLowerCase();
    const instructors = await Instructor.find({ email });
    if (instructors.length !== 1 || normalize(instructors[0]?.name) !== normalize(specification.name)) {
      throw new Error(`Could not safely identify exactly one instructor for ${specification.email}. No account credentials were issued.`);
    }
    const instructor = instructors[0];
    const linkedUsers = await User.find({ instructor: instructor._id }).select('+passwordHash');
    if (linkedUsers.length > 1) throw new Error(`${specification.name} is linked to multiple accounts. Resolve the duplicate links first.`);

    let user = linkedUsers[0];
    if (!user) {
      const loginMatches = await User.find({ $or: [{ email }, { username: email }, { username: specification.username }, { email: specification.username }] }).select('+passwordHash');
      if (loginMatches.length > 1) throw new Error(`${specification.name} has ambiguous matching accounts. Review User access before provisioning.`);
      user = loginMatches[0];
      if (user && (user.role !== 'Instructor' || user.instructor || normalize(user.name) !== normalize(instructor.name) || user.email !== email)) {
        throw new Error(`${specification.name} matches an account that cannot be safely linked. Review User access before provisioning.`);
      }
    }
    if (user && (user.role !== 'Instructor' || (user.instructor && String(user.instructor) !== String(instructor._id)))) {
      throw new Error(`${specification.name} is already associated with a non-Instructor account or another instructor.`);
    }

    if (user && !user.setupRequired) {
      if (normalize(user.name) !== normalize(instructor.name) || user.email !== email) {
        throw new Error(`${specification.name} has a linked account whose identity details differ. Review the records first.`);
      }
      if (!user.instructor) {
        user.instructor = instructor._id;
        await user.save();
      }
      outcomes.push({ name: instructor.name, email, username: user.username || '(email login)', result: 'Already provisioned; existing password preserved' });
      continue;
    }

    const password = newPassword();
    const passwordHash = await hashPassword(password);
    if (user) {
      updatedSetupUsers.push({
        user,
        fields: {
          name: user.name,
          email: user.email,
          username: user.username,
          role: user.role,
          passwordHash: user.passwordHash,
          instructor: user.instructor,
          status: user.status,
          setupRequired: user.setupRequired
        }
      });
      user.name = instructor.name;
      user.email = email;
      user.username = specification.username;
      user.role = 'Instructor';
      user.instructor = instructor._id;
      user.passwordHash = passwordHash;
      user.setupRequired = false;
      user.status = instructor.status === 'Active' ? 'Active' : 'Inactive';
      await user.save();
    } else {
      user = await User.create({
        name: instructor.name,
        username: specification.username,
        email,
        role: 'Instructor',
        instructor: instructor._id,
        passwordHash,
        setupRequired: false,
        status: instructor.status === 'Active' ? 'Active' : 'Inactive'
      });
      createdIds.push(user._id);
    }
    outcomes.push({ name: instructor.name, email, username: specification.username, password, result: 'Created and linked' });
  }
  completed = true;
  console.log('Instructor account provisioning complete. Newly issued passwords are shown once; save them securely and share them directly with each instructor.');
  console.table(outcomes);
  if (outcomes.some(outcome => outcome.result === 'Already provisioned; existing password preserved')) {
    console.log('Existing passwords were preserved and cannot be displayed. Use the account password reset flow if an instructor needs a new password.');
  }
} catch (error) {
  for (const id of createdIds) await User.deleteOne({ _id: id }).catch(() => {});
  for (const previous of updatedSetupUsers.reverse()) {
    await User.updateOne({ _id: previous.user._id }, { $set: previous.fields }).catch(() => {});
  }
  throw error;
} finally {
  await mongoose.disconnect();
}
