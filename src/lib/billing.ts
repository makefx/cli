import { isRecord } from './json.ts';

/**
 * The account billing identity `purchase create --billing` may carry.
 *
 * The service validates it again; checking here refuses a malformed or
 * card-bearing document before the CLI signs in or sends anything. Unknown
 * fields are refused so payment data can never ride along.
 */
export type BillingIdentity = {
  name: string;
  email: string;
  address: {
    line1: string;
    line2?: string;
    city: string;
    postal_code: string;
    state?: string;
    country: string;
  };
  tax_id?: { type: 'eu_vat'; value: string };
};

export class BillingIdentityError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}

type Field = { min?: number; max: number; optional?: boolean; pattern?: RegExp; hint?: string };

// The service's email rule: no leading or doubled dot in the local part, and
// a dotted domain ending in a label of two or more letters.
const EMAIL_PATTERN =
  /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

function object(value: unknown, path: string, fields: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new BillingIdentityError(path, 'must be a JSON object.');
  const unknown = Object.keys(value).find((key) => !fields.includes(key));
  if (unknown !== undefined) {
    throw new BillingIdentityError(path ? `${path}.${unknown}` : unknown, 'is not a billing identity field.');
  }
  return value;
}

function text(record: Record<string, unknown>, key: string, path: string, field: Field): string | undefined {
  const name = path ? `${path}.${key}` : key;
  const value = record[key];
  if (value === undefined && field.optional) return undefined;
  if (typeof value !== 'string') throw new BillingIdentityError(name, 'must be a string.');
  const min = field.min ?? 0;
  if (value.length < min) throw new BillingIdentityError(name, 'must not be empty.');
  if (value.length > field.max) {
    throw new BillingIdentityError(name, `must be at most ${field.max} characters.`);
  }
  if (field.pattern && !field.pattern.test(value)) {
    throw new BillingIdentityError(name, `must be ${field.hint}.`);
  }
  return value;
}

export function parseBillingIdentity(value: unknown): BillingIdentity {
  const root = object(value, '', ['name', 'email', 'address', 'tax_id']);
  const address = object(root.address, 'address', ['line1', 'line2', 'city', 'postal_code', 'state', 'country']);
  const identity: BillingIdentity = {
    name: text(root, 'name', '', { min: 1, max: 200 }) as string,
    email: text(root, 'email', '', { max: 254, pattern: EMAIL_PATTERN, hint: 'an email address' }) as string,
    address: {
      line1: text(address, 'line1', 'address', { min: 1, max: 200 }) as string,
      city: text(address, 'city', 'address', { min: 1, max: 100 }) as string,
      postal_code: text(address, 'postal_code', 'address', { min: 1, max: 30 }) as string,
      country: text(address, 'country', 'address', {
        max: 2,
        pattern: /^[A-Z]{2}$/,
        hint: 'a two-letter uppercase country code',
      }) as string,
    },
  };
  const line2 = text(address, 'line2', 'address', { max: 200, optional: true });
  if (line2 !== undefined) identity.address.line2 = line2;
  const state = text(address, 'state', 'address', { max: 100, optional: true });
  if (state !== undefined) identity.address.state = state;
  if (root.tax_id !== undefined) {
    const taxId = object(root.tax_id, 'tax_id', ['type', 'value']);
    if (taxId.type !== 'eu_vat') throw new BillingIdentityError('tax_id.type', 'must be eu_vat.');
    identity.tax_id = { type: 'eu_vat', value: text(taxId, 'value', 'tax_id', { min: 1, max: 40 }) as string };
  }
  return identity;
}
