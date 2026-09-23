import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ParsedArgs } from '../lib/types.ts';
import { authenticatedToolClient, type ToolClient } from '../lib/tool-client.ts';
import { BillingIdentityError, parseBillingIdentity, type BillingIdentity } from '../lib/billing.ts';
import { CliUsageError } from '../lib/errors.ts';

type PurchaseDependencies = {
  client: (parsed: ParsedArgs) => Promise<ToolClient>;
  read: (path: string) => Promise<string>;
  write: (text: string) => void;
};

const defaults: PurchaseDependencies = {
  client: authenticatedToolClient,
  read: (path) => readFile(path, 'utf8'),
  write: (text) => process.stdout.write(`${text}\n`),
};

const USAGE = {
  'purchase create':
    'purchase create --account ACCOUNT --product eur20|eur100 --request-id ID [--billing JSON|@FILE] [--json]',
  'purchase get': 'purchase get --purchase ID [--json]',
} as const;

export type PurchaseCommand = keyof typeof USAGE;

export function purchaseCommandUsage(command: PurchaseCommand): string {
  return `Usage: makefx ${USAGE[command]}`;
}

function option(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options[name];
  if (value === 'true') throw new CliUsageError(`--${name} requires a value.`);
  return value;
}

function required(parsed: ParsedArgs, name: string, command: PurchaseCommand): string {
  const value = option(parsed, name);
  if (!value) throw new CliUsageError(`${command} requires --${name} <value>.`);
  return value;
}

function rejectUnexpected(parsed: ParsedArgs, command: PurchaseCommand, allowed: string[]): void {
  if (parsed.positionals.length > 0) {
    throw new CliUsageError(
      `${command} does not accept "${parsed.positionals[0]}". ${purchaseCommandUsage(command)}`,
    );
  }
  const options = new Set(['env', 'local', 'json', ...allowed]);
  const unexpected = Object.keys(parsed.options).find((name) => !options.has(name));
  if (unexpected) {
    throw new CliUsageError(`Unknown option --${unexpected}. ${purchaseCommandUsage(command)}`);
  }
  for (const flag of ['local', 'json']) {
    const value = parsed.options[flag];
    if (value !== undefined && value !== 'true') {
      throw new CliUsageError(`--${flag} does not accept a value. ${purchaseCommandUsage(command)}`);
    }
  }
  option(parsed, 'env');
}

function billingIdentity(value: unknown): BillingIdentity {
  try {
    return parseBillingIdentity(value);
  } catch (error) {
    if (!(error instanceof BillingIdentityError)) throw error;
    throw new CliUsageError(`--billing${error.path ? `.${error.path}` : ''} ${error.message}`);
  }
}

async function parseBilling(
  source: string,
  read: PurchaseDependencies['read'],
): Promise<BillingIdentity> {
  let text = source;
  if (source.startsWith('@')) {
    if (source.length === 1) throw new CliUsageError('--billing @FILE requires a file path.');
    text = await read(resolve(source.slice(1)));
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new CliUsageError('--billing must be valid JSON or @FILE containing JSON.');
  }
  return billingIdentity(value);
}

export async function purchaseToolCall(
  command: PurchaseCommand,
  parsed: ParsedArgs,
  read: PurchaseDependencies['read'] = defaults.read,
): Promise<{ name: string; args: Record<string, unknown> }> {
  if (command === 'purchase get') {
    rejectUnexpected(parsed, command, ['purchase']);
    return { name: 'get_credit_purchase', args: { purchase_id: required(parsed, 'purchase', command) } };
  }
  rejectUnexpected(parsed, command, ['account', 'product', 'request-id', 'billing']);
  const product = required(parsed, 'product', command);
  if (product !== 'eur20' && product !== 'eur100') {
    throw new CliUsageError('--product must be eur20 or eur100.');
  }
  const account = required(parsed, 'account', command);
  const requestId = required(parsed, 'request-id', command);
  if (account.length > 64) throw new CliUsageError('--account must be at most 64 characters.');
  if (requestId.length > 64) throw new CliUsageError('--request-id must be at most 64 characters.');
  const source = option(parsed, 'billing');
  const billing = source === undefined ? undefined : await parseBilling(source, read);
  return {
    name: 'create_credit_purchase',
    args: {
      account_id: account,
      product,
      request_id: requestId,
      ...(billing ? { billing } : {}),
    },
  };
}

function humanOutput(command: PurchaseCommand, result: Record<string, unknown>): string {
  const amounts =
    typeof result.total_amount === 'number' && typeof result.currency === 'string'
      ? `${(result.total_amount / 100).toFixed(2)} ${result.currency.toUpperCase()}`
      : undefined;
  return [
    result.purchase_id,
    result.status,
    amounts,
    command === 'purchase create' ? result.payment_url : result.invoice_url,
  ]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .join(' · ');
}

export async function handlePurchaseCommand(
  command: PurchaseCommand,
  parsed: ParsedArgs,
  dependencies: PurchaseDependencies = defaults,
): Promise<void> {
  const call = await purchaseToolCall(command, parsed, dependencies.read);
  const client = await dependencies.client(parsed);
  const result = await client.call(call.name, call.args);
  dependencies.write(
    parsed.options.json === 'true' ? JSON.stringify(result, null, 2) : humanOutput(command, result),
  );
}
