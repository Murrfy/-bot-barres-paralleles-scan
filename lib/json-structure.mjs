const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function plainJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function jsonStructureStatus(value, options = {}) {
  const maxDepth = positiveInt(options.maxDepth, 16);
  const maxNodes = positiveInt(options.maxNodes, 20000);
  const maxArrayLength = positiveInt(options.maxArrayLength, 5000);
  const maxObjectKeys = positiveInt(options.maxObjectKeys, 5000);

  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  let maxDepthObserved = 0;

  while (stack.length) {
    const current = stack.pop();
    const node = current.value;
    const depth = current.depth;

    nodes += 1;
    if (nodes > maxNodes) {
      return { ok: false, reason: 'JSON_NODE_LIMIT_EXCEEDED', nodes, maxDepthObserved };
    }
    if (depth > maxDepth) {
      return { ok: false, reason: 'JSON_DEPTH_EXCEEDED', nodes, maxDepthObserved: Math.max(maxDepthObserved, depth) };
    }
    if (depth > maxDepthObserved) maxDepthObserved = depth;

    if (node === null || typeof node === 'string' || typeof node === 'boolean') continue;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) {
        return { ok: false, reason: 'JSON_NUMBER_INVALID', nodes, maxDepthObserved };
      }
      continue;
    }

    if (Array.isArray(node)) {
      if (node.length > maxArrayLength) {
        return { ok: false, reason: 'JSON_ARRAY_LIMIT_EXCEEDED', nodes, maxDepthObserved };
      }
      for (let i = node.length - 1; i >= 0; i -= 1) {
        stack.push({ value: node[i], depth: depth + 1 });
      }
      continue;
    }

    if (!plainJsonObject(node)) {
      return { ok: false, reason: 'JSON_OBJECT_INVALID', nodes, maxDepthObserved };
    }

    const keys = Object.keys(node);
    if (keys.length > maxObjectKeys) {
      return { ok: false, reason: 'JSON_OBJECT_KEY_LIMIT_EXCEEDED', nodes, maxDepthObserved };
    }
    for (const key of keys) {
      if (DANGEROUS_KEYS.has(key)) {
        return { ok: false, reason: 'JSON_DANGEROUS_KEY', nodes, maxDepthObserved };
      }
      stack.push({ value: node[key], depth: depth + 1 });
    }
  }

  return { ok: true, reason: 'JSON_STRUCTURE_OK', nodes, maxDepthObserved };
}
