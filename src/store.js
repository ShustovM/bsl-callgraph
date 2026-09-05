'use strict';

const { createHash } = require('node:crypto');
const { runSync, runAsync, sortSteps } = require('./cooperative');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const CURSOR_VERSION = 1;

function normalizeKey(value) {
  return String(value ?? '').normalize('NFC').toLowerCase();
}

function compareText(left, right) {
  const a = normalizeKey(left);
  const b = normalizeKey(right);
  if (a < b) return -1;
  if (a > b) return 1;

  const originalA = String(left ?? '');
  const originalB = String(right ?? '');
  if (originalA < originalB) return -1;
  if (originalA > originalB) return 1;
  return 0;
}

function canonicalPath(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .normalize('NFC');
}

function derivedModuleId(procedure) {
  if (procedure.moduleId) return canonicalPath(procedure.moduleId);

  const file = canonicalPath(procedure.file);
  if (file) return normalizeKey(file.replace(/\.bsl$/i, ''));

  return `module/${normalizeKey(
    procedure.moduleDisplayName || procedure.module || procedure.moduleName || 'unknown'
  )}`;
}

function procedureAliases(procedure) {
  return new Set([
    procedure.moduleId,
    procedure.module,
    procedure.moduleDisplayName,
    procedure.moduleName,
    procedure.canonicalModule,
  ].filter(Boolean).map(normalizeKey));
}

function compareProcedures(left, right) {
  return compareText(left.moduleId, right.moduleId)
    || compareText(left.name, right.name)
    || compareText(left.file, right.file)
    || (Number(left.line) || 0) - (Number(right.line) || 0)
    || compareText(left.id, right.id);
}

function candidateIds(edge) {
  const values = [
    ...(Array.isArray(edge.candidates) ? edge.candidates : []),
    ...(Array.isArray(edge.candidateTargets) ? edge.candidateTargets : []),
  ];

  const ids = [];
  const seen = new Set();
  for (const value of values) {
    const id = typeof value === 'string'
      ? value
      : value?.id || value?.symbolId || value?.targetId;
    if (!id) continue;
    const key = normalizeKey(id);
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(String(id));
  }
  return ids.sort(compareText);
}

function edgeTargetSortKey(edge) {
  if (edge.calleeModuleId || edge.calleeModule) {
    return `${edge.calleeModuleId || edge.calleeModule}\u0000${edge.calleeName || edge.calleeId || ''}`;
  }
  if (edge.calleeId) return edge.calleeId;
  const candidates = candidateIds(edge);
  if (candidates.length > 0) return candidates.join('\u0000');
  return `${edge.calleeModuleId || edge.calleeModule || edge.receiver || ''}::${edge.calleeName || ''}`;
}

function compareEdges(left, right) {
  const resolutionRank = { resolved: 0, ambiguous: 1, dynamic: 2 };
  const leftCaller = left.callerModuleId || left.callerModule
    ? `${left.callerModuleId || left.callerModule}\u0000${left.callerName || left.callerId || ''}`
    : left.callerId || left.callerName || '';
  const rightCaller = right.callerModuleId || right.callerModule
    ? `${right.callerModuleId || right.callerModule}\u0000${right.callerName || right.callerId || ''}`
    : right.callerId || right.callerName || '';
  return compareText(leftCaller, rightCaller)
    || compareText(edgeTargetSortKey(left), edgeTargetSortKey(right))
    || ((resolutionRank[left.resolution] ?? 9) - (resolutionRank[right.resolution] ?? 9))
    || compareText(left.file || left.callerFile, right.file || right.callerFile)
    || (Number(left.callLine) || 0) - (Number(right.callLine) || 0)
    || (Number(left.callColumn) || 0) - (Number(right.callColumn) || 0)
    || compareText(left.id, right.id);
}

function edgeIdentity(edge) {
  const candidates = candidateIds(edge).map(normalizeKey).join(',');
  return [
    normalizeKey(edge.callerId || `${edge.callerModule || ''}::${edge.callerName || ''}`),
    normalizeKey(edge.calleeId || `${edge.calleeModuleId || edge.calleeModule || edge.receiver || ''}::${edge.calleeName || ''}`),
    normalizeKey(edge.resolution),
    candidates,
    normalizeKey(canonicalPath(edge.file || edge.callerFile)),
    Number(edge.callLine) || 0,
    Number(edge.callColumn) || 0,
    Number(edge.callEndLine) || 0,
    Number(edge.callEndColumn) || 0,
  ].join('\u0001');
}

function addToIndex(index, key, value) {
  if (!key) return;
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(value);
}

