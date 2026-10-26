export function normalizeLoginIdentifier(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function loginIdentifierQuery(identifier) {
  return { $or: [{ username: identifier }, { email: identifier.toLowerCase() }] };
}

export function resolveActiveLoginMatch(matches) {
  return matches?.length === 1 && matches[0].status === 'Active' ? matches[0] : null;
}

export function validLoginInput(identifier, password) {
  return typeof identifier === 'string' && identifier.length > 0 && identifier.length <= 320 && typeof password === 'string' && password.length > 0;
}
