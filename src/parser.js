'use strict';

const { lexBsl } = require('./lexer');
const {
  foldIdentifier,
  moduleIdentityFromPath,
  procedureId,
} = require('./module-identity');

const DECLARATION_KEYWORDS = new Map([
  ['процедура', 'procedure'],
  ['procedure', 'procedure'],
  ['функция', 'function'],
  ['function', 'function'],
]);

const END_KEYWORDS = new Map([
  ['конецпроцедуры', 'procedure'],
  ['endprocedure', 'procedure'],
  ['конецфункции', 'function'],
  ['endfunction', 'function'],
]);

const EXPORT_KEYWORDS = new Set(['экспорт', 'export']);
const ASYNC_KEYWORDS = new Set(['асинх', 'async']);

// Language statements and operators which can syntactically precede `(` but
// never represent a procedure/function call.
const BSL_KEYWORDS = new Set([
  'если', 'иначеесли', 'тогда', 'иначе', 'конецесли',
  'пока', 'цикл', 'конеццикла', 'для', 'каждого', 'из', 'по',
  'попытка', 'исключение', 'вызватьисключение', 'конецпопытки',
  'возврат', 'прервать', 'продолжить', 'новый', 'не', 'и', 'или',
  'процедура', 'функция', 'конецпроцедуры', 'конецфункции', 'экспорт',
  'асинх',
  'перем', 'знч', 'знач', 'истина', 'ложь', 'неопределено', 'null',
  'if', 'elseif', 'then', 'else', 'endif', 'while', 'do', 'enddo',
  'for', 'each', 'in', 'to', 'try', 'except', 'raise', 'endtry',
  'return', 'break', 'continue', 'new', 'not', 'and', 'or',
  'procedure', 'function', 'endprocedure', 'endfunction', 'export',
  'async',
  'var', 'val', 'true', 'false', 'undefined', 'typeof',
]);

function moduleNameFromPath(filePath) {
  return moduleIdentityFromPath(filePath).displayName;
}

function nextSignificant(tokens, startIndex) {
  let index = startIndex;
  while (tokens[index]?.type === 'newline') index++;
  return index;
}

function previousSignificant(tokens, startIndex) {
  let index = startIndex;
  while (tokens[index]?.type === 'newline') index--;
  return index;
}

function isFirstSignificantOnLine(tokens, index) {
  const token = tokens[index];
  const previous = tokens[previousSignificant(tokens, index - 1)];
  return !previous || previous.line < token.line;
}

function isDeclarationStart(tokens, index) {
  if (isFirstSignificantOnLine(tokens, index)) return true;

  const token = tokens[index];
  const previousIndex = previousSignificant(tokens, index - 1);
  const previous = tokens[previousIndex];
  if (previous?.line !== token.line
      || previous.type !== 'identifier'
      || !ASYNC_KEYWORDS.has(foldIdentifier(previous.value))) {
    return false;
  }
  return isFirstSignificantOnLine(tokens, previousIndex);
}

function diagnostic(code, message, token, extra = {}) {
  return {
    code,
    severity: 'warning',
    message,
    line: token?.line || 1,
    column: token?.column || 1,
    ...(token?.location ? { location: token.location } : {}),
    ...extra,
  };
}