function* sortIndexSteps(index, comparator) {
  let count = 0;
  for (const values of index.values()) {
    if (count++ % 128 === 0) yield;
    yield* sortSteps(values, comparator);
  }
}

// In-memory call-graph index with canonical identities and bounded result pages.
class CallGraphStore {
  constructor() {
    this._generation = 0;
    this._reset();
  }

  _reset() {
    // Public collections retained for compatibility with the 1.0 store.
    this.procedures = new Map();
    this.calls = [];
    this.stats = null;

    this._byName = new Map();
    this._byModule = new Map();
    this._procedureIdLookup = new Map();

    // Exact graph indexes.
    this._callsByCallerId = new Map();
    this._callsByCalleeId = new Map();

    // Exploratory/fallback indexes. Future resolver output normally uses the
    // ID maps above; these maps also keep old parser fixtures queryable.
    this._candidateCallsByCalleeId = new Map();
    this._fallbackCallsByCallerName = new Map();
    this._fallbackCallsByCalleeName = new Map();
  }

  // Load an index generation. Extra procedure/edge fields are deliberately
  // retained, including resolver confidence, reasons, and target provenance.
  load(index = {}) {
    return runSync(this._loadSteps(index));
  }

  loadAsync(index = {}, options = {}) {
    return runAsync(this._loadSteps(index), options);
  }

  *_loadSteps({ procedures = [], calls = [], stats = null } = {}) {
    yield;
    this._reset();
    this._generation = Number.isSafeInteger(stats?.generation)
      ? stats.generation
      : this._generation + 1;
    this.stats = stats;

    const normalizedProcedures = [];
    for (let index = 0; index < procedures.length; index++) {
      if (index % 256 === 0) yield;
      const procedure = procedures[index];
      const moduleId = derivedModuleId(procedure);
      const canonicalId = procedure.id
        ? String(procedure.id)
        : `${moduleId}::${normalizeKey(procedure.normalizedName || procedure.name)}`;

      if (procedure.id === canonicalId && procedure.moduleId === moduleId) {
        normalizedProcedures.push(procedure);
      } else {
        normalizedProcedures.push({ ...procedure, id: canonicalId, moduleId });
      }
    }
    yield* sortSteps(normalizedProcedures, compareProcedures);

    const seenProcedureIds = new Set();
    for (let index = 0; index < normalizedProcedures.length; index++) {
      if (index % 256 === 0) yield;
      const procedure = normalizedProcedures[index];
      const idKey = normalizeKey(procedure.id);
      if (seenProcedureIds.has(idKey)) continue;
      seenProcedureIds.add(idKey);

      this.procedures.set(procedure.id, procedure);
      this._procedureIdLookup.set(idKey, procedure);
      addToIndex(this._byName, normalizeKey(procedure.name), procedure);
      for (const alias of procedureAliases(procedure)) {
        addToIndex(this._byModule, alias, procedure);
      }
    }

    yield* sortIndexSteps(this._byName, compareProcedures);
    yield* sortIndexSteps(this._byModule, compareProcedures);

    const callsAreCanonical = calls.canonicalSorted === true;
    // Resolver output is already canonical. Query indexes are sorted for
    // manual/legacy input only, avoiding duplicate work for large generations.
    const seenEdges = new Set();
    for (let index = 0; index < calls.length; index++) {
      if (index % 256 === 0) yield;
      const edge = this._normalizeEdge(calls[index]);
      const identity = edge.id ? normalizeKey(edge.id) : edgeIdentity(edge);
      if (seenEdges.has(identity)) continue;
      seenEdges.add(identity);
      this.calls.push(edge);

      const caller = this._procedureById(edge.callerId);
      if (edge.callerId && caller) {
        addToIndex(this._callsByCallerId, normalizeKey(edge.callerId), edge);
      } else {
        addToIndex(this._fallbackCallsByCallerName, normalizeKey(edge.callerName), edge);
      }

      if (edge.resolution === 'resolved' && edge.calleeId && this._procedureById(edge.calleeId)) {
        addToIndex(this._callsByCalleeId, normalizeKey(edge.calleeId), edge);
      } else if (edge.resolution === 'ambiguous') {
        const ids = candidateIds(edge);
        for (const id of ids) {
          addToIndex(this._candidateCallsByCalleeId, normalizeKey(id), edge);
        }
        if (ids.length === 0) {
          addToIndex(this._fallbackCallsByCalleeName, normalizeKey(edge.calleeName), edge);
        }
      } else {
        addToIndex(this._fallbackCallsByCalleeName, normalizeKey(edge.calleeName), edge);
      }
    }

    if (!callsAreCanonical) {
      yield* sortIndexSteps(this._callsByCallerId, compareEdges);
      yield* sortIndexSteps(this._callsByCalleeId, compareEdges);
      yield* sortIndexSteps(this._candidateCallsByCalleeId, compareEdges);
      yield* sortIndexSteps(this._fallbackCallsByCallerName, compareEdges);
      yield* sortIndexSteps(this._fallbackCallsByCalleeName, compareEdges);
    }
  }

