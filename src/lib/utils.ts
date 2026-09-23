import type { ParsedArgs } from './types.ts';

export function parseArgs(argv: string[]): ParsedArgs {
  const options: Record<string, string> = {};
  const values: Record<string, string[]> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    // Handle single-dash options like -o
    if (token.startsWith('-') && !token.startsWith('--')) {
      const key = token.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        options[key] = next;
        (values[key] ??= []).push(next);
        i += 1;
      } else {
        options[key] = 'true';
        (values[key] ??= []).push('true');
      }
      continue;
    }

    // Handle double-dash options
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const eqIndex = token.indexOf('=');
    if (eqIndex !== -1) {
      const key = token.slice(2, eqIndex);
      const value = token.slice(eqIndex + 1);
      options[key] = value;
      (values[key] ??= []).push(value);
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      options[key] = next;
      (values[key] ??= []).push(next);
      i += 1;
    } else {
      options[key] = 'true';
      (values[key] ??= []).push('true');
    }
  }

  return { options, values, positionals };
}
