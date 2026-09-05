'use strict';

const IDENTIFIER_START = /[\p{L}_]/u;
const IDENTIFIER_CONTINUE = /[\p{L}\p{N}_]/u;

function isIdentifierStart(character) {
  return Boolean(character) && IDENTIFIER_START.test(character);
}

function isIdentifierContinue(character) {
  return Boolean(character) && IDENTIFIER_CONTINUE.test(character);
}

function location(startLine, startColumn, endLine, endColumn, startOffset, endOffset) {
  return {
    start: { line: startLine, column: startColumn, offset: startOffset },
    end: { line: endLine, column: endColumn, offset: endOffset },
  };
}

/**
 * Lex the subset of BSL needed by the call-graph parser.
 *
 * String contents and comments deliberately produce no tokens. Newline tokens
 * are retained, including inside multiline strings, so declarations and
 * diagnostics keep their original source coordinates.
 */
function lexBsl(source) {
  const text = String(source ?? '');
  const tokens = [];
  const diagnostics = [];
  let index = 0;
  let line = 1;
  let column = 1;
  let state = 'code';
  let stringStart = null;

  const addUnclosedStringDiagnostic = (endLine, endColumn, endOffset) => {
    if (!stringStart) return;
    diagnostics.push({
      code: 'unclosed-string',
      severity: 'warning',
      message: 'String literal is not closed before the end of the line or file.',
      line: stringStart.line,
      column: stringStart.column,
      location: location(
        stringStart.line,
        stringStart.column,
        endLine,
        endColumn,
        stringStart.offset,
        endOffset
      ),
    });
    stringStart = null;
  };

  const addNewline = (startOffset, startLine, startColumn, width) => {
    tokens.push({
      type: 'newline',
      value: '\n',
      line: startLine,
      column: startColumn,
      endLine: startLine + 1,
      endColumn: 1,
      offset: startOffset,
      endOffset: startOffset + width,
      location: location(
        startLine,
        startColumn,
        startLine + 1,
        1,
        startOffset,
        startOffset + width
      ),
    });
  };

  const consumeNewline = () => {
    const startOffset = index;
    const startLine = line;
    const startColumn = column;
    const width = text[index] === '\r' && text[index + 1] === '\n' ? 2 : 1;
    addNewline(startOffset, startLine, startColumn, width);
    index += width;
    line++;
    column = 1;
  };

  while (index < text.length) {
    const character = text[index];

    if (character === '\r' || character === '\n') {
      consumeNewline();
      if (state === 'comment') state = 'code';
      else if (state === 'string') state = 'string-continuation';
      else if (state === 'string-continuation-comment') {
        state = 'string-continuation';
      }
      continue;
    }

    if (state === 'comment') {
      index++;
      column++;
      continue;
    }

    // A BSL multiline string continues on a line whose first non-whitespace
    // character is `|`. Full-line comments may appear between such fragments
    // and must not affect quote balancing inside the string.
    if (state === 'string-continuation') {
      if (character === ' ' || character === '\t' || character === '\f') {
        index++;
        column++;
        continue;
      }
      if (character === '/' && text[index + 1] === '/') {
        state = 'string-continuation-comment';
        index += 2;
        column += 2;
        continue;
      }
      if (character === '|') {
        state = 'string';
        index++;
        column++;
        continue;
      }

      addUnclosedStringDiagnostic(line, column, index);
      state = 'code';
      continue;
    }

    if (state === 'string-continuation-comment') {
      index++;
      column++;
      continue;
    }

    if (state === 'string') {
      if (character === '"') {
        if (text[index + 1] === '"') {
          index += 2;
          column += 2;
        } else {
          state = 'code';
          stringStart = null;
          index++;
          column++;
        }
      } else {
        index++;
        column++;
      }
      continue;
    }

    if (character === '/' && text[index + 1] === '/') {
      state = 'comment';
      index += 2;
      column += 2;
      continue;
    }

    if (character === '"') {
      state = 'string';
      stringStart = { line, column, offset: index };
      index++;
      column++;
      continue;
    }

    if (isIdentifierStart(character)) {
      const startOffset = index;
      const startLine = line;
      const startColumn = column;
      index++;
      column++;
      while (index < text.length && isIdentifierContinue(text[index])) {
        index++;
        column++;
      }
      const value = text.slice(startOffset, index);
      tokens.push({
        type: 'identifier',
        value,
        line: startLine,
        column: startColumn,
        endLine: line,
        endColumn: column,
        offset: startOffset,
        endOffset: index,
        location: location(startLine, startColumn, line, column, startOffset, index),
      });
      continue;
    }

    if (!/\s/u.test(character)) {
      const startOffset = index;
      const startColumn = column;
      tokens.push({
        type: 'symbol',
        value: character,
        line,
        column: startColumn,
        endLine: line,
        endColumn: startColumn + 1,
        offset: startOffset,
        endOffset: startOffset + 1,
        location: location(line, startColumn, line, startColumn + 1, startOffset, startOffset + 1),
      });
    }
    index++;
    column++;
  }

  if ((state === 'string' || state === 'string-continuation'
      || state === 'string-continuation-comment') && stringStart) {
    addUnclosedStringDiagnostic(line, column, text.length);
  }

  return { tokens, diagnostics };
}

module.exports = {
  isIdentifierContinue,
  isIdentifierStart,
  lexBsl,
};
