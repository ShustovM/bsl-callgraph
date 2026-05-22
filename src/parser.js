'use strict';

// BSL keywords that look like calls but aren't
const BSL_KEYWORDS = new Set([
  'если', 'иначеесли', 'тогда', 'иначе', 'конецесли',
  'пока', 'цикл', 'конеццикла',
  'для', 'каждого', 'из', 'по',
  'попытка', 'исключение', 'вызватьисключение', 'конецпопытки',
  'возврат', 'прервать', 'продолжить',
  'новый', 'не', 'и', 'или',
  'процедура', 'функция', 'конецпроцедуры', 'конецфункции', 'экспорт',
  'перем', 'знч', 'typeof',
  'истина', 'ложь', 'неопределено', 'null', 'undefined',
  // English
  'if', 'elseif', 'then', 'else', 'endif',
  'while', 'do', 'enddo',
  'for', 'each', 'in', 'to', 'enddo',
  'try', 'except', 'raise', 'endtry',
  'return', 'break', 'continue',
  'new', 'not', 'and', 'or',
  'procedure', 'function', 'endprocedure', 'endfunction', 'export',
  'var', 'val', 'typeof',
  'true', 'false', 'undefined', 'null',
]);

// Procedure/function declaration (Russian + English, case-insensitive)
const RE_PROC_DECL = /^[ \t]*(Процедура|Функция|Procedure|Function)[ \t]+([а-яёА-ЯЁa-zA-Z_][а-яёА-ЯЁa-zA-Z0-9_]*)[ \t]*\(/i;
const RE_PROC_EXPORT = /\)[ \t]*(Экспорт|Export)[ \t]*$/i;
const RE_PROC_END = /^[ \t]*(КонецПроцедуры|КонецФункции|EndProcedure|EndFunction)[ \t]*;?[ \t]*$/i;

// Identifier character class (Cyrillic + Latin)
const IDENT_START = /[а-яёА-ЯЁa-zA-Z_]/u;
const IDENT_CONT = /[а-яёА-ЯЁa-zA-Z0-9_]/u;

// Strip single-line BSL comment, respecting string literals
function stripComment(line) {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      inString = !inString;
    } else if (!inString && line[i] === '/' && line[i + 1] === '/') {
      return line.slice(0, i);
    }
  }
  return line;
}

// Replace string literal contents with spaces (keeps structure intact)
function stripStrings(line) {
  let result = '';
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (inString && line[i + 1] === '"') {
        // Escaped double-quote inside string
        result += '  ';
        i++;
      } else {
        inString = !inString;
        result += '"';
      }
    } else if (inString) {
      result += ' ';
    } else {
      result += line[i];
    }
  }
  return result;
}

// Extract all call references from a single cleaned line
// Returns array of { calleeName, calleeModule (or null) }
function extractCallsFromLine(line) {
  const calls = [];
  let i = 0;

  while (i < line.length) {
    // Skip non-identifier chars
    if (!IDENT_START.test(line[i])) {
      i++;
      continue;
    }

    // Check what's before this identifier
    const charBefore = i > 0 ? line[i - 1] : '';
    const precededByDot = charBefore === '.';

    // Read identifier
    const start = i;
    while (i < line.length && IDENT_CONT.test(line[i])) i++;
    const ident = line.slice(start, i);

    // Skip whitespace
    let j = i;
    while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;

    if (line[j] === '(') {
      // It's a call
      if (precededByDot) {
        // This is the method part of Module.Method() — find module by walking back
        // Module was the identifier before the dot
        let dotPos = start - 1; // position of '.'
        let modEnd = dotPos;
        let modStart = modEnd - 1;
        while (modStart > 0 && IDENT_CONT.test(line[modStart - 1])) modStart--;
        if (modStart >= 0 && modEnd > modStart) {
          const mod = line.slice(modStart, modEnd);
          if (!BSL_KEYWORDS.has(mod.toLowerCase())) {
            calls.push({ calleeName: ident, calleeModule: mod });
          }
        }
      } else {
        // Direct call
        if (!BSL_KEYWORDS.has(ident.toLowerCase())) {
          calls.push({ calleeName: ident, calleeModule: null });
        }
      }
      i = j + 1;
    } else if (line[j] === '.') {
      // Could be Module.Method — skip for now, will be handled when we hit Method
      i = j + 1;
    } else {
      i = j;
    }
  }

  return calls;
}

// Extract module name from 1C file path convention
// CommonModules\ModuleName\Ext\Module.bsl → ModuleName
// Documents\DocName\Ext\ObjectModule.bsl → DocName
function moduleNameFromPath(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');

  // Find 'Ext' segment
  const extIdx = parts.findIndex(p => p.toLowerCase() === 'ext');
  if (extIdx >= 2) {
    return parts[extIdx - 1];
  }

  // Fallback: use filename without extension
  const fname = parts[parts.length - 1];
  return fname.replace(/\.bsl$/i, '');
}

// Parse BSL source text, returns { procedures, calls }
// procedures: [{ name, kind, isExport, line, module, file }]
// calls: [{ callerName, callerModule, callLine, calleeName, calleeModule }]
function parseFile(content, filePath) {
  const lines = content.split(/\r?\n/);
  const procedures = [];
  const calls = [];
  const moduleName = moduleNameFromPath(filePath);

  let currentProc = null;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineNum = lineIdx + 1;
    const rawLine = lines[lineIdx];
    const cleanLine = stripStrings(stripComment(rawLine));

    // Procedure/function end
    if (RE_PROC_END.test(cleanLine)) {
      currentProc = null;
      continue;
    }

    // Procedure/function declaration
    const declMatch = RE_PROC_DECL.exec(cleanLine);
    if (declMatch) {
      const kind = /процедура|procedure/i.test(declMatch[1]) ? 'procedure' : 'function';
      const name = declMatch[2];
      // Check for export — may be on same line or continuation, check full rawLine
      const isExport = RE_PROC_EXPORT.test(rawLine.replace(/\/\/.*$/, ''));
      currentProc = { name, kind, isExport, line: lineNum, module: moduleName, file: filePath };
      procedures.push(currentProc);
      continue;
    }

    // Extract calls within procedure/function body
    if (currentProc) {
      const lineCalls = extractCallsFromLine(cleanLine);
      for (const c of lineCalls) {
        calls.push({
          callerName: currentProc.name,
          callerModule: moduleName,
          callLine: lineNum,
          calleeName: c.calleeName,
          calleeModule: c.calleeModule,
        });
      }
    }
  }

  return { procedures, calls, module: moduleName };
}

module.exports = { parseFile, moduleNameFromPath };