  _procedureById(id) {
    if (!id) return null;
    return this._procedureIdLookup.get(normalizeKey(id)) || null;
  }

  _proceduresFor(name, module) {
    const matches = this._byName.get(normalizeKey(name)) || [];
    if (!module) return matches.slice();
    const moduleKey = normalizeKey(module);
    return matches.filter(procedure => procedureAliases(procedure).has(moduleKey));
  }

  _resolveProcedureId({ id, name, moduleId, module, callerId }) {
    const explicit = this._procedureById(id);
    if (explicit) return explicit.id;

    let matches = this._byName.get(normalizeKey(name)) || [];
    const requestedModule = moduleId || module;
    if (requestedModule) {
      const moduleKey = normalizeKey(requestedModule);
      matches = matches.filter(procedure => procedureAliases(procedure).has(moduleKey));
    } else if (callerId) {
      const caller = this._procedureById(callerId);
      if (caller) {
        matches = matches.filter(procedure =>
          normalizeKey(procedure.moduleId) === normalizeKey(caller.moduleId)
        );
      }
    }

    return matches.length === 1 ? matches[0].id : null;
  }

  _normalizeEdge(call) {
    const declaredResolution = normalizeKey(call.resolution);
    let resolution = declaredResolution;
    if (!resolution) {
      if (call.calleeId || call.target?.id || call.target?.symbolId) {
        resolution = 'resolved';
      } else if (candidateIds(call).length > 1) {
        resolution = 'ambiguous';
      } else if (call.receiver) {
        resolution = 'dynamic';
      } else {
        // Legacy parser calls were implicitly treated as graph edges.
        resolution = 'resolved';
      }
    }

    const callerId = this._resolveProcedureId({
      id: call.callerId,
      name: call.callerName,
      moduleId: call.callerModuleId,
      module: call.callerModule,
    });

    let calleeId = null;
    if (resolution === 'resolved') {
      calleeId = this._resolveProcedureId({
        id: call.calleeId || call.target?.id || call.target?.symbolId,
        name: call.calleeName,
        moduleId: call.calleeModuleId || call.target?.moduleId,
        module: call.calleeModule || call.target?.module,
        callerId,
      });
    }

    const patch = {};
    if (resolution !== call.resolution) patch.resolution = resolution;
    if (callerId && callerId !== call.callerId) patch.callerId = callerId;
    if (calleeId && calleeId !== call.calleeId) patch.calleeId = calleeId;

    const effective = Object.keys(patch).length > 0 ? { ...call, ...patch } : call;
    if (effective.id) return effective;

    const target = effective.calleeId
      || candidateIds(effective).join(',')
      || `${effective.calleeModuleId || effective.calleeModule || effective.receiver || ''}::${effective.calleeName || ''}`;
    const provenance = [
      canonicalPath(effective.file || effective.callerFile),
      Number(effective.callLine) || 0,
      Number(effective.callColumn) || 0,
    ].join(':');
    return {
      ...effective,
      id: `${effective.callerId || `${effective.callerModule || ''}::${effective.callerName || ''}`}->${target}:${provenance}:${resolution}`,
    };
  }

  _normalizeArguments(module, options) {
    if (module && typeof module === 'object' && !Array.isArray(module)) {
      return { module: undefined, options: module };
    }
    return { module, options };
  }

  _options(options) {
    return {
      includeAmbiguous: options?.includeAmbiguous === true,
      includeDynamic: options?.includeDynamic === true,
    };
  }

  _edgeAllowed(edge, options) {
    if (edge.resolution === 'resolved') return true;
    if (edge.resolution === 'ambiguous') return options.includeAmbiguous;
    return options.includeDynamic;
  }

  _edgeMatchesModule(edge, side, module, allowUnqualified = false) {
    if (!module) return true;
    const moduleKey = normalizeKey(module);
    const values = side === 'caller'
      ? [edge.callerModuleId, edge.callerModule, edge.callerModuleDisplayName]
      : [edge.calleeModuleId, edge.calleeModule, edge.calleeModuleDisplayName,
        edge.target?.moduleId, edge.target?.module, edge.target?.moduleDisplayName];
    const populated = values.filter(Boolean);
    if (populated.length === 0) return allowUnqualified;
    return populated.some(value => normalizeKey(value) === moduleKey);
  }