function findClosingParenthesis(tokens, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== 'symbol') continue;
    if (token.value === '(') depth++;
    if (token.value === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function appendParenthesisDiagnostics(tokens, diagnostics) {
  const stack = [];
  for (const token of tokens) {
    if (token.type !== 'symbol') continue;
    if (token.value === '(') {
      stack.push(token);
    } else if (token.value === ')') {
      if (stack.length > 0) stack.pop();
      else diagnostics.push(diagnostic(
        'unmatched-parenthesis',
        'Closing parenthesis has no matching opening parenthesis.',
        token
      ));
    }
  }
  for (const token of stack) {
    diagnostics.push(diagnostic(
      'unclosed-parenthesis',
      'Opening parenthesis is not closed.',
      token
    ));
  }
}

function parseDeclaration(tokens, index, moduleIdentity, filePath, diagnostics) {
  const keywordToken = tokens[index];
  const kind = DECLARATION_KEYWORDS.get(foldIdentifier(keywordToken.value));
  const nameIndex = nextSignificant(tokens, index + 1);
  const nameToken = tokens[nameIndex];

  if (!nameToken || nameToken.type !== 'identifier') {
    diagnostics.push(diagnostic(
      'malformed-declaration',
      'Procedure/function declaration has no valid name.',
      keywordToken
    ));
    return { nextIndex: index + 1, procedure: null };
  }

  const openIndex = nextSignificant(tokens, nameIndex + 1);
  if (tokens[openIndex]?.value !== '(') {
    diagnostics.push(diagnostic(
      'malformed-declaration',
      `Declaration of ${nameToken.value} has no parameter list.`,
      nameToken
    ));
    return { nextIndex: nameIndex + 1, procedure: null };
  }

  const closeIndex = findClosingParenthesis(tokens, openIndex);
  if (closeIndex < 0) {
    diagnostics.push(diagnostic(
      'unclosed-declaration',
      `Parameter list of ${nameToken.value} is not closed.`,
      tokens[openIndex],
      { procedureName: nameToken.value }
    ));
  }

  const effectiveCloseIndex = closeIndex < 0 ? tokens.length - 1 : closeIndex;
  const exportIndex = nextSignificant(tokens, effectiveCloseIndex + 1);
  const isExport = EXPORT_KEYWORDS.has(foldIdentifier(tokens[exportIndex]?.value));
  const endToken = tokens[isExport ? exportIndex : effectiveCloseIndex] || nameToken;
  const procId = procedureId(moduleIdentity.id, nameToken.value);
  const procedure = {
    id: procId,
    name: nameToken.value,
    normalizedName: foldIdentifier(nameToken.value),
    kind,
    isExport,
    line: keywordToken.line,
    column: keywordToken.column,
    endLine: endToken.endLine,
    endColumn: endToken.endColumn,
    location: {
      start: keywordToken.location.start,
      end: endToken.location.end,
    },
    module: moduleIdentity.displayName,
    moduleDisplayName: moduleIdentity.displayName,
    moduleAliases: moduleIdentity.aliases,
    moduleId: moduleIdentity.id,
    moduleKind: moduleIdentity.moduleKind,
    objectKind: moduleIdentity.objectKind,
    file: filePath,
  };

  return {
    nextIndex: isExport ? exportIndex + 1 : effectiveCloseIndex + 1,
    procedure,
  };
}

function callCandidate(tokens, index, currentProcedure, occurrence) {
  const nameToken = tokens[index];
  const openIndex = nextSignificant(tokens, index + 1);
  if (tokens[openIndex]?.value !== '(') return null;
  if (BSL_KEYWORDS.has(foldIdentifier(nameToken.value))) return null;

  const dotIndex = previousSignificant(tokens, index - 1);
  let receiver = null;
  if (tokens[dotIndex]?.value === '.') {
    const receiverIndex = previousSignificant(tokens, dotIndex - 1);
    if (tokens[receiverIndex]?.type === 'identifier') {
      receiver = tokens[receiverIndex].value;
    }
  }

  return {
    callerId: currentProcedure.id,
    calleeName: nameToken.value,
    calleeModule: null,
    receiver,
    callLine: nameToken.line,
    callColumn: nameToken.column,
    occurrence,
  };
}

/**
 * Parse one BSL module. Calls are intentionally unresolved candidates; use
 * resolveCalls()/resolveCallCandidates() after all files have been parsed.
 */
function parseFile(content, filePath) {
  const moduleIdentity = moduleIdentityFromPath(filePath);
  const lexed = lexBsl(content);
  const diagnostics = [...lexed.diagnostics];
  const procedures = [];
  const calls = [];
  const tokens = lexed.tokens;
  let currentProcedure = null;
  let occurrence = 0;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token.type !== 'identifier') {
      index++;
      continue;
    }

    const normalized = foldIdentifier(token.value);
    if (DECLARATION_KEYWORDS.has(normalized) && isDeclarationStart(tokens, index)) {
      if (currentProcedure) {
        diagnostics.push(diagnostic(
          'unclosed-procedure',
          `Procedure/function ${currentProcedure.name} has no matching end before the next declaration.`,
          token,
          { procedureName: currentProcedure.name }
        ));
      }
      const declaration = parseDeclaration(
        tokens,
        index,
        moduleIdentity,
        filePath,
        diagnostics
      );
      if (declaration.procedure) {
        procedures.push(declaration.procedure);
        currentProcedure = declaration.procedure;
      } else {
        currentProcedure = null;
      }
      index = Math.max(index + 1, declaration.nextIndex);
      continue;
    }

    if (END_KEYWORDS.has(normalized) && isFirstSignificantOnLine(tokens, index)) {
      if (!currentProcedure) {
        diagnostics.push(diagnostic(
          'unmatched-procedure-end',
          `Unexpected ${token.value} without an open procedure/function.`,
          token
        ));
      } else if (END_KEYWORDS.get(normalized) !== currentProcedure.kind) {
        diagnostics.push(diagnostic(
          'mismatched-procedure-end',
          `${token.value} does not match ${currentProcedure.kind} ${currentProcedure.name}.`,
          token,
          { procedureName: currentProcedure.name }
        ));
      }
      currentProcedure = null;
      index++;
      continue;
    }

    if (currentProcedure) {
      const candidate = callCandidate(
        tokens,
        index,
        currentProcedure,
        occurrence
      );
      if (candidate) {
        calls.push(candidate);
        occurrence++;
      }
    }
    index++;
  }

  if (currentProcedure) {
    diagnostics.push(diagnostic(
      'unclosed-procedure',
      `Procedure/function ${currentProcedure.name} has no matching end.`,
      tokens.at(-1),
      { procedureName: currentProcedure.name }
    ));
  }

  appendParenthesisDiagnostics(tokens, diagnostics);

  return {
    procedures,
    calls,
    diagnostics,
    module: moduleIdentity.displayName,
    moduleId: moduleIdentity.id,
    moduleIdentity,
  };
}

module.exports = {
  BSL_KEYWORDS,
  moduleNameFromPath,
  parseFile,
};
