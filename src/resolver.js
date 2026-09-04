'use strict';

const { foldIdentifier, procedureId } = require('./module-identity');

function canonicalProcedure(procedure) {
  const moduleId = procedure.moduleId || `module:${foldIdentifier(procedure.module || '')}`;
  const moduleDisplayName = procedure.moduleDisplayName || procedure.module || moduleId;
  return {
    ...procedure,
    id: procedure.id || procedureId(moduleId, procedure.name),
    moduleId,
    module: procedure.module || moduleDisplayName,
    moduleDisplayName,
    normalizedName: procedure.normalizedName || foldIdentifier(procedure.name),
  };
}

function compareText(left, right) {
  const leftText = String(left ?? '');
  const rightText = String(right ?? '');
  if (leftText === rightText) return 0;
  return leftText < rightText ? -1 : 1;
}

function compareProcedures(left, right) {
  return compareText(left.moduleId, right.moduleId)
    || compareText(left.normalizedName, right.normalizedName)
    || (left.line || 0) - (right.line || 0)
    || compareText(left.file, right.file);
}

function targetProvenance(procedure) {
  return {
    id: procedure.id,
    moduleId: procedure.moduleId,
    module: procedure.moduleDisplayName || procedure.module,
    name: procedure.name,
    kind: procedure.kind,
    isExport: Boolean(procedure.isExport),
    file: procedure.file,
    line: procedure.line,
    column: procedure.column || 1,
  };
}

