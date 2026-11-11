#!/usr/bin/env node
// Static SDK route evidence. This parses source and types without executing SDK or app code.
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url))));
const configPath = ts.findConfigFile(root, ts.sys.fileExists);
if (!configPath) throw new Error('SDK tsconfig.json was not found.');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error('SDK TypeScript configuration could not be read.');
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, { ...parsed.options, strictNullChecks: true });
const checker = program.getTypeChecker();
const evidence = new Map();
const maxAlternatives = 256;

function unique(values) {
  const result = [...new Set(values)];
  return result.length <= maxAlternatives ? result : undefined;
}

function merge(groups) {
  if (groups.some(group => group === undefined)) return undefined;
  return unique(groups.flat());
}

function typedStrings(node) {
  const inferred = checker.getTypeAtLocation(node);
  const type = inferred.flags & ts.TypeFlags.TypeParameter ? checker.getBaseConstraintOfType(inferred) ?? inferred : inferred;
  const variants = type.isUnion() ? type.types : [type];
  // An unconstrained string would make this a partial, misleading enumeration.
  if (variants.some(value => !(value.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.Never)))) return undefined;
  return unique(variants.filter(value => value.isStringLiteral()).map(value => value.value));
}

function declaration(node) {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const value = symbol?.valueDeclaration;
  return value?.getSourceFile().fileName.startsWith(resolve(root, 'src') + '/') ? value : undefined;
}

function returns(fn) {
  const signature = checker.getSignatureFromDeclaration(fn);
  if (!signature) return undefined;
  const resultType = checker.getReturnTypeOfSignature(signature);
  const variants = resultType.isUnion() ? resultType.types : [resultType];
  // Include implicit fallthrough and bare returns in the completeness check.
  if (variants.some(value => value.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown))) return undefined;
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return [fn.body];
  const result = [];
  function visit(node) {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) result.push(node.expression);
    ts.forEachChild(node, visit);
  }
  visit(fn);
  return result;
}

function objects(node, depth) {
  if (!node || depth > 12) return undefined;
  if (ts.isObjectLiteralExpression(node)) return [node];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return objects(node.expression, depth + 1);
  if (ts.isConditionalExpression(node)) return merge([objects(node.whenTrue, depth + 1), objects(node.whenFalse, depth + 1)]);
  if (ts.isIdentifier(node)) return objects(declaration(node)?.initializer, depth + 1);
  if (ts.isElementAccessExpression(node)) {
    const keys = strings(node.argumentExpression, depth + 1);
    const bases = objects(node.expression, depth + 1);
    if (!keys || !bases) return undefined;
    return merge(bases.flatMap(object => keys.map(key => {
      const property = object.properties.find(property => ts.isPropertyAssignment(property) && property.name.text === key);
      return property ? objects(property.initializer, depth + 1) : undefined;
    })));
  }
  if (ts.isCallExpression(node)) {
    const fn = declaration(node.expression);
    const body = fn && (ts.isFunctionLike(fn) ? fn : fn.initializer);
    const expressions = body && ts.isFunctionLike(body) ? returns(body) : undefined;
    if (expressions) return merge(expressions.map(value => objects(value, depth + 1)));
  }
  return undefined;
}

function strings(node, depth = 0) {
  if (!node || depth > 12) return undefined;
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return strings(node.expression, depth + 1);
  if (ts.isConditionalExpression(node)) return merge([strings(node.whenTrue, depth + 1), strings(node.whenFalse, depth + 1)]);
  if (ts.isTemplateExpression(node)) {
    let values = [node.head.text];
    for (const span of node.templateSpans) {
      const variants = strings(span.expression, depth + 1);
      if (!variants?.length || values.length * variants.length > maxAlternatives) return undefined;
      values = values.flatMap(prefix => variants.map(value => prefix + value + span.literal.text));
    }
    return unique(values);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = strings(node.left, depth + 1);
    const right = strings(node.right, depth + 1);
    if (!left || !right || left.length * right.length > maxAlternatives) return undefined;
    return unique(left.flatMap(prefix => right.map(value => prefix + value)));
  }
  if (ts.isPropertyAccessExpression(node)) {
    const bases = objects(node.expression, depth + 1);
    if (!bases) return undefined;
    return merge(bases.map(object => {
      const property = object.properties.find(property => ts.isPropertyAssignment(property) && property.name.text === node.name.text);
      return property ? strings(property.initializer, depth + 1) : undefined;
    }));
  }
  if (ts.isElementAccessExpression(node)) {
    const keys = strings(node.argumentExpression, depth + 1);
    const bases = objects(node.expression, depth + 1);
    if (!keys || !bases) return undefined;
    return merge(bases.flatMap(object => keys.map(key => {
      const property = object.properties.find(property => ts.isPropertyAssignment(property) && property.name.text === key);
      return property ? strings(property.initializer, depth + 1) : undefined;
    })));
  }
  if (ts.isIdentifier(node)) {
    const value = declaration(node);
    if (!value) return undefined;
    const init = value.initializer;
    if (init) return strings(init, depth + 1);
  }
  if (ts.isCallExpression(node)) {
    const fn = declaration(node.expression);
    const body = fn && (ts.isFunctionLike(fn) ? fn : fn.initializer);
    const expressions = body && ts.isFunctionLike(body) ? returns(body) : undefined;
    return expressions ? merge(expressions.map(value => strings(value, depth + 1))) : undefined;
  }
  return typedStrings(node);
}

for (const source of program.getSourceFiles()) {
  if (!source.fileName.startsWith(resolve(root, 'src') + '/')) continue;
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const literal = ts.isStringLiteralLike(node);
      for (const route of strings(node) ?? []) {
        if (!/^\/api\/[A-Za-z0-9/_-]+$/.test(route)) continue;
        const row = evidence.get(route) ?? { literal: [], expression: [] };
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        row[literal ? 'literal' : 'expression'].push(`${relative(root, source.fileName)}:${line}`);
        evidence.set(route, row);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

process.stdout.write(JSON.stringify(Object.fromEntries([...evidence].sort().map(([route, row]) => [route, {
  literal: [...new Set(row.literal)].sort(), expression: [...new Set(row.expression)].sort(),
}]))));
