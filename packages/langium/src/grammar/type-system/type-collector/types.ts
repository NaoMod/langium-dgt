/******************************************************************************
 * Copyright 2022 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import { CompositeGeneratorNode, NL, toString } from '../../../generator/generator-node';
import { CstNode } from '../../../syntax-tree';
import { Assignment, Action, TypeAttribute } from '../../generated/ast';
import { distinctAndSorted } from '../types-util';

export interface Property {
    name: string,
    optional: boolean,
    type: PropertyType,
    astNodes: Set<Assignment | Action | TypeAttribute>,
}

export type PropertyType =
    | ReferenceType
    | ArrayType
    | PropertyUnion
    | ValueType
    | PrimitiveType
    | StringType;

export interface ReferenceType {
    referenceType: PropertyType
}

export function isReferenceType(propertyType: PropertyType): propertyType is ReferenceType {
    return 'referenceType' in propertyType;
}

export interface ArrayType {
    elementType: PropertyType
}

export function isArrayType(propertyType: PropertyType): propertyType is ArrayType {
    return 'elementType' in propertyType;
}

export interface PropertyUnion {
    types: PropertyType[]
}

export function isPropertyUnion(propertyType: PropertyType): propertyType is PropertyUnion {
    return 'types' in propertyType;
}

export function flattenPropertyUnion(propertyType: PropertyType): PropertyType[] {
    if (isPropertyUnion(propertyType)) {
        const items: PropertyType[] = [];
        for (const type of propertyType.types) {
            items.push(...flattenPropertyUnion(type));
        }
        return items;
    } else {
        return [propertyType];
    }
}

export interface ValueType {
    value: TypeOption
}

export function isValueType(propertyType: PropertyType): propertyType is ValueType {
    return 'value' in propertyType;
}

export interface PrimitiveType {
    primitive: string
    regex?: string
}

export function isPrimitiveType(propertyType: PropertyType): propertyType is PrimitiveType {
    return 'primitive' in propertyType;
}

export interface StringType {
    string: string
}

export function isStringType(propertyType: PropertyType): propertyType is StringType {
    return 'string' in propertyType;
}

export type AstTypes = {
    interfaces: InterfaceType[],
    unions: UnionType[],
}

export function isUnionType(type: TypeOption): type is UnionType {
    return type && 'type' in type;
}

export function isInterfaceType(type: TypeOption): type is InterfaceType {
    return type && 'properties' in type;
}

export type TypeOption = InterfaceType | UnionType;

export class UnionType {
    name: string;
    type: PropertyType;
    superTypes = new Set<TypeOption>();
    subTypes = new Set<TypeOption>();
    containerTypes = new Set<TypeOption>();
    typeNames = new Set<string>();
    declared: boolean;
    dataType?: string;

    constructor(name: string, options?: {
        declared: boolean,
        dataType?: string
    }) {
        this.name = name;
        this.declared = options?.declared ?? false;
        this.dataType = options?.dataType;
    }

    toAstTypesString(reflectionInfo: boolean): string {
        const unionNode = new CompositeGeneratorNode();
        unionNode.append(`export type ${this.name} = ${propertyTypeToString(this.type, 'AstType')};`, NL);

        if (reflectionInfo) {
            unionNode.append(NL);
            pushReflectionInfo(unionNode, this.name);
        }

        if (this.dataType) {
            pushDataTypeReflectionInfo(unionNode, this);
        }

        return toString(unionNode);
    }

    toDeclaredTypesString(reservedWords: Set<string>): string {
        const unionNode = new CompositeGeneratorNode();
        unionNode.append(`type ${escapeReservedWords(this.name, reservedWords)} = ${propertyTypeToString(this.type, 'DeclaredType')};`, NL);
        return toString(unionNode);
    }
}

export class InterfaceType {
    name: string;
    superTypes = new Set<TypeOption>();
    subTypes = new Set<TypeOption>();
    containerTypes = new Set<TypeOption>();
    typeNames = new Set<string>();
    declared = false;
    abstract = false;

    properties: Property[] = [];

    get superProperties(): Property[] {
        return this.getSuperProperties(new Set());
    }

    private getSuperProperties(visited: Set<string>): Property[] {
        if (visited.has(this.name)) {
            return [];
        } else {
            visited.add(this.name);
        }
        const map = new Map<string, Property>();
        for (const property of this.properties) {
            map.set(property.name, property);
        }
        for (const superType of this.interfaceSuperTypes) {
            const allSuperProperties = superType.getSuperProperties(visited);
            for (const superProp of allSuperProperties) {
                if (!map.has(superProp.name)) {
                    map.set(superProp.name, superProp);
                }
            }
        }
        return Array.from(map.values());
    }

    get allProperties(): Property[] {
        const map = new Map(this.superProperties.map(e => [e.name, e]));
        for (const subType of this.subTypes) {
            this.getSubTypeProperties(subType, map, new Set());
        }
        const superProps = Array.from(map.values());
        return superProps;
    }

    private getSubTypeProperties(type: TypeOption, map: Map<string, Property>, visited: Set<string>): void {
        if (visited.has(this.name)) {
            return;
        } else {
            visited.add(this.name);
        }
        const props = isInterfaceType(type) ? type.properties : [];
        for (const prop of props) {
            if (!map.has(prop.name)) {
                map.set(prop.name, prop);
            }
        }
        for (const subType of type.subTypes) {
            this.getSubTypeProperties(subType, map, visited);
        }
    }

    get interfaceSuperTypes(): InterfaceType[] {
        return Array.from(this.superTypes).filter((e): e is InterfaceType => e instanceof InterfaceType);
    }

    constructor(name: string, declared: boolean, abstract: boolean) {
        this.name = name;
        this.declared = declared;
        this.abstract = abstract;
    }

    toAstTypesString(reflectionInfo: boolean): string {
        const interfaceNode = new CompositeGeneratorNode();

        const interfaceSuperTypes = this.interfaceSuperTypes.map(e => e.name);
        const superTypes = interfaceSuperTypes.length > 0 ? distinctAndSorted([...interfaceSuperTypes]) : ['AstNode'];
        interfaceNode.append(`export interface ${this.name} extends ${superTypes.join(', ')} {`, NL);

        interfaceNode.indent(body => {
            if (this.containerTypes.size > 0) {
                body.append(`readonly $container: ${distinctAndSorted([...this.containerTypes].map(e => e.name)).join(' | ')};`, NL);
            }
            if (this.typeNames.size > 0) {
                body.append(`readonly $type: ${distinctAndSorted([...this.typeNames]).map(e => `'${e}'`).join(' | ')};`, NL);
            }
            pushProperties(body, this.properties, 'AstType');
        });
        interfaceNode.append('}', NL);

        if (reflectionInfo) {
            interfaceNode.append(NL);
            pushReflectionInfo(interfaceNode, this.name);
        }

        return toString(interfaceNode);
    }

    toDeclaredTypesString(reservedWords: Set<string>): string {
        const interfaceNode = new CompositeGeneratorNode();

        const name = escapeReservedWords(this.name, reservedWords);
        const superTypes = distinctAndSorted(this.interfaceSuperTypes.map(e => e.name)).join(', ');
        interfaceNode.append(`interface ${name}${superTypes.length > 0 ? ` extends ${superTypes}` : ''} {`, NL);

        interfaceNode.indent(body => pushProperties(body, this.properties, 'DeclaredType', reservedWords));

        interfaceNode.append('}', NL);
        return toString(interfaceNode);
    }
}

export class TypeResolutionError extends Error {
    readonly target: CstNode | undefined;

    constructor(message: string, target: CstNode | undefined) {
        super(message);
        this.name = 'TypeResolutionError';
        this.target = target;
    }

}

export function isTypeAssignable(from: PropertyType, to: PropertyType): boolean {
    if (isPropertyUnion(from)) {
        return from.types.every(fromType => isTypeAssignable(fromType, to));
    } else if (isPropertyUnion(to)) {
        return to.types.some(toType => isTypeAssignable(from, toType));
    } else if (isValueType(to) && isUnionType(to.value)) {
        if (isValueType(from) && isUnionType(from.value) && to.value.name === from.value.name) {
            return true;
        }
        return isTypeAssignable(from, to.value.type);
    } else if (isReferenceType(from)) {
        return isReferenceType(to) && isTypeAssignable(from.referenceType, to.referenceType);
    } else if (isArrayType(from)) {
        return isArrayType(to) && isTypeAssignable(from.elementType, to.elementType);
    } else if (isValueType(from)) {
        if (isUnionType(from.value)) {
            return isTypeAssignable(from.value.type, to);
        }
        if (!isValueType(to)) {
            return false;
        }
        if (isUnionType(to.value)) {
            return isTypeAssignable(from, to.value.type);
        } else {
            return isInterfaceAssignable(from.value, to.value, new Set());
        }
    } else if (isPrimitiveType(from)) {
        return isPrimitiveType(to) && from.primitive === to.primitive;
    }
    else if (isStringType(from)) {
        return (isPrimitiveType(to) && to.primitive === 'string') || (isStringType(to) && to.string === from.string);
    }
    return false;
}

function isInterfaceAssignable(from: InterfaceType, to: InterfaceType, visited: Set<string>): boolean {
    if (visited.has(from.name)) {
        return true;
    } else {
        visited.add(from.name);
    }
    if (from.name === to.name) {
        return true;
    }
    for (const superType of from.superTypes) {
        if (isInterfaceType(superType) && isInterfaceAssignable(superType, to, visited)) {
            return true;
        }
    }
    return false;
}

export function propertyTypeToString(type: PropertyType, mode: 'AstType' | 'DeclaredType' = 'AstType'): string {
    if (isReferenceType(type)) {
        const refType = propertyTypeToString(type.referenceType, mode);
        return mode === 'AstType' ? `Reference<${refType}>` : `@${typeParenthesis(type.referenceType, refType)}`;
    } else if (isArrayType(type)) {
        const arrayType = propertyTypeToString(type.elementType, mode);
        return mode === 'AstType' ? `Array<${arrayType}>` : `${typeParenthesis(type.elementType, arrayType)}[]`;
    } else if (isPropertyUnion(type)) {
        const types = type.types.map(e => typeParenthesis(e, propertyTypeToString(e, mode)));
        return distinctAndSorted(types).join(' | ');
    } else if (isValueType(type)) {
        return type.value.name;
    } else if (isPrimitiveType(type)) {
        return type.primitive;
    } else if (isStringType(type)) {
        const delimiter = mode === 'AstType' ? "'" : '"';
        return `${delimiter}${type.string}${delimiter}`;
    }
    throw new Error('Invalid type');
}

function typeParenthesis(type: PropertyType, name: string): string {
    const needsParenthesis = isPropertyUnion(type);
    if (needsParenthesis) {
        name = `(${name})`;
    }
    return name;
}

function pushProperties(
    node: CompositeGeneratorNode,
    properties: Property[],
    mode: 'AstType' | 'DeclaredType',
    reserved = new Set<string>()
) {

    function propertyToString(property: Property): string {
        const name = mode === 'AstType' ? property.name : escapeReservedWords(property.name, reserved);
        const optional = property.optional && !isMandatoryPropertyType(property.type);
        const propType = propertyTypeToString(property.type, mode);
        return `${name}${optional ? '?' : ''}: ${propType}`;
    }

    distinctAndSorted(properties, (a, b) => a.name.localeCompare(b.name))
        .forEach(property => node.append(propertyToString(property), NL));
}

export function isMandatoryPropertyType(propertyType: PropertyType): boolean {
    if (isArrayType(propertyType)) {
        return true;
    } else if (isReferenceType(propertyType)) {
        return false;
    } else if (isPropertyUnion(propertyType)) {
        return propertyType.types.every(e => isMandatoryPropertyType(e));
    } else if (isPrimitiveType(propertyType)) {
        const value = propertyType.primitive;
        return value === 'boolean';
    } else {
        return false;
    }
}

function pushReflectionInfo(node: CompositeGeneratorNode, name: string) {
    node.append(`export const ${name} = '${name}';`, NL);
    node.append(NL);

    node.append(`export function is${name}(item: unknown): item is ${name} {`, NL);
    node.indent(body => body.append(`return reflection.isInstance(item, ${name});`, NL));
    node.append('}', NL);
}

function pushDataTypeReflectionInfo(node: CompositeGeneratorNode, union: UnionType) {
    switch (union.dataType) {
        case 'string':
            if (containsOnlyStringTypes(union.type)) {
                const subTypes = Array.from(union.subTypes).map(e => e.name);
                const strings = collectStringValuesFromDataType(union.type);
                const regexes = collectRegexesFromDataType(union.type);
                if (subTypes.length === 0 && strings.length === 0 && regexes.length === 0) {
                    generateIsDataTypeFunction(node, union.name, `typeof item === '${union.dataType}'`);
                } else {
                    const returnString = createDataTypeCheckerFunctionReturnString(subTypes, strings, regexes);
                    generateIsDataTypeFunction(node, union.name, returnString);
                }
            }
            break;
        case 'number':
        case 'boolean':
        case 'bigint':
            generateIsDataTypeFunction(node, union.name, `typeof item === '${union.dataType}'`);
            break;
        case 'Date':
            generateIsDataTypeFunction(node, union.name, 'item instanceof Date');
            break;
        default:
            return;
    }
}

function containsOnlyStringTypes(propertyType: PropertyType): boolean {
    let result = true;
    if (isPrimitiveType(propertyType)) {
        if (propertyType.primitive === 'string') {
            return true;
        } else {
            return false;
        }
    } else if (isStringType(propertyType)) {
        return true;
    } else if (!isPropertyUnion(propertyType)) {
        return false;
    } else {
        for (const type of propertyType.types) {
            if (isValueType(type)) {
                if (isUnionType(type.value)) {
                    if (!containsOnlyStringTypes(type.value.type)) {
                        return false;
                    }
                } else {
                    return false;
                }
            } else if (isPrimitiveType(type)) {
                if (type.primitive !== 'string' || !type.regex) {
                    return false;
                }
            } else if (isPropertyUnion(type)) {
                result = containsOnlyStringTypes(type);
            } else if (!isStringType(type)) {
                return false;
            }
        }
    }
    return result;
}

function createDataTypeCheckerFunctionReturnString(subTypes: string[], strings: string[], regexes: string[]): string {
    const allArray = [
        ...subTypes.map(e => `is${e}(item)`),
        ...strings.map(e => `item === '${e}'`)
    ];

    if (regexes.length > 0) {
        const joinedRegexes = regexes.map(e => `/${e}/.test(item)`).join(' || ');
        allArray.push(`(typeof item === 'string' && (${joinedRegexes}))`);
    }

    return allArray.join(' || ');
}

function escapeReservedWords(name: string, reserved: Set<string>): string {
    return reserved.has(name) ? `^${name}` : name;
}

function collectStringValuesFromDataType(propertyType: PropertyType): string[] {
    const values: string[] = [];
    if (isStringType(propertyType)) {
        return [propertyType.string];
    }
    if (isPropertyUnion(propertyType)) {
        for (const type of propertyType.types) {
            if (isStringType(type)) {
                values.push(type.string);
            } else if (isPropertyUnion(type)) {
                values.push(...collectStringValuesFromDataType(type));
            }
        }
    }

    return values;
}

function collectRegexesFromDataType(propertyType: PropertyType): string[] {
    const regexes: string[] = [];
    if (isPrimitiveType(propertyType) && propertyType.primitive === 'string' && propertyType.regex) {
        regexes.push(propertyType.regex);
    }
    if (isPropertyUnion(propertyType)) {
        for (const type of propertyType.types) {
            if (isPrimitiveType(type) && type.primitive === 'string' && type.regex) {
                regexes.push(type.regex);
            } else if (isPropertyUnion(type)) {
                regexes.push(...collectRegexesFromDataType(type));
            }
        }
    }
    return regexes;
}

function generateIsDataTypeFunction(node: CompositeGeneratorNode, unionName: string, returnString: string) {
    node.append(NL, `export function is${unionName}(item: unknown): item is ${unionName} {`, NL);
    node.indent(body => body.append(`return ${returnString};`, NL));
    node.append('}', NL);
}