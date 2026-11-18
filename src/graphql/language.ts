// The GraphQL language: a lexer and a parser for executable documents (operations and fragments) and for
// the SDL the schema is written in. Positions are kept so errors can name a line and column.

export class GraphQLSyntaxError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(message);
    this.line = line;
    this.column = column;
  }
}

interface Token {
  readonly kind: 'punct' | 'name' | 'int' | 'float' | 'string' | 'eof';
  readonly value: string;
  readonly line: number;
  readonly column: number;
}

const PUNCT = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);

function blockStringValue(raw: string): string {
  const lines = raw.split(/\r\n|\r|\n/);
  let common: number | null = null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const indent = line.length - line.trimStart().length;
    if (indent < line.length && (common === null || indent < common)) common = indent;
  }
  if (common !== null) for (let i = 1; i < lines.length; i += 1) lines[i] = (lines[i] as string).slice(common);
  while (lines.length > 0 && (lines[0] as string).trim() === '') lines.shift();
  while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === '') lines.pop();
  return lines.join('\n');
}

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  let line = 1;
  let lineStart = 0;
  const column = (): number => at - lineStart + 1;
  while (at < source.length) {
    const ch = source[at] as string;
    if (ch === '\n') {
      at += 1;
      line += 1;
      lineStart = at;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === ',' || ch === '\r' || ch === '﻿') {
      at += 1;
      continue;
    }
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    const startColumn = column();
    if (ch === '.' && source.startsWith('...', at)) {
      tokens.push({ kind: 'punct', value: '...', line, column: startColumn });
      at += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch, line, column: startColumn });
      at += 1;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const start = at;
      while (at < source.length && /[_0-9A-Za-z]/.test(source[at] as string)) at += 1;
      tokens.push({ kind: 'name', value: source.slice(start, at), line, column: startColumn });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const match = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(at));
      if (match === null) throw new GraphQLSyntaxError(`Unexpected character ${JSON.stringify(ch)}`, line, startColumn);
      at += match[0].length;
      tokens.push({ kind: match[1] !== undefined || match[2] !== undefined ? 'float' : 'int', value: match[0], line, column: startColumn });
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        if (end < 0) throw new GraphQLSyntaxError('Unterminated block string', line, startColumn);
        const raw = source.slice(at + 3, end).replace(/\\"""/g, '"""');
        const startLine = line;
        for (const char of source.slice(at, end + 3)) {
          if (char === '\n') line += 1;
        }
        at = end + 3;
        lineStart = source.lastIndexOf('\n', at - 1) + 1;
        tokens.push({ kind: 'string', value: blockStringValue(raw), line: startLine, column: startColumn });
        continue;
      }
      let value = '';
      at += 1;
      for (;;) {
        if (at >= source.length || source[at] === '\n') throw new GraphQLSyntaxError('Unterminated string', line, startColumn);
        const c = source[at] as string;
        if (c === '"') {
          at += 1;
          break;
        }
        if (c === '\\') {
          const e = source[at + 1];
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (e === 'u') {
            const hex = source.slice(at + 2, at + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GraphQLSyntaxError('Bad unicode escape', line, column());
            value += String.fromCharCode(Number.parseInt(hex, 16));
            at += 6;
            continue;
          }
          if (e === undefined || map[e] === undefined) throw new GraphQLSyntaxError('Bad escape sequence', line, column());
          value += map[e];
          at += 2;
          continue;
        }
        value += c;
        at += 1;
      }
      tokens.push({ kind: 'string', value, line, column: startColumn });
      continue;
    }
    throw new GraphQLSyntaxError(`Unexpected character ${JSON.stringify(ch)}`, line, startColumn);
  }
  tokens.push({ kind: 'eof', value: '', line, column: column() });
  return tokens;
}

// ---------------------------------------------------------------- the AST

export interface Location {
  readonly line: number;
  readonly column: number;
}

