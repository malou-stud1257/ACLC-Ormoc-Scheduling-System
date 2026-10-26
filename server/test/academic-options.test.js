import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACADEMIC_ADD_LABELS,
  ACADEMIC_SEMESTERS,
  COURSE_DEPARTMENTS,
  INSTRUCTOR_DEPARTMENTS,
  SECTION_NAMES,
  SECTION_PROGRAMS,
  formatSectionDisplayName,
  positiveWholeNumber
} from '../../shared/academic-options.js';

test('academic dropdown configuration preserves the requested option sets and order', () => {
  assert.deepEqual(COURSE_DEPARTMENTS, ['Computer Studies', 'Business', 'Hospitality Management', 'Criminology', 'General Education', 'Senior High School']);
  assert.deepEqual(INSTRUCTOR_DEPARTMENTS, ['Computer Studies', 'Business', 'Hospitality Management', 'Criminology', 'Language', 'Science', 'Social Science', 'Mathematics']);
  assert.deepEqual(SECTION_NAMES, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
  assert.deepEqual(SECTION_PROGRAMS, ['BSIT', 'BSCS', 'ACT', 'WAD', 'BSBA', 'OAT', 'OMT', 'BSHM', 'HRT', 'BS Criminology', 'BSTM', 'BS Entrepreneurship', 'BS ISM', 'STEM', 'ABM', 'HUMSS', 'ICT - CSS', 'ICT - Programming', 'ICT - Animation', 'HE']);
  assert.deepEqual(ACADEMIC_SEMESTERS, ['First Semester', 'Second Semester']);
  assert.deepEqual(ACADEMIC_ADD_LABELS, { courses: 'Add Course', instructors: 'Add Instructor', sections: 'Add Student Section', terms: 'Add Academic Term', users: 'Add User' });
});

test('positive whole number parsing rejects invalid section and year-level values', () => {
  for (const value of [1, '1', ' 02 ']) assert.ok(positiveWholeNumber(value) > 0);
  for (const value of [undefined, null, '', '0', 0, -1, '-1', 1.5, '1.5', 'Year 2', '1a']) assert.equal(positiveWholeNumber(value), null);
});

test('section display names combine available values without awkward separators', () => {
  assert.equal(formatSectionDisplayName({ program: 'BSCS', yearLevel: 1, name: 'A' }), 'BSCS-1 A');
  assert.equal(formatSectionDisplayName({ program: 'ICT - Programming', yearLevel: 11, name: 'A' }), 'ICT-Programming-11 A');
  assert.equal(formatSectionDisplayName({ program: 'BSIT', name: 'B' }), 'BSIT B');
  assert.equal(formatSectionDisplayName({ yearLevel: 11, name: 'C' }), '11 C');
  assert.equal(formatSectionDisplayName({ name: 'D' }), 'D');
  assert.equal(formatSectionDisplayName({}), '—');
});
