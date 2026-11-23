import fs from 'node:fs';
import path from 'node:path';
import { CRAFTHELM_ROOT } from './paths.mjs';

const schemaCache = new Map();

/**
 * Load a JSON Schema from `contracts/schemas/<name>.schema.json`.
 * @param {string} schemaName
 * @returns {object}
 */
export function loadSchema(schemaName) {
  const cleanName = schemaName.replace(/\.schema\.json$/, '');
  if (schemaCache.has(cleanName)) {
    return schemaCache.get(cleanName);
  }
  const filePath = path.join(CRAFTHELM_ROOT, 'contracts', 'schemas', `${cleanName}.schema.json`);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  schemaCache.set(cleanName, parsed);
  return parsed;
}

/**
 * Validate a data structure against a named CraftHelm JSON Schema.
 * Implements Draft 2020-12 subset used across CraftHelm contracts.
 * @param {string} schemaName
 * @param {unknown} data
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateAgainstSchema(schemaName, data) {
  const rootSchema = loadSchema(schemaName);
  const errors = [];
  validateNode(rootSchema, rootSchema, data, '$', errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Assert data conforms to schema, throwing an Error with detailed violations if not.
 * @param {string} schemaName
 * @param {unknown} data
 * @param {string} [label]
 */
export function assertValidSchema(schemaName, data, label = schemaName) {
  const res = validateAgainstSchema(schemaName, data);
  if (!res.valid) {
    throw new Error(`Schema validation failed for ${label}: ${res.errors.join('; ')}`);
  }
}

function resolveRef(rootSchema, ref) {
  if (!ref.startsWith('#/')) {
    throw new Error(`Unsupported external $ref: ${ref}`);
  }
  const parts = ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = rootSchema;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) {
      throw new Error(`Unresolvable $ref: ${ref}`);
    }
    cur = cur[part];
  }
  return cur;
}

function getJsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return typeof value;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((v, idx) => deepEqual(v, b[idx]));
  }
  if (typeof a === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function validateNode(rootSchema, schema, value, ptr, errors) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.$ref) {
    const target = resolveRef(rootSchema, schema.$ref);
    validateNode(rootSchema, target, value, ptr, errors);
  }

  if (schema.type !== undefined) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actualType = getJsonType(value);
    const typeMatches = allowedTypes.some((expected) => {
      if (expected === 'number' && actualType === 'integer') return true;
      return expected === actualType;
    });
    if (!typeMatches) {
      errors.push(`${ptr}: expected type ${allowedTypes.join('|')}, got ${actualType}`);
      return;
    }
  }

  if ('const' in schema && !deepEqual(value, schema.const)) {
    errors.push(`${ptr}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(value, item))) {
    errors.push(`${ptr}: value ${JSON.stringify(value)} not in enum [${schema.enum.join(', ')}]`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${ptr}: string length ${value.length} < minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${ptr}: string length ${value.length} > maxLength ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${ptr}: string does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${ptr}: ${value} < minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${ptr}: ${value} > maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${ptr}: array length ${value.length} < minItems ${schema.minItems}`);
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        validateNode(rootSchema, schema.items, value[i], `${ptr}[${i}]`, errors);
      }
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!Object.hasOwn(value, reqKey) || value[reqKey] === undefined) {
          errors.push(`${ptr}: missing required property "${reqKey}"`);
        }
      }
    }

    const props = schema.properties ?? {};
    for (const [key, propVal] of Object.entries(value)) {
      if (propVal === undefined) continue;
      if (Object.hasOwn(props, key)) {
        validateNode(rootSchema, props[key], propVal, `${ptr}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${ptr}.${key}: additional property is not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateNode(rootSchema, schema.additionalProperties, propVal, `${ptr}.${key}`, errors);
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      validateNode(rootSchema, sub, value, ptr, errors);
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((sub) => {
      const subErrors = [];
      validateNode(rootSchema, sub, value, ptr, subErrors);
      return subErrors.length === 0;
    });
    if (!matched) {
      errors.push(`${ptr}: failed to match anyOf`);
    }
  }

  if (Array.isArray(schema.oneOf)) {
    let matches = 0;
    for (const sub of schema.oneOf) {
      const subErrors = [];
      validateNode(rootSchema, sub, value, ptr, subErrors);
      if (subErrors.length === 0) matches += 1;
    }
    if (matches !== 1) {
      errors.push(`${ptr}: expected exactly 1 match in oneOf, got ${matches}`);
    }
  }

  if (schema.not) {
    const subErrors = [];
    validateNode(rootSchema, schema.not, value, ptr, subErrors);
    if (subErrors.length === 0) {
      errors.push(`${ptr}: must NOT match "not" subschema`);
    }
  }

  if (schema.if) {
    const ifErrors = [];
    validateNode(rootSchema, schema.if, value, ptr, ifErrors);
    if (ifErrors.length === 0 && schema.then) {
      validateNode(rootSchema, schema.then, value, ptr, errors);
    } else if (ifErrors.length > 0 && schema.else) {
      validateNode(rootSchema, schema.else, value, ptr, errors);
    }
  }
}