export type ValueNode =
  | { readonly kind: 'Variable'; readonly name: string }
  | { readonly kind: 'Int'; readonly value: number }
  | { readonly kind: 'Float'; readonly value: number }
  | { readonly kind: 'String'; readonly value: string }
  | { readonly kind: 'Boolean'; readonly value: boolean }
  | { readonly kind: 'Null' }
  | { readonly kind: 'Enum'; readonly value: string }
  | { readonly kind: 'List'; readonly values: readonly ValueNode[] }
  | { readonly kind: 'Object'; readonly fields: ReadonlyArray<readonly [string, ValueNode]> };

export type TypeNode =
  | { readonly kind: 'Named'; readonly name: string }
  | { readonly kind: 'List'; readonly of: TypeNode }
  | { readonly kind: 'NonNull'; readonly of: TypeNode };

export interface Directive {
  readonly name: string;
  readonly args: ReadonlyArray<readonly [string, ValueNode]>;
}

export interface FieldNode {
  readonly kind: 'Field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: ReadonlyArray<readonly [string, ValueNode]>;
  readonly directives: readonly Directive[];
  readonly selections: readonly Selection[] | null;
  readonly loc: Location;
}

export interface SpreadNode {
  readonly kind: 'Spread';
  readonly name: string;
  readonly directives: readonly Directive[];
  readonly loc: Location;
}

export interface InlineNode {
  readonly kind: 'Inline';
  readonly typeCondition: string | null;
  readonly directives: readonly Directive[];
  readonly selections: readonly Selection[];
  readonly loc: Location;
}

export type Selection = FieldNode | SpreadNode | InlineNode;

export interface VariableDefinition {
  readonly name: string;
  readonly type: TypeNode;
  readonly defaultValue: ValueNode | null;
}

export interface Operation {
  readonly kind: 'Operation';
  readonly operation: 'query' | 'mutation' | 'subscription';
  readonly name: string | null;
  readonly variables: readonly VariableDefinition[];
  readonly selections: readonly Selection[];
  readonly loc: Location;
}

export interface Fragment {
  readonly kind: 'Fragment';
  readonly name: string;
  readonly typeCondition: string;
  readonly selections: readonly Selection[];
  readonly loc: Location;
}

export interface Document {
  readonly operations: readonly Operation[];
  readonly fragments: ReadonlyMap<string, Fragment>;
}

// ---------------------------------------------------------------- the parser

