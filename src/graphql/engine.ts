// A small GraphQL engine: a schema built from SDL plus resolvers, static validation of a document against it
// (unknown fields, types and fragments are reported, GitHub-style, before anything runs), and execution with
// variables, aliases, fragments, inline fragments on interfaces and unions, @skip/@include, serial mutations
// and the introspection types (__schema, __type, __typename) answered from the same definitions.

import {
  GraphQLSyntaxError,
  parseDocument,
  parseSdl,
  printValue,
  type ArgSource,
  type Directive,
  type Document,
  type EnumSource,
  type FieldNode,
  type Fragment,
  type Location,
  type Operation,
  type Selection,
  type TypeNode,
  type ValueNode,
} from './language.ts';

export interface FieldDef {
  readonly name: string;
  readonly description: string | null;
  readonly args: readonly ArgSource[];
  readonly type: TypeNode;
  readonly deprecation: string | null;
}

export interface TypeDef {
  readonly kind: 'SCALAR' | 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT';
  readonly name: string;
  readonly description: string | null;
  readonly fields: readonly FieldDef[];
  readonly fieldMap: ReadonlyMap<string, FieldDef>;
  readonly interfaces: readonly string[];
  readonly values: readonly EnumSource[];
  readonly inputFields: readonly ArgSource[];
  possibleTypes: string[];
}

export type Args = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Resolver<C> = (parent: any, args: Args, context: C) => unknown;

export class GraphQLError extends Error {
  readonly type: string | null;

  constructor(message: string, type: string | null = null) {
    super(message);
    this.type = type;
  }
}

export interface ErrorEntry {
  message: string;
  locations?: Location[];
  path?: Array<string | number>;
  type?: string;
  extensions?: Record<string, unknown>;
}

export interface Result {
  data?: Record<string, unknown> | null;
  errors?: ErrorEntry[];
}

const BUILTIN_SDL = `
scalar String
scalar Int
scalar Float
scalar Boolean
scalar ID
type __Schema {
  description: String
  types: [__Type!]!
  queryType: __Type!
  mutationType: __Type
  subscriptionType: __Type
  directives: [__Directive!]!
}
type __Type {
  kind: __TypeKind!
  name: String
  description: String
  specifiedByURL: String
  fields(includeDeprecated: Boolean = false): [__Field!]
  interfaces: [__Type!]
  possibleTypes: [__Type!]
  enumValues(includeDeprecated: Boolean = false): [__EnumValue!]
  inputFields(includeDeprecated: Boolean = false): [__InputValue!]
  ofType: __Type
  isOneOf: Boolean
}
type __Field {
  name: String!
  description: String
  args(includeDeprecated: Boolean = false): [__InputValue!]!
  type: __Type!
  isDeprecated: Boolean!
  deprecationReason: String
}
type __InputValue {
  name: String!
  description: String
  type: __Type!
  defaultValue: String
  isDeprecated: Boolean!
  deprecationReason: String
}
type __EnumValue {
  name: String!
  description: String
  isDeprecated: Boolean!
  deprecationReason: String
}
type __Directive {
  name: String!
  description: String
  isRepeatable: Boolean!
  locations: [__DirectiveLocation!]!
  args(includeDeprecated: Boolean = false): [__InputValue!]!
}
enum __TypeKind { SCALAR OBJECT INTERFACE UNION ENUM INPUT_OBJECT LIST NON_NULL }
enum __DirectiveLocation {
  QUERY MUTATION SUBSCRIPTION FIELD FRAGMENT_DEFINITION FRAGMENT_SPREAD INLINE_FRAGMENT VARIABLE_DEFINITION
  SCHEMA SCALAR OBJECT FIELD_DEFINITION ARGUMENT_DEFINITION INTERFACE UNION ENUM ENUM_VALUE INPUT_OBJECT
  INPUT_FIELD_DEFINITION
}
`;

/** Introspection's values: a type reference (named or wrapped) and the definitions it points into. */
interface TypeRefValue {
  readonly __ref: TypeNode;
}

function named(type: TypeNode): string {
  return type.kind === 'Named' ? type.name : named(type.of);
}

function typeText(type: TypeNode): string {
  if (type.kind === 'Named') return type.name;
  if (type.kind === 'List') return `[${typeText(type.of)}]`;
  return `${typeText(type.of)}!`;
}

