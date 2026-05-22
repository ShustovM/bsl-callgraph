'use strict';

// In-memory call-graph index with fast lookup maps
class CallGraphStore {
  constructor() {
    this._reset();
  }

  _reset() {
    // All procedures/functions: id → procedure
    this.procedures = new Map();
    // Calls list
    this.calls = [];
    // Stats from last index
    this.stats = null;

    // Fast lookup indexes
    // name (lowercase) → [procedure, ...]
    this._byName = new Map();
    // module (lowercase) → [procedure, ...]
    this._byModule = new Map();
    // "calleeName:calleeModule" → [call, ...]  (calleeModule may be empty)
    this._callsByCallee = new Map();
    // "callerName:callerModule" → [call, ...]
    this._callsByCaller = new Map();
  }

  // Load index from buildIndex() result
  load({ procedures, calls, stats }) {
    this._reset();
    this.stats = stats;

    for (const proc of procedures) {
      const id = `${proc.module}:${proc.name}`;
      this.procedures.set(id, proc);

      const nameKey = proc.name.toLowerCase();
      if (!this._byName.has(nameKey)) this._byName.set(nameKey, []);
      this._byName.get(nameKey).push(proc);

      const modKey = (proc.module || '').toLowerCase();
      if (!this._byModule.has(modKey)) this._byModule.set(modKey, []);
      this._byModule.get(modKey).push(proc);
    }

    for (const call of calls) {
      this.calls.push(call);

      // Index by callee
      const calleeKey = `${call.calleeName.toLowerCase()}:${(call.calleeModule || '').toLowerCase()}`;
      if (!this._callsByCallee.has(calleeKey)) this._callsByCallee.set(calleeKey, []);
      this._callsByCallee.get(calleeKey).push(call);

      // Index by caller
      const callerKey = `${call.callerName.toLowerCase()}:${(call.callerModule || '').toLowerCase()}`;
      if (!this._callsByCaller.has(callerKey)) this._callsByCaller.set(callerKey, []);
      this._callsByCaller.get(callerKey).push(call);
    }
  }

  // Find symbol definitions by name (optionally filtered by module)
  findSymbol(name, module) {
    const matches = this._byName.get(name.toLowerCase()) || [];
    if (!module) return matches;
    const modLower = module.toLowerCase();
    return matches.filter(p => p.module.toLowerCase() === modLower);
  }

  // Get all callers of a procedure/function
  // Returns calls where calleeName matches (and calleeModule if provided)
  getCallers(name, module) {
    const nameLower = name.toLowerCase();
    const results = [];

    // Check both "name:module" and "name:" (direct calls without module prefix)
    const keysToCheck = [`${nameLower}:`];
    if (module) {
      keysToCheck.push(`${nameLower}:${module.toLowerCase()}`);
    } else {
      // No module specified — search all module variants
      for (const [key] of this._callsByCallee) {
        if (key.startsWith(`${nameLower}:`)) {
          keysToCheck.push(key);
        }
      }
    }

    const seen = new Set();
    for (const key of keysToCheck) {
      for (const call of (this._callsByCallee.get(key) || [])) {
        const uid = `${call.callerModule}:${call.callerName}:${call.callLine}`;
        if (!seen.has(uid)) {
          seen.add(uid);
          results.push(call);
        }
      }
    }

    return results;
  }

  // Get all callees (what a procedure calls)
  getCallees(name, module) {
    const nameLower = name.toLowerCase();
    const keysToCheck = [];

    if (module) {
      keysToCheck.push(`${nameLower}:${module.toLowerCase()}`);
    } else {
      for (const [key] of this._callsByCaller) {
        if (key.startsWith(`${nameLower}:`)) {
          keysToCheck.push(key);
        }
      }
    }

    const results = [];
    const seen = new Set();
    for (const key of keysToCheck) {
      for (const call of (this._callsByCaller.get(key) || [])) {
        const uid = `${call.calleeModule || ''}:${call.calleeName}:${call.callLine}`;
        if (!seen.has(uid)) {
          seen.add(uid);
          results.push(call);
        }
      }
    }

    return results;
  }

  // Get impact radius: all procedures that transitively call the given one
  // depth: max recursion depth (default 5)
  getImpact(name, module, depth = 5) {
    const visited = new Set();
    const result = [];

    const traverse = (n, m, currentDepth) => {
      if (currentDepth <= 0) return;
      const callers = this.getCallers(n, m);
      for (const call of callers) {
        const key = `${call.callerModule}:${call.callerName}`;
        if (visited.has(key)) continue;
        visited.add(key);
        result.push(call);
        traverse(call.callerName, call.callerModule, currentDepth - 1);
      }
    };

    traverse(name, module, depth);
    return result;
  }
}

module.exports = { CallGraphStore };
