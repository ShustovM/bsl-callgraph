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

  for (const procedure of normalizedProcedures) {
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
    || symbolTable.procedures.find(proc => proc.id === candidate.callerId)?.moduleId
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
  return compareText(left.callerModuleId, right.callerModuleId)
    || compareText(foldIdentifier(left.callerName), foldIdentifier(right.callerName))
    || compareText(left.file, right.file)
    || (left.callLine || 0) - (right.callLine || 0)
    || (left.callColumn || 0) - (right.callColumn || 0)
    || compareText(foldIdentifier(left.calleeName), foldIdentifier(right.calleeName))
    || compareText(left.receiver, right.receiver)
    || compareText(left.id, right.id);
}

function makeEdge(candidate, result, ordinal) {
  const target = result.resolution === 'resolved' ? result.targets[0] : null;
  const targetDetails = result.targets.map(targetProvenance);
  const callerModuleId = candidate.callerModuleId || null;
  const callLine = candidate.callLine || candidate.line || 1;
  const callColumn = candidate.callColumn || candidate.column || 1;
  return {
    ...candidate,
    id: `edge:${candidate.callerId || `${callerModuleId}:${candidate.callerName}`}:${callLine}:${callColumn}:${ordinal}`,
    resolution: result.resolution,
    reason: result.reason,
    resolutionReason: result.reason,
    confidence: result.confidence,
    calleeId: target?.id || null,
    calleeModuleId: target?.moduleId || null,
    calleeModule: target ? target.moduleDisplayName || target.module : null,
    calleeFile: target?.file || null,
    calleeLine: target?.line || null,
    target: target ? targetProvenance(target) : null,
    candidates: targetDetails.map(item => item.id),
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
  return orderedCandidates.map((candidate, ordinal) =>
    makeEdge(candidate, resolutionFor(candidate, symbolTable), ordinal)
  );
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