class Parser {
  readonly tokens: Token[];
  at = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.at + offset, this.tokens.length - 1)] as Token;
  }

  next(): Token {
    const token = this.peek();
    if (this.at < this.tokens.length - 1) this.at += 1;
    return token;
  }

  is(value: string): boolean {
    const token = this.peek();
    return (token.kind === 'punct' || token.kind === 'name') && token.value === value;
  }

  fail(token: Token): never {
    const shown = token.kind === 'eof' ? 'end of file' : `"${token.value}" (${token.kind === 'name' ? 'IDENTIFIER' : token.kind.toUpperCase()})`;
    throw new GraphQLSyntaxError(`Parse error on ${shown} at [${token.line}, ${token.column}]`, token.line, token.column);
  }

  expect(value: string): Token {
    const token = this.next();
    if ((token.kind !== 'punct' && token.kind !== 'name') || token.value !== value) this.fail(token);
    return token;
  }

  name(): string {
    const token = this.next();
    if (token.kind !== 'name') this.fail(token);
    return token.value;
  }

  loc(): Location {
    const token = this.peek();
    return { line: token.line, column: token.column };
  }

  document(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'Operation', operation: 'query', name: null, variables: [], selections: this.selectionSet(), loc: { line: token.line, column: token.column } });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        operations.push(this.operation());
      } else if (token.kind === 'name' && token.value === 'fragment') {
        const fragment = this.fragment();
        fragments.set(fragment.name, fragment);
      } else {
        this.fail(token);
      }
    }
    return { operations, fragments };
  }

  operation(): Operation {
    const loc = this.loc();
    const operation = this.name() as Operation['operation'];
    const name = this.peek().kind === 'name' ? this.name() : null;
    const variables: VariableDefinition[] = [];
    if (this.is('(')) {
      this.expect('(');
      while (!this.is(')')) {
        this.expect('$');
        const variable = this.name();
        this.expect(':');
        const type = this.type();
        let defaultValue: ValueNode | null = null;
        if (this.is('=')) {
          this.next();
          defaultValue = this.value(true);
        }
        this.directives();
        variables.push({ name: variable, type, defaultValue });
      }
      this.expect(')');
    }
    this.directives();
    return { kind: 'Operation', operation, name, variables, selections: this.selectionSet(), loc };
  }

  fragment(): Fragment {
    const loc = this.loc();
    this.expect('fragment');
    const name = this.name();
    if (name === 'on') this.fail(this.tokens[this.at - 1] as Token);
    this.expect('on');
    const typeCondition = this.name();
    this.directives();
    return { kind: 'Fragment', name, typeCondition, selections: this.selectionSet(), loc };
  }

  type(): TypeNode {
    let type: TypeNode;
    if (this.is('[')) {
      this.next();
      type = { kind: 'List', of: this.type() };
      this.expect(']');
    } else {
      type = { kind: 'Named', name: this.name() };
    }
    if (this.is('!')) {
      this.next();
      type = { kind: 'NonNull', of: type };
    }
    return type;
  }

  selectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (!this.is('}')) {
      if (this.peek().kind === 'eof') this.fail(this.peek());
      selections.push(this.selection());
    }
    this.expect('}');
    return selections;
  }

  selection(): Selection {
    const loc = this.loc();
    if (this.is('...')) {
      this.next();
      if (this.is('on')) {
        this.next();
        const typeCondition = this.name();
        return { kind: 'Inline', typeCondition, directives: this.directives(), selections: this.selectionSet(), loc };
      }
      if (this.peek().kind === 'name') return { kind: 'Spread', name: this.name(), directives: this.directives(), loc };
      return { kind: 'Inline', typeCondition: null, directives: this.directives(), selections: this.selectionSet(), loc };
    }
    let name = this.name();
    let alias: string | null = null;
    if (this.is(':')) {
      this.next();
      alias = name;
      name = this.name();
    }
    const args = this.is('(') ? this.arguments() : [];
    const directives = this.directives();
    const selections = this.is('{') ? this.selectionSet() : null;
    return { kind: 'Field', alias, name, args, directives, selections, loc };
  }

  arguments(): Array<[string, ValueNode]> {
    this.expect('(');
    const args: Array<[string, ValueNode]> = [];
    while (!this.is(')')) {
      const name = this.name();
      this.expect(':');
      args.push([name, this.value(false)]);
    }
    this.expect(')');
    return args;
  }

  directives(): Directive[] {
    const directives: Directive[] = [];
    while (this.is('@')) {
      this.next();
      const name = this.name();
      directives.push({ name, args: this.is('(') ? this.arguments() : [] });
    }
    return directives;
  }

  value(constant: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct') {
      if (token.value === '$' && !constant) return { kind: 'Variable', name: this.name() };
      if (token.value === '[') {
        const values: ValueNode[] = [];
        while (!this.is(']')) values.push(this.value(constant));
        this.expect(']');
        return { kind: 'List', values };
      }
      if (token.value === '{') {
        const fields: Array<[string, ValueNode]> = [];
        while (!this.is('}')) {
          const name = this.name();
          this.expect(':');
          fields.push([name, this.value(constant)]);
        }
        this.expect('}');
        return { kind: 'Object', fields };
      }
      this.fail(token);
    }
    if (token.kind === 'int') return { kind: 'Int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'Float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'String', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true' || token.value === 'false') return { kind: 'Boolean', value: token.value === 'true' };
      if (token.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: token.value };
    }
    this.fail(token);
  }

  // ------------------------------------------------------------ SDL

  description(): string | null {
    return this.peek().kind === 'string' ? this.next().value : null;
  }

  sdl(): SchemaSource {
    const types: TypeSource[] = [];
    while (this.peek().kind !== 'eof') {
      const description = this.description();
      const keyword = this.name();
      const name = this.name();
      if (keyword === 'scalar') {
        types.push({ kind: 'SCALAR', name, description, interfaces: [], fields: [], values: [], members: [] });
      } else if (keyword === 'union') {
        this.expect('=');
        const members: string[] = [];
        if (this.is('|')) this.next();
        members.push(this.name());
        while (this.is('|')) {
          this.next();
          members.push(this.name());
        }
        types.push({ kind: 'UNION', name, description, interfaces: [], fields: [], values: [], members });
      } else if (keyword === 'enum') {
        this.expect('{');
        const values: EnumSource[] = [];
        while (!this.is('}')) {
          const valueDescription = this.description();
          const value = this.name();
          values.push({ name: value, description: valueDescription, deprecation: this.deprecation() });
        }
        this.expect('}');
        types.push({ kind: 'ENUM', name, description, interfaces: [], fields: [], values, members: [] });
      } else if (keyword === 'type' || keyword === 'interface' || keyword === 'input') {
        const interfaces: string[] = [];
        if (this.is('implements')) {
          this.next();
          if (this.is('&')) this.next();
          interfaces.push(this.name());
          while (this.is('&')) {
            this.next();
            interfaces.push(this.name());
          }
        }
        this.expect('{');
        const fields: FieldSource[] = [];
        while (!this.is('}')) {
          const fieldDescription = this.description();
          const fieldName = this.name();
          const args: ArgSource[] = [];
          if (this.is('(')) {
            this.next();
            while (!this.is(')')) args.push(this.argument());
            this.expect(')');
          }
          this.expect(':');
          const type = this.type();
          let defaultValue: ValueNode | null = null;
          if (this.is('=')) {
            this.next();
            defaultValue = this.value(true);
          }
          fields.push({ name: fieldName, description: fieldDescription, args, type, defaultValue, deprecation: this.deprecation() });
        }
        this.expect('}');
        types.push({ kind: keyword === 'type' ? 'OBJECT' : keyword === 'interface' ? 'INTERFACE' : 'INPUT_OBJECT', name, description, interfaces, fields, values: [], members: [] });
      } else {
        this.fail(this.tokens[this.at - 2] as Token);
      }
    }
    return { types };
  }

  argument(): ArgSource {
    const description = this.description();
    const name = this.name();
    this.expect(':');
    const type = this.type();
    let defaultValue: ValueNode | null = null;
    if (this.is('=')) {
      this.next();
      defaultValue = this.value(true);
    }
    return { name, description, type, defaultValue, deprecation: this.deprecation() };
  }

  deprecation(): string | null {
    if (!this.is('@')) return null;
    const directives = this.directives();
    const deprecated = directives.find((directive) => directive.name === 'deprecated');
    if (deprecated === undefined) return null;
    const reason = deprecated.args.find(([name]) => name === 'reason')?.[1];
    return reason !== undefined && reason.kind === 'String' ? reason.value : 'No longer supported';
  }
}