  _uniqueSortedEdges(edges) {
    const byIdentity = new Map();
    for (const edge of edges) {
      const identity = edgeIdentity(edge);
      if (!byIdentity.has(identity)) byIdentity.set(identity, edge);
    }
    return [...byIdentity.values()].sort(compareEdges);
  }

  _page(items, options, scope) {
    if (options === undefined) return items;
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('options must be an object');
    }

    let limit = options.limit ?? DEFAULT_PAGE_SIZE;
    if (typeof limit !== 'number' || !Number.isFinite(limit)) {
      throw new TypeError('limit must be a finite number');
    }
    limit = Math.trunc(limit);
    if (limit < 1) throw new RangeError('limit must be at least 1');
    limit = Math.min(limit, MAX_PAGE_SIZE);

    const scopeHash = createHash('sha256')
      .update(JSON.stringify(scope))
      .digest('base64url')
      .slice(0, 24);
    let offset = 0;
    if (options.cursor != null) {
      try {
        const decoded = JSON.parse(Buffer.from(String(options.cursor), 'base64url').toString('utf8'));
        if (decoded.v !== CURSOR_VERSION
          || decoded.g !== this._generation
          || decoded.s !== scopeHash
          || !Number.isSafeInteger(decoded.o)
          || decoded.o < 0) {
          throw new Error('cursor mismatch');
        }
        offset = decoded.o;
      } catch {
        throw new RangeError('Invalid or expired pagination cursor');
      }
    }

    const pageItems = items.slice(offset, offset + limit);
    const nextOffset = offset + pageItems.length;
    const nextCursor = nextOffset < items.length
      ? Buffer.from(JSON.stringify({
        v: CURSOR_VERSION,
        g: this._generation,
        s: scopeHash,
        o: nextOffset,
      })).toString('base64url')
      : null;

