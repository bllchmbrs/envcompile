export class EnvcompileError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'EnvcompileError';
    this.exitCode = exitCode;
  }
}

export function configError(message) {
  return new EnvcompileError(message, 2);
}

export function dotenvxError(message) {
  return new EnvcompileError(message, 3);
}