export interface ArgSource {
  readonly name: string;
  readonly description: string | null;
  readonly type: TypeNode;
  readonly defaultValue: ValueNode | null;
  readonly deprecation: string | null;
}

export interface FieldSource extends ArgSource {
  readonly args: readonly ArgSource[];
}

export interface EnumSource {
  readonly name: string;
  readonly description: string | null;
  readonly deprecation: string | null;
}

export interface TypeSource {
  readonly kind: 'SCALAR' | 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT';
  readonly name: string;
  readonly description: string | null;
  readonly interfaces: readonly string[];
  readonly fields: readonly FieldSource[];
  readonly values: readonly EnumSource[];
  readonly members: readonly string[];
}

export interface SchemaSource {
  readonly types: readonly TypeSource[];
}

export function parseDocument(source: string): Document {
  return new Parser(source).document();
}

export function parseSdl(source: string): SchemaSource {
  return new Parser(source).sdl();
}

/** A value literal printed back as GraphQL (introspection's defaultValue). */
export function printValue(value: ValueNode): string {
  switch (value.kind) {
    case 'Variable':
      return `$${value.name}`;
    case 'Int':
    case 'Float':
      return String(value.value);
    case 'String':
      return JSON.stringify(value.value);
    case 'Boolean':
      return String(value.value);
    case 'Null':
      return 'null';
    case 'Enum':
      return value.value;
    case 'List':
      return `[${value.values.map(printValue).join(', ')}]`;
    case 'Object':
      return `{${value.fields.map(([name, field]) => `${name}: ${printValue(field)}`).join(', ')}}`;
  }
}