function addToMap(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function moduleAliases(procedure) {
  const aliases = new Set([
    procedure.moduleId,
    procedure.module,
    procedure.moduleDisplayName,
  ].filter(Boolean).map(foldIdentifier));
  for (const alias of procedure.moduleAliases || procedure.aliases || []) {
    aliases.add(foldIdentifier(alias));
  }
  return aliases;
}

function buildSymbolTable(procedures) {
  const normalizedProcedures = procedures.map(canonicalProcedure).sort(compareProcedures);
  const byModuleAndName = new Map();
  const exportedByName = new Map();
  const modulesByAlias = new Map();
  const moduleRecords = new Map();
  const byId = new Map();
  const provenanceById = new Map();
  const singletonCandidateIds = new Map();

  for (const procedure of normalizedProcedures) {
    byId.set(procedure.id, procedure);
    provenanceById.set(procedure.id, Object.freeze(targetProvenance(procedure)));
    singletonCandidateIds.set(procedure.id, Object.freeze([procedure.id]));
    addToMap(
      byModuleAndName,
      `${foldIdentifier(procedure.moduleId)}::${procedure.normalizedName}`,
      procedure
    );
    if (procedure.isExport) addToMap(exportedByName, procedure.normalizedName, procedure);

    if (!moduleRecords.has(procedure.moduleId)) {
      const module = {
        id: procedure.moduleId,
        displayName: procedure.moduleDisplayName || procedure.module,
        aliases: moduleAliases(procedure),
      };
      moduleRecords.set(procedure.moduleId, module);
      for (const alias of module.aliases) addToMap(modulesByAlias, alias, module);
    }
  }

  for (const values of byModuleAndName.values()) values.sort(compareProcedures);
  for (const values of exportedByName.values()) values.sort(compareProcedures);
  for (const values of modulesByAlias.values()) {
    values.sort((left, right) => compareText(left.id, right.id));
  }

  return {
    procedures: normalizedProcedures,
    byId,
    provenanceById,
    singletonCandidateIds,
    byModuleAndName,
    exportedByName,
    modulesByAlias,
    modules: [...moduleRecords.values()].sort((left, right) => compareText(left.id, right.id)),
  };
}

function uniqueProcedures(procedures) {
  const byId = new Map();
  for (const procedure of procedures) byId.set(procedure.id, procedure);
  return [...byId.values()].sort(compareProcedures);
}

function resolutionFor(candidate, symbolTable) {
  const name = foldIdentifier(candidate.calleeName);
  const callerModuleId = candidate.callerModuleId
    || symbolTable.byId.get(candidate.callerId)?.moduleId
    || `module:${foldIdentifier(candidate.callerModule || '')}`;

  if (!candidate.receiver) {
    const local = uniqueProcedures(
      symbolTable.byModuleAndName.get(`${foldIdentifier(callerModuleId)}::${name}`) || []
    );
    if (local.length === 1) {
      return { resolution: 'resolved', reason: 'local-symbol', confidence: 'high', targets: local };
    }
    if (local.length > 1) {
      return { resolution: 'ambiguous', reason: 'multiple-local-symbols', confidence: 'low', targets: local };
    }

    const exported = uniqueProcedures(
      (symbolTable.exportedByName.get(name) || []).filter(procedure =>
        procedure.objectKind === 'common-module'
          || /(^|[\\/])CommonModules[\\/]/iu.test(procedure.file || '')
      )
    );
    if (exported.length === 1) {
      return {
        resolution: 'resolved',
        reason: 'unique-exported-symbol',
        confidence: 'medium',
        targets: exported,
      };
    }
    if (exported.length > 1) {
      return {
        resolution: 'ambiguous',
        reason: 'multiple-exported-symbols',
        confidence: 'low',
        targets: exported,
      };
    }
    return { resolution: 'dynamic', reason: 'unknown-unqualified-symbol', confidence: 'low', targets: [] };
  }

  const matchingModules = symbolTable.modulesByAlias.get(foldIdentifier(candidate.receiver)) || [];
  if (matchingModules.length === 0) {
    return { resolution: 'dynamic', reason: 'unknown-receiver', confidence: 'low', targets: [] };
  }

  const matchingTargets = uniqueProcedures(matchingModules.flatMap(module =>
    (symbolTable.byModuleAndName.get(`${foldIdentifier(module.id)}::${name}`) || [])
      .filter(procedure => procedure.isExport)
  ));
  if (matchingTargets.length === 1) {
    return {
      resolution: 'resolved',
      reason: 'known-module',
      confidence: 'high',
      targets: matchingTargets,
    };
  }
  if (matchingTargets.length > 1) {
    return {
      resolution: 'ambiguous',
      reason: 'ambiguous-module-alias',
      confidence: 'low',
      targets: matchingTargets,
    };
  }
  return {
    resolution: 'dynamic',
    reason: 'known-module-target-not-found',
    confidence: 'low',
    targets: [],
  };
}

function compareCalls(left, right) {
  return compareText(left.callerId, right.callerId)
    || compareText(left.callerModuleId, right.callerModuleId)
    || compareText(foldIdentifier(left.callerName), foldIdentifier(right.callerName))
    || compareText(left.file, right.file)
    || (left.callLine || 0) - (right.callLine || 0)
    || (left.callColumn || 0) - (right.callColumn || 0)
    || compareText(foldIdentifier(left.calleeName), foldIdentifier(right.calleeName))
    || compareText(left.receiver, right.receiver)
    || (left.occurrence || 0) - (right.occurrence || 0)
    || compareText(left.id, right.id);
}

const EMPTY_CANDIDATES = Object.freeze([]);

function makeEdge(candidate, result, ordinal, symbolTable) {
  const target = result.resolution === 'resolved' ? result.targets[0] : null;
  const caller = symbolTable.byId.get(candidate.callerId);
  const targetDetails = result.resolution === 'ambiguous'
    ? result.targets.map(procedure => symbolTable.provenanceById.get(procedure.id))
    : EMPTY_CANDIDATES;
  const callLine = candidate.callLine || candidate.line || 1;
  const callColumn = candidate.callColumn || candidate.column || 1;
  return {
    id: `edge:${ordinal.toString(36)}`,
    callerId: candidate.callerId || null,
    callerName: caller?.name || candidate.callerName || null,
    callerModuleId: caller?.moduleId || candidate.callerModuleId || null,
    callerModule: caller?.moduleDisplayName || caller?.module || candidate.callerModule || null,
    calleeName: candidate.calleeName,
    receiver: candidate.receiver || null,
    file: caller?.file || candidate.file || null,
    callLine,
    callColumn,
    resolution: result.resolution,
    reason: result.reason,
    confidence: result.confidence,
    calleeId: target?.id || null,
    calleeModule: null,
    target: target ? symbolTable.provenanceById.get(target.id) : null,
    candidates: target
      ? symbolTable.singletonCandidateIds.get(target.id)
      : targetDetails.length > 0
        ? targetDetails.map(item => item.id)
        : EMPTY_CANDIDATES,
    candidateTargets: targetDetails,
  };
}

/**
 * Resolve call candidates after every module has contributed its symbols.
 * Accepts either (procedures, calls) or ({ procedures, calls }).
 */
function resolveCalls(proceduresOrIndex, callsArgument) {
  const procedures = Array.isArray(proceduresOrIndex)
    ? proceduresOrIndex
    : proceduresOrIndex?.procedures || [];
  const calls = Array.isArray(proceduresOrIndex)
    ? callsArgument || []
    : proceduresOrIndex?.calls || [];
  const symbolTable = buildSymbolTable(procedures);
  const orderedCandidates = [...calls].sort(compareCalls);
  const edges = orderedCandidates.map((candidate, ordinal) =>
    makeEdge(candidate, resolutionFor(candidate, symbolTable), ordinal, symbolTable)
  );
  Object.defineProperty(edges, 'canonicalSorted', {
    value: true,
    enumerable: false,
  });
  return edges;
}

const resolveCallCandidates = resolveCalls;

function resolvedEdges(edges) {
  return edges.filter(edge => edge.resolution === 'resolved');
}

function exploratoryEdges(edges, options = {}) {
  return edges.filter(edge => edge.resolution === 'resolved'
    || (options.includeAmbiguous && edge.resolution === 'ambiguous')
    || (options.includeDynamic && edge.resolution === 'dynamic'));
}

module.exports = {
  buildSymbolTable,
  compareCalls,
  exploratoryEdges,
  resolveCallCandidates,
  resolveCalls,
  resolvedEdges,
  targetProvenance,
};
