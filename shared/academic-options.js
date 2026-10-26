export const COURSE_DEPARTMENTS = Object.freeze([
  'Computer Studies',
  'Business',
  'Hospitality Management',
  'Criminology',
  'General Education',
  'Senior High School'
]);

export const INSTRUCTOR_DEPARTMENTS = Object.freeze([
  'Computer Studies',
  'Business',
  'Hospitality Management',
  'Criminology',
  'Language',
  'Science',
  'Social Science',
  'Mathematics'
]);

export const SECTION_PROGRAMS = Object.freeze([
  'BSIT',
  'BSCS',
  'ACT',
  'WAD',
  'BSBA',
  'OAT',
  'OMT',
  'BSHM',
  'HRT',
  'BS Criminology',
  'BSTM',
  'BS Entrepreneurship',
  'BS ISM',
  'STEM',
  'ABM',
  'HUMSS',
  'ICT - CSS',
  'ICT - Programming',
  'ICT - Animation',
  'HE'
]);

export const ACADEMIC_SEMESTERS = Object.freeze(['First Semester', 'Second Semester']);
export const SECTION_NAMES = Object.freeze('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));

export const ACADEMIC_ADD_LABELS = Object.freeze({
  courses: 'Add Course',
  instructors: 'Add Instructor',
  sections: 'Add Student Section',
  terms: 'Add Academic Term',
  users: 'Add User'
});

export function positiveWholeNumber(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function formatSectionDisplayName(section = {}) {
  const program = String(section.program || '').trim().replace(/\s*-\s*/g, '-').replace(/\s+/g, '-');
  const yearLevel = section.yearLevel === undefined || section.yearLevel === null || section.yearLevel === '' ? '' : String(section.yearLevel).trim();
  const letter = String(section.name || '').trim();
  const prefix = [program, yearLevel].filter(Boolean).join('-');
  return [prefix, letter].filter(Boolean).join(' ') || '—';
}
