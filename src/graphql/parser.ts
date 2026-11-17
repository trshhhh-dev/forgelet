// A very small GraphQL document parser: operations, variables, selection sets, aliases, arguments,
// fragments and inline fragments.  It parses only the language, not the schema; the executor decides
// which fields exist and produces GitHub's {data, errors} envelope.

export interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Record<string, ValueNode>;
  readonly selection: readonly SelectionNode[];
}

export interface FragmentSpreadNode {
  readonly kind: 'spread';
  readonly name: string;
  readonly selection: readonly [];
}

export interface InlineFragmentNode {
  readonly kind: 'inline';
  readonly typeCondition: string | null;
  readonly selection: readonly SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, ValueNode>> };

export interface VariableDefinition {
  readonly name: string;
  readonly defaultValue: ValueNode | null;
}

export interface OperationNode {
  readonly type: 'query' | 'mutation' | 'subscription';
  readonly name: string | null;
  readonly variables: readonly VariableDefinition[];
  readonly selection: readonly SelectionNode[];
}

export interface FragmentNode {
  readonly name: string;
  readonly typeCondition: string;
  readonly selection: readonly SelectionNode[];
}

export interface DocumentNode {
  readonly operations: readonly OperationNode[];
  readonly fragments: ReadonlyMap<string, FragmentNode>;
}

export class GraphQLSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLSyntaxError';
  }
}

const NAME = /[_A-Za-z][_0-9A-Za-z]*/y;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