const DIRECTIVES = [
  { name: 'include', description: 'Directs the executor to include this field or fragment only when the `if` argument is true.', locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'] },
  { name: 'skip', description: 'Directs the executor to skip this field or fragment when the `if` argument is true.', locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'] },
];
const IF_ARG: ArgSource = { name: 'if', description: 'The condition.', type: { kind: 'NonNull', of: { kind: 'Named', name: 'Boolean' } }, defaultValue: null, deprecation: null };

export class Schema<C> {
  readonly types = new Map<string, TypeDef>();
  readonly resolvers: Readonly<Record<string, Resolver<C>>>;
  readonly typeOf: (value: unknown) => string | null;

  constructor(sdl: string, resolvers: Readonly<Record<string, Resolver<C>>>, typeOf: (value: unknown) => string | null) {
    this.resolvers = resolvers;
    this.typeOf = typeOf;
    for (const source of [...parseSdl(BUILTIN_SDL).types, ...parseSdl(sdl).types]) {
      const fields: FieldDef[] = source.kind === 'INPUT_OBJECT' ? [] : source.fields.map((field) => ({ name: field.name, description: field.description, args: field.args, type: field.type, deprecation: field.deprecation }));
      this.types.set(source.name, {
        kind: source.kind,
        name: source.name,
        description: source.description,
        fields,
        fieldMap: new Map(fields.map((field) => [field.name, field])),
        interfaces: source.interfaces,
        values: source.values,
        inputFields: source.kind === 'INPUT_OBJECT' ? source.fields : [],
        possibleTypes: source.kind === 'UNION' ? [...source.members] : [],
      });
    }
    for (const type of this.types.values()) {
      for (const name of type.interfaces) this.types.get(name)?.possibleTypes.push(type.name);
    }
  }

  applies(condition: string, runtime: string): boolean {
    if (condition === runtime) return true;
    return this.types.get(condition)?.possibleTypes.includes(runtime) ?? false;
  }

  // ------------------------------------------------------------ introspection values

  ref(type: TypeNode): TypeRefValue {
    return { __ref: type };
  }

  introspect(parentType: string, field: string, value: unknown, args: Args): unknown {
    const nameRef = (name: string): TypeRefValue => ({ __ref: { kind: 'Named', name } });
    if (parentType === '__Schema') {
      if (field === 'types') return [...this.types.keys()].sort().map(nameRef);
      if (field === 'queryType') return nameRef('Query');
      if (field === 'mutationType') return this.types.has('Mutation') ? nameRef('Mutation') : null;
      if (field === 'subscriptionType') return null;
      if (field === 'directives') return DIRECTIVES;
      if (field === 'description') return null;
    }
    if (parentType === '__Type') {
      const ref = (value as TypeRefValue).__ref;
      const def = ref.kind === 'Named' ? this.types.get(ref.name) : undefined;
      const deprecatedToo = args.includeDeprecated === true;
      switch (field) {
        case 'kind':
          return ref.kind === 'List' ? 'LIST' : ref.kind === 'NonNull' ? 'NON_NULL' : def?.kind ?? 'SCALAR';
        case 'name':
          return ref.kind === 'Named' ? ref.name : null;
        case 'description':
          return def?.description ?? null;
        case 'specifiedByURL':
          return null;
        case 'fields':
          return def !== undefined && (def.kind === 'OBJECT' || def.kind === 'INTERFACE') ? def.fields.filter((f) => deprecatedToo || f.deprecation === null).map((f) => ({ __field: f })) : null;
        case 'interfaces':
          return def === undefined ? null : def.kind === 'OBJECT' || def.kind === 'INTERFACE' ? def.interfaces.map(nameRef) : null;
        case 'possibleTypes':
          return def !== undefined && (def.kind === 'INTERFACE' || def.kind === 'UNION') ? [...def.possibleTypes].sort().map(nameRef) : null;
        case 'enumValues':
          return def?.kind === 'ENUM' ? def.values.filter((v) => deprecatedToo || v.deprecation === null).map((v) => ({ __enum: v })) : null;
        case 'inputFields':
          return def?.kind === 'INPUT_OBJECT' ? def.inputFields.map((f) => ({ __input: f })) : null;
        case 'ofType':
          return ref.kind === 'Named' ? null : { __ref: ref.of };
        case 'isOneOf':
          return def?.kind === 'INPUT_OBJECT' ? false : null;
        default:
          return null;
      }
    }
    if (parentType === '__Field') {
      const def = (value as { __field: FieldDef }).__field;
      if (field === 'name') return def.name;
      if (field === 'description') return def.description;
      if (field === 'args') return def.args.map((arg) => ({ __input: arg }));
      if (field === 'type') return { __ref: def.type };
      if (field === 'isDeprecated') return def.deprecation !== null;
      if (field === 'deprecationReason') return def.deprecation;
    }
    if (parentType === '__InputValue') {
      const def = (value as { __input: ArgSource }).__input;
      if (field === 'name') return def.name;
      if (field === 'description') return def.description;
      if (field === 'type') return { __ref: def.type };
      if (field === 'defaultValue') return def.defaultValue === null ? null : printValue(def.defaultValue);
      if (field === 'isDeprecated') return def.deprecation !== null;
      if (field === 'deprecationReason') return def.deprecation;
    }
    if (parentType === '__EnumValue') {
      const def = (value as { __enum: EnumSource }).__enum;
      if (field === 'name') return def.name;
      if (field === 'description') return def.description;
      if (field === 'isDeprecated') return def.deprecation !== null;
      if (field === 'deprecationReason') return def.deprecation;
    }
    if (parentType === '__Directive') {
      const def = value as { name: string; description: string; locations: string[] };
      if (field === 'name') return def.name;
      if (field === 'description') return def.description;
      if (field === 'isRepeatable') return false;
      if (field === 'locations') return def.locations;
      if (field === 'args') return [{ __input: IF_ARG }];
    }
    return null;
  }

  // ------------------------------------------------------------ validation

  validate(document: Document, operation: Operation): ErrorEntry[] {
    const errors: ErrorEntry[] = [];
    const root = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    if (!this.types.has(root)) {
      errors.push({ message: `Schema is not configured for ${operation.operation}s`, locations: [operation.loc] });
      return errors;
    }
    const label = `${operation.operation}${operation.name === null ? '' : ` ${operation.name}`}`;
    this.validateSelections(document, root, operation.selections, [label], errors, new Set(), root);
    return errors;
  }

  validateSelections(document: Document, typeName: string, selections: readonly Selection[], path: string[], errors: ErrorEntry[], spreading: Set<string>, root: string): void {
    const type = this.types.get(typeName);
    if (type === undefined) return;
    for (const selection of selections) {
      if (selection.kind === 'Field') {
        if (selection.name === '__typename') continue;
        if (typeName === 'Query' && (selection.name === '__schema' || selection.name === '__type')) {
          if (selection.selections !== null) this.validateSelections(document, selection.name === '__schema' ? '__Schema' : '__Type', selection.selections, [...path, selection.alias ?? selection.name], errors, spreading, root);
          continue;
        }
        const field = type.fieldMap.get(selection.name);
        if (field === undefined) {
          errors.push({
            message: `Field '${selection.name}' doesn't exist on type '${typeName}'`,
            locations: [selection.loc],
            path: [...path, selection.alias ?? selection.name],
            extensions: { code: 'undefinedField', typeName, fieldName: selection.name },
          });
          continue;
        }
        const target = this.types.get(named(field.type));
        if (target === undefined) continue;
        const composite = target.kind === 'OBJECT' || target.kind === 'INTERFACE' || target.kind === 'UNION';
        if (composite && selection.selections === null) {
          errors.push({
            message: `Field must have selections (field '${selection.name}' returns ${target.name} but has no selections. Did you mean '${selection.name} { ... }'?)`,
            locations: [selection.loc],
            path: [...path, selection.alias ?? selection.name],
            extensions: { code: 'selectionMismatch', nodeName: `field '${selection.name}'`, typeName: target.name },
          });
        } else if (!composite && selection.selections !== null) {
          errors.push({
            message: `Selections can't be made on scalars (field '${selection.name}' returns ${typeText(field.type)} but has selections [${selection.selections.map((child) => (child.kind === 'Field' ? child.name : '...')).join(', ')}])`,
            locations: [selection.loc],
            path: [...path, selection.alias ?? selection.name],
            extensions: { code: 'selectionMismatch', nodeName: `field '${selection.name}'`, typeName: typeText(field.type) },
          });
        } else if (composite && selection.selections !== null) {
          this.validateSelections(document, target.name, selection.selections, [...path, selection.alias ?? selection.name], errors, spreading, root);
        }
      } else if (selection.kind === 'Inline') {
        const condition = selection.typeCondition ?? typeName;
        if (!this.types.has(condition)) {
          errors.push({ message: `No such type ${condition}, so it can't be a fragment condition`, locations: [selection.loc], path: [...path, `... on ${condition}`], extensions: { code: 'undefinedType', typeName: condition } });
          continue;
        }
        this.validateSelections(document, condition, selection.selections, [...path, `... on ${condition}`], errors, spreading, root);
      } else {
        const fragment: Fragment | undefined = document.fragments.get(selection.name);
        if (fragment === undefined) {
          errors.push({ message: `Fragment ${selection.name} was used, but not defined`, locations: [selection.loc], path: [...path, `... ${selection.name}`], extensions: { code: 'useAndDefineFragment', fragmentName: selection.name } });
          continue;
        }
        if (spreading.has(fragment.name)) continue;
        if (!this.types.has(fragment.typeCondition)) {
          errors.push({ message: `No such type ${fragment.typeCondition}, so it can't be a fragment condition`, locations: [fragment.loc], path: [`fragment ${fragment.name}`], extensions: { code: 'undefinedType', typeName: fragment.typeCondition } });
          continue;
        }
        spreading.add(fragment.name);
        this.validateSelections(document, fragment.typeCondition, fragment.selections, [`fragment ${fragment.name}`], errors, spreading, root);
        spreading.delete(fragment.name);
      }
    }
  }

  // ------------------------------------------------------------ execution

  execute(source: string, variables: Args, operationName: string | null, context: C): Result {
    let document: Document;
    try {
      document = parseDocument(source);
    } catch (err) {
      if (err instanceof GraphQLSyntaxError) return { errors: [{ message: err.message, locations: [{ line: err.line, column: err.column }] }] };
      throw err;
    }
    const candidates = operationName === null || operationName === '' ? document.operations : document.operations.filter((operation) => operation.name === operationName);
    if (candidates.length === 0) {
      return { errors: [{ message: operationName === null || operationName === '' ? 'No operations in query document' : `Unknown operation named "${operationName}"` }] };
    }
    if (candidates.length > 1) return { errors: [{ message: 'An operation name is required when the document holds more than one operation' }] };
    const operation = candidates[0] as Operation;
    const errors = this.validate(document, operation);
    if (errors.length > 0) return { errors };
    const values: Args = {};
    for (const definition of operation.variables) {
      const given = variables[definition.name];
      if (given !== undefined) values[definition.name] = given;
      else if (definition.defaultValue !== null) values[definition.name] = this.literal(definition.defaultValue, {});
      else if (definition.type.kind === 'NonNull') {
        return { errors: [{ message: `Variable $${definition.name} of type ${typeText(definition.type)} was provided invalid value`, locations: [operation.loc], extensions: { value: null, problems: [{ path: [], explanation: 'Expected value to not be null' }] } }] };
      }
    }
    const run = new Execution(this, document, values, context);
    const root = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const data = run.selectionSet(root, {}, operation.selections, []);
    return run.errors.length > 0 ? { data, errors: run.errors } : { data };
  }

  literal(node: ValueNode, variables: Args): unknown {
    switch (node.kind) {
      case 'Variable':
        return variables[node.name];
      case 'Int':
      case 'Float':
      case 'String':
      case 'Boolean':
      case 'Enum':
        return node.value;
      case 'Null':
        return null;
      case 'List':
        return node.values.map((value) => this.literal(value, variables));
      case 'Object': {
        const out: Args = {};
        for (const [name, value] of node.fields) out[name] = this.literal(value, variables);
        return out;
      }
    }
  }
}

class Execution<C> {
  readonly schema: Schema<C>;
  readonly document: Document;
  readonly variables: Args;
  readonly context: C;
  readonly errors: ErrorEntry[] = [];

  constructor(schema: Schema<C>, document: Document, variables: Args, context: C) {
    this.schema = schema;
    this.document = document;
    this.variables = variables;
    this.context = context;
  }

  included(directives: readonly Directive[]): boolean {
    for (const directive of directives) {
      const condition = directive.args.find(([name]) => name === 'if')?.[1];
      const value = condition === undefined ? undefined : this.schema.literal(condition, this.variables);
      if (directive.name === 'skip' && value === true) return false;
      if (directive.name === 'include' && value === false) return false;
    }
    return true;
  }

  collect(typeName: string, selections: readonly Selection[], into: Map<string, FieldNode[]>, visited: Set<string>): Map<string, FieldNode[]> {
    for (const selection of selections) {
      if (!this.included(selection.directives)) continue;
      if (selection.kind === 'Field') {
        const key = selection.alias ?? selection.name;
        const list = into.get(key);
        if (list === undefined) into.set(key, [selection]);
        else list.push(selection);
      } else if (selection.kind === 'Inline') {
        if (selection.typeCondition === null || this.schema.applies(selection.typeCondition, typeName)) this.collect(typeName, selection.selections, into, visited);
      } else {
        if (visited.has(selection.name)) continue;
        const fragment = this.document.fragments.get(selection.name);
        if (fragment === undefined || !this.schema.applies(fragment.typeCondition, typeName)) continue;
        visited.add(selection.name);
        this.collect(typeName, fragment.selections, into, visited);
      }
    }
    return into;
  }

  args(field: FieldDef | null, node: FieldNode): Args {
    const out: Args = {};
    for (const [name, value] of node.args) {
      const resolved = this.schema.literal(value, this.variables);
      if (resolved !== undefined) out[name] = resolved;
    }
    for (const arg of field?.args ?? []) {
      if (out[arg.name] === undefined && arg.defaultValue !== null) out[arg.name] = this.schema.literal(arg.defaultValue, {});
    }
    return out;
  }

  selectionSet(typeName: string, value: unknown, selections: readonly Selection[], path: Array<string | number>): Record<string, unknown> {
    const fields = this.collect(typeName, selections, new Map(), new Set());
    const out: Record<string, unknown> = {};
    const type = this.schema.types.get(typeName);
    for (const [key, nodes] of fields) {
      const node = nodes[0] as FieldNode;
      const fieldPath = [...path, key];
      if (node.name === '__typename') {
        out[key] = typeName;
        continue;
      }
      try {
        if (typeName === 'Query' && node.name === '__schema') {
          out[key] = this.selectionSet('__Schema', {}, merged(nodes), fieldPath);
          continue;
        }
        if (typeName === 'Query' && node.name === '__type') {
          const name = this.args(null, node).name;
          out[key] = typeof name === 'string' && this.schema.types.has(name) ? this.selectionSet('__Type', { __ref: { kind: 'Named', name } }, merged(nodes), fieldPath) : null;
          continue;
        }
        const field = type?.fieldMap.get(node.name);
        if (field === undefined) {
          out[key] = null;
          continue;
        }
        const args = this.args(field, node);
        let resolved: unknown;
        if (typeName.startsWith('__')) resolved = this.schema.introspect(typeName, node.name, value, args);
        else {
          const resolver = this.schema.resolvers[`${typeName}.${node.name}`];
          if (resolver !== undefined) resolved = resolver(value, args, this.context);
          else resolved = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[node.name] : undefined;
        }
        out[key] = this.complete(field.type, resolved, nodes, fieldPath);
      } catch (err) {
        out[key] = null;
        const entry: ErrorEntry = { message: err instanceof Error ? err.message : String(err), locations: [node.loc], path: fieldPath };
        if (err instanceof GraphQLError && err.type !== null) entry.type = err.type;
        this.errors.push(entry);
      }
    }
    return out;
  }

  complete(type: TypeNode, value: unknown, nodes: readonly FieldNode[], path: Array<string | number>): unknown {
    if (type.kind === 'NonNull') return this.complete(type.of, value, nodes, path);
    if (value === null || value === undefined) return null;
    if (type.kind === 'List') {
      if (!Array.isArray(value)) return null;
      return value.map((item, index) => this.complete(type.of, item, nodes, [...path, index]));
    }
    const def = this.schema.types.get(type.name);
    if (def === undefined || def.kind === 'SCALAR' || def.kind === 'ENUM') return value;
    let runtime = def.name;
    if (def.kind === 'INTERFACE' || def.kind === 'UNION') {
      const found = this.schema.typeOf(value);
      if (found === null || !this.schema.applies(def.name, found)) return null;
      runtime = found;
    }
    return this.selectionSet(runtime, value, merged(nodes), path);
  }
}

function merged(nodes: readonly FieldNode[]): Selection[] {
  const out: Selection[] = [];
  for (const node of nodes) if (node.selections !== null) out.push(...node.selections);
  return out;
}
