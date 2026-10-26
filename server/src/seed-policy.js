const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function demoSeedAllowed(nodeEnv, mongoUri) {
  const environment = String(nodeEnv || '').trim().toLowerCase();
  if (environment === 'production') return false;
  try {
    const localDatabase = loopbackHosts.has(new URL(mongoUri).hostname.toLowerCase());
    return localDatabase && ['development', 'test', ''].includes(environment);
  } catch {
    return false;
  }
}