class Parser {
  private offset = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    this.skip();
    while (!this.done()) {
      this.skip();
      if (this.done()) break;
      if (this.keyword('fragment')) {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
      } else {
        operations.push(this.parseOperation());
      }
      this.skip();
    }
    if (operations.length === 0) throw new GraphQLSyntaxError('the document has no operations');
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    this.skip();
    let type: OperationNode['type'] = 'query';
    let name: string | null = null;
    if (this.peek() === '{') {
      return { type, name, variables: [], selection: this.parseSelectionSet() };
    }
    if (this.keyword('query')) type = 'query';
    else if (this.keyword('mutation')) type = 'mutation';
    else if (this.keyword('subscription')) type = 'subscription';
    else throw new GraphQLSyntaxError(`expected an operation at offset ${this.offset}`);
    this.skip();
    const maybeName = this.readName();
    if (maybeName !== null) name = maybeName;
    const variables = this.parseVariableDefinitions();
    this.skipDirectives();
    const selection = this.parseSelectionSet();
    return { type, name, variables, selection };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    this.skip();
    if (this.peek() !== '(') return [];
    this.expect('(');
    const definitions: VariableDefinition[] = [];
    for (;;) {
      this.skip();
      if (this.peek() === ')') break;
      this.expect('$');
      const name = this.requireName('a variable name');
      this.skip();
      this.expect(':');
      this.skipType();
      this.skip();
      let defaultValue: ValueNode | null = null;
      if (this.peek() === '=') {
        this.offset += 1;
        defaultValue = this.parseValue();
      }
      definitions.push({ name, defaultValue });
      this.skip();
      if (this.peek() === ',') this.offset += 1;
      this.skip();
      if (this.peek() === ')') break;
    }
    this.expect(')');
    return definitions;
  }

  private skipType(): void {
    this.skip();
    if (this.peek() === '[') {
      this.offset += 1;
      this.skipType();
      this.expect(']');
    } else {
      this.requireName('a type name');
    }
    this.skip();
    if (this.peek() === '!') this.offset += 1;
  }

  private parseFragment(): FragmentNode {
    const name = this.requireName('a fragment name');
    this.skip();
    if (!this.keyword('on')) throw new GraphQLSyntaxError(`expected "on" after fragment ${name}`);
    this.skip();
    const typeCondition = this.requireName('a type condition');
    this.skipDirectives();
    const selection = this.parseSelectionSet();
    return { name, typeCondition, selection };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.skip();
    this.expect('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      this.skip();
      if (this.peek() === '}') break;
      if (this.done()) throw new GraphQLSyntaxError('unterminated selection set');
      selections.push(this.parseSelection());
      this.skip();
      if (this.peek() === ',') this.offset += 1;
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    this.skip();
    if (this.source.startsWith('...', this.offset)) {
      this.offset += 3;
      this.skip();
      if (this.keyword('on')) {
        this.skip();
        const typeCondition = this.requireName('an inline fragment type');
        this.skipDirectives();
        const selection = this.parseSelectionSet();
        return { kind: 'inline', typeCondition, selection };
      }
      if (this.peek() === '{' || this.peek() === '@') {
        this.skipDirectives();
        const selection = this.parseSelectionSet();
        return { kind: 'inline', typeCondition: null, selection };
      }
      const name = this.requireName('a fragment name');
      this.skipDirectives();
      return { kind: 'spread', name, selection: [] };
    }
    let name = this.requireName('a field name');
    let alias: string | null = null;
    this.skip();
    if (this.peek() === ':') {
      this.offset += 1;
      alias = name;
      this.skip();
      name = this.requireName('a field name');
    }
    const args = this.parseArguments();
    this.skipDirectives();
    this.skip();
    const selection = this.peek() === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selection };
  }

  private parseArguments(): Record<string, ValueNode> {
    this.skip();
    const args: Record<string, ValueNode> = {};
    if (this.peek() !== '(') return args;
    this.offset += 1;
    for (;;) {
      this.skip();
      if (this.peek() === ')') break;
      const name = this.requireName('an argument name');
      this.skip();
      this.expect(':');
      args[name] = this.parseValue();
      this.skip();
      if (this.peek() === ',') this.offset += 1;
    }
    this.expect(')');
    return args;
  }

  private parseValue(): ValueNode {
    this.skip();
    const char = this.peek();
    if (char === '$') {
      this.offset += 1;
      this.skip();
      return { kind: 'variable', name: this.requireName('a variable name') };
    }
    if (char === '"') return { kind: 'string', value: this.readString() };
    if (char === '[') {
      this.offset += 1;
      const values: ValueNode[] = [];
      for (;;) {
        this.skip();
        if (this.peek() === ']') break;
        values.push(this.parseValue());
        this.skip();
        if (this.peek() === ',') this.offset += 1;
      }
      this.expect(']');
      return { kind: 'list', values };
    }
    if (char === '{') {
      this.offset += 1;
      const fields: Record<string, ValueNode> = {};
      for (;;) {
        this.skip();
        if (this.peek() === '}') break;
        const name = this.requireName('an input field name');
        this.skip();
        this.expect(':');
        fields[name] = this.parseValue();
        this.skip();
        if (this.peek() === ',') this.offset += 1;
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    const number = this.read(NUMBER);
    if (number !== null) return { kind: 'number', value: Number(number) };
    const name = this.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    if (name !== null) return { kind: 'enum', value: name };
    throw new GraphQLSyntaxError(`expected a value at offset ${this.offset}`);
  }

  private skipDirectives(): void {
    for (;;) {
      this.skip();
      if (this.peek() !== '@') return;
      this.offset += 1;
      this.requireName('a directive name');
      this.parseArguments();
    }
  }

  private readString(): string {
    this.expect('"');
    if (this.source.startsWith('""', this.offset)) {
      // Block string.
      this.offset += 2;
      const end = this.source.indexOf('"""', this.offset);
      if (end < 0) throw new GraphQLSyntaxError('unterminated block string');
      const value = this.source.slice(this.offset, end);
      this.offset = end + 3;
      return value;
    }
    let out = '';
    while (!this.done()) {
      const char = this.source[this.offset] as string;
      this.offset += 1;
      if (char === '"') return out;
      if (char === '\\') {
        const escaped = this.source[this.offset] as string;
        this.offset += 1;
        if (escaped === 'u') {
          const hex = this.source.slice(this.offset, this.offset + 4);
          this.offset += 4;
          out += String.fromCharCode(Number.parseInt(hex, 16));
        } else {
          out += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
        }
      } else {
        out += char;
      }
    }
    throw new GraphQLSyntaxError('unterminated string');
  }

  private skip(): void {
    for (;;) {
      while (!this.done() && /\s|,/.test(this.source[this.offset] as string)) this.offset += 1;
      if (!this.done() && this.source[this.offset] === '#') {
        while (!this.done() && this.source[this.offset] !== '\n') this.offset += 1;
        continue;
      }
      break;
    }
  }

  private keyword(word: string): boolean {
    this.skip();
    if (!this.source.startsWith(word, this.offset)) return false;
    const next = this.source[this.offset + word.length];
    if (next !== undefined && /[_0-9A-Za-z]/.test(next)) return false;
    this.offset += word.length;
    return true;
  }

  private peek(): string | null {
    return this.done() ? null : (this.source[this.offset] as string);
  }

  private expect(char: string): void {
    this.skip();
    if (this.source[this.offset] !== char) {
      throw new GraphQLSyntaxError(`expected "${char}" at offset ${this.offset}`);
    }
    this.offset += 1;
  }

  private read(pattern: RegExp): string | null {
    pattern.lastIndex = this.offset;
    const found = pattern.exec(this.source);
    if (found === null || found.index !== this.offset) return null;
    this.offset += found[0].length;
    return found[0];
  }

  private readName(): string | null {
    return this.read(NAME);
  }

  private requireName(what: string): string {
    const name = this.readName();
    if (name === null) throw new GraphQLSyntaxError(`expected ${what} at offset ${this.offset}`);
    return name;
  }

  private done(): boolean {
    return this.offset >= this.source.length;
  }
}

export function parseGraphQL(source: string): DocumentNode {
  if (typeof source !== 'string' || source.trim() === '') throw new GraphQLSyntaxError('the query is empty');
  return new Parser(source).parseDocument();
}

/** Resolve a parsed value against a request's variables (and an operation's declared defaults). */
export function valueOf(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => valueOf(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = valueOf(value, variables);
      return out;
    }
  }
}
