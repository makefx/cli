import { isDeepStrictEqual } from 'node:util';

export type JsonSchema = Record<string, unknown>;

type ValidationIssue = { field: string; message: string };
export type JsonSchemaValidation = { ok: true; value: unknown } | { ok: false; issue: ValidationIssue };

const SCHEMA_KEYS = new Set([
  '$schema',
  'type',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'default',
  'title',
  'description',
  'preview_url',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'prefixItems',
  'anyOf',
  'oneOf',
]);

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function record(value: unknown): JsonSchema | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonSchema)
    : undefined;
}

function nonnegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function schemaList(value: unknown, field: string): JsonSchema[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array.`);
  }
  return value.map((candidate, index) => {
    const child = record(candidate);
    if (!child) throw new Error(`${field}[${index}] must be an object.`);
    return child;
  });
}

export function assertJsonSchema(schema: unknown, field = 'params_schema'): asserts schema is JsonSchema {
  const value = record(schema);
  if (!value) throw new Error(`${field} must be an object.`);

  for (const key of Object.keys(value)) {
    if (!SCHEMA_KEYS.has(key)) throw new Error(`${field} uses unsupported keyword "${key}".`);
  }
  if (value.type !== undefined && (typeof value.type !== 'string' || !TYPES.has(value.type))) {
    throw new Error(`${field}.type is invalid.`);
  }
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0)) {
    throw new Error(`${field}.enum must be a non-empty array.`);
  }
  for (const name of ['minimum', 'maximum'] as const) {
    if (value[name] !== undefined && (typeof value[name] !== 'number' || !Number.isFinite(value[name]))) {
      throw new Error(`${field}.${name} must be a finite number.`);
    }
  }
  if (
    typeof value.minimum === 'number' &&
    typeof value.maximum === 'number' &&
    value.minimum > value.maximum
  ) {
    throw new Error(`${field}.minimum must not exceed maximum.`);
  }
  for (const name of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    if (value[name] !== undefined && !nonnegativeInteger(value[name])) {
      throw new Error(`${field}.${name} must be a nonnegative integer.`);
    }
  }
  if (
    typeof value.minLength === 'number' &&
    typeof value.maxLength === 'number' &&
    value.minLength > value.maxLength
  ) {
    throw new Error(`${field}.minLength must not exceed maxLength.`);
  }
  if (
    typeof value.minItems === 'number' &&
    typeof value.maxItems === 'number' &&
    value.minItems > value.maxItems
  ) {
    throw new Error(`${field}.minItems must not exceed maxItems.`);
  }
  for (const name of ['$schema', 'title', 'description', 'preview_url'] as const) {
    if (value[name] !== undefined && typeof value[name] !== 'string') {
      throw new Error(`${field}.${name} must be a string.`);
    }
  }

  if (value.properties !== undefined) {
    const properties = record(value.properties);
    if (!properties) throw new Error(`${field}.properties must be an object.`);
    for (const [name, child] of Object.entries(properties)) {
      assertJsonSchema(child, `${field}.properties.${name}`);
    }
  }
  if (
    value.required !== undefined &&
    (!Array.isArray(value.required) || value.required.some((name) => typeof name !== 'string'))
  ) {
    throw new Error(`${field}.required must be an array of strings.`);
  }
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') {
    throw new Error(`${field}.additionalProperties must be a boolean.`);
  }
  if (value.items !== undefined && value.items !== false) {
    assertJsonSchema(value.items, `${field}.items`);
  }
  if (value.prefixItems !== undefined) {
    if (!Array.isArray(value.prefixItems)) throw new Error(`${field}.prefixItems must be an array.`);
    value.prefixItems.forEach((child, index) => assertJsonSchema(child, `${field}.prefixItems[${index}]`));
  }
  for (const name of ['anyOf', 'oneOf'] as const) {
    if (value[name] === undefined) continue;
    schemaList(value[name], `${field}.${name}`).forEach((child, index) =>
      assertJsonSchema(child, `${field}.${name}[${index}]`),
    );
  }
  if ('default' in value) {
    const result = validate(value, value.default, field);
    if (!result.ok) throw new Error(`${field}.default is invalid: ${result.issue.message}`);
  }
}

function issue(field: string, message: string): JsonSchemaValidation {
  return { ok: false, issue: { field, message } };
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return record(value) !== undefined;
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function validate(schema: JsonSchema, input: unknown, field: string): JsonSchemaValidation {
  if (typeof schema.type === 'string' && !typeMatches(schema.type, input)) {
    return issue(field, `Expected ${schema.type}.`);
  }
  if (schema.const !== undefined && !isDeepStrictEqual(input, schema.const)) {
    return issue(field, `Expected ${JSON.stringify(schema.const)}.`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => isDeepStrictEqual(input, candidate))) {
    return issue(field, `Expected one of ${schema.enum.map((value) => JSON.stringify(value)).join(', ')}.`);
  }

  if (typeof input === 'number') {
    if (typeof schema.minimum === 'number' && input < schema.minimum) {
      return issue(field, `Must be at least ${schema.minimum}.`);
    }
    if (typeof schema.maximum === 'number' && input > schema.maximum) {
      return issue(field, `Must be at most ${schema.maximum}.`);
    }
  }
  if (typeof input === 'string') {
    const length = Array.from(input).length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) {
      return issue(field, `Must contain at least ${schema.minLength} characters.`);
    }
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
      return issue(field, `Must contain at most ${schema.maxLength} characters.`);
    }
  }

  let output = input;
  if (Array.isArray(input)) {
    if (typeof schema.minItems === 'number' && input.length < schema.minItems) {
      return issue(field, `Must contain at least ${schema.minItems} items.`);
    }
    if (typeof schema.maxItems === 'number' && input.length > schema.maxItems) {
      return issue(field, `Must contain at most ${schema.maxItems} items.`);
    }
    const prefixItems = Array.isArray(schema.prefixItems) ? (schema.prefixItems as JsonSchema[]) : [];
    const values = [...input];
    for (let index = 0; index < values.length; index += 1) {
      const child = prefixItems[index] ?? (record(schema.items) as JsonSchema | undefined);
      if (!child) {
        if (schema.items === false && index >= prefixItems.length) {
          return issue(`${field}[${index}]`, 'Unexpected item.');
        }
        continue;
      }
      const result = validate(child, values[index], `${field}[${index}]`);
      if (!result.ok) return result;
      values[index] = result.value;
    }
    output = values;
  }
  const object = record(input);
  if (object) {
    const properties = record(schema.properties) ?? {};
    const values = { ...object };
    for (const [name, childValue] of Object.entries(properties)) {
      const child = childValue as JsonSchema;
      if (!(name in values) && 'default' in child) values[name] = structuredClone(child.default);
      if (!(name in values)) continue;
      const result = validate(child, values[name], `${field}.${name}`);
      if (!result.ok) return result;
      values[name] = result.value;
    }
    for (const name of (schema.required ?? []) as string[]) {
      if (!(name in values)) return issue(`${field}.${name}`, 'Required value is missing.');
    }
    if (schema.additionalProperties === false) {
      const unexpected = Object.keys(values).find((name) => !(name in properties));
      if (unexpected) return issue(`${field}.${unexpected}`, 'Unknown parameter.');
    }
    output = values;
  }

  for (const name of ['anyOf', 'oneOf'] as const) {
    if (schema[name] === undefined) continue;
    const matches = schemaList(schema[name], name)
      .map((candidate) => validate(candidate, output, field))
      .filter((result): result is { ok: true; value: unknown } => result.ok);
    if (matches.length === 0) return issue(field, 'Does not match any allowed value.');
    if (name === 'oneOf' && matches.length !== 1) {
      return issue(field, 'Matches more than one allowed value.');
    }
    output = matches[0].value;
  }

  return { ok: true, value: output };
}

export function validateJsonSchema(schema: JsonSchema, input: unknown): JsonSchemaValidation {
  return validate(schema, input, 'params');
}