    return { items: pageItems, nextCursor, total: items.length };
  }

  // Find exact symbol definitions by name (optionally filtered by a display
  // alias or canonical module ID).
  findSymbol(name, module, options) {
    ({ module, options } = this._normalizeArguments(module, options));
    const results = this._proceduresFor(name, module);
    return this._page(results, options, {
      operation: 'findSymbol',
      name: normalizeKey(name),
      module: normalizeKey(module),
    });
  }

  // Search symbols by partial name (substring, case-insensitive).
  searchSymbols(query, module, options) {
    ({ module, options } = this._normalizeArguments(module, options));
    const queryKey = normalizeKey(query);
    const moduleKey = normalizeKey(module);
    const results = [];
    for (const [nameKey, procedures] of this._byName) {
      if (!nameKey.includes(queryKey)) continue;
      for (const procedure of procedures) {
        if (!module || procedureAliases(procedure).has(moduleKey)) results.push(procedure);
      }
    }
    results.sort(compareProcedures);
    return this._page(results, options, {
      operation: 'searchSymbols',
      query: queryKey,
      module: moduleKey,
    });
  }

  _incomingEdges(name, module, rawOptions) {
    const options = this._options(rawOptions);
    const targets = this._proceduresFor(name, module);
    const targetIds = new Set(targets.map(target => normalizeKey(target.id)));
    const results = [];

    for (const targetId of targetIds) {
      for (const edge of this._callsByCalleeId.get(targetId) || []) results.push(edge);
      if (options.includeAmbiguous) {
        for (const edge of this._candidateCallsByCalleeId.get(targetId) || []) results.push(edge);
      }
    }

    // Legacy resolved calls without a target ID, dynamic calls, and ambiguous
    // calls without candidate IDs are matched by their descriptive fields.
    const fallback = this._fallbackCallsByCalleeName.get(normalizeKey(name)) || [];
    for (const edge of fallback) {
      if (!this._edgeAllowed(edge, options)) continue;
      if (targetIds.size > 0 && edge.calleeId) continue;
      const allowUnqualified = edge.resolution === 'resolved' && !edge.calleeId;
      if (!this._edgeMatchesModule(edge, 'callee', module, allowUnqualified)) continue;
      results.push(edge);
    }

    return this._uniqueSortedEdges(results);
  }

  // Get incoming edges. Exact mode includes only resolved edges; ambiguous and
  // dynamic candidates require explicit options.
  getCallers(name, module, options) {
    ({ module, options } = this._normalizeArguments(module, options));
    const results = this._incomingEdges(name, module, options);
    const flags = this._options(options);
    return this._page(results, options, {
      operation: 'getCallers',
      name: normalizeKey(name),
      module: normalizeKey(module),
      ...flags,
    });
  }

  _outgoingEdges(name, module, rawOptions) {
    const options = this._options(rawOptions);
    const callers = this._proceduresFor(name, module);
    const callerIds = new Set(callers.map(caller => normalizeKey(caller.id)));
    const results = [];

    for (const callerId of callerIds) {
      for (const edge of this._callsByCallerId.get(callerId) || []) {
        if (this._edgeAllowed(edge, options)) results.push(edge);
      }
    }

    const fallback = this._fallbackCallsByCallerName.get(normalizeKey(name)) || [];
    for (const edge of fallback) {
      if (!this._edgeAllowed(edge, options)) continue;
      if (!this._edgeMatchesModule(edge, 'caller', module)) continue;
      results.push(edge);
    }

    return this._uniqueSortedEdges(results);
  }

  // Get outgoing edges. This is the principal exploratory API: callers may opt
  // into ambiguous module candidates and dynamic receiver calls independently.
  getCallees(name, module, options) {
    ({ module, options } = this._normalizeArguments(module, options));
    const results = this._outgoingEdges(name, module, options);
    const flags = this._options(options);
    return this._page(results, options, {
      operation: 'getCallees',
      name: normalizeKey(name),
      module: normalizeKey(module),
      ...flags,
    });
  }

  // Get the reverse transitive closure. Results contain one representative
  // edge per impacted caller, ordered by breadth/depth and then canonically.
  getImpact(name, module, depth = 5, options) {
    if (module && typeof module === 'object' && !Array.isArray(module)) {
      options = module;
      module = undefined;
      depth = options.depth ?? 5;
    } else if (depth && typeof depth === 'object' && !Array.isArray(depth)) {
      options = depth;
      depth = options.depth ?? 5;
    }

    depth = Number(depth ?? 5);
    if (!Number.isFinite(depth)) throw new TypeError('depth must be a finite number');
    depth = Math.max(0, Math.trunc(depth));

    const flags = this._options(options);
    const roots = this._proceduresFor(name, module);
    const visited = new Set(roots.map(root => normalizeKey(root.id)));
    const rootFallback = `${normalizeKey(module)}::${normalizeKey(name)}`;
    visited.add(rootFallback);

    let frontier = [{ name, module }];
    const results = [];

    for (let currentDepth = 0; currentDepth < depth && frontier.length > 0; currentDepth++) {
      const nextFrontier = [];
      for (const target of frontier) {
        const incoming = target.id
          ? this._incomingEdgesById(target.id, flags)
          : this._incomingEdges(target.name, target.module, flags);

        for (const edge of incoming) {
          const caller = this._procedureById(edge.callerId);
          const callerKey = caller
            ? normalizeKey(caller.id)
            : `${normalizeKey(edge.callerModule)}::${normalizeKey(edge.callerName)}`;
          if (visited.has(callerKey)) continue;
          visited.add(callerKey);
          results.push(edge);
          nextFrontier.push(caller
            ? { id: caller.id, name: caller.name, module: caller.moduleId }
            : { name: edge.callerName, module: edge.callerModule });
        }
      }
      frontier = nextFrontier;
    }

    return this._page(results, options, {
      operation: 'getImpact',
      name: normalizeKey(name),
      module: normalizeKey(module),
      depth,
      ...flags,
    });
  }

  _incomingEdgesById(id, rawOptions) {
    const options = this._options(rawOptions);
    const idKey = normalizeKey(id);
    const results = [...(this._callsByCalleeId.get(idKey) || [])];
    if (options.includeAmbiguous) {
      for (const edge of this._candidateCallsByCalleeId.get(idKey) || []) results.push(edge);
    }

    const target = this._procedureById(id);
    if (target) {
      const fallback = this._fallbackCallsByCalleeName.get(normalizeKey(target.name)) || [];
      for (const edge of fallback) {
        if (!this._edgeAllowed(edge, options)) continue;
        if (edge.calleeId) continue;
        const allowUnqualified = edge.resolution === 'resolved';
        if (!this._edgeMatchesModule(edge, 'callee', target.moduleId, allowUnqualified)
          && !this._edgeMatchesModule(edge, 'callee', target.module, allowUnqualified)) continue;
        results.push(edge);
      }
    }
    return this._uniqueSortedEdges(results);
  }
}

module.exports = {
  CallGraphStore,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
};
