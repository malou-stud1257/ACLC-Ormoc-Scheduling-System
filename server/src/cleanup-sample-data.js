import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { Room, Instructor, Course, Section, AcademicTerm, Schedule, ReservationRequest, User } from './models.js';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });
const uri = process.env.MONGODB_URI || '';
const confirmation = process.argv.find(arg => arg.startsWith('--confirm='))?.slice('--confirm='.length);
let parsed;
try { parsed = new URL(uri); } catch { throw new Error('Set MONGODB_URI to the intended local development database before cleanup.'); }
const database = parsed.pathname.replace(/^\//, '').split('/')[0];
if (process.env.NODE_ENV === 'production') throw new Error('Cleanup is disabled in production.');
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname.toLowerCase())) throw new Error('Cleanup only supports a loopback MongoDB server.');
if (!database || database !== 'campus_scheduler') throw new Error(`Cleanup is restricted to the campus_scheduler database; configured database is ${database || '(unspecified)'}.`);

const roomFixtures = [
  { code: 'A-204', name: 'A-204', type: 'Classroom', building: 'Academic Building', capacity: 40, resources: ['Projector', 'Whiteboard'] },
  { code: 'A-108', name: 'A-108', type: 'Classroom', building: 'Academic Building', capacity: 32, resources: ['Projector', 'Air conditioning'] },
  { code: 'SCI-2', name: 'Science Lab 2', type: 'Laboratory', building: 'Science Center', capacity: 28, resources: ['Lab benches', 'Safety equipment'] },
  { code: 'COMP-1', name: 'Computer Lab 1', type: 'Computer Laboratory', building: 'Technology Wing', capacity: 36, resources: ['Computers', 'Projector'] },
  { code: 'LH-1', name: 'Lecture Hall', type: 'Lecture hall', building: 'Main Building', capacity: 100, resources: ['Projector', 'Microphone'] }
];
const instructorFixtures = [
  { employeeId: 'FAC-001', name: 'Maya Santos', email: 'maya.santos@campus.edu', department: 'Computer Science' },
  { employeeId: 'FAC-002', name: 'Daniel Reyes', email: 'daniel.reyes@campus.edu', department: 'Sciences' },
  { employeeId: 'FAC-003', name: 'Althea Cruz', email: 'althea.cruz@campus.edu', department: 'Mathematics' }
];
const courseFixtures = [
  { code: 'CS 201', title: 'Data Structures', department: 'Computer Science' },
  { code: 'BIO 110', title: 'General Biology', department: 'Sciences' },
  { code: 'MATH 204', title: 'Applied Statistics', department: 'Mathematics' }
];
const sectionFixtures = [
  { name: 'BSCS 2A', program: 'Computer Science', yearLevel: 'Year 2', studentCount: 34 },
  { name: 'BSBIO 1B', program: 'Biology', yearLevel: 'Year 1', studentCount: 26 },
  { name: 'BSIT 2C', program: 'Information Technology', yearLevel: 'Year 2', studentCount: 31 }
];
const same = (doc, fixture, fields) => fields.every(field => JSON.stringify(doc[field] ?? null) === JSON.stringify(fixture[field] ?? null));
const counts = { candidate: {}, removed: {}, skipped: {} };
const add = (bucket, type) => { counts[bucket][type] = (counts[bucket][type] || 0) + 1; };

try {
  await mongoose.connect(uri);
  console.log(`Target database: ${database} (${parsed.hostname})`);
  const rooms = (await Room.find()).filter(doc => roomFixtures.some(f => same(doc, f, ['code', 'name', 'type', 'building', 'capacity', 'resources'])));
  const instructors = (await Instructor.find()).filter(doc => instructorFixtures.some(f => same(doc, f, ['employeeId', 'name', 'email', 'department'])));
  const courses = (await Course.find()).filter(doc => courseFixtures.some(f => same(doc, f, ['code', 'title', 'department'])));
  const sections = (await Section.find()).filter(doc => sectionFixtures.some(f => same(doc, f, ['name', 'program', 'yearLevel', 'studentCount'])));
  const term = await AcademicTerm.findOne({ name: 'First Semester', schoolYear: '2026–27', status: 'Active' });
  const candidates = [
    ...rooms.map(doc => ['rooms', doc, Schedule.exists({ room: doc._id }).then(Boolean).then(async schedule => schedule || Boolean(await ReservationRequest.exists({ room: doc._id })))]),
    ...instructors.map(doc => ['instructors', doc, Schedule.exists({ instructor: doc._id }).then(Boolean).then(async schedule => schedule || Boolean(await ReservationRequest.exists({ $or: [{ instructor: doc._id }, { requesterInstructor: doc._id }] }) || await User.exists({ instructor: doc._id })))]),
    ...courses.map(doc => ['courses', doc, Schedule.exists({ course: doc._id }).then(Boolean).then(async schedule => schedule || Boolean(await ReservationRequest.exists({ course: doc._id })))]),
    ...sections.map(doc => ['sections', doc, Schedule.exists({ section: doc._id }).then(Boolean).then(async schedule => schedule || Boolean(await ReservationRequest.exists({ section: doc._id })))]),
    ...(term ? [['terms', term, Schedule.exists({ term: term._id }).then(Boolean).then(async schedule => schedule || Boolean(await ReservationRequest.exists({ term: term._id })))] ] : [])
  ];
  for (const [kind, doc, dependencyPromise] of candidates) {
    const referenced = await dependencyPromise;
    if (referenced) { add('skipped', kind); continue; }
    add('candidate', kind);
    if (confirmation === database) { await doc.deleteOne(); add('removed', kind); }
  }

  // Demo users are removable only when their full known identity matches and
  // no operational history refers to the account or its linked instructor.
  const accountFixtures = [
    { name: 'Scheduling Office', email: 'scheduler@campus.edu', role: 'Scheduler' },
    { name: 'Maya Santos', email: 'maya.santos@campus.edu', role: 'Instructor' },
    { name: 'Schedule Viewer', email: 'viewer@campus.edu', role: 'Student / Schedule Viewer' }
  ];
  for (const user of await User.find({ email: { $in: accountFixtures.map(x => x.email) } })) {
    const fixture = accountFixtures.find(x => x.email === user.email);
    const linked = user.instructor && await (Schedule.exists({ instructor: user.instructor }) || ReservationRequest.exists({ $or: [{ requesterInstructor: user.instructor }, { instructor: user.instructor }] }));
    const requestHistory = await ReservationRequest.exists({ requesterEmail: user.email });
    if (!same(user, fixture, ['name', 'email', 'role']) || linked || requestHistory) { add('skipped', 'users'); continue; }
    add('candidate', 'users');
    if (confirmation === database) { await user.deleteOne(); add('removed', 'users'); }
  }
  console.log(JSON.stringify(counts, null, 2));
  if (confirmation !== database) console.log(`Dry run only. Review the candidates, then rerun with --confirm=${database} to remove eligible exact matches.`);
  else console.log('Cleanup complete. Referenced, non-matching, and ambiguous records were preserved.');
} finally { await mongoose.disconnect(); }
