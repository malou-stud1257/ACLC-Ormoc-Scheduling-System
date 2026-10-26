import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Room, Resource, Instructor, Course, Section, AcademicTerm, Schedule, ReservationRequest, User, AuditLog, BookingLock } from './models.js';
import { overlaps as overlap, validTimeRange, validDateOnly, weekdayOccursBetween, dayOf } from './scheduling.js';
import { loginIdentifierQuery, normalizeLoginIdentifier, resolveActiveLoginMatch, validLoginInput } from './login.js';
import { ACADEMIC_SEMESTERS, COURSE_DEPARTMENTS, INSTRUCTOR_DEPARTMENTS, SECTION_NAMES, SECTION_PROGRAMS, positiveWholeNumber } from '../../shared/academic-options.js';
import { ROOM_FLOORS } from '../../shared/room-options.js';
import { ROLE, ROLE_VALUES, MANAGER_ROLES, canRead, canWrite } from '../../shared/permissions.js';

const app = express();
const allowedOrigins = [...new Set([
  ...(process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map(origin => origin.trim()).filter(Boolean),
  'https://localhost',
  'http://localhost'
])];
app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)) }));
app.use(express.json({ limit: '1mb' }));
const scrypt = promisify(scryptCallback);
const manager = MANAGER_ROLES;
const roles = ROLE_VALUES;
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const permit = (...allowed) => (req, res, next) => allowed.includes(req.user.role) ? next() : res.status(403).json({ message: 'Your role cannot perform this action.' });
const policyPermit = (permission, resource) => (req, res, next) => (permission === 'read' ? canRead(req.user.role, resource) : canWrite(req.user.role, resource)) ? next() : res.status(403).json({ message: 'Your role cannot perform this action.' });
const publicUser = u => ({ _id: u._id, name: u.name, username: u.username, email: u.email, role: u.role, status: u.status, setupRequired: Boolean(u.setupRequired), instructor: u.instructor, section: u.section });
const academicFields = {
  courses: ['code', 'title', 'department', 'status'],
  instructors: ['employeeId', 'name', 'email', 'department', 'status'],
  sections: ['name', 'program', 'yearLevel', 'studentCount', 'status'],
  terms: ['name', 'schoolYear', 'startDate', 'endDate', 'status']
};
const academicOptions = { courses: { department: COURSE_DEPARTMENTS }, instructors: { department: INSTRUCTOR_DEPARTMENTS }, sections: { name: SECTION_NAMES, program: SECTION_PROGRAMS }, terms: { name: ACADEMIC_SEMESTERS } };
const searchFields = {
  courses: ['code', 'title', 'department'], instructors: ['employeeId', 'name', 'email', 'department'],
  sections: ['name', 'program', 'yearLevel'], terms: ['name', 'schoolYear']
};
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function academicPayload(path, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Provide a valid record.'), { status: 400 });
  const allowed = academicFields[path];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw Object.assign(new Error('The request contains fields this record cannot change.'), { status: 400 });
  const data = Object.fromEntries(allowed.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
  const numericFields = path === 'sections' ? ['yearLevel', 'studentCount'] : [];
  const stringFields = allowed.filter(key => !numericFields.includes(key) && key !== 'startDate' && key !== 'endDate');
  if (stringFields.some(key => Object.hasOwn(data, key) && typeof data[key] !== 'string')) throw Object.assign(new Error('Text fields must contain text values.'), { status: 400 });
  if (path === 'courses' && (('code' in data && !data.code.trim()) || ('title' in data && !data.title.trim()))) throw Object.assign(new Error('Course code and title are required.'), { status: 400 });
  if (path === 'instructors' && ('name' in data && !data.name.trim())) throw Object.assign(new Error('Instructor name is required.'), { status: 400 });
  if (path === 'terms' && (('name' in data && !data.name.trim()) || ('schoolYear' in data && !data.schoolYear.trim()))) throw Object.assign(new Error('Term name and school year are required.'), { status: 400 });
  for (const [field, options] of Object.entries(academicOptions[path] || {})) {
    if (Object.hasOwn(data, field) && data[field] !== '' && !options.includes(data[field])) throw Object.assign(new Error(`Choose a valid ${field === 'name' ? 'semester' : field}.`), { status: 400 });
    if (Object.hasOwn(data, field) && data[field] === '' && field !== 'name') delete data[field];
  }
  if (path === 'sections') {
    if (Object.hasOwn(data, 'yearLevel')) {
      data.yearLevel = data.yearLevel === '' ? undefined : positiveWholeNumber(data.yearLevel);
      if (data.yearLevel === null) throw Object.assign(new Error('Year level must be a positive whole number.'), { status: 400 });
      if (data.yearLevel === undefined) delete data.yearLevel;
    }
  }
  if (path === 'instructors' && data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) throw Object.assign(new Error('Enter a valid instructor email address.'), { status: 400 });
  if (path === 'instructors' && Object.hasOwn(data, 'employeeId')) {
    data.employeeId = data.employeeId.trim();
    if (!data.employeeId) delete data.employeeId;
  }
  if (path === 'terms') {
    for (const key of ['startDate', 'endDate']) if (Object.hasOwn(data, key)) data[key] = data[key] ? new Date(data[key]) : null;
    const start = data.startDate ?? body.startDate;
    const end = data.endDate ?? body.endDate;
    if (start && end && start > end) throw Object.assign(new Error('The term start date must not be after its end date.'), { status: 400 });
  }
  if (path === 'sections' && Object.hasOwn(data, 'studentCount')) {
    data.studentCount = Number(data.studentCount);
    if (!Number.isInteger(data.studentCount) || data.studentCount < 0) throw Object.assign(new Error('Student count must be a whole number of zero or more.'), { status: 400 });
  }
  return data;
}
async function ensureAcademicUnique(path, data, exceptId) {
  const Model = collections[path];
  const duplicate = async filter => Model.exists({ ...filter, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
  if (path === 'courses' && data.code && await duplicate({ code: new RegExp(`^${escapeRegex(data.code.trim())}$`, 'i') })) throw Object.assign(new Error('A course with this code already exists.'), { status: 409 });
  if (path === 'instructors') {
    if (data.employeeId && await duplicate({ employeeId: data.employeeId.trim() })) throw Object.assign(new Error('An instructor with this ID already exists.'), { status: 409 });
    if (data.email && await duplicate({ email: data.email.trim().toLowerCase() })) throw Object.assign(new Error('An instructor with this email already exists.'), { status: 409 });
  }
  if (path === 'terms' && data.name && data.schoolYear && await duplicate({ name: new RegExp(`^${escapeRegex(data.name.trim())}$`, 'i'), schoolYear: new RegExp(`^${escapeRegex(data.schoolYear.trim())}$`, 'i') })) throw Object.assign(new Error('This academic term already exists.'), { status: 409 });
}
async function academicDependencies(path, id) {
  const counts = {};
  const count = async (label, query) => { const value = await query; if (value) counts[label] = value; };
  if (path === 'courses') {
    await count('schedules', Schedule.countDocuments({ course: id }));
    await count('reservations', ReservationRequest.countDocuments({ course: id }));
  } else if (path === 'instructors') {
    await count('schedules', Schedule.countDocuments({ instructor: id }));
    await count('reservations', ReservationRequest.countDocuments({ $or: [{ instructor: id }, { requesterInstructor: id }] }));
    await count('linked user accounts', User.countDocuments({ instructor: id }));
  } else if (path === 'sections') {
    await count('schedules', Schedule.countDocuments({ section: id }));
    await count('reservations', ReservationRequest.countDocuments({ section: id }));
  } else if (path === 'terms') {
    await count('schedules', Schedule.countDocuments({ term: id }));
    await count('reservations', ReservationRequest.countDocuments({ term: id }));
  }
  return counts;
}
async function conflictingLoginIdentifier(username, email, exceptId) {
  const emailLower = String(email || '').trim().toLowerCase();
  const alternatives = [{ email: emailLower }, { username: emailLower }];
  if (username) alternatives.push({ username }, { email: username.toLowerCase() });
  return User.exists({ $or: alternatives, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
}
const schoolToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.SCHOOL_TIME_ZONE || 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function weekBounds(weekStart) {
  const date = new Date(`${weekStart}T12:00:00Z`);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - ((day + 6) % 7));
  const from = date.toISOString().slice(0, 10);
  date.setUTCDate(date.getUTCDate() + 6);
  return { from, to: date.toISOString().slice(0, 10) };
}
async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) throw Object.assign(new Error('Password must be 10–200 characters.'), { status: 400 });
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}
const randomSetupPassword = () => randomBytes(48).toString('base64url');
const normalizeEmail = email => String(email || '').trim().toLowerCase();
function requireInstructorEmail(email) {
  const normalized = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw Object.assign(new Error('A valid email address is required to link an instructor account.'), { status: 400 });
  return normalized;
}
async function linkedInstructorUser(instructorId) {
  return User.findOne({ instructor: instructorId });
}
async function createSetupAccount(instructor) {
  const email = requireInstructorEmail(instructor.email);
  const byEmail = await User.findOne({ email });
  if (byEmail) {
    if (byEmail.role !== 'Instructor' || (byEmail.instructor && String(byEmail.instructor) !== String(instructor._id))) throw Object.assign(new Error('An account already uses this instructor email and cannot be linked safely. Resolve the account conflict first.'), { status: 409 });
    const alreadyLinked = await linkedInstructorUser(instructor._id);
    if (alreadyLinked && String(alreadyLinked._id) !== String(byEmail._id)) throw Object.assign(new Error('This instructor is already linked to another account.'), { status: 409 });
    byEmail.instructor = instructor._id;
    await byEmail.save();
    return byEmail;
  }
  if (await conflictingLoginIdentifier(undefined, email)) throw Object.assign(new Error('The instructor email conflicts with another account login identifier.'), { status: 409 });
  return User.create({ name: instructor.name, email, role: 'Instructor', instructor: instructor._id, status: 'Inactive', setupRequired: true, passwordHash: await hashPassword(randomSetupPassword()) });
}
async function syncInstructorToAccount(instructor, { syncStatus = false } = {}) {
  const user = await linkedInstructorUser(instructor._id);
  if (!user) return null;
  if (user.role !== 'Instructor') throw Object.assign(new Error('The instructor link points to a non-instructor account. Correct the link before editing this record.'), { status: 409 });
  const email = requireInstructorEmail(instructor.email);
  if (await conflictingLoginIdentifier(user.username, email, user._id)) throw Object.assign(new Error('The instructor email conflicts with another account login identifier.'), { status: 409 });
  user.name = instructor.name;
  user.email = email;
  if (syncStatus) user.status = instructor.status === 'Active' && !user.setupRequired ? 'Active' : 'Inactive';
  await user.save();
  return user;
}
async function checkPassword(password, encoded) {
  const [, salt, hex] = (encoded || '').split(':');
  if (!salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = await scrypt(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function sign(user) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters.');
  const payload = Buffer.from(JSON.stringify({ sub: user._id, iat: Date.now(), exp: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url');
  const signature = createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
function authenticate(req, res, next) {
  const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  try {
    if (!token || !process.env.JWT_SECRET) throw new Error('missing');
    const [payload, signature] = token.split('.');
    const expected = createHmac('sha256', process.env.JWT_SECRET).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('signature');
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (parsed.exp < Date.now()) throw new Error('expired');
    req.authId = parsed.sub;
    next();
  } catch { res.status(401).json({ message: 'Sign in to continue.' }); }
}
app.get('/', (_req, res) => res.type('text').send('Campus Room Scheduler API is running.'));
app.get('/api/health', (_req, res) => res.json({ ok: true, database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' }));
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const rawIdentifier = req.body.identifier ?? req.body.email;
  const identifier = normalizeLoginIdentifier(rawIdentifier);
  if (!validLoginInput(identifier, req.body.password)) return res.status(400).json({ message: 'Enter a valid username or email address and password.' });
  const matches = await User.find(loginIdentifierQuery(identifier)).select('+passwordHash').limit(2);
  const user = resolveActiveLoginMatch(matches);
  if (!user || user.setupRequired || !await checkPassword(req.body.password, user.passwordHash)) return res.status(401).json({ message: 'Username/email or password is incorrect.' });
  res.json({ token: sign(user), user: publicUser(user) });
}));
app.use('/api', authenticate, asyncRoute(async (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth/')) return next();
  const user = await User.findById(req.authId);
  if (!user || user.status !== 'Active') return res.status(401).json({ message: 'This account is unavailable. Sign in again.' });
  if (!roles.includes(user.role)) return res.status(403).json({ message: 'This account has no valid system role. Ask an administrator to review it.' });
  if (user.role === ROLE.INSTRUCTOR) {
    const instructor = await Instructor.findOne({ _id: user.instructor, email: user.email, status: 'Active' });
    if (!instructor) return res.status(403).json({ message: 'This instructor account is not linked to an active matching instructor profile.' });
  }
  req.user = user;
  next();
}));
app.get('/api/me', asyncRoute(async (req, res) => res.json(publicUser(req.user))));
async function requireStudentSection(user) {
  if (user.role !== ROLE.STUDENT) return null;
  const section = user.section && await Section.findOne({ _id: user.section, status: 'Active' });
  if (!section) throw Object.assign(new Error('This student account is not assigned to an active section. Ask an administrator to update User access.'), { status: 403 });
  return section;
}
const ownRequestFilter = user => ({ $or: [
  { requesterUser: user._id },
  { requesterUser: { $exists: false }, requesterInstructor: user.instructor }
] });
const populateSchedule = q => q.populate('course instructor section room term');
function scheduleInputError(data) {
  const required = ['course', 'instructor', 'section', 'room', 'term', 'day', 'startTime', 'endTime'];
  if (required.some(field => data[field] === undefined || data[field] === null || data[field] === '')) return 'Complete all required schedule fields.';
  if (!['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].includes(data.day)) return 'Choose a valid weekday.';
  if (!validTimeRange(data.startTime, data.endTime)) return 'Enter valid 24-hour times with the end later than the start.';
  if (!['course', 'instructor', 'section', 'room', 'term'].every(field => mongoose.isValidObjectId(data[field]))) return 'Choose valid course, instructor, section, room, and academic term records.';
  return null;
}

async function scheduleConflicts(data, excludeId) {
  const issues = [];
  if (!validTimeRange(data.startTime, data.endTime)) issues.push({ assignment: 'Time range', message: 'Enter a valid time range with the end after the start.' });
  if (!['course', 'instructor', 'section', 'room', 'term'].every(field => mongoose.isValidObjectId(data[field]))) return [...issues, { assignment: 'Records', message: 'Choose valid course, instructor, section, room, and academic term records.' }];
  const [room, instructor, section, term] = await Promise.all([Room.findById(data.room), Instructor.findById(data.instructor), Section.findById(data.section), AcademicTerm.findById(data.term)]);
  if (!room || !instructor || !section || !term) return [...issues, { assignment: 'Records', message: 'Choose an existing room, instructor, section, and academic term.' }];
  if (room.status !== 'Active') issues.push({ assignment: 'Room', message: `${room.name} is not active and available.` });
  if (instructor.status !== 'Active' || section.status !== 'Active' || term.status !== 'Active') issues.push({ assignment: 'Records', message: 'The instructor, section, and academic term must be active.' });
  if (section.studentCount > room.capacity) issues.push({ assignment: 'Capacity', message: `${room.name} holds ${room.capacity}, but this section has ${section.studentCount} students.` });
  const course = await Course.findById(data.course);
  if (!course || course.status !== 'Active') issues.push({ assignment: 'Course', message: 'Choose an active course.' });
  const requiredResources = Array.isArray(data.resources) ? data.resources : typeof data.resources === 'string' ? data.resources.split(',').map(x => x.trim()).filter(Boolean) : [];
  const roomResources = (room.resources || []).map(x => String(x).toLowerCase());
  const missingResources = requiredResources.filter(x => !roomResources.includes(String(x).toLowerCase()));
  if (missingResources.length) issues.push({ assignment: 'Resources', message: `${room.name} does not list: ${missingResources.join(', ')}.` });
  if (!validTimeRange(data.startTime, data.endTime)) return issues;
  const termStart = term.startDate?.toISOString().slice(0, 10);
  const termEnd = term.endDate?.toISOString().slice(0, 10);
  for (const period of room.unavailablePeriods || []) {
    if (termStart && termEnd && weekdayOccursBetween(period.startDate > termStart ? period.startDate : termStart, period.endDate < termEnd ? period.endDate : termEnd, data.day)) issues.push({ assignment: 'Room', message: `${room.name} is unavailable during ${period.startDate}–${period.endDate}${period.reason ? ` (${period.reason})` : ''}.` });
  }
  const existing = await Schedule.find({ day: data.day, term: data.term, status: { $ne: 'Cancelled' }, isActive: { $ne: false }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).populate('room instructor section');
  for (const s of existing) if (overlap(data.startTime, data.endTime, s.startTime, s.endTime)) {
    if (String(s.room?._id) === String(data.room)) issues.push({ assignment: 'Room', message: `${s.room.name} is assigned ${s.startTime}–${s.endTime}.` });
    if (String(s.instructor?._id) === String(data.instructor)) issues.push({ assignment: 'Instructor', message: `${s.instructor.name} is teaching ${s.startTime}–${s.endTime}.` });
    if (String(s.section?._id) === String(data.section)) issues.push({ assignment: 'Section', message: `${s.section.name} is scheduled ${s.startTime}–${s.endTime}.` });
  }
  const bookings = await ReservationRequest.find({ day: data.day, status: 'Approved' }).populate('room instructor section');
  for (const booking of bookings) {
    const occursInTerm = booking.term ? String(booking.term) === String(term._id) : termStart && termEnd ? booking.date >= termStart && booking.date <= termEnd : term.status === 'Active';
    if (!occursInTerm || !overlap(data.startTime, data.endTime, booking.startTime, booking.endTime)) continue;
    if (String(booking.room?._id) === String(data.room)) issues.push({ assignment: 'Reservation', message: `${room.name} is reserved on ${booking.date} ${booking.startTime}–${booking.endTime}.` });
    if (booking.instructor && String(booking.instructor._id) === String(data.instructor)) issues.push({ assignment: 'Instructor', message: `${instructor.name} has an approved reservation on ${booking.date}.` });
    if (booking.section && String(booking.section._id) === String(data.section)) issues.push({ assignment: 'Section', message: `${section.name} has an approved reservation on ${booking.date}.` });
  }
  return issues;
}
const lockKeysFor = data => [
  `room:${data.room}:${data.day}`,
  ...(data.instructor ? [`instructor:${data.instructor}:${data.day}`] : []),
  ...(data.section ? [`section:${data.section}:${data.day}`] : [])
].sort();
async function withBookingLocks(keys, work) {
  const acquired = [];
  try {
    for (const key of [...new Set(keys)].sort()) {
      const token = randomUUID();
      let lock = null;
      for (let attempt = 0; attempt < 15 && !lock; attempt++) {
        try {
          lock = await BookingLock.findOneAndUpdate({ _id: key, leaseUntil: { $lt: new Date() } }, { $set: { token, leaseUntil: new Date(Date.now() + 30000) } }, { new: true, upsert: true });
        } catch (error) {
          if (error.code !== 11000) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      if (!lock) throw Object.assign(new Error('Another schedule or reservation is being saved for this time. Please retry.'), { status: 409 });
      acquired.push({ key, token });
    }
    return await work();
  } finally {
    await Promise.all(acquired.map(({ key, token }) => BookingLock.deleteOne({ _id: key, token })));
  }
}
async function termForDate(date, requestedTerm) {
  const terms = requestedTerm ? [await AcademicTerm.findById(requestedTerm)] : await AcademicTerm.find({ status: 'Active' });
  return terms.find(term => {
    if (!term || term.status !== 'Active') return false;
    const start = term.startDate?.toISOString().slice(0, 10);
    const end = term.endDate?.toISOString().slice(0, 10);
    return start && end ? date >= start && date <= end : !requestedTerm || term.status === 'Active';
  }) || null;
}
async function reservationRoomConflicts(request, room, term) {
  const issues = [];
  if (!room || room.status !== 'Active') return [{ assignment: 'Room', message: 'Choose an active room.' }];
  if (request.section) {
    const section = await Section.findById(request.section);
    if (!section || section.status !== 'Active') issues.push({ assignment: 'Section', message: 'The selected section is unavailable.' });
    else if (section.studentCount > room.capacity) issues.push({ assignment: 'Capacity', message: `${room.name} holds ${room.capacity}, but this section has ${section.studentCount} students.` });
  }
  const requirements = Array.isArray(request.requirements) ? request.requirements : typeof request.requirements === 'string' ? request.requirements.split(',').map(x => x.trim()).filter(Boolean) : [];
  const inventory = (room.resources || []).map(x => String(x).toLowerCase());
  const missing = requirements.filter(x => !inventory.includes(String(x).toLowerCase()));
  if (missing.length) issues.push({ assignment: 'Resources', message: `${room.name} does not list: ${missing.join(', ')}.` });
  if ((room.unavailablePeriods || []).some(p => request.date >= p.startDate && request.date <= p.endDate)) issues.push({ assignment: 'Room', message: `${room.name} is unavailable on ${request.date}.` });
  const schedules = await Schedule.find({ day: request.day, ...(term ? { term: term._id } : {}), status: { $ne: 'Cancelled' }, isActive: { $ne: false } });
  for (const item of schedules) if (overlap(request.startTime, request.endTime, item.startTime, item.endTime)) {
    if (String(item.room) === String(room._id)) issues.push({ assignment: 'Room', message: `${room.name} has a recurring class ${item.startTime}–${item.endTime}.` });
    if (request.instructor && String(item.instructor) === String(request.instructor)) issues.push({ assignment: 'Instructor', message: 'The instructor has a recurring class at that time.' });
    if (request.section && String(item.section) === String(request.section)) issues.push({ assignment: 'Section', message: 'The section has a recurring class at that time.' });
  }
  const bookings = await ReservationRequest.find({ date: request.date, status: 'Approved', _id: { $ne: request._id } });
  for (const item of bookings) if (overlap(request.startTime, request.endTime, item.startTime, item.endTime)) {
    if (String(item.room) === String(room._id)) issues.push({ assignment: 'Room', message: `${room.name} is already reserved ${item.startTime}–${item.endTime}.` });
    if (request.instructor && String(item.instructor || item.requesterInstructor) === String(request.instructor)) issues.push({ assignment: 'Instructor', message: 'The instructor has another approved reservation at that time.' });
    if (request.section && String(item.section) === String(request.section)) issues.push({ assignment: 'Section', message: 'The section has another approved reservation at that time.' });
  }
  return issues;
}
async function approveReservation(requestId, actor, review) {
  const claimed = await ReservationRequest.findOneAndUpdate({ _id: requestId, status: 'Pending' }, { $set: { status: 'Approving' } }, { new: true });
  if (!claimed) throw Object.assign(new Error('This request is no longer pending. Refresh the list and review its current status.'), { status: 409 });
  try {
    if (!validDateOnly(claimed.date) || !validTimeRange(claimed.startTime, claimed.endTime)) throw Object.assign(new Error('The request has an invalid date or time range.'), { status: 400 });
    claimed.day = dayOf(claimed.date);
    claimed.course = review.course || claimed.course;
    claimed.section = review.section || claimed.section;
    claimed.instructor = review.instructor || claimed.instructor || claimed.requesterInstructor;
    const term = await termForDate(claimed.date, review.term || claimed.term);
    if (!term) throw Object.assign(new Error('No active academic term applies to this reservation date.'), { status: 409 });
    const candidates = review.room ? await Room.find({ _id: review.room }) : claimed.room ? await Room.find({ _id: claimed.room }) : await Room.find({ status: 'Active' }).sort('capacity');
    let conflicts = [];
    for (const room of candidates) {
      const keys = lockKeysFor({ room: room._id, day: claimed.day, instructor: claimed.instructor || claimed.requesterInstructor, section: claimed.section });
      const approved = await withBookingLocks(keys, async () => {
        const stillPending = await ReservationRequest.exists({ _id: claimed._id, status: 'Approving' });
        if (!stillPending) throw Object.assign(new Error('This request has already been reviewed.'), { status: 409 });
        const problems = await reservationRoomConflicts(claimed, room, term);
        if (problems.length) { conflicts = [...conflicts, ...problems]; return null; }
        return ReservationRequest.findOneAndUpdate({ _id: claimed._id, status: 'Approving' }, { $set: { status: 'Approved', room: room._id, term: term._id, course: claimed.course, section: claimed.section, instructor: claimed.instructor, day: claimed.day, decidedBy: actor.name, decidedAt: new Date(), decisionNotes: review.decisionNotes || '', publishToStudents: Boolean(review.publishToStudents && claimed.course && claimed.section) } }, { new: true, runValidators: true });
      });
      if (approved) {
        await AuditLog.create({ actor: actor.email, action: 'approved', entity: 'requests', entityId: approved._id, details: { room: approved.room, date: approved.date, publishToStudents: approved.publishToStudents } });
        return approved;
      }
    }
    throw Object.assign(new Error(candidates.length ? 'Cannot approve: the request conflicts with a class, reservation, room limit, or room resources.' : 'No room is available to approve this request.'), { status: 409, conflicts: conflicts.length ? conflicts : [{ assignment: 'Room', message: 'No active room is available for this request.' }] });
  } catch (error) {
    await ReservationRequest.updateOne({ _id: claimed._id, status: 'Approving' }, { $set: { status: 'Pending' } });
    throw error;
  }
}
const collections = { rooms: Room, resources: Resource, instructors: Instructor, courses: Course, sections: Section, terms: AcademicTerm, schedules: Schedule, requests: ReservationRequest };
app.get('/api/dashboard', asyncRoute(async (req, res) => {
  const studentSection = req.user.role === ROLE.STUDENT && req.user.section ? await Section.findOne({ _id: req.user.section, status: 'Active' }) : null;
  const sf = req.user.role === ROLE.INSTRUCTOR ? { instructor: req.user.instructor, status: 'Published' } : req.user.role === ROLE.STUDENT ? studentSection ? { section: studentSection._id, status: 'Published' } : { _id: { $exists: false }, status: 'Published' } : {};
  const rf = req.user.role === ROLE.INSTRUCTOR ? ownRequestFilter(req.user) : { _id: { $exists: false } };
  const today = dayOf(schoolToday());
  const [rooms, activeRooms, activeInstructors, requests, pending, todaySchedules, upcoming] = await Promise.all([Room.countDocuments(), Room.countDocuments({ status: 'Active' }), Instructor.countDocuments({ status: 'Active' }), ReservationRequest.countDocuments(rf), ReservationRequest.countDocuments({ ...rf, status: 'Pending' }), populateSchedule(Schedule.find({ ...sf, day: today, isActive: { $ne: false }, status: req.user.role === ROLE.INSTRUCTOR || req.user.role === ROLE.STUDENT ? 'Published' : { $ne: 'Cancelled' } })).sort('startTime'), populateSchedule(Schedule.find({ ...sf, isActive: { $ne: false }, status: req.user.role === ROLE.INSTRUCTOR || req.user.role === ROLE.STUDENT ? 'Published' : { $ne: 'Cancelled' } }).sort('day startTime').limit(5))]);
  res.json({ rooms, activeRooms, activeInstructors, requests, pending, today: todaySchedules, upcoming });
}));
app.get('/api/reports/room/:id', policyPermit('read', 'reports'), asyncRoute(async (req, res) => {
  const room = await Room.findById(req.params.id); if (!room) return res.status(404).json({ message: 'Room not found.' });
  const schedules = await populateSchedule(Schedule.find({ room: room._id, isActive: { $ne: false }, status: req.user.role === 'Student / Schedule Viewer' ? 'Published' : { $ne: 'Cancelled' } })).sort('day startTime');
  res.json({ room, schedules, reservations: await ReservationRequest.find({ room: room._id, status: 'Approved' }).sort('date startTime') });
}));
app.get('/api/availability', asyncRoute(async (req, res) => {
  const { date, startTime, endTime } = req.query;
  if (!validDateOnly(date) || !validTimeRange(startTime, endTime)) return res.status(400).json({ message: 'Provide a valid date, start time, and end time.' });
  const day = dayOf(date);
  const term = await termForDate(date, req.query.term);
  if (!term) return res.status(400).json({ message: 'Select an active academic term that includes the requested date.' });
  const rooms = await Room.find({ status: 'Active', ...(req.query.capacity ? { capacity: { $gte: Number(req.query.capacity) } } : {}) }).sort('capacity');
  const needs = req.query.resources ? String(req.query.resources).split(',').map(x => x.trim()).filter(Boolean) : [];
  const studentSection = await requireStudentSection(req.user);
  let requestedInstructor = req.query.instructor;
  let requestedSection = req.query.section;
  if (req.user.role === ROLE.INSTRUCTOR) {
    requestedInstructor = req.user.instructor;
    if (requestedSection && !await Schedule.exists({ instructor: req.user.instructor, section: requestedSection, status: { $ne: 'Cancelled' }, isActive: { $ne: false } })) return res.status(403).json({ message: 'You can only check availability for a section assigned to you.' });
  }
  if (studentSection) {
    if (requestedSection && String(requestedSection) !== String(studentSection._id)) return res.status(403).json({ message: 'Students can only check availability for their assigned section.' });
    requestedInstructor = undefined;
    requestedSection = studentSection._id;
  }
  const request = { date, day, startTime, endTime, instructor: requestedInstructor, section: requestedSection, requirements: needs };
  const available = [];
  for (const room of rooms) if (!(await reservationRoomConflicts(request, room, term)).length) available.push(room);
  res.json(available);
}));
app.get('/api/reports', asyncRoute(async (req, res) => {
  if (!canRead(req.user.role, 'reports')) return res.status(403).json({ message: 'Your role cannot access reports.' });
  const type = req.query.type;
  if (type === 'reservations') {
    const filter = req.user.role === 'Instructor' ? { requesterEmail: req.user.email } : {};
    if (req.query.status) filter.status = req.query.status;
    return res.json(await ReservationRequest.find(filter).populate('room').sort('date startTime'));
  }
  if (type === 'room-day') {
    const day = req.query.date ? dayOf(req.query.date) : req.query.day;
    if (!day) return res.status(400).json({ message: 'Provide a date or weekday.' });
    const filter = { day, ...(req.query.room ? { room: req.query.room } : {}), ...(req.user.role === 'Instructor' ? { instructor: req.user.instructor } : {}), ...(req.user.role === 'Student / Schedule Viewer' ? { status: 'Published' } : { status: { $ne: 'Cancelled' } }), isActive: { $ne: false } };
    const classes = await populateSchedule(Schedule.find(filter)).sort('startTime');
    const reservations = req.query.date ? await ReservationRequest.find({ date: req.query.date, status: 'Approved', ...(req.query.room ? { room: req.query.room } : {}), ...(req.user.role === 'Instructor' ? { requesterEmail: req.user.email } : {}) }).populate('room').sort('startTime') : [];
    return res.json({ date: req.query.date, day, classes, reservations });
  }
  if (type === 'instructor' || type === 'section') {
    if (type === 'section' && req.user.role === 'Instructor') return res.status(403).json({ message: 'Instructors can view their own teaching timetable only.' });
    const field = type;
    const id = type === 'instructor' && req.user.role === 'Instructor' ? req.user.instructor : req.query[type];
    if (!id) return res.status(400).json({ message: `Provide a ${type} record.` });
    const filter = { [field]: id, status: req.user.role === 'Student / Schedule Viewer' || req.user.role === 'Instructor' ? 'Published' : { $ne: 'Cancelled' }, isActive: { $ne: false }, ...(req.query.term ? { term: req.query.term } : {}) };
    return res.json(await populateSchedule(Schedule.find(filter)).sort('day startTime'));
  }
  if (type === 'weekly-utilization') {
    const bounds = weekBounds(validDateOnly(req.query.weekStart) ? req.query.weekStart : schoolToday());
    const [rooms, schedules, reservations] = await Promise.all([Room.find({ status: 'Active' }).sort('name'), Schedule.find({ status: req.user.role === 'Student / Schedule Viewer' ? 'Published' : { $ne: 'Cancelled' }, isActive: { $ne: false }, ...(req.query.term ? { term: req.query.term } : {}) }), ReservationRequest.find({ status: 'Approved', date: { $gte: bounds.from, $lte: bounds.to } })]);
    return res.json(rooms.map(room => {
      const assigned = schedules.filter(s => String(s.room) === String(room._id));
      const duration = item => { const [sh, sm] = item.startTime.split(':').map(Number); const [eh, em] = item.endTime.split(':').map(Number); return eh * 60 + em - sh * 60 - sm; };
      const classMinutes = assigned.reduce((sum, item) => sum + duration(item), 0);
      const roomBookings = reservations.filter(item => String(item.room) === String(room._id));
      const reservationMinutes = roomBookings.reduce((sum, item) => sum + duration(item), 0);
      const minutes = classMinutes + reservationMinutes;
      return { room, classCount: assigned.length, reservationCount: roomBookings.length, scheduledMinutes: minutes };
    }));
  }
  res.status(400).json({ message: 'Choose room-day, weekly-utilization, instructor, section, or reservations.' });
}));
for (const [path, Model] of Object.entries(collections)) {
  app.get(`/api/${path}`, asyncRoute(async (req, res) => {
    if (!canRead(req.user.role, path)) return res.status(403).json({ message: 'Your role cannot access this record list.' });
    let filter = {};
    if (academicFields[path]) {
      if (['Active', 'Inactive', 'Completed'].includes(req.query.status)) filter.status = req.query.status;
      if (path === 'sections') {
        if (req.query.program) filter.program = req.query.program;
        if (req.query.yearLevel) filter.yearLevel = req.query.yearLevel;
      }
      if (path === 'terms' && req.query.schoolYear) filter.schoolYear = req.query.schoolYear;
      const search = String(req.query.search || '').trim();
      if (search && path === 'sections') {
        const number = positiveWholeNumber(search);
        filter.$or = [{ name: new RegExp(escapeRegex(search), 'i') }, { program: new RegExp(escapeRegex(search), 'i') }, ...(number ? [{ yearLevel: number }] : [])];
      } else if (search) filter.$or = searchFields[path].map(field => ({ [field]: new RegExp(escapeRegex(search), 'i') }));
    }
    if (path === 'rooms') {
      if (['Active', 'Inactive', 'Under maintenance'].includes(req.query.status)) filter.status = req.query.status;
      const search = String(req.query.search || '').trim();
      if (search) filter.$or = ['code', 'name', 'type', 'building', 'resources'].map(field => ({ [field]: new RegExp(escapeRegex(search), 'i') }));
    }
    if (req.user.role === ROLE.INSTRUCTOR && path === 'instructors') filter._id = req.user.instructor;
    if (req.user.role === ROLE.INSTRUCTOR && ['courses', 'sections'].includes(path)) {
      const assigned = await Schedule.find({ instructor: req.user.instructor, status: { $ne: 'Cancelled' }, isActive: { $ne: false } }).select('course section term').lean();
      const field = { courses: 'course', sections: 'section', terms: 'term' }[path];
      const ids = [...new Set(assigned.map(item => String(item[field])).filter(Boolean))];
      filter._id = { $in: ids };
      filter.status = 'Active';
    }
    if ((req.user.role === ROLE.INSTRUCTOR || req.user.role === ROLE.STUDENT) && path === 'terms') filter.status = 'Active';
    if (path === 'schedules') {
      for (const field of ['room', 'section', 'course', 'term', 'instructor']) if (req.query[field] && !mongoose.isValidObjectId(req.query[field])) return res.status(400).json({ message: `Invalid ${field} filter.` });
      if (req.query.day && !['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].includes(req.query.day)) return res.status(400).json({ message: 'Choose a valid weekday filter.' });
      if (req.user.role === ROLE.INSTRUCTOR) filter = { instructor: req.user.instructor, status: 'Published' };
      if (req.user.role === ROLE.STUDENT) {
        const section = await requireStudentSection(req.user);
        if (req.query.section && String(req.query.section) !== String(section._id)) return res.status(403).json({ message: 'Students can only view schedules for their assigned section.' });
        filter = { section: section._id, status: 'Published' };
      }
      filter.isActive = { $ne: false };
      if (manager.includes(req.user.role)) filter.status = { $ne: 'Cancelled' };
      for (const field of ['room', 'section', 'course', 'term', 'day']) if (req.query[field]) filter[field] = req.query[field];
      if (req.user.role === ROLE.STUDENT) filter.section = req.user.section;
      if (req.query.instructor && req.user.role !== 'Instructor') filter.instructor = req.query.instructor;
      if (req.query.status && manager.includes(req.user.role)) {
        if (!['Scheduled', 'Published', 'Cancelled', 'Inactive'].includes(req.query.status)) return res.status(400).json({ message: 'Choose a valid schedule status.' });
        if (req.query.status === 'Inactive') filter.isActive = false;
        else filter.status = req.query.status;
      }
      const search = String(req.query.search || '').trim();
      if (search) {
        const pattern = new RegExp(escapeRegex(search), 'i');
        const [courses, instructors, sections, rooms] = await Promise.all([
          Course.find({ $or: [{ code: pattern }, { title: pattern }] }).distinct('_id'),
          Instructor.find({ name: pattern }).distinct('_id'),
          Section.find({ $or: [{ name: pattern }, { program: pattern }, ...(positiveWholeNumber(search) ? [{ yearLevel: positiveWholeNumber(search) }] : [])] }).distinct('_id'),
          Room.find({ $or: [{ code: pattern }, { name: pattern }] }).distinct('_id')
        ]);
        const matches = [{ course: { $in: courses } }, { instructor: { $in: instructors } }, { section: { $in: sections } }, { room: { $in: rooms } }];
        filter.$and = [...(filter.$and || []), { $or: matches }];
      }
    }
    if (path === 'requests' && req.user.role === ROLE.INSTRUCTOR) filter = ownRequestFilter(req.user);
    let query = Model.find(filter).sort(path === 'schedules' ? 'day startTime' : path === 'courses' ? 'code' : 'name');
    if (path === 'schedules') query = populateSchedule(query);
    if (path === 'requests') query = query.populate('room');
    const rows = await query;
    if (path === 'schedules') {
      const bounds = weekBounds(validDateOnly(req.query.weekStart) ? req.query.weekStart : schoolToday());
      const scopedSection = req.user.role === ROLE.STUDENT ? req.user.section : null;
      const eventFilter = { status: 'Approved', publishToStudents: true, date: { $gte: bounds.from, $lte: bounds.to }, ...(req.user.role === ROLE.INSTRUCTOR ? { instructor: req.user.instructor } : {}), ...(scopedSection ? { section: scopedSection } : {}), ...(req.query.room ? { room: req.query.room } : {}), ...(req.query.section && !scopedSection ? { section: req.query.section } : {}), ...(req.query.course ? { course: req.query.course } : {}), ...(req.query.term ? { term: req.query.term } : {}) };
      const events = req.query.status && req.query.status !== 'Published' ? [] : await ReservationRequest.find(eventFilter).populate('course instructor section room term').sort('date startTime');
      const search = String(req.query.search || '').trim().toLowerCase();
      const oneTime = events.filter(event => (!req.query.day || event.day === req.query.day) && (!search || [event.course?.code, event.course?.title, event.instructor?.name, event.section?.name, event.room?.code, event.room?.name].some(value => String(value || '').toLowerCase().includes(search)))).map(event => ({ ...event.toObject(), _id: `reservation:${event._id}`, eventId: event._id, scheduleType: 'One-time', status: 'Published' }));
      const uniqueSchedules = new Map([...rows, ...oneTime].map(schedule => [String(schedule._id), schedule]));
      return res.json([...uniqueSchedules.values()].sort((a, b) => a.day.localeCompare(b.day) || a.startTime.localeCompare(b.startTime) || String(a.room?._id || a.room).localeCompare(String(b.room?._id || b.room))));
    }
    res.json(rows);
  }));
  if (path === 'schedules') app.get('/api/schedules/:id', asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid schedule ID.' });
    const studentSection = await requireStudentSection(req.user);
    const filter = { _id: req.params.id, ...(req.user.role === ROLE.INSTRUCTOR ? { instructor: req.user.instructor, status: 'Published', isActive: { $ne: false } } : studentSection ? { section: studentSection._id, status: 'Published', isActive: { $ne: false } } : {}) };
    const schedule = await populateSchedule(Schedule.findOne(filter));
    if (!schedule) return res.status(404).json({ message: 'Schedule not found.' });
    res.json(schedule);
  }));
  app.post(`/api/${path}`, policyPermit('write', path === 'requests' ? 'requests:create' : path), asyncRoute(async (req, res) => {
    if (path === 'rooms' && !ROOM_FLOORS.includes(req.body.floor)) return res.status(400).json({ message: `Choose a valid room floor: ${ROOM_FLOORS.join(', ')}.` });
    if (path === 'schedules') {
      const allowed = ['course', 'instructor', 'section', 'room', 'term', 'resources', 'day', 'startTime', 'endTime', 'status'];
      if (Object.keys(req.body).some(key => !allowed.includes(key))) return res.status(400).json({ message: 'The schedule contains unsupported fields.' });
    }
    const data = academicFields[path] ? academicPayload(path, req.body) : { ...req.body };
    if (path === 'instructors' && data.email) data.email = normalizeEmail(data.email);
    if (path === 'schedules') { const error = scheduleInputError(data); if (error) return res.status(400).json({ message: error }); }
    if (academicFields[path]) {
      await ensureAcademicUnique(path, data);
      if (path === 'terms' && data.startDate && data.endDate && data.startDate > data.endDate) return res.status(400).json({ message: 'The term start date must not be after its end date.' });
    }
    if (path === 'users') {
      data.passwordHash = await hashPassword(data.password); delete data.password;
      const created = await Model.create(data); return res.status(201).json(publicUser(created));
    }
    if (path === 'instructors') {
      data.email = requireInstructorEmail(data.email);
      const instructor = await Model.create(data);
      try {
        await createSetupAccount(instructor);
      } catch (error) {
        await Instructor.deleteOne({ _id: instructor._id }).catch(() => {});
        throw error;
      }
      await AuditLog.create({ actor: req.user.email, action: 'created', entity: path, entityId: instructor._id });
      return res.status(201).json(instructor);
    }
    if (path === 'schedules') {
      const saved = await withBookingLocks(lockKeysFor(data), async () => {
        const issues = await scheduleConflicts(data);
        if (issues.length) return { issues };
        const doc = await Model.create(data);
        await AuditLog.create({ actor: req.user.email, action: 'created', entity: path, entityId: doc._id });
        return { doc };
      });
      if (saved.issues) return res.status(409).json({ message: 'This schedule cannot be saved.', conflicts: saved.issues });
      return res.status(201).json(saved.doc);
    }
    if (path === 'requests') {
      const allowed = ['type', 'purpose', 'description', 'requirements', 'room', 'course', 'section', 'term', 'date', 'startTime', 'endTime'];
      if (Object.keys(req.body).some(key => !allowed.includes(key))) return res.status(400).json({ message: 'The reservation request contains unsupported fields.' });
      data.requester = req.user.name; data.requesterEmail = req.user.email; data.requesterUser = req.user._id; data.requesterInstructor = req.user.instructor; data.instructor = req.user.instructor; data.status = 'Pending'; data.publishToStudents = false; delete data.day;
      if (!validDateOnly(data.date) || !validTimeRange(data.startTime, data.endTime)) return res.status(400).json({ message: 'Choose a valid date and time range.' });
      data.day = dayOf(data.date);
      const term = await termForDate(data.date, data.term);
      if (!term) return res.status(400).json({ message: 'Choose an active academic term that includes the requested date.' });
      data.term = term._id;
      if (data.room && !await Room.exists({ _id: data.room, status: 'Active' })) return res.status(400).json({ message: 'The preferred room is not active.' });
      if (data.course && !await Course.exists({ _id: data.course, status: 'Active' })) return res.status(400).json({ message: 'Choose an active course.' });
      if (data.section && !await Section.exists({ _id: data.section, status: 'Active' })) return res.status(400).json({ message: 'Choose an active section.' });
      if (data.course || data.section) {
        const assignment = await Schedule.exists({ instructor: req.user.instructor, ...(data.course ? { course: data.course } : {}), ...(data.section ? { section: data.section } : {}), status: { $ne: 'Cancelled' }, isActive: { $ne: false } });
        if (!assignment) return res.status(403).json({ message: 'Reservation requests can only reference a course or section assigned to your instructor account.' });
      }
      if (!Array.isArray(data.requirements)) data.requirements = typeof data.requirements === 'string' ? data.requirements.split(',').map(x => x.trim()).filter(Boolean) : [];
    }
    const doc = await Model.create(data);
    await AuditLog.create({ actor: req.user.email, action: 'created', entity: path, entityId: doc._id });
    res.status(201).json(doc);
  }));
  app.patch(`/api/${path}/:id`, permit(...(path === 'requests' ? manager : manager)), asyncRoute(async (req, res) => {
    if (path === 'schedules') {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid schedule ID.' });
      const allowed = ['course', 'instructor', 'section', 'room', 'term', 'resources', 'day', 'startTime', 'endTime', 'status'];
      if (Object.keys(req.body).some(key => !allowed.includes(key))) return res.status(400).json({ message: 'The schedule contains unsupported fields.' });
    }
    let data = academicFields[path] ? academicPayload(path, req.body) : { ...req.body };
    let previousInstructor;
    if (path === 'instructors' && data.email) data.email = normalizeEmail(data.email);
    if (path === 'rooms') {
      const existing = await Room.findById(req.params.id).select('floor building');
      if (!existing) return res.status(404).json({ message: 'Room not found.' });
      const floor = Object.hasOwn(data, 'floor') ? data.floor : existing.floor;
      if (!ROOM_FLOORS.includes(floor)) return res.status(400).json({ message: `Choose a valid room floor: ${ROOM_FLOORS.join(', ')}.` });
      const building = Object.hasOwn(data, 'building') ? data.building : existing.building;
      if (typeof building !== 'string' || !building.trim()) return res.status(400).json({ message: 'Enter a building or location for this room.' });
    }
    if (academicFields[path]) {
      const existing = await Model.findById(req.params.id);
      if (!existing) return res.status(404).json({ message: 'Record not found.' });
      if (path === 'instructors') previousInstructor = existing.toObject();
      await ensureAcademicUnique(path, data, existing._id);
      if (path === 'terms' && data.status === 'Inactive' && existing.status === 'Active' && await AcademicTerm.countDocuments({ status: 'Active' }) <= 1) return res.status(409).json({ message: 'The only active academic term cannot be deactivated. Activate another term first.' });
      if (path === 'terms') {
        const start = Object.hasOwn(data, 'startDate') ? data.startDate : existing.startDate;
        const end = Object.hasOwn(data, 'endDate') ? data.endDate : existing.endDate;
        if (start && end && start > end) return res.status(400).json({ message: 'The term start date must not be after its end date.' });
      }
    }
    if (path === 'users') {
      delete data.passwordHash;
      if (data.password) { data.passwordHash = await hashPassword(data.password); delete data.password; }
      const doc = await Model.findByIdAndUpdate(req.params.id, data, { new: true, runValidators: true });
      return doc ? res.json(publicUser(doc)) : res.status(404).json({ message: 'User not found.' });
    }
    if (path === 'schedules') {
      const old = await Schedule.findById(req.params.id); if (!old) return res.status(404).json({ message: 'Schedule not found.' });
      const merged = { ...old.toObject(), ...data };
      const inputError = scheduleInputError(merged); if (inputError) return res.status(400).json({ message: inputError });
      const result = await withBookingLocks([...lockKeysFor(old), ...lockKeysFor(merged)], async () => {
        if (!['Cancelled'].includes(merged.status) && merged.isActive !== false) {
          const issues = await scheduleConflicts(merged, old._id);
          if (issues.length) return { issues };
        }
        const doc = await Schedule.findByIdAndUpdate(req.params.id, data, { new: true, runValidators: true });
        await AuditLog.create({ actor: req.user.email, action: 'updated', entity: path, entityId: doc._id, details: { status: doc.status } });
        return { doc };
      });
      if (result.issues) return res.status(409).json({ message: 'This schedule cannot be saved.', conflicts: result.issues });
      return res.json(result.doc);
    }
    if (path === 'requests') {
      const request = await ReservationRequest.findById(req.params.id); if (!request) return res.status(404).json({ message: 'Request not found.' });
      if (data.status === 'Approved') return res.json(await approveReservation(request._id, req.user, data));
      if (data.status === 'Rejected') {
        const doc = await ReservationRequest.findOneAndUpdate({ _id: request._id, status: 'Pending' }, { $set: { status: 'Rejected', decisionNotes: data.decisionNotes || '', decidedBy: req.user.name, decidedAt: new Date() } }, { new: true, runValidators: true });
        if (!doc) return res.status(409).json({ message: 'This request is no longer pending. Refresh the list.' });
        await AuditLog.create({ actor: req.user.email, action: 'rejected', entity: path, entityId: doc._id, details: { decisionNotes: doc.decisionNotes } });
        return res.json(doc);
      }
      if (Object.keys(data).some(k => !['decisionNotes', 'publishToStudents', 'course', 'section', 'instructor'].includes(k))) return res.status(400).json({ message: 'Only review notes and affected schedule details can be updated.' });
      if (request.status !== 'Approved' && (data.publishToStudents || data.course || data.section)) return res.status(409).json({ message: 'Approve the reservation before publishing it to a student timetable.' });
      if (data.publishToStudents && (!(data.course || request.course) || !(data.section || request.section))) return res.status(400).json({ message: 'A course and student section are required before publishing this event.' });
      for (const field of ['course', 'section', 'instructor']) if (data[field] && !await ({ course: Course, section: Section, instructor: Instructor }[field].exists({ _id: data[field] }))) return res.status(400).json({ message: 'Invalid ' + field + ' record.' });
      const doc = await ReservationRequest.findByIdAndUpdate(request._id, data, { new: true, runValidators: true });
      await AuditLog.create({ actor: req.user.email, action: 'updated', entity: path, entityId: doc._id, details: { publishToStudents: doc.publishToStudents } });
      return res.json(doc);
    }
    let update = data;
    const unset = {};
    if (path === 'instructors' && Object.hasOwn(req.body, 'employeeId') && !req.body.employeeId.trim()) unset.employeeId = 1;
    if (path === 'sections' && Object.hasOwn(req.body, 'yearLevel') && req.body.yearLevel === '') unset.yearLevel = 1;
    for (const field of Object.keys(academicOptions[path] || {})) if (field !== 'name' && Object.hasOwn(req.body, field) && req.body[field] === '') unset[field] = 1;
    if (Object.keys(unset).length) update = { $set: data, $unset: unset };
    const doc = await Model.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!doc) return res.status(404).json({ message: 'Record not found.' });
    if (path === 'instructors') {
      try { await syncInstructorToAccount(doc, { syncStatus: Object.hasOwn(data, 'status') }); }
      catch (error) { const { _id, __v, ...restore } = previousInstructor; await Instructor.findByIdAndUpdate(_id, { $set: restore }).catch(() => {}); throw error; }
    }
    await AuditLog.create({ actor: req.user.email, action: 'updated', entity: path, entityId: doc._id, details: path === 'requests' ? { status: doc.status } : undefined });
    res.json(doc);
  }));
  if (academicFields[path]) app.post(`/api/${path}/:id/deactivate`, permit(...manager), asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid record ID.' });
    const existing = await Model.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Record not found.' });
    if (existing.status === 'Active' && path === 'terms' && await AcademicTerm.countDocuments({ status: 'Active' }) <= 1) return res.status(409).json({ message: 'The only active academic term cannot be deactivated. Activate another term first.' });
    if (existing.status === 'Inactive') return res.json(existing);
    const doc = await Model.findByIdAndUpdate(existing._id, { status: 'Inactive' }, { new: true, runValidators: true });
    if (path === 'instructors') {
      try { await syncInstructorToAccount(doc, { syncStatus: true }); }
      catch (error) { await Instructor.findByIdAndUpdate(doc._id, { status: existing.status }).catch(() => {}); throw error; }
    }
    await AuditLog.create({ actor: req.user.email, action: 'deactivated', entity: path, entityId: doc._id });
    return res.json(doc);
  }));
  if (academicFields[path]) app.post(`/api/${path}/:id/activate`, permit(...manager), asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid record ID.' });
    const existing = await Model.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Record not found.' });
    if (existing.status !== 'Inactive') return res.status(409).json({ message: 'Only inactive records can be activated.' });
    await ensureAcademicUnique(path, existing.toObject(), existing._id);
    if (path === 'terms' && existing.startDate && existing.endDate && existing.startDate > existing.endDate) return res.status(409).json({ message: 'This term has an invalid date range and cannot be activated.' });
    const doc = await Model.findByIdAndUpdate(existing._id, { status: 'Active' }, { new: true, runValidators: true });
    if (path === 'instructors') {
      try { await syncInstructorToAccount(doc, { syncStatus: true }); }
      catch (error) { await Instructor.findByIdAndUpdate(doc._id, { status: existing.status }).catch(() => {}); throw error; }
    }
    await AuditLog.create({ actor: req.user.email, action: 'activated', entity: path, entityId: doc._id });
    return res.json(doc);
  }));
  if (path === 'rooms') app.post('/api/rooms/:id/deactivate', permit(...manager), asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid room ID.' });
    const room = await Room.findById(req.params.id);
    if (!room) return res.status(404).json({ message: 'Room not found.' });
    if (room.status === 'Inactive') return res.json(room);
    room.status = 'Inactive'; await room.save();
    await AuditLog.create({ actor: req.user.email, action: 'deactivated', entity: 'rooms', entityId: room._id });
    return res.json(room);
  }));
  if (path === 'rooms') app.post('/api/rooms/:id/activate', permit(...manager), asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid room ID.' });
    const room = await Room.findById(req.params.id);
    if (!room) return res.status(404).json({ message: 'Room not found.' });
    if (room.status !== 'Inactive') return res.status(409).json({ message: 'Only inactive rooms can be activated.' });
    room.status = 'Active'; await room.save();
    await AuditLog.create({ actor: req.user.email, action: 'activated', entity: 'rooms', entityId: room._id });
    return res.json(room);
  }));
  app.delete(`/api/${path}/:id`, permit(...manager), asyncRoute(async (req, res) => {
    if (path === 'requests') return res.status(405).json({ message: 'Reservation requests are retained for review history.' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid record ID.' });
    if (academicFields[path]) {
      const existing = await Model.findById(req.params.id);
      if (!existing) return res.status(404).json({ message: 'Record not found.' });
      const dependencies = await academicDependencies(path, existing._id);
      if (Object.keys(dependencies).length) return res.status(409).json({ code: 'RECORD_REFERENCED', message: 'This record is in use and cannot be permanently deleted.', dependencies, canDeactivate: true });
      if (path === 'terms' && existing.status === 'Active' && await AcademicTerm.countDocuments({ status: 'Active' }) <= 1) return res.status(409).json({ message: 'The only active academic term cannot be deleted. Activate another term first.' });
      await AuditLog.create({ actor: req.user.email, action: 'deleted', entity: path, entityId: existing._id, details: { label: existing.name || existing.title || existing.code } });
      await Model.deleteOne({ _id: existing._id });
      return res.json({ _id: existing._id, deleted: true });
    }
    if (path === 'rooms') {
      const room = await Room.findById(req.params.id);
      if (!room) return res.status(404).json({ message: 'Room not found.' });
      const dependencies = {
        schedules: await Schedule.countDocuments({ room: room._id }),
        reservations: await ReservationRequest.countDocuments({ room: room._id })
      };
      if (Object.values(dependencies).some(Boolean)) return res.status(409).json({ code: 'RECORD_REFERENCED', message: 'This room has schedule or reservation history and cannot be permanently deleted.', dependencies, canDeactivate: true });
      await AuditLog.create({ actor: req.user.email, action: 'deleted', entity: 'rooms', entityId: room._id, details: { label: room.name } });
      await Room.deleteOne({ _id: room._id });
      return res.json({ _id: room._id, deleted: true });
    }
    const doc = await Model.findByIdAndUpdate(req.params.id, path === 'schedules' ? { status: 'Cancelled', isActive: true } : { status: 'Inactive' }, { new: true, runValidators: true });
    if (!doc) return res.status(404).json({ message: 'Record not found.' });
    await AuditLog.create({ actor: req.user.email, action: path === 'schedules' ? 'cancelled' : 'deactivated', entity: path, entityId: doc._id });
    res.json(doc);
  }));
}
app.post('/api/schedules/:id/deactivate', permit(...manager), asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid schedule ID.' });
  const schedule = await Schedule.findById(req.params.id);
  if (!schedule) return res.status(404).json({ message: 'Schedule not found.' });
  if (schedule.status === 'Cancelled') return res.status(409).json({ message: 'A cancelled schedule cannot be deactivated.' });
  if (schedule.isActive === false) return res.json(schedule);
  schedule.isActive = false; await schedule.save();
  await AuditLog.create({ actor: req.user.email, action: 'deactivated', entity: 'schedules', entityId: schedule._id });
  return res.json(schedule);
}));
app.post('/api/schedules/:id/activate', permit(...manager), asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid schedule ID.' });
  const schedule = await Schedule.findById(req.params.id);
  if (!schedule) return res.status(404).json({ message: 'Schedule not found.' });
  if (schedule.status === 'Cancelled') return res.status(409).json({ message: 'A cancelled schedule cannot be reactivated. Create a new schedule instead.' });
  if (schedule.isActive !== false) return res.json(schedule);
  const data = schedule.toObject(); data.isActive = true;
  const result = await withBookingLocks(lockKeysFor(data), async () => {
    const issues = await scheduleConflicts(data, schedule._id);
    if (issues.length) return { issues };
    schedule.isActive = true; await schedule.save();
    await AuditLog.create({ actor: req.user.email, action: 'activated', entity: 'schedules', entityId: schedule._id });
    return { schedule };
  });
  if (result.issues) return res.status(409).json({ message: 'This schedule cannot be reactivated.', conflicts: result.issues });
  return res.json(result.schedule);
}));
app.get('/api/users', policyPermit('read', 'users'), asyncRoute(async (req, res) => {
  const filter = {};
  if (req.query.status === 'Active' || req.query.status === 'Inactive') filter.status = req.query.status;
  if (roles.includes(req.query.role)) filter.role = req.query.role;
  const search = String(req.query.search || '').trim();
  if (search) {
    const linkedInstructors = await Instructor.find({ $or: ['name', 'employeeId'].map(field => ({ [field]: new RegExp(escapeRegex(search), 'i') })) }).distinct('_id');
    if (mongoose.isValidObjectId(search)) linkedInstructors.push(search);
    filter.$or = [...['name', 'username', 'email'].map(field => ({ [field]: new RegExp(escapeRegex(search), 'i') })), { instructor: { $in: linkedInstructors } }];
  }
  res.json((await User.find(filter).populate('instructor', 'name employeeId department status').populate('section', 'name program yearLevel status').sort('name')).map(publicUser));
}));
app.post('/api/users', policyPermit('write', 'users'), asyncRoute(async (req, res) => {
  const { name, role, password } = req.body;
  const email = String(req.body.email || '').trim().toLowerCase();
  const username = String(req.body.username || '').trim() || undefined;
  const employeeId = String(req.body.employeeId || '').trim() || undefined;
  const department = String(req.body.department || '').trim() || undefined;
  const sectionId = req.body.section || undefined;
  if (!username && role !== 'Instructor') return res.status(400).json({ message: 'A username is required for new non-instructor accounts.' });
  if (typeof name !== 'string' || !name.trim() || !roles.includes(role)) return res.status(400).json({ message: 'Provide a name and a supported role.' });
  if (req.body.status !== undefined && !['Active', 'Inactive'].includes(req.body.status)) return res.status(400).json({ message: 'Choose a valid account status.' });
  if (role === 'Instructor') {
    requireInstructorEmail(email);
    if (department && !INSTRUCTOR_DEPARTMENTS.includes(department)) return res.status(400).json({ message: 'Choose a valid instructor department.' });
    if (employeeId && await Instructor.exists({ employeeId })) return res.status(409).json({ message: 'An instructor with this ID already exists.' });
    if (await Instructor.countDocuments({ email }) > 1) return res.status(409).json({ message: 'Multiple instructor records use this email; resolve the records before linking an account.' });
  } else if (department || employeeId || req.body.instructor) return res.status(400).json({ message: 'Instructor profile details can only be set for an Instructor account.' });
  if (role === ROLE.STUDENT) {
    if (!sectionId || !mongoose.isValidObjectId(sectionId) || !await Section.exists({ _id: sectionId, status: 'Active' })) return res.status(400).json({ message: 'Assign this student account to an active student section.' });
  } else if (sectionId) return res.status(400).json({ message: 'A student section can only be assigned to a Student account.' });
  if (await conflictingLoginIdentifier(username, email)) return res.status(409).json({ message: 'That username or email conflicts with an existing login identifier.' });
  const passwordHash = await hashPassword(password);
  const status = req.body.status || 'Active';
  if (role !== 'Instructor') {
    const user = await User.create({ name, username, email, role, status, passwordHash, ...(role === ROLE.STUDENT ? { section: sectionId } : {}) });
    return res.status(201).json(publicUser(user));
  }
  let instructor = await Instructor.findOne({ email });
  let createdInstructor = false;
  let previousInstructor;
  if (instructor) {
    if (await User.exists({ instructor: instructor._id })) return res.status(409).json({ message: 'An Instructor account is already linked to the instructor record with this email.' });
    if (employeeId && await Instructor.exists({ employeeId, _id: { $ne: instructor._id } })) return res.status(409).json({ message: 'An instructor with this ID already exists.' });
    previousInstructor = instructor.toObject();
    instructor.name = name.trim();
    instructor.status = status;
    if (department) instructor.department = department;
    if (employeeId) instructor.employeeId = employeeId;
    await instructor.save();
  } else {
    instructor = await Instructor.create({ name: name.trim(), email, department, employeeId, status });
    createdInstructor = true;
  }
  let user;
  try {
    user = await User.create({ name: name.trim(), username, email, role, instructor: instructor._id, status, passwordHash, setupRequired: false });
  } catch (error) {
    if (createdInstructor) await Instructor.deleteOne({ _id: instructor._id }).catch(() => {});
    else if (previousInstructor) {
      const { _id, __v, ...restore } = previousInstructor;
      await Instructor.findByIdAndUpdate(_id, { $set: restore }).catch(() => {});
    }
    throw error;
  }
  await AuditLog.create({ actor: req.user.email, action: 'created', entity: 'instructors', entityId: instructor._id });
  return res.status(201).json(publicUser(await User.findById(user._id).populate('instructor', 'name employeeId department status')));
}));
app.post('/api/users/:id/deactivate', policyPermit('write', 'users'), asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid user ID.' });
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  if (String(user._id) === String(req.authId)) return res.status(409).json({ message: 'You cannot deactivate your own administrator account.' });
  if (user.role === 'Administrator' && user.status === 'Active' && await User.countDocuments({ role: 'Administrator', status: 'Active' }) <= 1) return res.status(409).json({ message: 'The last active administrator account cannot be deactivated.' });
  if (user.status === 'Inactive') return res.json(publicUser(user));
  const instructor = user.role === 'Instructor' && user.instructor ? await Instructor.findById(user.instructor) : null;
  const oldInstructorStatus = instructor?.status;
  if (instructor) { instructor.status = 'Inactive'; await instructor.save(); }
  try { user.status = 'Inactive'; await user.save(); }
  catch (error) { if (instructor) { instructor.status = oldInstructorStatus; await instructor.save().catch(() => {}); } throw error; }
  await AuditLog.create({ actor: req.user.email, action: 'deactivated', entity: 'users', entityId: user._id });
  return res.json(publicUser(user));
}));
app.post('/api/users/:id/activate', policyPermit('write', 'users'), asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid user ID.' });
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  if (user.setupRequired) return res.status(409).json({ message: 'Set a private password in Edit user access before activating this instructor account.' });
  if (user.role === ROLE.STUDENT && (!user.section || !await Section.exists({ _id: user.section, status: 'Active' }))) return res.status(409).json({ message: 'Assign this student account to an active section before activating it.' });
  if (user.status === 'Active') return res.json(publicUser(user));
  const instructor = user.role === 'Instructor' && user.instructor ? await Instructor.findById(user.instructor) : null;
  if (user.role === 'Instructor' && !instructor) return res.status(409).json({ message: 'Link a valid instructor record before restoring this account.' });
  const oldInstructorStatus = instructor?.status;
  if (instructor) { instructor.status = 'Active'; await instructor.save(); }
  try { user.status = 'Active'; await user.save(); }
  catch (error) { if (instructor) { instructor.status = oldInstructorStatus; await instructor.save().catch(() => {}); } throw error; }
  await AuditLog.create({ actor: req.user.email, action: 'activated', entity: 'users', entityId: user._id });
  return res.json(publicUser(user));
}));
app.patch('/api/users/:id', policyPermit('write', 'users'), asyncRoute(async (req, res) => {
  const allowed = ['name', 'username', 'email', 'role', 'status', 'password', 'department', 'employeeId', 'instructor', 'section'];
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(key => !allowed.includes(key))) return res.status(400).json({ message: 'The request contains fields this account cannot change.' });
  const data = { ...req.body };
  const passwordWasSet = typeof data.password === 'string' && data.password.length > 0;
  if (data.email) data.email = String(data.email).trim().toLowerCase();
  if (data.username !== undefined) data.username = String(data.username).trim() || undefined;
  if (data.employeeId !== undefined) data.employeeId = String(data.employeeId).trim() || undefined;
  if (data.department !== undefined) data.department = String(data.department).trim() || undefined;
  const existing = await User.findById(req.params.id);
  if (!existing) return res.status(404).json({ message: 'User not found.' });
  if (String(existing._id) === String(req.authId) && (data.status === 'Inactive' || data.role && data.role !== 'Administrator')) return res.status(409).json({ message: 'You cannot deactivate or remove administrator access from your own account.' });
  if (data.role && !roles.includes(data.role)) return res.status(400).json({ message: 'Choose a supported account role.' });
  const nextRole = data.role || existing.role;
  if (existing.role === ROLE.ADMIN && existing.status === 'Active' && (nextRole !== ROLE.ADMIN || data.status === 'Inactive') && await User.countDocuments({ role: ROLE.ADMIN, status: 'Active' }) <= 1) return res.status(409).json({ message: 'The last active administrator cannot be demoted or deactivated.' });
  if (data.status && !['Active', 'Inactive'].includes(data.status)) return res.status(400).json({ message: 'Choose a valid account status.' });
  if (await conflictingLoginIdentifier(data.username ?? existing.username, data.email ?? existing.email, existing._id)) return res.status(409).json({ message: 'That username or email conflicts with an existing login identifier.' });
  if (nextRole !== 'Instructor' && (data.department !== undefined || data.employeeId !== undefined || data.instructor !== undefined)) return res.status(400).json({ message: 'Instructor profile fields can only be changed for an Instructor account.' });
  if (nextRole === ROLE.STUDENT) {
    const sectionId = data.section ?? existing.section;
    if (!sectionId || !mongoose.isValidObjectId(sectionId) || !await Section.exists({ _id: sectionId, status: 'Active' })) return res.status(400).json({ message: 'Assign this student account to an active student section.' });
    data.section = sectionId;
  } else if (data.section !== undefined) return res.status(400).json({ message: 'A student section can only be assigned to a Student account.' });
  if (passwordWasSet) { data.passwordHash = await hashPassword(data.password); data.setupRequired = false; delete data.password; }
  if (existing.setupRequired && !passwordWasSet && (data.status || existing.status) === 'Active') return res.status(409).json({ message: 'Set a private password before activating this account.' });

  let linked = existing.role === 'Instructor' && existing.instructor ? await Instructor.findById(existing.instructor) : null;
  let previousInstructor;
  let newInstructor = false;
  if (nextRole === 'Instructor') {
    const email = requireInstructorEmail(data.email ?? existing.email);
    const instructorName = String(data.name ?? existing.name).trim();
    if (!instructorName) return res.status(400).json({ message: 'Instructor name is required.' });
    if (data.department && !INSTRUCTOR_DEPARTMENTS.includes(data.department)) return res.status(400).json({ message: 'Choose a valid instructor department.' });
    if (data.instructor && linked && String(data.instructor) !== String(linked._id)) return res.status(409).json({ message: 'An Instructor account cannot be relinked to a different instructor record.' });
    if (linked) {
      if (await Instructor.exists({ email, _id: { $ne: linked._id } })) return res.status(409).json({ message: 'Another instructor already uses this email address.' });
      if (data.employeeId && await Instructor.exists({ employeeId: data.employeeId, _id: { $ne: linked._id } })) return res.status(409).json({ message: 'An instructor with this ID already exists.' });
      previousInstructor = linked.toObject();
      linked.name = instructorName; linked.email = email;
      if (data.department !== undefined) linked.department = data.department;
      if (data.employeeId !== undefined) linked.employeeId = data.employeeId;
      linked.status = data.status ?? existing.status;
      await linked.save();
    } else {
      linked = await Instructor.findOne({ email });
      if (linked && await User.exists({ instructor: linked._id, _id: { $ne: existing._id } })) return res.status(409).json({ message: 'This instructor record is already linked to another account.' });
      if (linked) {
        previousInstructor = linked.toObject();
        if (data.employeeId && await Instructor.exists({ employeeId: data.employeeId, _id: { $ne: linked._id } })) return res.status(409).json({ message: 'An instructor with this ID already exists.' });
        linked.name = instructorName; linked.email = email;
        if (data.department !== undefined) linked.department = data.department;
        if (data.employeeId !== undefined) linked.employeeId = data.employeeId;
        linked.status = data.status ?? existing.status;
        await linked.save();
      } else {
        if (data.employeeId && await Instructor.exists({ employeeId: data.employeeId })) return res.status(409).json({ message: 'An instructor with this ID already exists.' });
        linked = await Instructor.create({ name: instructorName, email, department: data.department, employeeId: data.employeeId, status: data.status ?? existing.status });
        newInstructor = true;
      }
    }
    data.instructor = linked._id;
    data.role = 'Instructor';
    delete data.department; delete data.employeeId;
  } else if (existing.role === 'Instructor' && linked) {
    previousInstructor = linked.toObject();
    linked.status = 'Inactive';
    await linked.save();
    delete data.instructor;
  }
  let user;
  try {
    const unset = {};
    if (nextRole !== ROLE.INSTRUCTOR && existing.instructor) unset.instructor = 1;
    if (nextRole !== ROLE.STUDENT && existing.section) unset.section = 1;
    const update = Object.keys(unset).length ? { $set: data, $unset: unset } : data;
    user = await User.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!user) return res.status(404).json({ message: 'User not found.' });
  } catch (error) {
    if (newInstructor && linked) await Instructor.deleteOne({ _id: linked._id }).catch(() => {});
    else if (previousInstructor) { const { _id, __v, ...restore } = previousInstructor; await Instructor.findByIdAndUpdate(_id, { $set: restore }).catch(() => {}); }
    throw error;
  }
  await AuditLog.create({ actor: req.user.email, action: 'updated', entity: 'users', entityId: user._id, details: { role: user.role, status: user.status } });
  res.json(publicUser(await User.findById(user._id).populate('instructor', 'name employeeId department status').populate('section', 'name program yearLevel status')));
}));
app.delete('/api/users/:id', policyPermit('write', 'users'), asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid user ID.' });
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  if (String(user._id) === String(req.authId)) return res.status(409).json({ message: 'You cannot permanently delete your own administrator account.' });
  if (user.role === 'Administrator' && user.status === 'Active' && await User.countDocuments({ role: 'Administrator', status: 'Active' }) <= 1) return res.status(409).json({ message: 'The last active administrator account cannot be deleted.' });
  const dependencies = {};
  if (user.instructor) {
    const [schedules, reservations] = await Promise.all([
      Schedule.countDocuments({ instructor: user.instructor }),
      ReservationRequest.countDocuments({ $or: [{ instructor: user.instructor }, { requesterInstructor: user.instructor }] })
    ]);
    if (schedules) dependencies['instructor schedules'] = schedules;
    if (reservations) dependencies['instructor reservations'] = reservations;
    dependencies['linked instructor record'] = 1;
  }
  const [requests, auditLogs] = await Promise.all([
    ReservationRequest.countDocuments({ requesterEmail: user.email }),
    AuditLog.countDocuments({ $or: [{ actor: user.email }, { entity: 'users', entityId: String(user._id) }] })
  ]);
  if (requests) dependencies['reservation history'] = requests;
  if (auditLogs) dependencies['audit history'] = auditLogs;
  if (Object.keys(dependencies).length) return res.status(409).json({ code: 'RECORD_REFERENCED', message: 'This account has linked records and cannot be permanently deleted.', dependencies, canDeactivate: true });
  await AuditLog.create({ actor: req.user.email, action: 'deleted', entity: 'users', entityId: user._id, details: { email: user.email } });
  await User.deleteOne({ _id: user._id });
  res.json({ _id: user._id, deleted: true });
}));
app.post('/api/requests/:id/cancel', policyPermit('write', 'requests:cancel'), asyncRoute(async (req, res) => {
  const doc = await ReservationRequest.findOneAndUpdate({ _id: req.params.id, status: 'Pending', $or: [{ requesterUser: req.user._id }, { requesterUser: { $exists: false }, requesterInstructor: req.user.instructor }] }, { $set: { status: 'Cancelled' } }, { new: true });
  if (!doc) return res.status(409).json({ message: 'Only your pending request can be cancelled.' });
  await AuditLog.create({ actor: req.user.email, action: 'cancelled', entity: 'requests', entityId: doc._id });
  res.json(doc);
}));
app.use((err, _req, res, _next) => {
  if (err.status) return res.status(err.status).json({ message: err.message });
  if (err.name === 'ValidationError' || err.name === 'CastError') return res.status(400).json({ message: err.message });
  if (err.code === 11000) {
    if (err.keyPattern?.employeeId) return res.status(409).json({ message: 'An instructor with this ID already exists.' });
    if (err.keyPattern?.instructor) return res.status(409).json({ message: 'This instructor record is already linked to another account.' });
    if (err.keyPattern?.email) return res.status(409).json({ message: 'This email address is already registered.' });
    return res.status(409).json({ message: 'A record with this value already exists.' });
  }
  console.error(err); res.status(500).json({ message: 'The server could not complete this request.' });
});
export { app };
if (process.env.NODE_ENV !== 'test') {
  const port = process.env.PORT || 5000;
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error('Set JWT_SECRET in server/.env to a private value of at least 32 characters.');
    process.exit(1);
  }
  mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/campus_scheduler', { serverSelectionTimeoutMS: 5000 }).then(() => app.listen(port, () => console.log(`Scheduler API listening on ${port}`))).catch(err => { console.error('MongoDB connection failed. Start MongoDB with `docker compose up -d mongodb` or set MONGODB_URI in server/.env.'); console.error(err.message); process.exit(1); });
}
