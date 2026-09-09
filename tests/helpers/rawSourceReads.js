import {parse} from "espree";

/** Locate raw textual reads in client tests. JSON, explicit fixture paths and
 * binary reads remain filesystem I/O; source scans use readSource so their
 * anchors mean the same thing on LF and CRLF checkouts. Unknown UTF-8 paths
 * are reported too, including reader wrappers whose parameter is dynamic. */
export const rawSourceReads = source => {
    const tree = parse(source, {ecmaVersion: "latest", sourceType: "module", ecmaFeatures: {jsx: true}, loc: true});
    const namespaces = new Set(), readers = new Set(), bindings = new Map(), calls = [];
    const visit = (node, ancestors = []) => {
        if (!node || typeof node !== "object") return;
        if (node.type === "ImportDeclaration" && ["fs", "node:fs"].includes(node.source.value)) {
            for (const specifier of node.specifiers) {
                if (specifier.type === "ImportSpecifier") {
                    if (specifier.imported.name === "readFileSync") readers.add(specifier.local.name);
                } else namespaces.add(specifier.local.name);
            }
        }
        if (node.type === "VariableDeclarator" && node.id.type === "Identifier") bindings.set(node.id.name, node.init);
        if (node.type === "CallExpression") calls.push({node, ancestors});
        for (const [key, value] of Object.entries(node)) {
            if (key === "loc") continue;
            if (Array.isArray(value)) value.forEach(child => visit(child, [...ancestors, node]));
            else if (value && typeof value === "object") visit(value, [...ancestors, node]);
        }
    };
    visit(tree);
    const member = node => node?.computed ? node.property?.value : node?.property?.name;
    const isReader = (node, seen = new Set()) => {
        if (!node) return false;
        if (node.type === "Identifier") {
            if (readers.has(node.name)) return true;
            if (seen.has(node.name)) return false;
            return isReader(bindings.get(node.name), new Set([...seen, node.name]));
        }
        return node.type === "MemberExpression" && namespaces.has(node.object.name) && member(node) === "readFileSync";
    };
    const pathText = (node, seen = new Set()) => {
        if (!node) return "";
        if (node.type === "Literal") return String(node.value);
        if (node.type === "Identifier") {
            if (seen.has(node.name)) return "";
            return pathText(bindings.get(node.name), new Set([...seen, node.name]));
        }
        if (node.type === "TemplateLiteral") return node.quasis.map(part => part.value.cooked).join("*");
        if (node.type === "CallExpression" || node.type === "NewExpression") return node.arguments.map(arg => pathText(arg, seen)).join("/");
        if (node.type === "BinaryExpression") return pathText(node.left, seen) + pathText(node.right, seen);
        return "";
    };
    return calls.filter(({node, ancestors}) => {
        if (!isReader(node.callee)) return false;
        const file = pathText(node.arguments[0]).replaceAll("\\", "/");
        const encoding = node.arguments[1];
        const textual = /^utf-?8$/i.test(encoding?.value ?? "") || encoding?.properties?.some(property =>
            (property.key.name ?? property.key.value) === "encoding" && /^utf-?8$/i.test(property.value.value));
        const clientSource = /(?:^|\/)client\/src(?:\/|$)/.test(file);
        if (!textual && !clientSource) return false;
        const parsedJson = ancestors.some(parent => parent.type === "CallExpression" &&
            parent.callee.type === "MemberExpression" && parent.callee.object.name === "JSON" && member(parent.callee) === "parse");
        return !parsedJson && !/\.json$/.test(file) && !/(?:^|\/)fixtures?(?:\/|$)/.test(file);
    }).map(({node}) => node.loc.start.line);
};
