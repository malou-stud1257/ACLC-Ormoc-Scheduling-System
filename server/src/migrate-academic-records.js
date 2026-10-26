import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACADEMIC_SEMESTERS, COURSE_DEPARTMENTS, INSTRUCTOR_DEPARTMENTS, SECTION_NAMES, SECTION_PROGRAMS, positiveWholeNumber } from '../../shared/academic-options.js';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/campus_scheduler';
const apply = process.argv.includes('--apply');
const enumFields = [
  ['courses', 'department', COURSE_DEPARTMENTS],
  ['instructors', 'department', INSTRUCTOR_DEPARTMENTS],
  ['sections', 'name', SECTION_NAMES],
  ['sections', 'program', SECTION_PROGRAMS],
  ['academicterms', 'name', ACADEMIC_SEMESTERS]
];

try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  const db = mongoose.connection.db;
  const unsupported = [];
  const numericIssues = [];
  const numericConversions = [];
  const emptyOptionalYearLevels = [];

  for (const [collection, field, choices] of enumFields) {
    const rows = await db.collection(collection).find({}, { projection: { [field]: 1 } }).toArray();
    for (const row of rows) {
      const value = row[field];
      if (value !== undefined && value !== null && value !== '' && !choices.includes(value)) {
        unsupported.push({ collection, id: String(row._id), field, value });
      }
    }
  }

  for (const row of await db.collection('sections').find({}, { projection: { yearLevel: 1 } }).toArray()) {
    const value = row.yearLevel;
    if (value === undefined || value === null) continue;
    if (value === '') {
      emptyOptionalYearLevels.push(String(row._id));
      continue;
    }
    const parsed = positiveWholeNumber(value);
    if (parsed === null) numericIssues.push({ id: String(row._id), field: 'yearLevel', value });
    else if (typeof value === 'string') numericConversions.push({ id: String(row._id), field: 'yearLevel', from: value, to: parsed });
  }

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', unsupportedDropdownValues: unsupported, invalidYearLevels: numericIssues, yearLevelStringsToConvert: numericConversions, emptyOptionalYearLevelsToClear: emptyOptionalYearLevels }, null, 2));

  if (apply && numericIssues.length) {
    console.error('No numeric fields were changed because invalid legacy values need manual correction first.');
    process.exitCode = 2;
  } else if (apply) {
    for (const item of numericConversions) {
      await db.collection('sections').updateOne({ _id: new mongoose.Types.ObjectId(item.id) }, { $set: { [item.field]: item.to } });
    }
    for (const id of emptyOptionalYearLevels) {
      await db.collection('sections').updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $unset: { yearLevel: '' } });
    }
    console.log(`Converted ${numericConversions.length} numeric year-level strings and cleared ${emptyOptionalYearLevels.length} empty optional year levels. Unsupported dropdown values were preserved.`);
  }
} finally {
  await mongoose.disconnect();
}
