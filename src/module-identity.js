'use strict';

const OBJECT_KIND_NAMES = new Map([
  ['commonmodules', 'common-module'],
  ['commonforms', 'common-form'],
  ['commoncommands', 'common-command'],
  ['catalogs', 'catalog'],
  ['documents', 'document'],
  ['dataprocessors', 'data-processor'],
  ['reports', 'report'],
  ['informationregisters', 'information-register'],
  ['accumulationregisters', 'accumulation-register'],
  ['accountingregisters', 'accounting-register'],
  ['calculationregisters', 'calculation-register'],
  ['constants', 'constant'],
  ['enumerations', 'enumeration'],
  ['chartsofaccounts', 'chart-of-accounts'],
  ['chartsofcalculationtypes', 'chart-of-calculation-types'],
  ['chartsofcharacteristictypes', 'chart-of-characteristic-types'],
  ['businessprocesses', 'business-process'],
  ['tasks', 'task'],
  ['exchangeplans', 'exchange-plan'],
  ['scheduledjobs', 'scheduled-job'],
  ['sessionparameters', 'session-parameter'],
]);

const MODULE_KIND_NAMES = new Map([
  ['module', 'module'],
  ['objectmodule', 'object-module'],
  ['managermodule', 'manager-module'],
  ['recordsetmodule', 'record-set-module'],
  ['valuemanagermodule', 'value-manager-module'],
  ['commandmodule', 'command-module'],
  ['managedapplicationmodule', 'managed-application-module'],
  ['ordinaryapplicationmodule', 'ordinary-application-module'],
  ['externalconnectionmodule', 'external-connection-module'],
  ['sessionmodule', 'session-module'],
]);

function foldIdentifier(value) {
  return String(value ?? '').normalize('NFC').toLowerCase();
}

function normalizeRelativePath(filePath) {
  const rawParts = String(filePath ?? '')
    .replace(/\\/gu, '/')
    .split('/');
  const parts = [];

  for (const rawPart of rawParts) {
    const part = rawPart.normalize('NFC');
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else parts.push(part);
      continue;
    }
    parts.push(part);
  }

  return parts.join('/');
}

function moduleKindFromFilename(filename, formName, commandName) {
  if (formName) return 'form-module';
  if (commandName) return 'command-module';
  const base = filename.replace(/\.bsl$/iu, '');
  return MODULE_KIND_NAMES.get(base.toLowerCase()) || `${foldIdentifier(base)}-module`;
}

function moduleIdentityFromPath(filePath) {
  const relativePath = normalizeRelativePath(filePath);
  const parts = relativePath.split('/').filter(Boolean);
  const filename = parts.at(-1) || 'Module.bsl';
  const lowered = parts.map(part => part.toLowerCase());

  const collectionIndex = lowered.findIndex(part => OBJECT_KIND_NAMES.has(part));
  const collection = collectionIndex >= 0 ? parts[collectionIndex] : null;
  const objectName = collectionIndex >= 0 ? parts[collectionIndex + 1] || null : null;
  const objectKind = collection
    ? OBJECT_KIND_NAMES.get(collection.toLowerCase())
    : 'standalone-module';

  const formsIndex = lowered.findIndex(part => part === 'forms');
  const commandsIndex = lowered.findIndex(part => part === 'commands');
  const extIndex = lowered.findIndex(part => part === 'ext');
  const formName = formsIndex >= 0 ? parts[formsIndex + 1] || null : null;
  const commandName = commandsIndex >= 0 ? parts[commandsIndex + 1] || null : null;
  const moduleKind = objectKind === 'common-form'
    ? 'form-module'
    : objectKind === 'common-command'
      ? 'command-module'
      : moduleKindFromFilename(filename, formName, commandName);
  const fallbackName = filename.replace(/\.bsl$/iu, '');
  const enclosingName = extIndex > 0 ? parts[extIndex - 1] : null;
  const displayName = formName || commandName || objectName || enclosingName || fallbackName;
  const canonicalPath = relativePath.replace(/\.bsl$/iu, '');
  const id = `module:${foldIdentifier(canonicalPath)}`;
  const aliases = [];

  for (const alias of [displayName, objectName]) {
    if (!alias) continue;
    if (!aliases.some(existing => foldIdentifier(existing) === foldIdentifier(alias))) {
      aliases.push(alias);
    }
  }

  return {
    id,
    moduleId: id,
    relativePath,
    canonicalPath,
    displayName,
    moduleDisplayName: displayName,
    aliases,
    objectKind,
    objectName,
    moduleKind,
    formName,
    commandName,
  };
}

function procedureId(moduleId, procedureName) {
  return `${moduleId}::${foldIdentifier(procedureName)}`;
}

module.exports = {
  foldIdentifier,
  moduleIdentityFromPath,
  normalizeRelativePath,
  procedureId,
};
