export const ROLE = Object.freeze({
  ADMIN: 'Administrator',
  SCHEDULER: 'Scheduler',
  INSTRUCTOR: 'Instructor',
  STUDENT: 'Student / Schedule Viewer'
});

export const ROLE_VALUES = Object.freeze(Object.values(ROLE));
export const MANAGER_ROLES = Object.freeze([ROLE.ADMIN, ROLE.SCHEDULER]);

const policies = Object.freeze({
  [ROLE.ADMIN]: {
    pages: ['dashboard', 'schedules', 'rooms', 'requests', 'courses', 'reports'],
    read: ['dashboard', 'rooms', 'resources', 'instructors', 'courses', 'sections', 'terms', 'schedules', 'requests', 'users', 'reports'],
    write: ['rooms', 'resources', 'instructors', 'courses', 'sections', 'terms', 'schedules', 'requests', 'users', 'reports']
  },
  [ROLE.SCHEDULER]: {
    pages: ['dashboard', 'schedules', 'rooms', 'requests', 'courses', 'reports'],
    read: ['dashboard', 'rooms', 'resources', 'instructors', 'courses', 'sections', 'terms', 'schedules', 'requests', 'reports'],
    write: ['rooms', 'resources', 'instructors', 'courses', 'sections', 'terms', 'schedules', 'requests', 'reports']
  },
  [ROLE.INSTRUCTOR]: {
    pages: ['dashboard', 'schedules', 'rooms', 'requests'],
    read: ['dashboard', 'rooms', 'instructors', 'courses', 'sections', 'terms', 'schedules', 'requests'],
    write: ['requests:create', 'requests:cancel']
  },
  [ROLE.STUDENT]: {
    pages: ['dashboard', 'schedules', 'rooms'],
    read: ['dashboard', 'rooms', 'terms', 'schedules'],
    write: []
  }
});

export function canAccessPage(role, page) {
  return policies[role]?.pages.includes(page) ?? false;
}

export function canRead(role, resource) {
  return policies[role]?.read.includes(resource) ?? false;
}

export function canWrite(role, resource) {
  return policies[role]?.write.includes(resource) ?? false;
}

export function isManager(role) {
  return role === ROLE.ADMIN || role === ROLE.SCHEDULER;
}
